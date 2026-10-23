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

const DOC_PREFIX = 'SoT API — '; // préfixe des titres (AnythingLLM le transforme en nom de fichier)
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

// Documents du workspace issus de cette source : { docpath, hash } (hash lu dans la description).
// On identifie par docSource : AnythingLLM le conserve tel quel, alors qu'il réécrit le titre.
async function findDocs(docSource) {
  const { workspace } = await llm('GET', `/workspace/${ANYTHINGLLM_WORKSPACE}`);
  const ws = Array.isArray(workspace) ? workspace[0] : workspace;
  return (ws?.documents ?? []).flatMap((doc) => {
    let meta;
    try { meta = JSON.parse(doc.metadata || '{}'); } catch { return []; }
    if (meta.docSource !== docSource) return [];
    const hash = String(meta.description || '').match(/^sha256:([0-9a-f]{64})$/)?.[1] ?? null;
    return [{ docpath: doc.docpath, hash }];
  });
}

// Retire des documents du workspace puis du stockage (My Documents)
async function removeDocs(docpaths) {
  await llm('POST', `/workspace/${ANYTHINGLLM_WORKSPACE}/update-embeddings`, { adds: [], deletes: docpaths });
  await llm('DELETE', '/system/remove-documents', { names: docpaths }).catch(() => {});
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
  const docSource = `${SOT_API_URL}/${endpoint}`;
  const existing = await findDocs(docSource);

  // Après un redémarrage, l'empreinte stockée dans AnythingLLM évite de tout ré-embedder.
  // Si une version à jour existe déjà, on la garde et on retire seulement les doublons.
  const current = existing.find((doc) => doc.hash === hash);
  if (current) {
    const extras = existing.filter((doc) => doc !== current).map((doc) => doc.docpath);
    if (extras.length) await removeDocs(extras);
    lastHashes.set(endpoint, hash);
    return `inchangé (déjà dans le workspace${extras.length ? `, ${extras.length} doublon(s) retiré(s)` : ''})`;
  }
  const olds = existing.map((doc) => doc.docpath);
  console.log(`📚 sync ${endpoint}: indexation dans AnythingLLM (${text.length} car.)…`);

  // Nouveau document d'abord, puis échange dans le workspace : pas de trou entre les deux versions
  const { documents } = await llm('POST', '/document/raw-text', {
    textContent: text,
    metadata: { title, docSource, description: `sha256:${hash}` },
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
  console.log(`📚 Synchronisation démarrée (${new Date().toLocaleString('fr-FR')})`);
  for (const endpoint of endpoints) {
    console.log(`📚 sync ${endpoint}: récupération…`);
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
  if (!SOT_API_TOKEN) {
    console.log('📚 Synchro API désactivée (SOT_API_TOKEN vide)');
    return;
  }
  const endpoints = SOT_API_ENDPOINTS.split(',').map((e) => e.trim()).filter(Boolean);
  // Plafond à 24 jours : au-delà, setInterval déborde (32 bits) et tourne en boucle
  const hours = Math.min(Number(SOT_SYNC_INTERVAL_HOURS) || 6, 24 * 24);
  console.log(`📚 Synchro API → workspace: ${endpoints.join(', ')} toutes les ${hours} h`);
  syncAll(endpoints);
  setInterval(() => syncAll(endpoints), hours * 3600 * 1000);
}
