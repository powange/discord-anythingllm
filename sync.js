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
  SOT_API_ENDPOINTS = 'wiki-names,release-notes,chest-items,recommendations,steam-news,rarethief-guides',
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
  // AnythingLLM traite tout ce qui suit le dernier point du titre comme une extension et le retire :
  // « … version 3.9.1 (…) » et « … version 3.9.0 (…) » deviendraient tous deux « …-3-9.txt ».
  // Un « .txt » final lui sert d'extension et le titre reste intact (« …-3-9-1-(…).txt »).
  const dotted = title.includes('.');
  const fileTitle = dotted ? `${title}.txt` : title;
  // Le titre entre dans l'empreinte des seuls titres à point : ces documents sont renvoyés une fois
  // avec le titre corrigé, sans réindexer tous les autres
  const hash = createHash('sha256').update(dotted ? `${fileTitle}\n${text}` : text).digest('hex');
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
    metadata: { title: fileTitle, docSource, description: `sha256:${hash}` },
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

// Images par source (coffre, emblèmes) : nom en minuscules → { name, image, category }.
// Les URL restent hors des documents (bruit pour l'indexation, mal recopiées par le modèle) :
// c'est le bot qui joint les images des objets et emblèmes cités dans une réponse.
const imageSets = new Map();
const MIN_NAME_LENGTH = 8; // évite les faux positifs sur des noms trop courts

// Clé de recherche d'un nom : minuscules, apostrophe typographique ramenée à ' (même longueur)
const nameKey = (s) => s.toLowerCase().replace(/’/g, "'");

