# cron_scripts/

Scripts Python pour les tâches automatiques VTC Intelligence.
Ces fichiers sont chargés par les CRONs Perplexity via GitHub pour résister aux resets sandbox.

| Fichier | CRON | Rôle |
|---------|------|------|
| vtc_api_client.py | — | Client HTTP requests (fix urllib 403) |
| vtc_hourly_update.py | b3ed8968 | Monitoring horaire + auto-retrain |
| vtc_retrain.py | b3ed8968 | Calcul MAE + validation retrain |
| vtc_collect_morning_6h.py | 29554453 | Collecte prédictions rush matin |
| vtc_diagnostic_22h.py | af286c4e | Diagnostic prédit vs réel + email |
| monitor_6e9deef8.py | 6e9deef8 | Monitoring régression moteur |

## Anti-reset

Chaque script se résout lui-même :
1. Cherche vtc_api_client.py dans son propre dossier
2. Cherche dans /home/user/workspace/cron_scripts/
3. Clone/pull le repo GitHub si introuvable
