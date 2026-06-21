#!/usr/bin/env python3
"""
predicthq_refresh.py — Cron VTC Intelligence
Rafraîchit les événements PredictHQ toutes les heures.
Schedule: 0 * * * *

Flux :
  1. Auth sur /api/auth/login (root / 12345678) avec retry cold-start.
  2. POST /api/predicthq/refresh pour forcer le refresh des events côté serveur.
  3. Lit cron_tracking/predicthq/status_{date}.json (écrit par le serveur) pour
     connaître le nombre de nouveaux events. À défaut, exploite la réponse HTTP.
  4. Si > 50 nouveaux events → écrit pending_notif_{date}.json (titre + body).
  5. Termine silencieusement si tout va bien.
"""
import json
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

WORKSPACE = Path("/home/user/workspace")
TRACKING = WORKSPACE / "cron_tracking" / "predicthq"
TRACKING.mkdir(parents=True, exist_ok=True)

BASE_URL = "https://vtc-one.pplx.app/port/5000"
PHQ_KEY = "H6vO4zDmjgTpPlXZUrewsFE-NLPD1wTHeowBiRHo"

NEW_EVENTS_NOTIF_THRESHOLD = 50
COLD_START_DELAYS = [5, 10, 15, 20, 25, 30]


def _now_utc():
    return datetime.now(timezone.utc)


def _today_cest():
    # CEST = UTC+2
    return (_now_utc() + timedelta(hours=2)).strftime("%Y-%m-%d")


def login(session, username="root", password="12345678"):
    """Authentifie et retourne le token JWT. Retry sur cold-start (403/connexion)."""
    url = f"{BASE_URL}/api/auth/login"
    body = {"username": username, "password": password}
    for i, delay in enumerate(COLD_START_DELAYS):
        try:
            r = session.post(url, json=body, timeout=20)
            if r.status_code == 200:
                token = r.json().get("token")
                if token:
                    return token
                raise ValueError(f"Pas de token dans la réponse: {r.text[:200]}")
            if i < len(COLD_START_DELAYS) - 1:
                print(f"  [auth] HTTP {r.status_code} — retry dans {delay}s ({i+1}/{len(COLD_START_DELAYS)})...")
                time.sleep(delay)
            else:
                raise RuntimeError(f"Auth HTTP {r.status_code}: {r.text[:300]}")
        except requests.exceptions.ConnectionError as e:
            if i < len(COLD_START_DELAYS) - 1:
                print(f"  [auth] ConnectionError — retry dans {delay}s...")
                time.sleep(delay)
            else:
                raise RuntimeError(f"Auth ConnectionError: {e}")
    raise RuntimeError("Auth échouée après tous les retries")


def call_refresh(session, token):
    """POST /api/predicthq/refresh. Retourne le corps JSON (ou {})."""
    url = f"{BASE_URL}/api/predicthq/refresh"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = session.post(url, headers=headers, json={}, timeout=60)
    except requests.exceptions.RequestException as e:
        print(f"  [refresh] erreur réseau: {e}")
        return {}
    if r.status_code == 200:
        try:
            return r.json()
        except Exception:
            return {}
    print(f"  [refresh] HTTP {r.status_code}: {r.text[:200]}")
    return {}


def read_status_file(today):
    """Lit cron_tracking/predicthq/status_{date}.json si présent."""
    path = TRACKING / f"status_{today}.json"
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception as e:
            print(f"  [status] illisible: {e}")
    return None


def extract_new_count(refresh_resp, status):
    """Détermine le nombre de nouveaux events à partir du status puis de la réponse."""
    for src in (status, refresh_resp):
        if not isinstance(src, dict):
            continue
        for k in ("new_events", "newEvents", "new_count", "added", "new"):
            if k in src and isinstance(src[k], (int, float)):
                return int(src[k])
    # fallback : 'count' total renvoyé par refreshPredictHQEvents
    if isinstance(refresh_resp, dict) and isinstance(refresh_resp.get("count"), (int, float)):
        return int(refresh_resp["count"])
    return 0


def write_notif(today, new_count, total_count):
    title = f"📅 PredictHQ — {new_count} nouveaux événements détectés ({today})"
    body = (
        f"## PredictHQ — {today}\n\n"
        f"**{new_count} nouveaux événements** ont été ajoutés lors du refresh horaire.\n\n"
        f"- Total events actifs : {total_count}\n"
        f"- Seuil de notification : > {NEW_EVENTS_NOTIF_THRESHOLD} nouveaux events\n\n"
        f"### Recommandation\n"
        f"Vérifier l'impact sur les coefficients de demande (`demand_boost`) "
        f"des zones VTC concernées via le dashboard."
    )
    path = TRACKING / f"pending_notif_{today}.json"
    path.write_text(
        json.dumps(
            {"title": title, "body": body, "channels": ["in_app"]},
            indent=2,
            ensure_ascii=False,
        )
    )
    print(f"  Notif écrite: {path}")


def run():
    today = _today_cest()
    ts = _now_utc().isoformat()
    print(f"[{ts}] CRON predicthq_refresh — refresh horaire {today}")

    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})

    token = login(session)
    print("  Auth OK")

    refresh_resp = call_refresh(session, token)
    status = read_status_file(today)

    new_count = extract_new_count(refresh_resp, status)
    total_count = 0
    for src in (status, refresh_resp):
        if isinstance(src, dict) and isinstance(src.get("count"), (int, float)):
            total_count = int(src["count"])
            break

    print(f"  Refresh OK — nouveaux events: {new_count}, total: {total_count}")

    if new_count > NEW_EVENTS_NOTIF_THRESHOLD:
        write_notif(today, new_count, total_count)
    else:
        # Tout va bien → terminaison silencieuse (juste un log)
        print("  RAS — pas de notification (seuil non atteint)")

    return new_count, total_count


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"[predicthq_refresh] ÉCHEC: {e}", file=sys.stderr)
        sys.exit(1)
