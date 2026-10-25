import 'dotenv/config';
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, GatewayIntentBits, Partials, Events, EmbedBuilder } from 'discord.js';
import { startDocSync, findItemImages, findWikiNames, findCategoryCards } from './sync.js';
import { stormCard } from './storm.js';

// Version du code en cours d'exécution : empreinte des sources (le .git n'est pas dans l'image).
// Exposée par /health pour vérifier qu'un déploiement est bien en place (même calcul : scripts/wait-deploy.sh).
const CODE_VERSION = createHash('sha256')
  .update(['bot.js', 'sync.js', 'storm.js'].map((f) => readFileSync(new URL(`./${f}`, import.meta.url))).join('\n'))
  .digest('hex').slice(0, 12);
const STARTED_AT = new Date().toISOString();

// --- Configuration depuis l'environnement ---
const {
  DISCORD_TOKEN,
  ANYTHINGLLM_URL,
  ANYTHINGLLM_API_KEY,
  ANYTHINGLLM_WORKSPACE,
  ANYTHINGLLM_MODE = 'chat',
  ANYTHINGLLM_AGENT = 'false',
  ALLOWED_CHANNEL_IDS = '',
  TEST_API_TOKEN = '', // interface HTTP de test : désactivée si vide
  TEST_API_PORT = '3000',
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

// Pied de réponse (durée, chemin suivi, outils) : désactivable avec RESPONSE_FOOTER=false
const showFooter = process.env.RESPONSE_FOOTER !== 'false';

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
// Ni trop souple (« même en partie » : le modèle citait la description décorative d'un seau du coffre
// pour une question de mécanique de jeu), ni « s'ils mentionnent seulement le sujet » (appliqué avec
// zèle par un modèle à réflexion). On vise le cas précis : une description d'objet n'est pas une règle de jeu.
const QUERY_INSTRUCTION = `\n\n(Consigne : réponds uniquement à partir des documents fournis et des extraits ou fiches joints, `
  + `s'ils répondent à la question posée. La description d'un objet du coffre ou d'un emblème ne suffit pas `
  + `à répondre à une question sur le fonctionnement du jeu (mécanique, gameplay). S'ils ne répondent pas à la `
  + `question, réponds exactement « ${NO_ANSWER_MARKER} » et rien d'autre. ${DISCORD_FORMAT})`;

// Questions sur un personnage ou le lore : la base (versions, coffre, emblèmes) ne les couvre pas et ne
// fait que citer des noms dans des objets. On passe directement à l'agent et à ses skills (PNJ, navires
// du lore…). Pas « navire » seul : il désigne aussi toute une catégorie du coffre.
const AGENT_FIRST = new RegExp([
  "qui (est|sont|était|étaient)\\b", "c'est qui", "parle[- ]moi d", "raconte",
  'pnj', 'npc', 'personnages?\\b',
  'lore\\b', 'histoire\\b', 'légende de\\b', // pas « Légende des pirates » (un titre du jeu)
  // « le bateau de Flameheart » : navire d'un personnage (les cosmétiques disent « navire X », « de navire »)
  "(bateau|navire|vaisseau|galion|sloop|brigantin)s? (de|du|d')",
  // Données en direct (skills statut des serveurs et actualités) : l'agent interroge la source à jour.
  // Les annonces synchronisées, en anglais, sont mal retrouvées par une question en français.
  'serveurs?\\b', 'panne', 'down\\b', 'maintenance', 'joueurs (en ligne|connectés)', 'beard',
  'év[éè]nements?\\b', 'quoi de neuf', 'actualités?\\b', 'news\\b', 'twitch drops?', 'community weekend',
  // Début de mot : (?<!\p{L}) et non \b, qui ignore les lettres accentuées (« événement », « énigme »)
].map((p) => `(?<!\\p{L})${p}`).join('|'), 'iu');

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

// Retire le raisonnement des modèles « à réflexion » (<think>…</think>), que LM Studio peut laisser
// dans le texte : bloc complet, balise fermante seule (ouverture avalée) ou bloc tronqué non refermé
function stripThinking(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
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
    // Arguments connus des skills intégrées, sinon le premier argument texte (skills personnalisées)
    const detail = args.query ?? args.url ?? args.content ?? args.document_filename
      ?? Object.values(args).find((v) => typeof v === 'string' && v.trim());
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
// trace (optionnel) : relève les outils appelés par l'agent, pour le pied de réponse
async function askAnythingLLM(message, sessionId, onStatus, { mode = ANYTHINGLLM_MODE, agent = agentEnabled, trace } = {}) {
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
          const tool = status.match(/executing `([^`]+)` tool/)?.[1];
          if (tool) trace?.tools.add(tool);
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

  const result = stripThinking(answer);
  if (result.length < answer.trim().length) {
    console.log(`  🧠 raisonnement du modèle retiré (${answer.trim().length - result.length} car.)`);
    // Diagnostic : pourquoi le modèle a conclu ce qu'il a conclu (ex. AUCUNE_INFO malgré un bon document)
    if (DEBUG) {
      const thinking = answer.match(/<think>([\s\S]*?)(<\/think>|$)/i)?.[1] ?? '';
      console.log(`  💭 ${thinking.replace(/\s+/g, ' ').trim().slice(0, 1500)}`);
    }
  }
  console.log(`← réponse: ${result.length} car., ${events} évén., ${Date.now() - started} ms`);
  if (!result && events) {
    console.warn("  ⚠️ réponse vide malgré des événements — schéma d'événements inattendu ? (relance avec DEBUG=true)");
  }
  return result;
}

// Recherche vectorielle sur la QUESTION SEULE. En mode query, AnythingLLM cherche avec tout le message
// envoyé : la consigne, bien plus longue que la question, détermine alors la recherche et ramène des
// extraits sans rapport. Le bot joint donc lui-même les meilleurs extraits trouvés ici.
const MIN_EXTRACT_SCORE = 0.2; // en dessous, l'extrait n'a pas de vrai rapport avec la question
const MAX_EXTRACTS = 4;
const MAX_EXTRACT_CHARS = 1500;
async function searchExtracts(question) {
  try {
    const res = await fetch(`${ANYTHINGLLM_URL}/api/v1/workspace/${ANYTHINGLLM_WORKSPACE}/vector-search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: question, topN: 6 }),
    });
    const { results = [], message } = await res.json();
    if (DEBUG) {
      console.log(`  🔍 recherche vectorielle: ${results.length} extrait(s)${message ? ` (${message})` : ''}`);
      for (const r of results) {
        const score = typeof r.score === 'number' ? r.score.toFixed(3) : '?';
        console.log(`     ${score} | ${r.metadata?.title ?? '?'} | ${String(r.text || '').replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    return results
      .filter((r) => typeof r.score === 'number' && r.score >= MIN_EXTRACT_SCORE)
      .slice(0, MAX_EXTRACTS)
      .map((r) => ({
        score: r.score,
        title: r.metadata?.title ?? '?',
        // Préfixe « passage: » du modèle d'embedding et en-tête de métadonnées d'AnythingLLM retirés
        text: String(r.text || '').replace(/^passage:\s*/, '').replace(/<document_metadata>[\s\S]*?<\/document_metadata>/, '')
          .trim().slice(0, MAX_EXTRACT_CHARS),
      }));
  } catch (err) {
    console.warn('  🔍 recherche vectorielle impossible:', err.message);
    return [];
  }
}

// --- Fils de conversation ---
// Une mention ouvre un nouveau fil ; « Répondre » à un message de Sotia continue le sien. La mémoire
// vient de Discord (questions + réponses finales), pas de l'historique d'AnythingLLM, qui contient
// consignes, extraits joints et AUCUNE_INFO.
const THREAD_EXCHANGES = 3; // échanges précédents transmis au modèle
const THREAD_ANSWER_CHARS = 800; // réponse précédente raccourcie au-delà
const threadMemory = new Map(); // id d'un message de Sotia → { question, answer, parent }

function rememberExchange(messageIds, record) {
  for (const id of messageIds) threadMemory.set(id, record);
  // Mémoire bornée : on oublie les plus anciens (ordre d'insertion de la Map)
  while (threadMemory.size > 2000) threadMemory.delete(threadMemory.keys().next().value);
}

const stripMention = (text) => text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
const stripFooter = (text) => text.split('\n').filter((l) => !l.startsWith('-# ')).join('\n').trim();

// Échange auquel ce message répond, s'il répond à Sotia (sinon null : nouveau fil).
// Hors mémoire (anciens messages, redémarrage), on relit la chaîne sur Discord : message de Sotia →
// question à laquelle il répond → message de Sotia auquel cette question répondait… (THREAD_EXCHANGES max)
async function loadThread(message, depth = 0) {
  const refId = message.reference?.messageId;
  if (!refId || depth >= THREAD_EXCHANGES) return null;
  if (threadMemory.has(refId)) return threadMemory.get(refId);
  const botMsg = await message.fetchReference().catch(() => null);
  if (!botMsg || botMsg.author.id !== client.user.id) return null;
  const chunks = await answerChunks(botMsg);
  const questionMsg = chunks[0].reference?.messageId ? await chunks[0].fetchReference().catch(() => null) : null;
  return {
    question: questionMsg ? stripMention(questionMsg.content) : '',
    // Anciennes réponses : pied de réponse et raisonnement <think> affiché avant sa correction retirés
    answer: stripThinking(stripFooter(chunks.map((c) => c.content).join('\n'))),
    parent: questionMsg ? await loadThread(questionMsg, depth + 1) : null,
  };
}

// Morceaux d'une réponse découpée : seul le premier répond à la question, les suivants sont envoyés
// à la suite sans lien. On regroupe les messages de Sotia consécutifs autour du morceau visé, jusqu'au
// premier morceau (celui qui a un lien) avant, et jusqu'à la réponse suivante (nouveau lien) après.
async function answerChunks(botMsg) {
  const isBot = (m) => m.author.id === client.user.id;
  const byTime = (a, b) => a.createdTimestamp - b.createdTimestamp;
  const chunks = [botMsg];
  if (!botMsg.reference) {
    const before = await botMsg.channel.messages.fetch({ before: botMsg.id, limit: 5 }).catch(() => null);
    for (const m of [...(before?.values() ?? [])].sort(byTime).reverse()) {
      if (!isBot(m)) break;
      chunks.unshift(m);
      if (m.reference) break;
    }
  }
  const after = await botMsg.channel.messages.fetch({ after: botMsg.id, limit: 5 }).catch(() => null);
  for (const m of [...(after?.values() ?? [])].sort(byTime)) {
    if (!isBot(m) || m.reference) break;
    chunks.push(m);
  }
  return chunks;
}

// Contexte transmis au modèle : les derniers échanges du fil, du plus ancien au plus récent
function threadContext(record) {
  const chain = [];
  for (let r = record; r && chain.length < THREAD_EXCHANGES; r = r.parent) chain.unshift(r);
  const clip = (s) => (s.length > THREAD_ANSWER_CHARS ? `${s.slice(0, THREAD_ANSWER_CHARS)}…` : s);
  return {
    history: 'Échanges précédents de cette conversation (pour comprendre la nouvelle question) :\n\n'
      + chain.map((r) => `${r.question ? `Joueur : ${r.question}\n` : ''}Sotia : ${clip(r.answer)}`).join('\n\n'),
    // Les questions du fil aident à retrouver le sujet (« et son bateau ? » après « qui est Flameheart ? »)
    questions: chain.map((r) => r.question).filter(Boolean),
    search: chain.map((r) => r.question).filter(Boolean).join(' '),
    exchanges: chain.length,
  };
}

// Routage à deux temps : documents d'abord (mode query), agent (recherche web) ensuite.
// trace : chemin suivi, fiches jointes et outils appelés, pour le pied de réponse.
// thread : contexte du fil (threadContext) quand le message répond à Sotia.
async function askWithRouting(question, sessionId, onStatus, trace = { tools: new Set() }, thread = null) {
  // Avec un fil : échanges précédents avant la question ; recherches sur la question précédente + celle-ci
  const message = thread ? `${thread.history}\n\nNouvelle question : ${question}` : question;
  const search = thread?.search ? `${thread.search} ${question}` : question;
  if (thread) trace.thread = thread.exchanges;

  if (!agentFallback) {
    trace.path = agentEnabled ? 'agent' : 'documents';
    return askAnythingLLM(message, sessionId, onStatus, { trace });
  }

  // Tempête : le bot calcule lui-même position et trajet à l'instant de la question (storm.js) et les
  // joint en fiche ; le modèle ne connaît pas l'heure et un document serait périmé en quelques minutes
  if (STORM_INTENT.test(search)) {
    try {
      const card = await stormCard();
      console.log('  🌩️ fiche tempête jointe');
      trace.path = 'storm';
      // Mode chat et non query : en query, AnythingLLM refuse sans appeler le modèle quand sa propre
      // recherche ne trouve rien dans les documents, ce qui arrivait une fois sur deux ici
      const answer = await askAnythingLLM(`${message}\n\nFiche calculée à l'instant :\n\n${card}\n\n(Consigne : réponds `
        + 'uniquement à partir de cette fiche. Garde les noms anglais des îles tels quels, sans les traduire. '
        + `${DISCORD_FORMAT})`, `${sessionId}-storm-${Date.now()}`, onStatus, { mode: 'chat', agent: false });
      trace.queryAnswer = answer;
      if (answer && !isQueryRefusal(answer)) return answer;
    } catch (err) {
      console.warn('  🌩️ prévisions de la tempête indisponibles :', err.message);
    }
    // Repli : l'agent et sa skill sot-storm (indication dans TOOL_HINTS)
    trace.path = trace.path === 'storm' ? 'storm→agent' : 'agent';
    return askAgent(message, sessionId, onStatus, [], trace);
  }

  // Pages du wiki citées par leur nom (personnages, lieux…) : indice donné à l'agent, qui cherche en anglais
  const wikiTitles = findWikiNames(search);
  if (AGENT_FIRST.test(question)) {
    console.log('  ↪ thème hors base (personnage, lore, direct) → @agent directement');
    trace.path = 'agent';
    return askAgent(message, sessionId, onStatus, wikiTitles, trace);
  }

  // Objets et emblèmes cités par leur nom exact : on joint leur fiche, car la recherche
  // vectorielle retrouve mal un nom propre (« Au cœur du fléau » → « Cœur ardent »).
  // Ils passent avant les noms du wiki : « le Coutelas de Flameheart » est un objet du coffre.
  const known = findItemImages(search, 3);
  // Questions de comptage ou de liste : lignes du sommaire du coffre pour les catégories citées
  // (« combien d'animaux de compagnie ? » → Familiers / Pets : 43 objets)
  const categories = COUNT_INTENT.test(question) ? findCategoryCards(search) : [];
  if (!known.length && !categories.length && wikiTitles.length) {
    console.log(`  ↪ nom du wiki cité (${wikiTitles.join(', ')}) → @agent directement`);
    trace.path = 'agent';
    return askAgent(message, sessionId, onStatus, wikiTitles, trace);
  }
  const cards = (known.length || categories.length)
    ? `\n\nFiches de la base de connaissances :\n\n${[
      ...known.map((k) => `[${k.category}]\n${k.entry}`),
      ...categories,
    ].join('\n\n')}`
    : '';
  if (known.length || categories.length) {
    console.log(`  📇 fiche(s) jointe(s) : ${[...known.map((k) => k.name), ...categories.map((c) => c.split(' : ')[0])].join(', ')}`);
    trace.cards = known.map((k) => k.name);
  }

  // Meilleurs extraits pour la question seule, sans consigne (voir searchExtracts). Dans un fil, une
  // recherche par question : mises bout à bout, elles diluent la similarité (aucun extrait au seuil)
  const queries = [question, ...(thread?.questions ?? [])];
  const merged = new Map();
  for (const list of await Promise.all(queries.map(searchExtracts))) {
    for (const e of list) {
      const key = `${e.title}\n${e.text}`;
      if (!merged.has(key) || merged.get(key).score < e.score) merged.set(key, e);
    }
  }
  const found = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, MAX_EXTRACTS);
  const extracts = found.length
    ? `\n\nExtraits de la base de connaissances :\n\n${found.map((e) => `[${e.title}]\n${e.text}`).join('\n\n')}`
    : '';
  if (found.length) console.log(`  📄 extrait(s) joint(s) : ${found.map((e) => e.title).join(', ')}`);
  trace.extracts = found.map((e) => e.title); // diagnostic (interface de test)

  trace.path = 'documents';
  // Session neuve, comme pour l'agent : l'historique du salon contient des « même question → AUCUNE_INFO »
  // que le modèle recopie sans lire les documents (réponse en 5 s, sans réflexion)
  const answer = await askAnythingLLM(message + cards + extracts + QUERY_INSTRUCTION, `${sessionId}-query-${Date.now()}`,
    onStatus, { mode: 'query', agent: false });
  trace.queryAnswer = answer; // diagnostic : réponse du premier passage, même si l'agent prend le relais
  if (answer && !isQueryRefusal(answer)) return answer;

  console.log('  ↪ rien dans les documents → relance en @agent');
  onStatus?.('📚 Rien dans la base de connaissances, je cherche ailleurs…');
  trace.path = 'documents→agent';
  return askAgent(message, sessionId, onStatus, wikiTitles, trace);
}