// Retire des lignes Markdown les URL d'image et identifiants techniques, en notant au passage
// la fiche de chaque élément (« - **Nom FR** / *Nom EN* … » et ses sous-lignes) : son image et son
// texte, retrouvables par le nom français comme par le nom anglais (absent pour certains objets)
function stripImages(lines, images, category) {
  const kept = [];
  let entry = null;
  const flush = () => {
    if (!entry?.image) return;
    const item = { name: entry.name, nameEn: entry.nameEn, image: entry.image, category, entry: entry.lines.join('\n') };
    for (const n of [entry.name, entry.nameEn]) {
      const id = n && nameKey(n);
      if (id && id.length >= MIN_NAME_LENGTH && !images.has(id)) images.set(id, item);
    }
  };
  for (const line of lines) {
    const m = line.match(/^- \*\*(.+?)\*\*(?: \/ \*(.+?)\*)?/);
    if (m) { flush(); entry = { name: m[1], nameEn: m[2] ?? null, image: null, lines: [] }; }
    const image = line.match(/^\s*- Image : (\S+)/)?.[1];
    if (image) {
      if (entry) entry.image = image;
      continue;
    }
    const clean = line.replace(/ \(`[^`]+`\)/, '');
    kept.push(clean);
    entry?.lines.push(clean);
  }
  flush();
  return kept;
}

// Retire les documents d'une source qui ne sont plus produits (ancien document unique, sections disparues)
async function removeStale(docs, base, currentSources) {
  const stale = docs
    .filter((doc) => doc.docSource === base || (doc.docSource?.startsWith(`${base}/`) && !currentSources.has(doc.docSource)))
    .map((doc) => doc.docpath);
  if (stale.length) await removeDocs(stale);
  return stale.length ? `, ${stale.length} ancien(s) document(s) retiré(s)` : '';
}

// Objets et emblèmes cités dans un texte, dans leur ordre d'apparition (max `limit`) :
// { name, image, category, entry } — sert aux images des réponses et aux fiches jointes aux questions.
// properNoun : n'accepter que les noms écrits avec une majuscule, comme un nom propre (réponses du
// modèle) — sinon « pour une surprise explosive » déclenche l'emblème « Surprise explosive ».
export function findItemImages(text, limit = 4, { properNoun = false } = {}) {
  const lower = nameKey(text);
  const matches = [];
  for (const [name, item] of [...imageSets.values()].flatMap((set) => [...set])) {
    // Toutes les occurrences : la première peut être incluse dans un nom plus long
    for (let start = lower.indexOf(name); start !== -1; start = lower.indexOf(name, start + 1)) {
      const first = text[start];
      if (properNoun && first === first.toLowerCase()) continue;
      matches.push({ ...item, start, end: start + name.length });
    }
  }
  // Le nom le plus long l'emporte : « Barre amirale rituelle » plutôt que « Barre amirale ».
  // Un doublon d'image (même objet cité en FR puis en EN) n'est pas gardé, mais son passage reste
  // occupé : sinon « Ceremonial Admiral Wheel » laisserait passer « Admiral Wheel », un autre objet.
  matches.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const kept = [];
  const occupied = [];
  for (const m of matches) {
    if (occupied.some((o) => m.start < o.end && o.start < m.end)) continue;
    occupied.push(m);
    if (!kept.some((k) => k.image === m.image)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start).slice(0, limit);
}

// Fiches de catégorie du coffre : libellé (minuscules) → ligne du sommaire avec les nombres d'objets
let categoryCards = new Map();
// Synonymes courants absents des libellés de l'API (clé de catégorie → mots des joueurs)
const CATEGORY_ALIASES = { Pets: ['animaux de compagnie', 'animal de compagnie', 'animaux'] };

// Catégories du coffre citées dans un texte (mot entier, singulier ou pluriel) : lignes du sommaire
export function findCategoryCards(text, limit = 3) {
  const lower = nameKey(text);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = [];
  for (const [key, line] of categoryCards) {
    const singular = key.replace(/[sx]$/, '');
    if (new RegExp(`(?<![\\p{L}\\d])${escape(singular)}[sx]?(?![\\p{L}\\d])`, 'u').test(lower) && !lines.includes(line)) {
      lines.push(line);
    }
  }
  return lines.slice(0, limit);
}

// Catalogue du coffre : un document par sous-catégorie, avec une introduction qui dit ce qu'est
// le « coffre » (sinon le modèle comprend « coffres au trésor »). Images et identifiants retirés.
async function syncChestItems(docs) {
  // Sommaire JSON (catégories, sous-catégories, libellés FR/EN), puis une sous-catégorie par appel
  const { count, categories = [] } = await api('chest-items', { md: false });
  if (!categories.length) throw new Error('API chest-items: aucune catégorie');

  const base = `${SOT_API_URL}/chest-items`;
  // Sommaire : catégories et sous-catégories avec leur nombre d'objets, pour les questions
  // « combien de… » (sans lui, le modèle comptait les pages d'une catégorie du wiki : faux)
  const label = (x) => `${x.label?.fr ?? x.key}${x.label?.en && x.label.en !== x.label?.fr ? ` / ${x.label.en}` : ''}`;
  await upsertDoc(docs, {
    docSource: base, title: `${DOC_PREFIX}coffre du pirate, catégories et nombre d'objets`, label: 'chest-items (sommaire)',
    text: [
      '# Coffre du pirate de Sea of Thieves : catégories et nombre d\'objets',
      '',
      `Le coffre du pirate (« Pirate's Chest ») contient ${count} objets cosmétiques et d'équipement, répartis par `
        + 'catégorie et sous-catégorie (nombre d\'objets entre parenthèses) :',
      '',
      ...categories.map((c) => `- ${label(c)} : ${c.count} objets (${(c.subcategories ?? [])
        .map((s) => `${label(s)} ${s.count}`).join(' ; ')})`),
    ].join('\n'),
  });

  // Fiches de catégorie (comptages), retrouvées par libellé FR/EN : la recherche vectorielle ne relie pas
  // « animaux de compagnie » à la catégorie « Familiers / Pets »
  const cards = new Map();
  const addCard = (name, line) => {
    const key = name && nameKey(String(name).trim());
    if (key && key.length >= 4 && key !== 'null' && !cards.has(key)) cards.set(key, line);
  };
  for (const c of categories) {
    const catLine = `Coffre du pirate — ${label(c)} : ${c.count} objets (${(c.subcategories ?? [])
      .filter((s) => s.label?.fr || s.label?.en).map((s) => `${label(s)} ${s.count}`).join(' ; ')})`;
    addCard(c.label?.fr, catLine);
    addCard(c.label?.en, catLine);
    for (const alias of CATEGORY_ALIASES[c.key] ?? []) addCard(alias, catLine);
    for (const s of c.subcategories ?? []) {
      const subLine = `Coffre du pirate — ${label(c)} › ${label(s)} : ${s.count} objets`;
      addCard(s.label?.fr, subLine);
      addCard(s.label?.en, subLine);
    }
  }
  if (cards.size) categoryCards = cards;

  const images = new Map();
  const sources = new Set();
  const counts = { 'mis à jour': 0, inchangé: 0 };
  for (const cat of categories) {
    for (const sub of cat.subcategories ?? []) {
      const section = `${cat.key}/${sub.key}`;
      const docSource = `${base}/${section}`;
      sources.add(docSource);
      const where = `${cat.label?.fr ?? cat.key} › ${sub.label?.fr ?? sub.key}`;
      const whereEn = `${cat.label?.en ?? cat.key} › ${sub.label?.en ?? sub.key}`;
      try {
        const md = await api(`chest-items/${encodeURIComponent(cat.key)}/${encodeURIComponent(sub.key)}`);
        // On saute les titres de l'API : l'introduction les remplace
        const lines = stripImages(md.split('\n').filter((l) => l.trim() && !l.startsWith('#')), images, where);
        const items = lines.filter((l) => l.startsWith('- ')).length;
        const text = [
          `# Coffre du pirate de Sea of Thieves — ${where} (${whereEn})`,
          '',
          'Le « coffre » (coffre du pirate, « Pirate\'s Chest ») regroupe les objets cosmétiques et d\'équipement '
            + 'que l\'on peut acheter ou débloquer dans Sea of Thieves. Ce ne sont pas des coffres au trésor. '
            + `Ce document liste les ${items} objets de la catégorie ${where}, avec leur nom français et anglais, `
            + 'leur description, leur coût et leurs prérequis.',
          '',
          ...lines,
        ].join('\n');
        counts[await upsertDoc(docs, {
          docSource, title: `Coffre du pirate — ${where}`, text, label: `chest-items ${section}`,
        })] += 1;
      } catch (err) {
        console.error(`📚 sync chest-items ${section} en échec:`, err.message);
      }
    }
  }

  if (images.size) imageSets.set('chest-items', images);

  // Sous-catégories disparues de l'API (le sommaire porte la source de base : il n'est pas périmé)
  const removed = await removeStale(docs.filter((doc) => doc.docSource !== base), base, sources);
  return `${sources.size} sous-catégories — ${counts['mis à jour']} indexée(s), ${counts.inchangé} inchangée(s)${removed}`;
}

