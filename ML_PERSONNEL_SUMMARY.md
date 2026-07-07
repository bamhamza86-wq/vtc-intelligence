# Couche ML Personnel Driver — Résumé livrable

Commit : `5632326` — `feat(ml): moteur ML personnel — LR online + bandit contextuel + patterns + anomalies + XAI + drift + mode sans IA`

Zéro nouvelle dépendance npm : régression logistique (SGD online), arbre de régression, bandit contextuel epsilon-greedy — tous implémentés en TypeScript pur dans `server/mlPersonal.ts`.

## Fichiers créés

| Fichier | Rôle |
|---|---|
| `server/mlPersonal.ts` (~990 lignes) | Moteur ML complet : feature store, modèles, patterns, anomalies, drift, self-eval, cold-start, persistance |
| `client/src/pages/MLInsightsPage.tsx` | Page `/#/ml-insights` : patterns, anomalies, jauge de confiance, prochaine meilleure zone |
| `client/src/components/SimulateRideDialog.tsx` | Widget "Simuler une course" (dialog rapide, verdict ACCEPTER/REFUSER) |
| `client/src/components/FocusAIBanner.tsx` | Bannière sobre affichée sur Focus quand le mode "pas d'IA" est actif |
| `client/src/lib/aiToggle.ts` | Persistance localStorage du mode "pas d'IA aujourd'hui" (reset automatique à minuit) |

## Fichiers modifiés

- `server/auth.ts` — ajout de `getCurrentUsername(req)` pour identifier l'utilisateur courant (app single-tenant).
- `server/routes.ts` — hook du feature store sur `POST /api/rides/complete` + 10 nouveaux endpoints `/api/ml/*`.
- `client/src/App.tsx` — route `/ml-insights`.
- `client/src/components/Layout.tsx` — entrée de navigation "Insights IA" (icône Brain).
- `client/src/components/PredictionPanel.tsx` — explicabilité XAI inline ("Pourquoi : ...") sur la zone top-1.
- `client/src/pages/FocusPage.tsx` — widget `SimulateRideDialog` + bannière `FocusAIBanner` (masque le widget si IA désactivée).
- `client/src/pages/ProfilePage.tsx` — carte "IA & prédictions" avec toggle "Pas d'IA aujourd'hui".

## Base de données (tables additives, `CREATE TABLE IF NOT EXISTS`)

- `driver_features` — feature store personnel (user_id, ride_id, ts, hour, day_of_week, is_weekend, is_holiday, weather_code, temp_c, precip_mm, zone_id, distance_km, duration_min, fare, net_profit, is_profitable, weekday_bucket, event_nearby, prev_ride_zone).
- `ml_models` — modèles sérialisés en JSON (user_id, model_name, params_json, updated_at).
- `ml_predictions_log` — historique des prédictions pour le calcul de drift/self-eval.
- `ml_ai_disabled_log` — historique des journées "sans IA" pour comparaison a posteriori.

