import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { startDocSync } from './sync.js';

// --- Configuration depuis l'environnement ---
const {
  DISCORD_TOKEN,
  ANYTHINGLLM_URL,
  ANYTHINGLLM_API_KEY,
  ANYTHINGLLM_WORKSPACE,
  ANYTHINGLLM_MODE = 'chat',
  ANYTHINGLLM_AGENT = 'false',
  ALLOWED_CHANNEL_IDS = '',
} = process.env;

// Échec propre au démarrage si une variable obligatoire manque
const required = { DISCORD_TOKEN, ANYTHINGLLM_URL, ANYTHINGLLM_API_KEY, ANYTHINGLLM_WORKSPACE };
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`❌ Variables d'environnement manquantes : ${missing.join(', ')}`);
  process.exit(1);
}

// Mode "écoute totale" : salons où le bot répond à TOUS les messages (optionnel)
const allowedChannels = new Set(
  ALLOWED_CHANNEL_IDS.split(',').map((id) => id.trim()).filter(Boolean),
);

// Mode agent : préfixe la question par @agent pour déclencher skills/tools/MCP
//   'true'     → toujours @agent
//   'fallback' → d'abord en mode query (documents seuls), puis @agent si rien trouvé
const agentEnabled = ANYTHINGLLM_AGENT === 'true';
const agentFallback = ANYTHINGLLM_AGENT === 'fallback';

// Réponse renvoyée par AnythingLLM en mode query quand aucun document ne correspond.
// Doit correspondre au "Query mode refusal response" du workspace s'il a été personnalisé.
const QUERY_REFUSAL = (process.env.QUERY_REFUSAL_RESPONSE
  || 'There is no relevant information in this workspace to answer your query.').trim();

// Le refus ci-dessus n'est renvoyé que si AUCUN extrait ne passe le seuil de similarité.
// Quand des extraits proches mais hors sujet sont trouvés, le modèle répond « je ne sais pas »
// avec ses propres mots : on lui demande donc un mot-clé fixe, facile à détecter.
const NO_ANSWER_MARKER = 'AUCUNE_INFO';
// Discord n'affiche pas les tableaux Markdown : on demande des listes à la place
const DISCORD_FORMAT = "Pas de tableau Markdown (Discord ne les affiche pas), utilise des listes.";
const QUERY_INSTRUCTION = `\n\n(Consigne : réponds uniquement à partir des documents fournis. `
  + `S'ils ne contiennent pas la réponse, réponds exactement « ${NO_ANSWER_MARKER} » et rien d'autre. `
  + `${DISCORD_FORMAT})`;

// Compare sans tenir compte de la casse, des espaces ni de la ponctuation finale
const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?…]+$/, '').trim();
const isQueryRefusal = (answer) =>
  answer.includes(NO_ANSWER_MARKER) || normalize(answer) === normalize(QUERY_REFUSAL);

// Diagnostic & robustesse
const DEBUG = process.env.DEBUG === 'true';
// Deux temps : délai généreux avant le 1er octet (cold start d'un modèle local),
// puis délai court entre deux morceaux une fois le flux lancé.
const FIRST_BYTE_MS = Number(process.env.FIRST_BYTE_TIMEOUT_MS) || 300000;
const STREAM_IDLE_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS) || 60000;

const DISCORD_LIMIT = 2000; // limite de caractères par message Discord

// --- Intégration AnythingLLM ---
// Extrait un message de statut/skill lisible d'un événement SSE (sinon null).
// Ces événements viennent des appels introspect() des skills de l'agent.
function statusFromEvent(evt) {
  const type = String(evt.type || '').toLowerCase();
  const isStatus = type.includes('status') || type.includes('thought') || type.includes('thinking');
  if (!isStatus) return null;
  // Les étapes de l'agent arrivent en type "agentThought", texte dans le champ "thought"
  const text = String(evt.thought ?? evt.content ?? evt.textResponse ?? evt.message ?? '').trim();
  return text || null;
}