// Emblèmes (« recommandations ») : un sommaire des factions et campagnes, puis un document
// par campagne avec une introduction. Images retirées des documents, gardées pour Discord.
async function syncRecommendations(docs) {
  const { count, factions = [] } = await api('recommendations', { md: false });
  if (!factions.length) throw new Error('API recommendations: aucune faction');
  const base = `${SOT_API_URL}/recommendations`;
  const en = (x) => (x.nameEn && x.nameEn !== x.name ? ` / ${x.nameEn}` : ''); // nom anglais s'il diffère

  const summary = [
    '# Emblèmes de Sea of Thieves : factions et campagnes',
    '',
    `Sea of Thieves compte ${count} emblèmes (« emblems », succès à débloquer, avec des grades et des paliers), `
      + 'répartis par faction et par campagne (noms français et anglais) :',
    '',
    ...factions.map((f) => `- ${f.name}${en(f)} : ${f.count} emblèmes`
      + (f.campaigns.length > 1 ? ` (campagnes : ${f.campaigns.map((c) => `${c.name}${en(c)} ${c.count}`).join(' ; ')})` : '')),
  ].join('\n');
  // Même source que l'éventuel ancien document unique : il est remplacé
  await upsertDoc(docs, {
    docSource: base, title: `${DOC_PREFIX}emblèmes par faction et campagne`, text: summary, label: 'recommendations (sommaire)',
  });

  const images = new Map();
  const sources = new Set();
  const counts = { 'mis à jour': 0, inchangé: 0 };
  for (const f of factions) {
    for (const c of f.campaigns) {
      const docSource = `${base}/${f.key}/${c.key}`;
      sources.add(docSource);
      const where = c.name === f.name ? f.name : `${f.name} › ${c.name}`;
      const whereEn = c.name === f.name ? (f.nameEn ?? f.name) : `${f.nameEn ?? f.name} › ${c.nameEn ?? c.name}`;
      try {
        const md = await api(`recommendations/${encodeURIComponent(f.key)}/${encodeURIComponent(c.key)}`);
        // On saute les titres de l'API : l'introduction les remplace
        const lines = stripImages(md.split('\n').filter((l) => l.trim() && !l.startsWith('#')), images, `Emblème — ${where}`);
        const text = [
          `# Emblèmes de Sea of Thieves — ${where}${whereEn !== where ? ` (${whereEn})` : ''}`,
          '',
          'Les emblèmes (« emblems ») sont les succès à débloquer dans Sea of Thieves. Chacun a un grade maximal '
            + `et des paliers (seuils à atteindre pour chaque grade). Ce document liste les ${c.count} emblèmes `
            + `de la faction ${f.name}${c.name === f.name ? '' : `, campagne ${c.name}`}, avec leur nom français et anglais.`,
          '',
          ...lines,
        ].join('\n');
        counts[await upsertDoc(docs, {
          docSource, title: `Emblèmes — ${where}`, text, label: `recommendations ${f.key}/${c.key}`,
        })] += 1;
      } catch (err) {
        console.error(`📚 sync recommendations ${f.key}/${c.key} en échec:`, err.message);
      }
    }
  }
  if (images.size) imageSets.set('recommendations', images);

  // Le sommaire porte la source de base : on ne le compte pas comme périmé
  const removed = await removeStale(docs.filter((doc) => doc.docSource !== base), base, sources);
  return `${count} emblèmes, ${sources.size} campagnes — ${counts['mis à jour']} indexée(s), ${counts.inchangé} inchangée(s)${removed}`;
}

