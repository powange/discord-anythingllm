// --- Synchronisation d'une API externe vers la base de connaissances AnythingLLM ---
// Récupère des endpoints (en Markdown) et les remplace comme documents du workspace,
// pour que le mode query les trouve. Rien n'est relancé si le contenu n'a pas changé.
import { createHash } from 'node:crypto';

const {
  ANYTHINGLLM_URL,
  ANYTHINGLLM_API_KEY,
  ANYTHINGLLM_WORKSPACE,
  SOT_API_URL = 'https://achievements-sot.powange.com/api/agent',
  SOT_API_TOKEN,
  SOT_API_ENDPOINTS = 'release-notes,chest-items',
  SOT_SYNC_INTERVAL_HOURS = '6',
} = process.env;

const DOC_PREFIX = 'SoT API — '; // préfixe des titres : identifie nos documents dans le workspace
const lastHashes = new Map(); // endpoint → empreinte du dernier contenu envoyé

// Appel à la Developer API d'AnythingLLM
async function llm(method, path, body) {
  const res = await fetch(`${ANYTHINGLLM_URL}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`AnythingLLM ${method} ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res.json().catch(() => ({}));
}

// Chemins (docpath) des documents du workspace portant ce titre
async function findDocpaths(title) {
  const { workspace } = await llm('GET', `/workspace/${ANYTHINGLLM_WORKSPACE}`);
  const ws = Array.isArray(workspace) ? workspace[0] : workspace;
  return (ws?.documents ?? [])
    .filter((doc) => {
      try { return JSON.parse(doc.metadata || '{}').title === title; } catch { return false; }
    })
    .map((doc) => doc.docpath);
}

async function syncEndpoint(endpoint) {
  const res = await fetch(`${SOT_API_URL}/${endpoint}?format=md`, {
    headers: { Authorization: `Bearer ${SOT_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`API ${endpoint}: HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (!text) throw new Error(`API ${endpoint}: réponse vide`);

  const hash = createHash('sha256').update(text).digest('hex');
  if (lastHashes.get(endpoint) === hash) return 'inchangé';

  const title = `${DOC_PREFIX}${endpoint}`;
  const olds = await findDocpaths(title);

  // Nouveau document d'abord, puis échange dans le workspace : pas de trou entre les deux versions
  const { documents } = await llm('POST', '/document/raw-text', {
    textContent: text,
    metadata: { title, docSource: `${SOT_API_URL}/${endpoint}` },
  });
  const location = documents?.[0]?.location;
  if (!location) throw new Error(`raw-text ${endpoint}: pas d'emplacement renvoyé`);

  await llm('POST', `/workspace/${ANYTHINGLLM_WORKSPACE}/update-embeddings`, { adds: [location], deletes: olds });
  // Supprime aussi les anciennes versions du stockage (My Documents)
  if (olds.length) await llm('DELETE', '/system/remove-documents', { names: olds }).catch(() => {});

  lastHashes.set(endpoint, hash);
  return `mis à jour (${text.length} car., ${olds.length} ancienne(s) version(s) retirée(s))`;
}

async function syncAll(endpoints) {
  for (const endpoint of endpoints) {
    try {
      console.log(`📚 sync ${endpoint}: ${await syncEndpoint(endpoint)}`);
    } catch (err) {
      // Une source en échec ne bloque pas les autres ; on réessaiera au prochain tour
      console.error(`📚 sync ${endpoint} en échec:`, err.message);
    }
  }
}

// Lance une synchronisation immédiate puis périodique (désactivée sans SOT_API_TOKEN)
export function startDocSync() {
  if (!SOT_API_TOKEN) return;
  const endpoints = SOT_API_ENDPOINTS.split(',').map((e) => e.trim()).filter(Boolean);
  const hours = Number(SOT_SYNC_INTERVAL_HOURS) || 6;
  console.log(`📚 Synchro API → workspace: ${endpoints.join(', ')} toutes les ${hours} h`);
  syncAll(endpoints);
  setInterval(() => syncAll(endpoints), hours * 3600 * 1000);
}
