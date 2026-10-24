// Skill AnythingLLM : annonces officielles de Rare, via l'API publique des actualités Steam.
// Le site officiel génère ses actualités dans le navigateur ; Steam reçoit les mêmes annonces.
const NEWS_API = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
const APP_ID = '1172620'; // Sea of Thieves sur Steam
const MAX_CHARS = 6000; // le contexte du modèle local est limité (~8k tokens)

module.exports.runtime = {
  handler: async function ({ query }) {
    const callerId = `${this.config.name}-v${this.config.version}`;
    try {
      const wanted = String(query || '').trim();
      this.introspect(wanted ? `Recherche dans les annonces officielles : « ${wanted} »…` : 'Lecture des dernières annonces officielles…');

      // Uniquement le flux des annonces de Rare (pas les articles de presse relayés par Steam)
      const params = new URLSearchParams({
        appid: APP_ID, count: '20', maxlength: '0', feeds: 'steam_community_announcements', format: 'json',
      });
      const res = await fetch(`${NEWS_API}?${params}`);
      if (!res.ok) throw new Error(`Steam HTTP ${res.status}`);
      const items = (await res.json()).appnews?.newsitems ?? [];
      if (!items.length) return 'Aucune annonce officielle trouvée.';

      // Avec un mot-clé : l'annonce la plus pertinente (un mot dans le titre pèse lourd, chaque
      // occurrence dans le texte un peu) ; une simple mention dans des notes de version ne suffit pas
      const words = wanted.toLowerCase().split(/\s+/).filter(Boolean);
      const count = (s, w) => s.split(w).length - 1;
      const score = (n) => {
        const title = n.title.toLowerCase();
        const body = n.contents.toLowerCase();
        if (!words.every((w) => title.includes(w) || body.includes(w))) return 0;
        return words.reduce((sum, w) => sum + (title.includes(w) ? 20 : 0) + count(body, w), 0);
      };
      const ranked = words.length ? items.map((n) => ({ n, s: score(n) })).filter((x) => x.s > 0) : [];
      ranked.sort((a, b) => b.s - a.s);
      const chosen = !words.length ? items[0] : ranked[0]?.n;

      const date = (n) => new Date(n.date * 1000).toISOString().slice(0, 10);
      const list = items.slice(0, 10).map((n) => `- ${date(n)} : ${n.title}`).join('\n');
      if (!chosen) {
        return `Aucune annonce récente ne parle de « ${wanted} ». Dernières annonces officielles :\n${list}`;
      }

      const text = this._text(chosen.contents);
      const truncated = text.length > MAX_CHARS;
      return [
        `Annonce officielle : ${chosen.title}`,
        `Publiée le ${date(chosen)} — ${chosen.url}`,
        '',
        truncated ? `${text.slice(0, MAX_CHARS)}\n[… annonce tronquée, voir le lien]` : text,
        '',
        `Dernières annonces officielles :\n${list}`,
      ].join('\n');
    } catch (e) {
      this.logger(`${callerId} a échoué pour « ${query} » : ${e.message}`);
      return `La lecture des annonces officielles a échoué : ${e.message}`;
    }
  },

  // BBCode Steam → texte : titres en « ## », listes en « - », images et liens réduits
  _text(bbcode) {
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
  },
};