// --- Sources publiques hors API SoT : annonces officielles (Steam) et guides récents (Rare Thief) ---
// Fenêtre glissante : ce qui en sort est retiré, pour qu'une vieille annonce ne passe pas pour actuelle.
const STEAM_NEWS_DAYS = Number(process.env.STEAM_NEWS_DAYS) || 180;
const RARETHIEF_DAYS = Number(process.env.RARETHIEF_DAYS) || 90;
const PUBLIC_UA = 'AnythingLLM-SoT-Sync/1.0 (powange)';
const day = (d) => new Date(d).toISOString().slice(0, 10);

// BBCode Steam → texte
function bbcodeToText(bbcode) {
  return String(bbcode)
    .replace(/\[img[^\]]*\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[h[1-6][^\]]*\]/gi, '\n## ')
    .replace(/\[\*\]/g, '\n- ')
    .replace(/\[\/\*\]/g, '')
    .replace(/\[\/(p|h[1-6]|list|olist)\]/gi, '\n')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[\/?[a-z0-9]+(=[^\]]*)?\]/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// HTML WordPress → texte
function htmlToText(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—' };
  return String(html)
    .replace(/<(script|style|figure|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Math.min(Number(n), 4))} `)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/h[1-6]|\/ul|\/ol|\/div)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => entities[name.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Crée/met à jour une série de documents + un sommaire, puis retire ceux sortis de la fenêtre
async function syncSeries(docs, { base, indexSource, index, items, label }) {
  await upsertDoc(docs, { ...index, docSource: indexSource, label: `${label} (sommaire)` });
  const counts = { 'mis à jour': 0, inchangé: 0 };
  for (const item of items) {
    try {
      counts[await upsertDoc(docs, { ...item, label: `${label} ${item.date}` })] += 1;
    } catch (err) {
      console.error(`📚 sync ${label} « ${item.title} » en échec:`, err.message);
    }
  }
  const removed = await removeStale(docs.filter((doc) => doc.docSource !== indexSource), base,
    new Set(items.map((i) => i.docSource)));
  return `${items.length} document(s) — ${counts['mis à jour']} indexé(s), ${counts.inchangé} inchangé(s)${removed}`;
}

// Annonces officielles de Rare (flux Steam), sauf les notes de version déjà synchronisées
async function syncSteamNews(docs) {
  const params = new URLSearchParams({
    appid: '1172620', count: '100', maxlength: '0', feeds: 'steam_community_announcements', format: 'json',
  });
  const res = await fetch(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?${params}`);
  if (!res.ok) throw new Error(`Steam HTTP ${res.status}`);
  const since = Date.now() - STEAM_NEWS_DAYS * 86400 * 1000;
  const news = ((await res.json()).appnews?.newsitems ?? [])
    .filter((n) => n.date * 1000 >= since && !/release notes/i.test(n.title));

  const base = 'steam-news://1172620'; // identifiant stable (les URL Steam changent de domaine)
  const items = news.map((n) => ({
    docSource: `${base}/${n.gid}`,
    date: day(n.date * 1000),
    title: `Annonce officielle Sea of Thieves — ${n.title} (${day(n.date * 1000)})`,
    text: `# Annonce officielle de Rare (Sea of Thieves) : ${n.title}\n\n`
      + `Publiée le ${day(n.date * 1000)} (source : ${n.url}).\n\n${bbcodeToText(n.contents)}`,
  }));
  const index = {
    title: `${DOC_PREFIX}actualités officielles`,
    text: [
      '# Actualités officielles de Sea of Thieves',
      '',
      'Quoi de neuf sur Sea of Thieves : dernières annonces officielles de Rare (événements, Community Weekend, '
        + 'Twitch Drops, saisons, concours), de la plus récente à la plus ancienne :',
      '',
      ...news.map((n) => `- ${day(n.date * 1000)} : ${n.title}`),
    ].join('\n'),
  };
  return syncSeries(docs, { base, indexSource: base, index, items, label: 'steam-news' });
}

