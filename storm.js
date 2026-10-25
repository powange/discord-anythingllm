// --- Tempête : position et trajet prévu, calculés par le bot au moment de la question ---
// Prévisions de l'API GraphQL publique de Merfolk's Lullaby (https://www.merfolkslullaby.com/map?tab=weather),
// comme le plugin streamdeck-sot : ~1 h 20 de prévisions, rafraîchies au plus toutes les 24 minutes
// (le rythme de leur propre carte), noms d'îles récupérés une seule fois.
const API_URL = 'https://api.merfolkslullaby.com/api';
const USER_AGENT = 'discord-anythingllm (https://github.com/powange/discord-anythingllm)';
const FORECAST_TTL_MS = 24 * 60_000;
const MIN_FORECAST_AHEAD_MS = 20 * 60_000; // prévisions trop courtes : rafraîchissement forcé
const TIME_ZONE = 'Europe/Paris';
const NEXT_ISLANDS = 8;

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
  const time = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
  const lines = [
    `Tempête de Sea of Thieves (« the Storm »), prévisions de Merfolk's Lullaby — il est actuellement ${time(now)} (heure de Paris).`,
    `Position actuelle de la tempête : ${await name(current)}.`,
    'Prochaines îles sur son trajet :',
  ];
  for (const p of route.slice(1, NEXT_ISLANDS + 1)) {
    lines.push(`- ${await name(p)} : vers ${time(p.at)} (dans ${Math.max(1, Math.ceil((p.at - now) / 60_000))} min)`);
  }
  if (route.length === 1) lines.push('- aucune autre île dans les prévisions disponibles');
  lines.push(`Prévisions disponibles jusqu'à ${time(positions[positions.length - 1].at)} environ ; `
    + 'la tempête peut être décalée de quelques minutes en jeu. Les noms d\'îles sont les noms anglais officiels.');
  return lines.join('\n');
}
