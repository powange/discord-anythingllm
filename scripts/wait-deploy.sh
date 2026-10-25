#!/usr/bin/env bash
# Attend que le bot déployé exécute la même version que le code local (empreinte de bot.js + sync.js,
# calculée comme au démarrage du bot), via GET /health de l'interface de test.
# Usage : scripts/wait-deploy.sh [url] [délai max en s]   — jeton lu dans TEST_API_TOKEN du .env
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${1:-http://192.168.0.13:3105}"
MAX="${2:-600}"
TOKEN=$(grep -E '^TEST_API_TOKEN=' .env | cut -d= -f2- | tr -d "\"' \r")
WANT=$(node -e "
  const { createHash } = require('node:crypto'); const { readFileSync } = require('node:fs');
  console.log(createHash('sha256').update(['bot.js', 'sync.js'].map((f) => readFileSync(f)).join('\n')).digest('hex').slice(0, 12));")
echo "Version attendue : $WANT"
for ((t = 0; t < MAX; t += 10)); do
  GOT=$(curl -s -m 5 -H "Authorization: Bearer $TOKEN" "$URL/health" | node -e "
    let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => {
      try { const h = JSON.parse(s); console.log(h.version ?? 'inconnue', h.startedAt ?? ''); } catch { console.log('injoignable'); } });")
  if [[ "${GOT%% *}" == "$WANT" ]]; then echo "Déployé : version $WANT (démarré ${GOT#* })"; exit 0; fi
  echo "… en cours (version déployée : $GOT)"
  sleep 10
done
echo "Délai dépassé : la version $WANT n'est pas en place" >&2
exit 1