// Passage par l'agent (skills personnalisées, recherche web).
// Session neuve à chaque appel : tout historique (AUCUNE_INFO, réponses précédentes) pousse
// sinon le modèle à recopier une ancienne réponse au lieu d'appeler ses outils.
// Pas « fais une recherche web » : l'agent doit pouvoir choisir une skill spécialisée (ex. PNJ du wiki)
// Indications de skill selon le sujet : sans elles, l'agent répondait à une énigme avec les annonces
// officielles (« pas d'énigme »), ou à une question de mécanique de mémoire, sans source
// Formulées comme des ordres avec un exemple de recherche : une simple suggestion était ignorée
// (sot-news choisi pour l'énigme, sa description citant « Community Weekend »)
const TOOL_HINTS = [
  [/(?<!\p{L})(tempêtes?|storm)(?!\p{L})/iu,
    'Cette question porte sur la tempête : appelle l\'outil sot-storm, qui donne sa position et son trajet prévu.'],
  [/(?<!\p{L})(énigmes?|riddles?|guides?|soluces?|solutions?|défis|challenges?|journaux|journals?)(?!\p{L})/iu,
    'Cette question porte sur une énigme, un guide ou un défi : appelle d\'abord l\'outil sot-guides avec une '
      + 'recherche en anglais (ex. « Community Weekend riddle », « Bilge Rats challenges »), pas sot-news.'],
  [/(?<!\p{L})(comment|fonctionne|marche|mécaniques?|peut-on|peux-on|est-ce qu'on peut|réparer)(?!\p{L})/iu,
    'Cette question porte sur le fonctionnement du jeu : appelle d\'abord l\'outil sot-wiki avec des mots-clés '
      + 'en anglais (ex. « repair ship hull », « gunpowder barrel »).'],
];
// Questions de comptage ou de liste : on y joint les fiches de catégorie du coffre
const COUNT_INTENT = /(?<!\p{L})(combien|nombre|liste|lister|quels sont|quelles sont|how many)(?!\p{L})/iu;
// Questions sur la tempête : fiche calculée par le bot (storm.js)
const STORM_INTENT = /(?<!\p{L})(tempêtes?|storm)(?!\p{L})/iu;

async function askAgent(message, sessionId, onStatus, wikiTitles = [], trace) {
  const hints = [
    ...(wikiTitles.length ? [`Pages du wiki probablement concernées : ${wikiTitles.join(', ')}.`] : []),
    // Une seule indication, la plus spécifique (ordre de TOOL_HINTS) : « comment résoudre l'énigme » → guides
    ...TOOL_HINTS.filter(([re]) => re.test(message)).slice(0, 1).map(([, h]) => h),
  ];
  // Sans réflexion, le modèle saute volontiers l'appel d'outil et répond de mémoire, parfois en prétendant
  // avoir cherché : on impose au moins un outil pour toute question sur le jeu
  const agentQuestion = `${message}\n\n(Consigne : pour une question sur Sea of Thieves, appelle toujours au moins `
    + 'un outil avant de répondre : une de tes compétences spécialisées si l\'une correspond, sinon web-browsing. '
    + `${hints.join(' ')}${hints.length ? ' ' : ''}Ne prétends jamais avoir fait une recherche que tu n'as pas faite. `
    // Sources non fiables : on accepte de répondre, mais en le disant
    + 'Si ta réponse vient d\'une recherche web générale, précise qu\'elle n\'est pas vérifiée à 100 % et cite la source. '
    + `${DISCORD_FORMAT})`;
  const ask = () => askAnythingLLM(agentQuestion, `${sessionId}-agent-${Date.now()}`, onStatus, { mode: 'chat', agent: true, trace });
  const answer = await ask();
  if (answer) return answer;
  // Réponse vide : le modèle a généré du texte qu'AnythingLLM n'a pas retenu comme réponse (vu après
  // un appel de skill renvoyant une longue annonce). Un second essai suffit en général.
  console.warn('  ↻ réponse vide de l\'agent → nouvel essai');
  onStatus?.('🔄 Je reformule ma réponse…');
  return ask();
}

// Pied de réponse (petit texte gris Discord « -# ») : durée, chemin suivi, outils de l'agent, fiches
const TOOL_NAMES = {
  'sot-wiki': 'wiki', 'sot-news': 'annonces officielles', 'sot-guides': 'guides Rare Thief',
  'sot-status': 'statut des serveurs', 'web-browsing': 'recherche web', 'web-scraping': 'page web',
  'rag-memory': 'documents', 'document-summarizer': 'documents', 'sot-wiki-npc': 'wiki (PNJ)',
  'sot-storm': 'tempête',
};
// Skill sans libellé : nom technique rendu lisible (« sot-wiki-ships » → « wiki ships »)
const toolName = (t) => TOOL_NAMES[t] ?? t.replace(/^sot-/, '').replace(/[-_]+/g, ' ');
const ROUTES = {
  documents: '📚 base de connaissances', agent: '🔎 agent', 'documents→agent': '📚→🔎 agent',
  storm: '🌩️ prévisions de la tempête (Merfolk\'s Lullaby)', 'storm→agent': '🌩️→🔎 agent',
};
function responseFooter(ms, trace) {
  const parts = [`⏱️ ${(ms / 1000).toFixed(1).replace('.', ',')} s`];
  const tools = [...new Set([...trace.tools].map(toolName))];
  const route = ROUTES[trace.path];
  if (route) parts.push(tools.length ? `${route} : ${tools.join(', ')}` : route);
  if (trace.cards?.length) parts.push(`📇 ${trace.cards.join(', ')}`);
  if (trace.thread) parts.push(`🧵 suite de la conversation`);
  // Agent sans source fiable : réponse de mémoire, ou seulement une recherche web générale
  if (trace.path?.includes('agent')) {
    const webOnly = [...trace.tools].every((t) => t === 'web-browsing' || t === 'web-scraping');
    if (!trace.tools.size) parts.push('⚠️ non vérifiée (sans source)');
    else if (webOnly) parts.push('⚠️ source web non vérifiée');
  }
  return `-# ${parts.join(' · ')}`;
}

// Traitement complet d'une question, commun à Discord et à l'interface HTTP de test :
// routage (fiches, extraits, query, agent), puis pied de réponse et objets à illustrer
async function answerQuestion(question, { sessionId, onStatus, thread = null }) {
  const started = Date.now();
  const trace = { tools: new Set(), cards: [], path: null };
  if (thread) console.log(`  🧵 suite d'un fil (${thread.exchanges} échange(s) précédent(s))`);
  const answer = await askWithRouting(question, sessionId, onStatus, trace, thread);
  const ms = Date.now() - started;
  return {
    answer, trace, ms,
    footer: responseFooter(ms, trace),
    items: findItemImages(answer || '', 4, { properNoun: true }),
  };
}

// --- Interface HTTP de test (désactivée sans TEST_API_TOKEN) ---
// POST /ask { question, history?: [{ question, answer }] } → même traitement qu'un message Discord,
// réponse en JSON. Permet de tester le bot sans passer par Discord. GET /health : état du bot.
function startTestApi() {
  if (!TEST_API_TOKEN) return;
  const expected = Buffer.from(`Bearer ${TEST_API_TOKEN}`);
  const authorized = (req) => {
    const got = Buffer.from(String(req.headers.authorization || ''));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  };

  createServer(async (req, res) => {
    try {
      if (!authorized(req)) return send(res, 401, { error: 'jeton manquant ou invalide' });
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, {
          ok: true, version: CODE_VERSION, startedAt: STARTED_AT, discord: client.isReady(), agentFallback, debug: DEBUG,
        });
      }
      if (req.method !== 'POST' || req.url !== '/ask') return send(res, 404, { error: 'route inconnue' });

      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 100_000) return send(res, 413, { error: 'requête trop volumineuse' });
      }
      const { question, history = [] } = JSON.parse(raw || '{}');
      if (!question || typeof question !== 'string') return send(res, 400, { error: 'champ "question" requis' });

      // Fil simulé : [{ question, answer }, …] du plus ancien au plus récent, comme des « Répondre » successifs
      const previous = history.reduce((parent, h) => ({ question: h.question ?? '', answer: h.answer ?? '', parent }), null);
      const statuses = [];
      console.log(`🧪 test HTTP | q="${question.slice(0, 80)}"`);
      const { answer, trace, ms, footer, items } = await answerQuestion(question, {
        sessionId: 'http-test', onStatus: (s) => statuses.push(s), thread: previous ? threadContext(previous) : null,
      });
      return send(res, 200, {
        answer, footer, ms,
        path: trace.path, tools: [...trace.tools], cards: trace.cards, thread: trace.thread ?? 0,
        statuses, images: items.map(({ name, nameEn, category }) => ({ name, nameEn, category })),
        // Diagnostic : extraits joints au premier passage et sa réponse (ex. AUCUNE_INFO avant relais)
        extracts: trace.extracts ?? [], queryAnswer: trace.queryAnswer ?? null,
      });
    } catch (err) {
      console.error('Erreur test HTTP:', err);
      return send(res, 500, { error: err.message });
    }
  }).listen(TEST_API_PORT, () => console.log(`🧪 Interface de test HTTP active sur le port ${TEST_API_PORT}`));
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
  console.log(`✅ Connecté en tant que ${c.user.tag} (version ${CODE_VERSION})`);
  console.log(
    `   Workspace: ${ANYTHINGLLM_WORKSPACE} | Mode: ${agentFallback ? 'query → @agent' : ANYTHINGLLM_MODE}${agentEnabled ? ' | Agent: on' : ''}`,
  );
  if (allowedChannels.size) {
    console.log(`   Salons en écoute totale: ${[...allowedChannels].join(', ')}`);
  }
  startDocSync();
  startTestApi();
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore ses propres messages et ceux des autres bots
  if (message.author.bot) return;

  const isDM = message.channel.isDMBased();
  const isMentioned = message.mentions.users.has(client.user.id);
  const isAllowedChannel = allowedChannels.has(message.channel.id);
  // « Répondre » à Sotia sans la mentionner (mention désactivée dans la réponse) : c'est aussi pour elle
  const refId = message.reference?.messageId;
  const isReplyToBot = Boolean(refId) && (threadMemory.has(refId) || message.mentions.repliedUser?.id === client.user.id);

  // Ne répond qu'en DM, sur mention, en réponse à l'un de ses messages, ou dans un salon en écoute totale
  if (!isDM && !isMentioned && !isReplyToBot && !isAllowedChannel) return;

  // Retire la mention du bot du texte avant d'envoyer la question
  const question = stripMention(message.content);

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
    // « Répondre » à un message de Sotia : on continue ce fil ; sinon nouvelle conversation
    const previous = await loadThread(message);
    const thread = previous ? threadContext(previous) : null;
    const { answer, footer, items } = await withTyping(message.channel, () =>
      answerQuestion(question, { sessionId, onStatus: showStatus, thread }),
    );

    // La réponse est prête : on retire le message de statut éphémère
    if (statusMsg) await statusMsg.delete().catch(() => {});

    const chunks = splitMessage((answer || '_(réponse vide)_') + (showFooter ? `\n\n${footer}` : ''));
    // Images des objets du coffre et emblèmes cités, jointes au dernier morceau (nom anglais en rappel)
    const embeds = items.map((item) =>
      new EmbedBuilder().setTitle(item.name)
        .setDescription(item.nameEn ? `${item.category}\nEN : ${item.nameEn}` : item.category)
        .setThumbnail(item.image));
    const withEmbeds = (content, i) => (i === chunks.length - 1 && embeds.length ? { content, embeds } : content);
    // Premier morceau en réponse, le reste à la suite
    const sent = [await message.reply(withEmbeds(chunks[0], 0))];
    for (const [i, chunk] of chunks.entries()) if (i > 0) sent.push(await message.channel.send(withEmbeds(chunk, i)));
    // Chaque morceau envoyé permet de « Répondre » pour continuer ce fil
    if (answer) rememberExchange(sent.map((m) => m.id), { question, answer, parent: previous });
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

// Connexion initiale impossible (ex. gateway Discord en 503) : on quitte pour que Docker
// (restart: unless-stopped) relance le conteneur, au lieu de rester allumé sans être connecté.
// Une fois connecté, discord.js gère seul les reconnexions.
client.login(DISCORD_TOKEN).catch((err) => {
  console.error('❌ Connexion à Discord impossible, arrêt pour redémarrage:', err.message);
  process.exit(1);
});
