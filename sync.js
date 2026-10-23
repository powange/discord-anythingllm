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

  // Sommaire de la dernière version, présenté comme tel. Il doit rester compact : AnythingLLM
  // découpe en extraits d'~1000 car., et seuls ceux qui portent l'en-tête « dernière mise à jour »
  // sont retrouvés par « contenu de la dernière version ? ». Le détail reste dans le document de la version.
  const latestNotes = await api(`release-notes/${encodeURIComponent(latest.version)}`);
  const themes = []; // "### Thème" → ["#### Sous-thème", …]
  for (const line of latestNotes.split('\n')) {
    if (line.startsWith('### ')) themes.push({ name: line.slice(4).trim(), items: [] });
    else if (line.startsWith('#### ') && themes.length) themes.at(-1).items.push(line.slice(5).trim());
  }
  // Le détail des correctifs n'aide pas à résumer la version et ferait déborder l'extrait
  for (const t of themes) if (/fixed issues/i.test(t.name)) t.items = [];
  await upsertDoc(docs, {
    docSource: `${SOT_API_URL}/release-notes/latest`,
    title: `Dernière mise à jour de Sea of Thieves — ${label(latest)} (${latest.date})`,
    text: [
      `# Dernière mise à jour de Sea of Thieves : version ${label(latest)}, sortie le ${latest.date}`,
      '',
      `Contenu de la dernière mise à jour (la plus récente, version ${label(latest)}), par thème :`,
      ...themes.map((t) => `- ${t.name}${t.items.length ? ` : ${t.items.join(' ; ')}` : ''}`),
      '',
      `Le détail de chaque point se trouve dans les notes de version ${label(latest)}.`,
    ].join('\n'),
    label: 'release-notes (dernière)',
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

// Libellés français des catégories du coffre (clés de l'API)
const CHEST_CATEGORIES = {
  Ship: 'Navire',
  Vanity: 'Apparence (titres, emotes, coiffures, accessoires, tatouages…)',
  Clothing: 'Vêtements',
  Equipment: 'Équipement (instruments, chope, boussole, longue-vue, pelle…)',
  Armory: 'Armurerie (armes)',
  ShipTrinket: 'Bibelots de navire',
  ShipDecoration: 'Décorations de navire',
  Bones: 'Corps squelettiques',
  Pets: 'Animaux de compagnie',
};

// Images des objets du coffre : nom en minuscules → { name, image, category }.
// Les URL restent hors des documents (bruit pour l'indexation, mal recopiées par le modèle) :
// c'est le bot qui joint les images des objets cités dans une réponse.
let itemImages = new Map();
const MIN_NAME_LENGTH = 8; // évite les faux positifs sur des noms trop courts

// Objets du coffre cités dans un texte, dans leur ordre d'apparition (max `limit`)
export function findItemImages(text, limit = 4) {
  const lower = text.toLowerCase();
  const matches = [];
  for (const [name, item] of itemImages) {
    // Toutes les occurrences : la première peut être incluse dans un nom plus long
    for (let start = lower.indexOf(name); start !== -1; start = lower.indexOf(name, start + 1)) {
      matches.push({ ...item, start, end: start + name.length });
    }
  }
  // Le nom le plus long l'emporte : « Barre amirale rituelle » plutôt que « Barre amirale »
  matches.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const m of matches) {
    if (!kept.some((k) => (m.start < k.end && k.start < m.end) || k.image === m.image)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start).slice(0, limit);
}

// Catalogue du coffre : un document par sous-catégorie, avec une introduction qui dit ce qu'est
// le « coffre » (sinon le modèle comprend « coffres au trésor »). Images et identifiants retirés.
async function syncChestItems(docs) {
  const md = await api('chest-items');
  const sections = new Map(); // "Catégorie/Sous-catégorie" → lignes d'objets
  const images = new Map();
  let category = null;
  let key = null;
  let itemName = null;
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) { category = line.slice(3).trim(); key = null; continue; }
    if (line.startsWith('### ') && category) {
      key = `${category}/${line.slice(4).trim()}`;
      sections.set(key, []);
      continue;
    }
    if (!key || !line.trim()) continue;
    const image = line.match(/^\s*- Image : (\S+)/)?.[1];
    if (image) {
      const id = itemName?.toLowerCase();
      if (id && id.length >= MIN_NAME_LENGTH && !images.has(id)) {
        images.set(id, { name: itemName, image, category: `${CHEST_CATEGORIES[category] ?? category} › ${key.split('/')[1]}` });
      }
      continue;
    }
    itemName = line.match(/^- \*\*(.+?)\*\*/)?.[1] ?? itemName;
    sections.get(key).push(line.replace(/ \(`[^`]+`\)/, ''));
  }
  if (images.size) itemImages = images;
  if (!sections.size) throw new Error('API chest-items: aucune section reconnue (format Markdown modifié ?)');

  const base = `${SOT_API_URL}/chest-items`;
  const counts = { 'mis à jour': 0, inchangé: 0 };
  for (const [section, lines] of sections) {
    const [cat, sub] = section.split('/');
    const catLabel = CHEST_CATEGORIES[cat] ?? cat;
    const items = lines.filter((l) => l.startsWith('- ')).length;
    const text = [
      `# Coffre du pirate de Sea of Thieves — ${catLabel} › ${sub}`,
      '',
      'Le « coffre » (coffre du pirate) regroupe les objets cosmétiques et d\'équipement que l\'on peut '
        + 'acheter ou débloquer dans Sea of Thieves. Ce ne sont pas des coffres au trésor. '
        + `Ce document liste les ${items} objets de la catégorie ${catLabel} (${cat}), sous-catégorie ${sub}, `
        + 'avec leur description, leur coût et leurs prérequis.',
      '',
      ...lines,
    ].join('\n');
    try {
      counts[await upsertDoc(docs, {
        docSource: `${base}/${section}`, title: `Coffre du pirate — ${catLabel} › ${sub}`,
        text, label: `chest-items ${section}`,
      })] += 1;
    } catch (err) {
      console.error(`📚 sync chest-items ${section} en échec:`, err.message);
    }
  }

  // Ancien document unique et sous-catégories disparues de l'API
  const current = new Set([...sections.keys()].map((s) => `${base}/${s}`));
  const stale = docs
    .filter((doc) => doc.docSource === base || (doc.docSource?.startsWith(`${base}/`) && !current.has(doc.docSource)))
    .map((doc) => doc.docpath);
  if (stale.length) await removeDocs(stale);

  return `${sections.size} sous-catégories — ${counts['mis à jour']} indexée(s), ${counts.inchangé} inchangée(s)`
    + (stale.length ? `, ${stale.length} ancien(s) document(s) retiré(s)` : '');
}

// Endpoints découpés en plusieurs documents ; les autres donnent un seul document
const SPLIT_SYNCS = { 'release-notes': syncReleaseNotes, 'chest-items': syncChestItems };

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
      const result = SPLIT_SYNCS[endpoint] ? await SPLIT_SYNCS[endpoint](docs) : await syncEndpoint(docs, endpoint);
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