// Traduit une étape brute de l'agent en statut lisible pour Discord (null = à ne pas afficher).
// Ex. brut : "@agent is executing `web-browsing` tool {\"query\": \"...\"}"
const TOOL_LABELS = {
  'web-browsing': '🔎 Recherche sur le web',
  'web-scraping': '🌐 Lecture d\'une page web',
  'rag-memory': '📄 Recherche dans les documents',
  'document-summarizer': '📄 Lecture des documents',
};
function formatStatus(raw) {
  const text = raw.replace(/^@agent:?\s*/, '');
  const tool = text.match(/^is executing `([^`]+)` tool\s*(\{[\s\S]*\})?/);
  if (tool) {
    let args = {};
    try { args = JSON.parse(tool[2] || '{}'); } catch { /* arguments illisibles : libellé seul */ }
    const detail = args.query ?? args.url ?? args.content ?? args.document_filename;
    const label = TOOL_LABELS[tool[1]] ?? `🔧 Outil ${tool[1]}`;
    return detail ? `${label} : « ${String(detail).slice(0, 200)} »` : `${label}…`;
  }
  const found = text.match(/found (\d+) results/i);
  if (found) return `🔎 ${found[1]} résultats trouvés, lecture en cours…`;
  if (/^Using SearXNG/i.test(text)) return null; // redondant avec l'appel d'outil
  return `🔧 ${text}`;
}

// Interroge le workspace en streaming (SSE) et renvoie le texte final.
// onStatus(text) est appelé pour chaque activité de skill remontée par l'agent.
async function askAnythingLLM(message, sessionId, onStatus, { mode = ANYTHINGLLM_MODE, agent = agentEnabled } = {}) {
  const url = `${ANYTHINGLLM_URL}/api/v1/workspace/${ANYTHINGLLM_WORKSPACE}/stream-chat`;
  // @agent déclenche l'agent AnythingLLM via la Developer API (mode reste chat/query)
  const payload = agent ? `@agent ${message}` : message;

  // Coupe-circuit : abandonne si aucune donnée n'arrive pendant STREAM_IDLE_MS
  const controller = new AbortController();
  let idleTimer;
  let gotData = false;
  // 1er octet : délai généreux (FIRST_BYTE_MS) ; ensuite : délai court entre morceaux (STREAM_IDLE_MS)
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), gotData ? STREAM_IDLE_MS : FIRST_BYTE_MS);
  };

  const started = Date.now();
  console.log(`→ stream-chat | mode=${mode} agent=${agent} | q="${message.slice(0, 80)}"`);

  arm();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ANYTHINGLLM_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ message: payload, mode, sessionId }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(idleTimer);
    if (controller.signal.aborted) throw new Error(`Timeout: aucune réponse d'AnythingLLM après ${FIRST_BYTE_MS} ms`);
    throw err;
  }

  console.log(`  stream ouvert: HTTP ${res.status} | content-type=${res.headers.get('content-type') || '?'}`);

  // Erreur HTTP (auth, workspace inexistant, serveur down…)
  if (!res.ok || !res.body) {
    clearTimeout(idleTimer);
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim());
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let events = 0;
  let closed = false;

  try {
    // Lit le flux SSE : chaque événement est une ligne "data: {json}"
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) gotData = true; // 1er octet reçu -> bascule sur le délai court
      arm();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // garde la ligne incomplète pour le prochain tour

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let evt;
        try { evt = JSON.parse(data); } catch { continue; } // ignore le non-JSON
        events += 1;
        if (DEBUG && events <= 8) console.log(`  event #${events}: ${data.slice(0, 200)}`);

        if (evt.error) throw new Error(String(evt.error));

        const status = statusFromEvent(evt);
        if (status) {
          console.log(`  🔧 ${status.slice(0, 200)}`); // trace brute des skills de l'agent (ex. recherche web)
          const pretty = formatStatus(status);
          if (pretty) onStatus?.(pretty);
        }
        else if (typeof evt.textResponse === 'string') {
          const isChunk = String(evt.type || '').toLowerCase().includes('chunk');
          if (DEBUG && !isChunk) console.log(`  event complet (${evt.type}): ${evt.textResponse.length} car.`);
          // Un morceau s'ajoute ; un événement complet (l'agent renvoie tout le texte à la fin) remplace.
          // Garde-fou : un morceau identique au texte déjà reçu est un doublon, on l'ignore.
          if (!isChunk) answer = evt.textResponse;
          else if (!(answer && evt.textResponse === answer)) answer += evt.textResponse;
        }

        if (evt.close === true) { closed = true; break; }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(gotData
        ? `Timeout: flux AnythingLLM inactif depuis ${STREAM_IDLE_MS} ms`
        : `Timeout: aucune réponse d'AnythingLLM après ${FIRST_BYTE_MS} ms`);
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
    await reader.cancel().catch(() => {});
  }

  const result = answer.trim();
  console.log(`← réponse: ${result.length} car., ${events} évén., ${Date.now() - started} ms`);
  if (!result && events) {
    console.warn("  ⚠️ réponse vide malgré des événements — schéma d'événements inattendu ? (relance avec DEBUG=true)");
  }
  return result;
}