// Guides récents du site communautaire Rare Thief (WordPress)
async function syncRareThief(docs) {
  const base = 'https://rarethief.com';
  const after = new Date(Date.now() - RARETHIEF_DAYS * 86400 * 1000).toISOString().slice(0, 19);
  const posts = [];
  for (let page = 1; ; page += 1) {
    const params = new URLSearchParams({ after, per_page: '100', page: String(page), _fields: 'title,link,date,content' });
    const res = await fetch(`${base}/wp-json/wp/v2/posts?${params}`, { headers: { 'User-Agent': PUBLIC_UA } });
    if (!res.ok) throw new Error(`Rare Thief HTTP ${res.status}`);
    const batch = await res.json();
    posts.push(...batch);
    if (batch.length < 100) break;
  }

  const items = posts.map((p) => {
    const title = htmlToText(p.title.rendered);
    return {
      docSource: p.link,
      date: day(p.date),
      title: `Guide Rare Thief — ${title} (${day(p.date)})`,
      text: `# Guide communautaire Sea of Thieves (Rare Thief) : ${title}\n\n`
        + `Publié le ${day(p.date)} sur rarethief.com (source : ${p.link}).\n\n${htmlToText(p.content.rendered)}`,
    };
  });
  const indexSource = `${base}/guides-recents`; // source synthétique du sommaire
  const index = {
    title: `${DOC_PREFIX}guides récents Rare Thief`,
    text: [
      '# Guides récents de Sea of Thieves (Rare Thief)',
      '',
      'Guides communautaires récents du site Rare Thief (énigmes, événements, défis Bilge Rats du mois, '
        + 'Tall Tales), du plus récent au plus ancien :',
      '',
      ...items.map((i) => `- ${i.date} : ${i.title.replace(/^Guide Rare Thief — | \(\d{4}-\d{2}-\d{2}\)$/g, '')}`),
    ].join('\n'),
  };
  return syncSeries(docs, { base, indexSource, index, items, label: 'rarethief' });
}

