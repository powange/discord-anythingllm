// Skill AnythingLLM : position et trajet prévu de la tempête, d'après l'API GraphQL publique de
// Merfolk's Lullaby (https://www.merfolkslullaby.com/map?tab=weather). Même logique que le plugin
// Stream Deck streamdeck-sot : prévisions sur ~1 h 20, rafraîchies au plus toutes les 24 minutes
// (le rythme de leur propre carte), noms d'îles mis en cache une fois pour toutes.
const API_URL = 'https://api.merfolkslullaby.com/api';
const USER_AGENT = 'AnythingLLM-SoT-Storm-Skill/1.0 (powange)';
const FORECAST_TTL_MS = 24 * 60_000;
const MIN_FORECAST_AHEAD_MS = 20 * 60_000; // prévisions trop courtes : on force un rafraîchissement
const TIME_ZONE = 'Europe/Paris';

// Cache commun au processus : AnythingLLM peut recharger le fichier de la skill entre deux appels
const cache = (globalThis.__sotStormCache ??= { forecast: null, loadedAt: 0, names: new Map() });

module.exports.runtime = {
  handler: async function ({ islands }) {
    const callerId = `${this.config.name}-v${this.config.version}`;
    try {
      this.introspect('Lecture des prévisions de la tempête…');
      const now = Date.now();
      const count = Math.min(Math.max(Number(islands) || 6, 1), 12);

      let positions = await this._forecast(false);
      if (!positions.length || positions[positions.length - 1].at < now + MIN_FORECAST_AHEAD_MS) {
        positions = await this._forecast(true);
      }
      if (!positions.length) return 'Aucune prévision de la tempête n\'est disponible pour le moment.';

      // Îles dans l'ordre où la tempête les atteint, en commençant par celle qu'elle couvre maintenant
      let current = positions[0];
      for (const p of positions) if (p.at <= now) current = p;
      const route = [current];
      for (const p of positions) {
        if (p.at > now && p.elementId && p.elementId !== route[route.length - 1].elementId) route.push(p);
      }

      const name = async (p) => (p.elementId && (await this._name(p.elementId))) || 'en pleine mer';
      const time = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
      const lines = [
        `Position actuelle de la tempête : ${await name(current)}.`,
        '',
        'Prochaines îles sur son trajet (heure de Paris) :',
      ];
      for (const p of route.slice(1, count + 1)) {
        lines.push(`- ${await name(p)} : vers ${time(p.at)} (dans ${Math.max(1, Math.ceil((p.at - now) / 60_000))} min)`);
      }
      if (route.length === 1) lines.push('- aucune autre île dans les prévisions disponibles');
      const horizon = positions[positions.length - 1].at;
      lines.push('', `Prévisions disponibles jusqu'à ${time(horizon)} environ. Source : Merfolk's Lullaby `
        + '(https://www.merfolkslullaby.com/map?tab=weather) ; la tempête peut être décalée de quelques minutes en jeu.');
      return lines.join('\n');
    } catch (e) {
      this.logger(`${callerId} a échoué : ${e.message}`);
      return `Impossible de lire les prévisions de la tempête : ${e.message}`;
    }
  },

  async _graphql(query, variables = {}) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) throw new Error('trop de requêtes, réessayer plus tard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.data) throw new Error(json.errors?.[0]?.message ?? 'réponse vide');
    return json.data;
  },

  // Positions prévues (de quelques minutes en arrière à ~1 h 20 en avant), triées par heure
  async _forecast(force) {
    if (!force && cache.forecast && Date.now() - cache.loadedAt < FORECAST_TTL_MS) return cache.forecast;
    const data = await this._graphql(
      'query getBetaWeather($offset: Int, $limit: Int) { getBetaWeather(offset: $offset, limit: $limit) { eid speed date } }',
    );
    cache.forecast = (data.getBetaWeather ?? [])
      .map((p) => ({ at: Date.parse(p.date ?? ''), elementId: p.eid || undefined }))
      .filter((p) => Number.isFinite(p.at))
      .sort((a, b) => a.at - b.at);
    cache.loadedAt = Date.now();
    return cache.forecast;
  },

  // Nom anglais d'une île (les noms ne changent pas : un seul appel par île)
  async _name(id) {
    if (!cache.names.has(id)) {
      const pending = this._graphql(
        'query getElement($id: UUID) { getElement(id: $id) { attributes { type localization { locale value } } } }',
        { id },
      ).then((data) => {
        const loc = data.getElement?.attributes?.find((a) => a.type === 'name')?.localization;
        const all = Array.isArray(loc) ? loc : loc ? [loc] : [];
        return (all.find((l) => l.locale === 'en') ?? all[0])?.value || undefined;
      }).catch(() => {
        cache.names.delete(id); // nouvel essai au prochain appel
        return undefined;
      });
      cache.names.set(id, pending);
    }
    return cache.names.get(id);
  },
};
