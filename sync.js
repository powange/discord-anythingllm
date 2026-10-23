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
const RECHECK_LATEST = 3; // versions les plus récentes revérifiées à chaque tour (notes parfois corrigées)
const lastHashes = new Map(); // docSource → empreinte du dernier contenu envoyé

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

// Appel à l'API source : Markdown (texte) ou JSON
async function api(path, { md = true } = {}) {
  const res = await fetch(`${SOT_API_URL}/${path}${md ? '?format=md' : ''}`, {
    headers: { Authorization: `Bearer ${SOT_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`API ${path}: HTTP ${res.status}`);
  if (!md) return res.json();
  const text = (await res.text()).trim();
  if (!text) throw new Error(`API ${path}: réponse vide`);
  return text;
}

// Documents du workspace : { docpath, docSource, hash } (hash lu dans la description).
// On identifie par docSource : AnythingLLM le conserve tel quel, alors qu'il réécrit le titre.
async function workspaceDocs() {
  const { workspace } = await llm('GET', `/workspace/${ANYTHINGLLM_WORKSPACE}`);
  const ws = Array.isArray(workspace) ? workspace[0] : workspace;
  return (ws?.documents ?? []).flatMap((doc) => {
    let meta;
    try { meta = JSON.parse(doc.metadata || '{}'); } catch { return []; }
    const hash = String(meta.description || '').match(/^sha256:([0-9a-f]{64})$/)?.[1] ?? null;
    return [{ docpath: doc.docpath, docSource: meta.docSource, hash }];
  });
}

// Retire des documents du workspace puis du stockage (My Documents)
async function removeDocs(docpaths) {
  await llm('POST', `/workspace/${ANYTHINGLLM_WORKSPACE}/update-embeddings`, { adds: [], deletes: docpaths });
  await llm('DELETE', '/system/remove-documents', { names: docpaths }).catch(() => {});
}

// Crée ou remplace le document d'une source. Renvoie 'inchangé' ou 'mis à jour'.
async function upsertDoc(docs, { docSource, title, text, label }) {
  const hash = createHash('sha256').update(text).digest('hex');
  if (lastHashes.get(docSource) === hash) return 'inchangé';

  const existing = docs.filter((doc) => doc.docSource === docSource);
  // Après un redémarrage, l'empreinte stockée dans AnythingLLM évite de tout ré-embedder.
  // Si une version à jour existe déjà, on la garde et on retire seulement les doublons.
  const current = existing.find((doc) => doc.hash === hash);
  if (current) {
    const extras = existing.filter((doc) => doc !== current).map((doc) => doc.docpath);
    if (extras.length) {
      await removeDocs(extras);
      console.log(`📚 sync ${label}: ${extras.length} doublon(s) retiré(s)`);
    }
    lastHashes.set(docSource, hash);
    return 'inchangé';
  }
  const olds = existing.map((doc) => doc.docpath);
  console.log(`📚 sync ${label}: indexation dans AnythingLLM (${text.length} car.)…`);

  // Nouveau document d'abord, puis échange dans le workspace : pas de trou entre les deux versions
  const { documents } = await llm('POST', '/document/raw-text', {
    textContent: text,
    metadata: { title, docSource, description: `sha256:${hash}` },
  });
  const location = documents?.[0]?.location;
  if (!location) throw new Error(`raw-text ${label}: pas d'emplacement renvoyé`);

  await llm('POST', `/workspace/${ANYTHINGLLM_WORKSPACE}/update-embeddings`, { adds: [location], deletes: olds });
  // Supprime aussi les anciennes versions du stockage (My Documents)
  if (olds.length) await llm('DELETE', '/system/remove-documents', { names: olds }).catch(() => {});

  lastHashes.set(docSource, hash);
  return 'mis à jour';
}

// Endpoint simple : un seul document
async function syncEndpoint(docs, endpoint) {
  const text = await api(endpoint);
  const result = await upsertDoc(docs, {
    docSource: `${SOT_API_URL}/${endpoint}`, title: `${DOC_PREFIX}${endpoint}`, text, label: endpoint,
  });
  return `${result} (${text.length} car.)`;
}

// Notes de version : un document « historique » + un document par version.
// Un seul gros document noie les questions du type « dernière version » dans des milliers d'extraits.
async function syncReleaseNotes(docs) {
  const { releaseNotes = [] } = await api('release-notes', { md: false }); // triées, la plus récente d'abord
  if (!releaseNotes.length) throw new Error('API release-notes: aucune version');
  const label = (note) => note.display_version || note.version;

  const [latest] = releaseNotes;
  const history = [
    '# Historique des versions de Sea of Thieves',
    '',
    `La dernière version (mise à jour la plus récente) de Sea of Thieves est la ${label(latest)}, sortie le ${latest.date}.`,
    '',
    'Toutes les versions, de la plus récente à la plus ancienne :',
    '',
    ...releaseNotes.map((note) => `- Version ${label(note)} : sortie le ${note.date}`),
  ].join('\n');
  // Même source que l'ancien document unique : il est remplacé automatiquement
  await upsertDoc(docs, {
    docSource: `${SOT_API_URL}/release-notes`, title: `${DOC_PREFIX}historique des versions`,
    text: history, label: 'release-notes (historique)',
  });

  const present = new Set(docs.map((doc) => doc.docSource));
  const counts = { 'mis à jour': 0, inchangé: 0 };
  for (const [i, note] of releaseNotes.entries()) {
    const docSource = `${SOT_API_URL}/release-notes/${note.version}`;
    // Les anciennes versions déjà présentes ne changent plus : inutile de les retélécharger
    if (present.has(docSource) && i >= RECHECK_LATEST) { counts.inchangé += 1; continue; }
    try {
      const text = await api(`release-notes/${encodeURIComponent(note.version)}`);
      counts[await upsertDoc(docs, {
        docSource, title: `Sea of Thieves — notes de version ${label(note)} (${note.date})`,
        text, label: `release-notes ${label(note)}`,
      })] += 1;
    } catch (err) {
      console.error(`📚 sync release-notes ${label(note)} en échec:`, err.message);
    }
  }
  return `${releaseNotes.length} versions, dernière ${label(latest)} (${latest.date}) — `
    + `${counts['mis à jour']} indexée(s), ${counts.inchangé} inchangée(s)`;
}

async function syncAll(endpoints) {
  console.log(`📚 Synchronisation démarrée (${new Date().toLocaleString('fr-FR')})`);
  let docs;
  try {
    docs = await workspaceDocs();
  } catch (err) {
    console.error('📚 lecture du workspace en échec:', err.message);
    return;
  }
  for (const endpoint of endpoints) {
    console.log(`📚 sync ${endpoint}: récupération…`);
    try {
      const result = endpoint === 'release-notes' ? await syncReleaseNotes(docs) : await syncEndpoint(docs, endpoint);
      console.log(`📚 sync ${endpoint}: ${result}`);
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
