// Skill AnythingLLM : guides du site communautaire Rare Thief (WordPress, API REST publique).
// Un seul appel = recherche par pertinence + lecture du meilleur guide.
const SITE = 'https://rarethief.com';
const MAX_CHARS = 6000; // le contexte du modèle local est limité (~8k tokens)
const USER_AGENT = 'AnythingLLM-SoT-Guides-Skill/1.0 (powange)';

module.exports.runtime = {
  handler: async function ({ query }) {
    const callerId = `${this.config.name}-v${this.config.version}`;
    try {
      if (!query || !String(query).trim()) return 'Erreur : paramètre "query" vide.';
      this.introspect(`Recherche dans les guides Rare Thief : « ${query} »…`);

      const params = new URLSearchParams({
        search: String(query), orderby: 'relevance', per_page: '5', _fields: 'title,link,date,content',
      });
      const res = await fetch(`${SITE}/wp-json/wp/v2/posts?${params}`, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`Rare Thief HTTP ${res.status}`);
      const posts = await res.json();
      if (!posts.length) return `Aucun guide Rare Thief ne correspond à « ${query} ».`;

      const [best, ...others] = posts;
      const title = this._text(best.title.rendered);
      this.introspect(`Lecture du guide « ${title} »…`);
      const text = this._text(best.content.rendered);
      const truncated = text.length > MAX_CHARS;

      return [
        `Guide Rare Thief : ${title}`,
        `Publié le ${best.date.slice(0, 10)} — ${best.link}`,
        '',
        truncated ? `${text.slice(0, MAX_CHARS)}\n[… guide tronqué, voir le lien]` : text,
        '',
        others.length
          ? `Autres guides : ${others.map((p) => `${this._text(p.title.rendered)} (${p.date.slice(0, 10)})`).join(' ; ')}`
          : null,
      ].filter((l) => l !== null).join('\n');
    } catch (e) {
      this.logger(`${callerId} a échoué pour « ${query} » : ${e.message}`);
      return `La recherche dans les guides Rare Thief a échoué : ${e.message}`;
    }
  },

  // HTML WordPress → texte : titres en « ## », listes en « - », images et scripts retirés
  _text(html) {
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
  },
};
