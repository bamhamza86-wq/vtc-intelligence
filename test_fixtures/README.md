# Test Fixtures — VTC Intelligence

## load_test.py

Harness de charge concurrent basé sur aiohttp + uvloop.

Simule :
- 100 chauffeurs polling `/api/best-zone-now` et `/api/profitability` toutes les 3 s (30 s)
- 20 signalements simultanés sur Stade de France + CDG
- 5 connexions SSE parallèles écoutant `zones:updated`

Mesure p50/p95/p99/max par endpoint + latence broadcast SSE.

### Utilisation

```bash
# Contre la prod pplx.app
python3 test_fixtures/load_test.py

# Contre un serveur local
python3 test_fixtures/load_test.py --base http://localhost:5000

# Paramètres custom
python3 test_fixtures/load_test.py --drivers 200 --signals 50 --duration 60
```

### SLA cible

- p95 < 300 ms sur `best-zone-now` et `signal`
- Taux d'erreur = 0

Exit code : 0 = PASS, 1 = FAIL.

### Note sur SSE

L'événement `zones:updated` est périodique (cycle serveur 3 min). La latence SSE
mesurée reflète surtout l'attente du prochain tick — informational only, non
inclus dans le verdict SLA.
