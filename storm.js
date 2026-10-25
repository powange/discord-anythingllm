// --- Tempête : position et trajet prévu, calculés par le bot au moment de la question ---
// Prévisions de l'API GraphQL publique de Merfolk's Lullaby (https://www.merfolkslullaby.com/map?tab=weather),
// comme le plugin streamdeck-sot : ~1 h 20 de prévisions, rafraîchies au plus toutes les 24 minutes
// (le rythme de leur propre carte), noms d'îles récupérés une seule fois.
const API_URL = 'https://api.merfolkslullaby.com/api';
const USER_AGENT = 'discord-anythingllm (https://github.com/powange/discord-anythingllm)';
const FORECAST_TTL_MS = 24 * 60_000;
const MIN_FORECAST_AHEAD_MS = 20 * 60_000; // prévisions trop courtes : rafraîchissement forcé
const TIME_ZONE = 'Europe/Paris';

let forecast = null; // [{ at, elementId }] triées par heure
let loadedAt = 0;
const names = new Map(); // id d'île → Promise<nom anglais>

async function graphql(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) throw new Error('Merfolk\'s Lullaby : trop de requêtes');
  if (!res.ok) throw new Error(`Merfolk's Lullaby : HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data) throw new Error(json.errors?.[0]?.message ?? 'réponse vide');
  return json.data;
}

async function getForecast(force) {
  if (!force && forecast && Date.now() - loadedAt < FORECAST_TTL_MS) return forecast;
  const data = await graphql(
    'query getBetaWeather($offset: Int, $limit: Int) { getBetaWeather(offset: $offset, limit: $limit) { eid speed date } }',
  );
  forecast = (data.getBetaWeather ?? [])
    .map((p) => ({ at: Date.parse(p.date ?? ''), elementId: p.eid || undefined }))
    .filter((p) => Number.isFinite(p.at))
    .sort((a, b) => a.at - b.at);
  loadedAt = Date.now();
  console.log(`🌩️ prévisions de la tempête : ${forecast.length} positions`);
  return forecast;
}

// Nom anglais d'une île (les noms ne changent pas : un seul appel par île)
function islandName(id) {
  if (!names.has(id)) {
    names.set(id, graphql(
      'query getElement($id: UUID) { getElement(id: $id) { attributes { type localization { locale value } } } }',
      { id },
    ).then((data) => {
      const loc = data.getElement?.attributes?.find((a) => a.type === 'name')?.localization;
      const all = Array.isArray(loc) ? loc : loc ? [loc] : [];
      return (all.find((l) => l.locale === 'en') ?? all[0])?.value || undefined;
    }).catch(() => {
      names.delete(id); // nouvel essai à la prochaine question
      return undefined;
    }));
  }
  return names.get(id);
}

// Fiche « tempête » pour le modèle : heure actuelle, île couverte maintenant, prochaines îles avec
// l'heure d'arrivée. Calculée à l'instant de la question (le modèle ne connaît pas l'heure).
// Renvoie { text, times } : times associe chaque heure « HH:MM » de la fiche à son instant exact,
// pour la remplacer ensuite par un horodatage Discord (withDiscordTimestamps).
export async function stormCard() {
  const now = Date.now();
  let positions = await getForecast(false);
  if (!positions.length || positions[positions.length - 1].at < now + MIN_FORECAST_AHEAD_MS) {
    positions = await getForecast(true);
  }
  if (!positions.length) throw new Error('aucune prévision disponible');

  // Îles dans l'ordre où la tempête les atteint, en commençant par celle qu'elle couvre maintenant
  let current = positions[0];
  for (const p of positions) if (p.at <= now) current = p;
  const route = [current];
  for (const p of positions) {
    if (p.at > now && p.elementId && p.elementId !== route[route.length - 1].elementId) route.push(p);
  }

  const name = async (p) => (p.elementId && (await islandName(p.elementId))) || 'en pleine mer';
  const times = new Map();
  const time = (ms) => {
    const hhmm = new Date(ms).toLocaleTimeString('fr-FR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
    if (!times.has(hhmm)) times.set(hhmm, Math.round(ms / 1000));
    return hhmm;
  };
  const delay = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')}` : ''}`);
  const horizon = positions[positions.length - 1].at;
  const lines = [
    `Tempête de Sea of Thieves (« the Storm »), prévisions de Merfolk's Lullaby — il est actuellement ${time(now)} (heure de Paris).`,
    `Position actuelle de la tempête : ${await name(current)}.`,
    '',
    // Positions précalculées : le modèle se trompait en déduisant lui-même « où sera-t-elle dans 1 heure ? »
    'Position prévue dans :',
  ];
  for (let min = 15; now + min * 60_000 <= horizon; min += 15) {
    let at = current;
    for (const p of positions) if (p.at <= now + min * 60_000) at = p;
    lines.push(`- ${delay(min)} (vers ${time(now + min * 60_000)}) : ${await name(at)}`);
  }
  lines.push('', 'Toutes les prochaines îles sur son trajet :');
  for (const p of route.slice(1)) {
    lines.push(`- ${await name(p)} : vers ${time(p.at)} (dans ${delay(Math.max(1, Math.ceil((p.at - now) / 60_000)))})`);
  }
  if (route.length === 1) lines.push('- aucune autre île dans les prévisions disponibles');
  lines.push('', `Les prévisions s'arrêtent vers ${time(horizon)} (dans ${delay(Math.round((horizon - now) / 60_000))}) : `
    + 'au-delà, la position de la tempête n\'est pas connue. Elle peut être décalée de quelques minutes en jeu. '
    + 'Les noms d\'îles sont les noms anglais officiels.');
  return { text: lines.join('\n'), times };
}

// Remplace les heures de la fiche citées dans la réponse par des horodatages Discord : « 05:28 » devient
// « <t:…:t> · <t:…:R> », soit l'heure locale de chaque lecteur et « dans 16 minutes », mis à jour en direct
// par Discord. Le « (dans 16 min) » écrit par le modèle est retiré (figé, il deviendrait faux) ; le compte
// à rebours est ajouté même quand le modèle ne l'a pas écrit. Fait par le bot : le modèle recopierait mal
// ces nombres.
export function withDiscordTimestamps(answer, times) {
  return answer
    .replace(/\s*\(heure de Paris\)/gi, '')
    .replace(/(?<!\d)(\d{1,2})[:h](\d{2})(?!\d)(\s*\((?:soit\s+)?dans\s+(?:environ\s+)?[^)]*\))?/g, (match, h, m) => {
      const s = times.get(`${h.padStart(2, '0')}:${m}`);
      return s ? `<t:${s}:t> · <t:${s}:R>` : match;
    });
}