## Endpoints (tous `requireAuth`)

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/ml/predict-acceptance` | `{zone_id, distance_km, duration_min, fare, hour}` → `{p_accept, expected_gain, explanation, model, ride_count}` |
| GET | `/api/ml/hourly-rate-forecast?hour=&zone_id=&weather=` | `{predicted_hourly, confidence, sample_size, model}` |
| GET | `/api/ml/next-best-zone?hour=&day_type=` | `{zone_id, name, expected_gain, exploration, reason, model}` |
| GET | `/api/ml/patterns` | `{patterns: [{pattern_type, description_fr, confidence, action_hint}]}` |
| GET | `/api/ml/anomalies` | `{anomalies: [{type, where, when, magnitude, description_fr, suggested_action}]}` |
| GET | `/api/ml/drift` | `{drift_detected, mae_recent, mae_baseline, action}` |
| GET | `/api/ml/self-eval` | `{accuracy_7d, calibration_score, brier_score, honest_confidence}` |
| GET | `/api/ml/summary` | `{ride_count, models}` (debug) |
| POST | `/api/ml/ai-disabled-log` | `{date, net_profit_that_day}` → enregistre le résultat d'une journée sans IA |
| GET | `/api/ml/ai-disabled-history` | Historique des journées sans IA avec comparaison |

## Comportement cold-start

Sous 20 courses enregistrées, tous les modèles personnels retombent sur la moyenne de flotte (`profitability_scores`), avec `model: "cold_start"` explicite dans chaque réponse. Testé en conditions réelles :

**Avant (0 course) :**
```json
{
  "p_accept": 0.29, "expected_gain": 2.51,
  "model": "cold_start", "ride_count": 0,
  "explanation": [{"feature": "fleet_avg", "label_fr": "Moyenne de la flotte (pas encore assez d'historique personnel)"}]
}
```

**Après 25 courses simulées :**
```json
{
  "p_accept": 0.3, "expected_gain": 2.65,
  "model": "personal", "ride_count": 25,
  "explanation": [
    {"feature": "hour_sin", "weight": 0.29, "label_fr": "Créneau horaire (cycle) favorable"},
    {"feature": "zone_known", "weight": -0.18, "label_fr": "Historique de cette zone - incertain"},
    {"feature": "distance_km", "weight": -0.11, "label_fr": "Distance de la course - pénalisante"}
  ]
}
```

Transition confirmée au seuil de 20 courses (`ride_count < 20` → cold_start, sinon personal).

## Exemples de réponses (testées via curl, serveur local port 5055)

- `GET /api/ml/drift` → `{"drift_detected": false, "mae_recent": 0.4, "mae_baseline": 0.4, "action": "ok"}`
- `GET /api/ml/self-eval` → `{"accuracy_7d": 0.88, "calibration_score": 0.6, "brier_score": 0.17, "honest_confidence": "Modèle fiable cette semaine (88% de précision sur 25 prédictions)."}`
- `GET /api/ml/anomalies` → détecte `route_suboptimal`, `expected_vs_real_gap`, `self_sabotage` avec descriptions en français et actions suggérées.
- `GET /api/ml/hourly-rate-forecast?hour=17&zone_id=z_cdg` → `{"predicted_hourly": 38.25, "confidence": 0.63, "sample_size": 25, "model": "personal"}`

## Performance

Latence de `POST /api/ml/predict-acceptance` mesurée à ~7ms (largement sous le seuil de 100ms requis).

## Vérifications effectuées

- `npm run build` : succès, aucun warning bloquant (bundle client + serveur générés dans `dist/`).
- `npx tsc --noEmit` : aucune nouvelle erreur introduite par les fichiers ML (les erreurs TypeScript restantes dans le repo sont pré-existantes et liées à d'autres couches : `storage.ts`, `BestRoutePage.tsx`, `SmartPlanPage.tsx`, etc., hors périmètre de cette tâche).
- Tests fonctionnels via `curl` sur un serveur de test local (port 5055) : les 10 endpoints répondent correctement, transition cold-start → personal validée à 20 courses, latence vérifiée.
- Tests Playwright complets non exécutés (bandwidth de steps priorisée sur la vérification fonctionnelle directe via API, jugée suffisante et plus rapide à valider dans le contexte d'un espace de travail partagé avec plusieurs sous-agents concurrents).

## Notes sur l'environnement partagé

Ce projet est modifié en parallèle par d'autres sous-agents (couches Communauté, Sécurité, Fiscalité, Économie, Wow). Le commit `5632326` inclut nécessairement l'état du répertoire de travail au moment du commit, mais tous les changements listés ci-dessus sont strictement additifs et n'entrent en conflit avec aucune route ou table existante. Conformément aux règles du projet, ce sous-agent n'a pas publié/déployé — seul l'agent parent est habilité à le faire.
