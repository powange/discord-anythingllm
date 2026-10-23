// Skill AnythingLLM : recherche dans le wiki Sea of Thieves (MediaWiki) et lecture de la meilleure page.
// Un seul appel = recherche + lecture : les petits modèles enchaînent mal plusieurs outils.
const WIKI = 'https://seaofthieves.wiki.gg';
const API = `${WIKI}/api.php`;
const MAX_CHARS = 6000; // le contexte du modèle local est limité (~8k tokens)
const USER_AGENT = 'AnythingLLM-SoT-Wiki-Skill/1.0 (powange)';

module.exports.runtime = {
  handler: async function ({ query, section }) {
    const callerId = `${this.config.name}-v${this.config.version}`;
    try {
      if (!query || !String(query).trim()) return 'Erreur : paramètre "query" vide.';
      this.introspect(`Recherche dans le wiki Sea of Thieves : « ${query} »…`);

      const hits = await this._search(String(query));
      if (!hits.length) return `Aucune page du wiki Sea of Thieves ne correspond à « ${query} ».`;

      // Titre exact en priorité, sinon le premier résultat de la recherche
      const wanted = String(query).trim().toLowerCase();
      const page = hits.find((h) => h.title.toLowerCase() === wanted) ?? hits[0];
      this.introspect(`Lecture de la page « ${page.title} »…`);

      const { title, wikitext } = await this._page(page.title);
      const { text, sections } = this._clean(wikitext, section);
      const truncated = text.length > MAX_CHARS;
      const others = hits.filter((h) => h.title !== page.title).map((h) => h.title);

      return [
        `Page du wiki : ${title} (${WIKI}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))})`,
        section ? `Section : ${section}` : null,
        '',
        truncated ? `${text.slice(0, MAX_CHARS)}\n[… contenu tronqué]` : text,
        '',
        sections.length ? `Sections de la page : ${sections.join(' ; ')}` : null,
        truncated && !section ? 'Pour lire une section en entier, rappelle cet outil avec le paramètre "section".' : null,
        others.length ? `Autres pages pertinentes : ${others.join(' ; ')}` : null,
      ].filter((l) => l !== null).join('\n');
    } catch (e) {
      this.logger(`${callerId} a échoué pour « ${query} » : ${e.message}`);
      return `La recherche dans le wiki a échoué : ${e.message}`;
    }
  },

  async _get(params) {
    const url = `${API}?${new URLSearchParams({ ...params, format: 'json', formatversion: '2' })}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`wiki HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.info || data.error.code);
    return data;
  },

  async _search(query) {
    const data = await this._get({ action: 'query', list: 'search', srsearch: query, srlimit: '6', srnamespace: '0' });
    return data.query?.search ?? [];
  },

  async _page(title) {
    const data = await this._get({ action: 'parse', page: title, prop: 'wikitext', redirects: '1' });
    return { title: data.parse.title, wikitext: data.parse.wikitext ?? '' };
  },

  // Wikitexte → texte lisible : infobox gardée en « clé : valeur », modèles, références,
  // fichiers et catégories retirés, liens réduits à leur libellé
  _clean(wikitext, onlySection) {
    let s = wikitext
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<ref[^>]*\/>/gi, '')
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
      // Modèles qui affichent un nom dans le texte ({{ship|Magpie's Wing}}, {{ilink|Heart of Fire}}) :
      // on garde leur premier paramètre, sinon la phrase perd le nom
      .replace(/\{\{\s*(?:ship|ilink|c|quote|item|npc|l|lnk)\s*\|([^{}|]*)(?:\|[^{}]*)?\}\}/gi, '$1')
      // Liens réduits à leur libellé AVANT l'infobox : leurs « | » casseraient le découpage des paramètres
      .replace(/\[\[(?:File|Image|Category|Fichier|Catégorie):[^\]]*(?:\[\[[^\]]*\]\][^\]]*)*\]\]/gi, '')
      .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
      .replace(/\[\[([^\]]*)\]\]/g, '$1')
      .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
      .replace(/<br\s*\/?>/gi, ', ');

    // Infobox : paramètres utiles avant de retirer les modèles
    const infobox = [];
    s = s.replace(/\{\{\s*Infobox[^|}]*((?:\{\{[^{}]*\}\}|[^{}])*)\}\}/gi, (_, body) => {
      for (const m of body.matchAll(/\|\s*([^=|\n]+?)\s*=\s*([^|\n]+)/g)) {
        const value = m[2].replace(/\{\{[^{}]*\}\}/g, '').replace(/^[\s,]+|[\s,]+$/g, '');
        if (value && !/^(image|caption)/i.test(m[1])) infobox.push(`${m[1].trim()} : ${value}`);
      }
      return '';
    });

    // Modèles restants (imbriqués) : on retire les plus internes jusqu'à épuisement
    for (let prev; prev !== s;) { prev = s; s = s.replace(/\{\{[^{}]*\}\}/g, ''); }

    s = s
      .replace(/'{2,}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/^\{\||^\|\}|^\|-.*$/gm, '')
      .replace(/^[|!]\s*/gm, '')
      .replace(/\s*(\|\||!!)\s*/g, ' | ')
      .replace(/^(=+)\s*(.*?)\s*\1\s*$/gm, (_, eq, title) => `${'#'.repeat(Math.min(eq.length, 4))} ${title}`);

    const infoboxText = infobox.length ? `Infobox :\n${infobox.map((l) => `- ${l}`).join('\n')}\n\n` : '';
    const sections = [...s.matchAll(/^#{2,} (.+)$/gm)].map((m) => m[1]);

    if (onlySection) {
      const wanted = onlySection.trim().toLowerCase();
      const lines = s.split('\n');
      const start = lines.findIndex((l) => /^#{2,} /.test(l) && l.replace(/^#+ /, '').toLowerCase() === wanted);
      if (start !== -1) {
        const level = lines[start].match(/^#+/)[0].length;
        const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)[0].length <= level);
        s = lines.slice(start, end === -1 ? undefined : end).join('\n');
      }
    }

    const text = (onlySection ? s : infoboxText + s).replace(/\n{3,}/g, '\n\n').trim();
    return { text, sections };
  },
};