// --- Noms du wiki (personnages, lieux, factions…) : servent au routage, rien n'est indexé ---
// Une question qui cite l'un de ces noms part vers l'agent et sa skill wiki, quelle que soit sa formulation.
const WIKI_API = 'https://seaofthieves.wiki.gg/api.php';
const WIKI_CATEGORIES = (process.env.WIKI_CATEGORIES || [
  'NPCs', 'Tall Tales', 'Trading Company', 'World Event', 'Outposts', 'Seaposts', 'Skeleton Forts',
  'Sea Forts', 'Creatures', 'Enemy', 'Skeleton Lord', 'Islands',
].join(',')).split(',').map((c) => c.trim()).filter(Boolean);
// Pages générales des catégories et noms communs (animaux, rôles) : trop vagues pour désigner un sujet
const WIKI_GENERIC = /^(ships|seaposts|outposts|islands|creatures|npcs|tall tales|trading compan(y|ies)|skeletons?|fish|sloop|galleon|brigantine|bats|rats|pets|chef|chicken|shark|snake|lookout)$/i;
const MIN_WIKI_NAME = 4; // « Duke » ; les noms plus courts (« Bob ») sont trop ambigus
const SHORT_WIKI_NAME = 8; // en dessous : majuscule exigée (« Duke », pas « duke »)
let wikiNames = new Map(); // clé (minuscules) → titre de la page

async function syncWikiNames() {
  const names = new Map();
  for (const category of WIKI_CATEGORIES) {
    let cont = {};
    do {
      const params = new URLSearchParams({
        action: 'query', list: 'categorymembers', cmtitle: `Category:${category}`, cmnamespace: '0',
        cmlimit: '500', format: 'json', formatversion: '2', ...cont,
      });
      const res = await fetch(`${WIKI_API}?${params}`, { headers: { 'User-Agent': PUBLIC_UA } });
      if (!res.ok) throw new Error(`wiki HTTP ${res.status}`);
      const data = await res.json();
      for (const { title } of data.query?.categorymembers ?? []) {
        if (title.includes('/')) continue; // traductions (« Fish/fr ») et sous-pages (« Merrick/Journals »)
        const name = title.replace(/\s*\([^)]*\)$/, '').trim(); // « Skeleton Fort (location) » → « Skeleton Fort »
        if (name.length >= MIN_WIKI_NAME && !WIKI_GENERIC.test(name)) names.set(nameKey(name), title);
      }
      cont = data.continue ?? null;
    } while (cont);
  }
  if (!names.size) throw new Error('aucun nom récupéré');
  wikiNames = names;
  return `${names.size} noms (${WIKI_CATEGORIES.length} catégories) pour le routage`;
}

// Titres de pages du wiki cités dans un texte (mot entier ; majuscule exigée pour les noms courts)
export function findWikiNames(text, limit = 3) {
  const lower = nameKey(text);
  const found = [];
  for (const [key, title] of wikiNames) {
    for (let start = lower.indexOf(key); start !== -1; start = lower.indexOf(key, start + 1)) {
      const end = start + key.length;
      const isLetter = (c) => c !== undefined && /\p{L}|\d/u.test(c);
      if (isLetter(text[start - 1]) || isLetter(text[end])) continue;
      if (key.length < SHORT_WIKI_NAME && text[start] === text[start].toLowerCase()) continue;
      found.push({ title, start, length: key.length });
      break;
    }
  }
  // Le nom le plus long d'abord (« Captain Flameheart » plutôt que « Flameheart »), sans doublon
  return [...new Set(found.sort((a, b) => b.length - a.length).map((f) => f.title))].slice(0, limit);
}

// Endpoints découpés en plusieurs documents ; les autres donnent un seul document
const SPLIT_SYNCS = {
  'release-notes': syncReleaseNotes,
  'chest-items': syncChestItems,
  recommendations: syncRecommendations,
  'steam-news': syncSteamNews,
  'rarethief-guides': syncRareThief,
  'wiki-names': syncWikiNames,
};

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