// Routage à deux temps : documents d'abord (mode query), agent (recherche web) ensuite.
async function askWithRouting(message, sessionId, onStatus) {
  if (!agentFallback) return askAnythingLLM(message, sessionId, onStatus);

  const answer = await askAnythingLLM(message + QUERY_INSTRUCTION, sessionId, onStatus, { mode: 'query', agent: false });
  if (answer && !isQueryRefusal(answer)) return answer;

  console.log('  ↪ rien dans les documents → relance en @agent');
  onStatus?.('📚 Rien dans la base de connaissances, recherche sur le web…');
  // Session neuve à chaque relance : tout historique (AUCUNE_INFO, réponses précédentes) pousse
  // sinon le modèle à recopier une ancienne réponse au lieu d'appeler la recherche web.
  const webQuestion = `Fais une recherche sur le web pour répondre à cette question : ${message}\n\n(${DISCORD_FORMAT})`;
  return askAnythingLLM(webQuestion, `${sessionId}-agent-${Date.now()}`, onStatus, { mode: 'chat', agent: true });
}

// --- Découpe des réponses longues ---
// Coupe de préférence sur les sauts de ligne, sans dépasser la limite
function splitMessage(text, limit = DISCORD_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    // Ligne unique plus longue que la limite : découpe brute
    if (line.length > limit) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    // +1 pour le saut de ligne réintroduit lors de la concaténation
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// --- Indicateur "écrit…" ---
// Maintient le typing tant que la tâche n'est pas terminée (RAG parfois lent > 10s)
async function withTyping(channel, task) {
  channel.sendTyping().catch(() => {});
  const interval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
  try {
    return await task();
  } finally {
    clearInterval(interval);
  }
}

// --- Client Discord ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // nécessaire pour recevoir les DM
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Connecté en tant que ${c.user.tag}`);
  console.log(
    `   Workspace: ${ANYTHINGLLM_WORKSPACE} | Mode: ${agentFallback ? 'query → @agent' : ANYTHINGLLM_MODE}${agentEnabled ? ' | Agent: on' : ''}`,
  );
  if (allowedChannels.size) {
    console.log(`   Salons en écoute totale: ${[...allowedChannels].join(', ')}`);
  }
  startDocSync();
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore ses propres messages et ceux des autres bots
  if (message.author.bot) return;

  const isDM = message.channel.isDMBased();
  const isMentioned = message.mentions.users.has(client.user.id);
  const isAllowedChannel = allowedChannels.has(message.channel.id);

  // Ne répond qu'en DM, sur mention, ou dans un salon en écoute totale
  if (!isDM && !isMentioned && !isAllowedChannel) return;

  // Retire la mention du bot du texte avant d'envoyer la question
  const question = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  if (!question) {
    await message.reply('Pose-moi une question 🙂').catch(() => {});
    return;
  }

  // sessionId distinct par salon → fil de conversation propre côté AnythingLLM
  const sessionId = `discord-${message.channel.id}`;

  // Message de statut éphémère : créé au 1er événement de skill, effacé à la fin
  let statusMsg = null;
  let lastEdit = 0;
  const showStatus = async (text) => {
    const now = Date.now();
    if (now - lastEdit < 1500) return; // throttle anti rate-limit Discord
    lastEdit = now;
    const content = text.slice(0, DISCORD_LIMIT); // le statut porte déjà son emoji
    try {
      if (!statusMsg) statusMsg = await message.channel.send(content);
      else await statusMsg.edit(content);
    } catch { /* l'affichage du statut ne doit jamais casser la requête */ }
  };

  try {
    const answer = await withTyping(message.channel, () =>
      askWithRouting(question, sessionId, showStatus),
    );

    // La réponse est prête : on retire le message de statut éphémère
    if (statusMsg) await statusMsg.delete().catch(() => {});

    const chunks = splitMessage(answer || '_(réponse vide)_');
    // Premier morceau en réponse, le reste à la suite
    await message.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) await message.channel.send(chunk);
  } catch (err) {
    console.error('Erreur AnythingLLM:', err);
    if (statusMsg) await statusMsg.delete().catch(() => {});
    const hint = /timeout/i.test(err?.message || '') ? ' (délai dépassé)' : '';
    await message
      .reply(`⚠️ Une erreur est survenue en interrogeant la base de connaissances.${hint}`)
      .catch(() => {});
  }
});

// Filets de sécurité : on log sans faire crasher le process
process.on('unhandledRejection', (err) => console.error('Rejet non géré:', err));

client.login(DISCORD_TOKEN);
