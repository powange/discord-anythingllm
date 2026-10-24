// Skill AnythingLLM : état des serveurs (API de la page de statut officielle) + joueurs Steam.
const STATUS_API = 'https://status.seaofthieves.com/api/health';
const STATUS_PAGE = 'https://status.seaofthieves.com';
const PLAYERS_API = 'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=1172620';
// La page de statut refuse les clients non navigateurs (403) : on se présente comme sa propre page.
// Un seul appel par question, à la demande d'un joueur — l'équivalent d'ouvrir la page.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Libellés français des composants signalés par la page de statut
const LABELS = { GameDown: 'jeu indisponible', MatchMaking: 'matchmaking (connexion aux serveurs)', Login: 'connexion au compte' };

module.exports.runtime = {
  handler: async function ({ days }) {
    const callerId = `${this.config.name}-v${this.config.version}`;
    try {
      this.introspect('Vérification de la page de statut officielle…');
      const history = Math.min(Math.max(Number(days) || 3, 1), 14);

      const [status, players] = await Promise.all([
        fetch(STATUS_API, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } })
          .then((r) => { if (!r.ok) throw new Error(`statut HTTP ${r.status}`); return r.json(); }),
        fetch(PLAYERS_API).then((r) => r.json()).then((d) => d.response?.player_count).catch(() => null),
      ]);

      const label = (k) => LABELS[k] ?? k;
      const problems = (fail = {}) => [
        ...(fail.System ?? []).map((k) => label(k)),
        ...(fail.Beard ?? []).map((k) => `erreur ${k}`),
      ];
      const now = problems(status.currentStatus?.fail);
      const message = status.messages?.message?.trim();

      const lines = [
        `État des serveurs Sea of Thieves (source : ${STATUS_PAGE}, mis à jour ${status.currentStatus?.updatedInterval ?? '?'}) :`,
        now.length || status.failures ? `- En ce moment : PROBLÈME — ${now.join(', ') || 'incident signalé'}` : '- En ce moment : aucun problème signalé',
        message ? `- Message officiel : ${message}` : null,
        '',
        `Incidents des ${history} derniers jours :`,
        ...(status.historicStatus ?? []).slice(0, history).map((h) => {
          const p = problems(h.fail);
          return `- ${String(h.updatedInterval).slice(0, 10)} : ${p.length ? p.join(', ') : 'aucun'}`;
        }),
        '',
        players != null
          ? `Joueurs connectés sur Steam en ce moment : ${players} (Steam uniquement : les joueurs Xbox, PC Microsoft Store et PlayStation ne sont pas comptés)`
          : null,
      ];
      return lines.filter((l) => l !== null).join('\n');
    } catch (e) {
      this.logger(`${callerId} a échoué : ${e.message}`);
      return `Impossible de lire la page de statut (${e.message}). Elle est consultable sur ${STATUS_PAGE}.`;
    }
  },
};
