#!/bin/bash
# init-predicthq.sh — Initialisation PredictHQ au démarrage du serveur
# Injecte la clé API PredictHQ via l'endpoint REST sécurisé.
# Appelé par le run_command après démarrage du serveur.

set -e

BASE="http://localhost:5000"
MAX_WAIT=30
PHQ_KEY="${PHQ_API_KEY:-}"

# Si pas de clé en env, terminer silencieusement
if [ -z "$PHQ_KEY" ]; then
  echo "[init-predicthq] PHQ_API_KEY non définie, skip"
  exit 0
fi

# Attendre que le serveur soit prêt
echo "[init-predicthq] Attente démarrage serveur..."
for i in $(seq 1 $MAX_WAIT); do
  if curl -sf "$BASE/api/predicthq/status" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Auth
TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"root","password":"12345678"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "[init-predicthq] Auth échouée"
  exit 1
fi

# Injecter la clé
curl -sf -X PUT "$BASE/api/platforms/credentials/predicthq" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"api_key\":\"$PHQ_KEY\"}" > /dev/null

# Tester la connexion (marque status='connected')
curl -sf -X POST "$BASE/api/platforms/test/predicthq" \
  -H "Authorization: Bearer $TOKEN" > /dev/null

# Forcer un refresh des events
curl -sf -X POST "$BASE/api/predicthq/refresh" \
  -H "Authorization: Bearer $TOKEN" > /dev/null

echo "[init-predicthq] PredictHQ initialisé avec succès"
