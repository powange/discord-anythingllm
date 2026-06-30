import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';

// --- Configuration depuis l'environnement ---
const {
  DISCORD_TOKEN,
  ANYTHINGLLM_URL,
  ANYTHINGLLM_API_KEY,
  ANYTHINGLLM_WORKSPACE,
  ANYTHINGLLM_MODE = 'chat',
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

const DISCORD_LIMIT = 2000; // limite de caractères par message Discord

// --- Intégration AnythingLLM ---
// Interroge le workspace et renvoie la réponse texte
async function askAnythingLLM(message, sessionId) {
  const url = `${ANYTHINGLLM_URL}/api/v1/workspace/${ANYTHINGLLM_WORKSPACE}/chat`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ANYTHINGLLM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, mode: ANYTHINGLLM_MODE, sessionId }),
  });

  // Erreur HTTP (auth, workspace inexistant, serveur down…)
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim());
  }

  const data = await res.json();
  // AnythingLLM peut renvoyer une erreur applicative dans le corps
  if (data.error) throw new Error(String(data.error));
  return (data.textResponse ?? '').trim();
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
  console.log(`   Workspace: ${ANYTHINGLLM_WORKSPACE} | Mode: ${ANYTHINGLLM_MODE}`);
  if (allowedChannels.size) {
    console.log(`   Salons en écoute totale: ${[...allowedChannels].join(', ')}`);
  }
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

  try {
    const answer = await withTyping(message.channel, () => askAnythingLLM(question, sessionId));
    const chunks = splitMessage(answer || '_(réponse vide)_');

    // Premier morceau en réponse, le reste à la suite
    await message.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) await message.channel.send(chunk);
  } catch (err) {
    console.error('Erreur AnythingLLM:', err);
    await message
      .reply('⚠️ Une erreur est survenue en interrogeant la base de connaissances.')
      .catch(() => {});
  }
});

// Filets de sécurité : on log sans faire crasher le process
process.on('unhandledRejection', (err) => console.error('Rejet non géré:', err));

client.login(DISCORD_TOKEN);
