#!/usr/bin/env python3
"""
predicthq_refresh.py — Cron VTC Intelligence
Rafraîchit les événements PredictHQ toutes les heures.
Schedule: 0 * * * *

Flux :
  1. Auth sur /api/auth/login (root / 12345678) avec retry cold-start (timeout 40s).
  2. POST /api/predicthq/refresh avec retry (cold-start sandbox E2B).
  3. Compare le total avec le dernier run (last_count) pour calculer les NOUVEAUX events.
  4. Si delta >= NEW_EVENTS_THRESHOLD → écrit pending_notif_{date}.json (in-app).
  5. Sauvegarde le total dans last_count_{date}.json pour le run suivant.
  6. Termine silencieusement si tout va bien.
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

# Seuil : notifier seulement si >= 5 NOUVEAUX events depuis le dernier run
NEW_EVENTS_THRESHOLD = 5

# Retries cold-start (sandbox E2B peut être suspendu)
COLD_START_DELAYS = [10, 20, 30, 40, 40, 40]
AUTH_TIMEOUT = 40     # augmenté pour cold-start sandbox
REFRESH_TIMEOUT = 90  # augmenté pour appel API PredictHQ


def _now_utc():
    return datetime.now(timezone.utc)


def _today_cest():
    return (_now_utc() + timedelta(hours=2)).strftime("%Y-%m-%d")


def login(session, username="root", password="12345678"):
    """Auth avec retry sur cold-start (ConnectionError / timeout / 5xx)."""
    url = f"{BASE_URL}/api/auth/login"
    body = {"username": username, "password": password}
    for i, delay in enumerate(COLD_START_DELAYS):
        try:
            r = session.post(url, json=body, timeout=AUTH_TIMEOUT)
            if r.status_code == 200:
                token = r.json().get("token")
                if token:
                    return token
                raise ValueError(f"Pas de token: {r.text[:200]}")
            # 5xx = serveur pas encore prêt
            if r.status_code >= 500 and i < len(COLD_START_DELAYS) - 1:
                print(f"  [auth] HTTP {r.status_code} — cold-start, retry dans {delay}s...")
                time.sleep(delay)
                continue
            raise RuntimeError(f"Auth HTTP {r.status_code}: {r.text[:200]}")
        except (requests.exceptions.ConnectionError,
                requests.exceptions.ReadTimeout,
                requests.exceptions.Timeout) as e:
            if i < len(COLD_START_DELAYS) - 1:
                print(f"  [auth] {type(e).__name__} — retry dans {delay}s ({i+1}/{len(COLD_START_DELAYS)})...")
                time.sleep(delay)
            else:
                raise RuntimeError(f"Auth échouée après {len(COLD_START_DELAYS)} retries: {e}")
    raise RuntimeError("Auth échouée (boucle épuisée)")


def call_refresh(session, token):
    """POST /api/predicthq/refresh avec retry. Retourne le JSON ou {}."""
    url = f"{BASE_URL}/api/predicthq/refresh"
    headers = {"Authorization": f"Bearer {token}"}
    for attempt in range(3):
        try:
            r = session.post(url, headers=headers, json={}, timeout=REFRESH_TIMEOUT)
            if r.status_code == 200:
                try:
                    return r.json()
                except Exception:
                    return {}
            print(f"  [refresh] HTTP {r.status_code} (attempt {attempt+1})")
            if attempt < 2:
                time.sleep(15)
        except (requests.exceptions.ReadTimeout, requests.exceptions.Timeout) as e:
            print(f"  [refresh] timeout attempt {attempt+1}: {e}")
            if attempt < 2:
                time.sleep(20)
        except requests.exceptions.RequestException as e:
            print(f"  [refresh] erreur réseau attempt {attempt+1}: {e}")
            if attempt < 2:
                time.sleep(15)
    return {}


def load_last_count(today):
    """Charge le total du dernier run pour calculer le delta."""
    path = TRACKING / f"last_count_{today}.json"
    if path.exists():
        try:
            return json.loads(path.read_text()).get("total", 0)
        except Exception:
            pass
    # Fallback : chercher le fichier le plus récent (autre jour)
    candidates = sorted(TRACKING.glob("last_count_*.json"), reverse=True)
    for f in candidates:
        try:
            return json.loads(f.read_text()).get("total", 0)
        except Exception:
            continue
    return 0


def save_last_count(today, total):
    path = TRACKING / f"last_count_{today}.json"
    path.write_text(json.dumps({"total": total, "ts": _now_utc().isoformat()}, indent=2))


def write_notif(today, new_count, total_count):
    title = f"📅 PredictHQ — {new_count} nouveaux événements ({today})"
    body = (
        f"## PredictHQ — {today}\n\n"
        f"**{new_count} nouveaux événements** depuis le dernier refresh.\n\n"
        f"- Total events actifs : {total_count}\n"
        f"- Seuil de notification : +{NEW_EVENTS_THRESHOLD} nouveaux events\n\n"
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
    print(f"  Notif écrite: {path.name}")


def run():
    today = _today_cest()
    ts = _now_utc().isoformat()
    print(f"[{ts}] CRON predicthq_refresh — refresh horaire {today}")

    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})

    token = login(session)
    print("  Auth OK")

    last_count = load_last_count(today)
    print(f"  Dernier total connu : {last_count}")

    refresh_resp = call_refresh(session, token)

    # Extraire le total depuis la réponse
    total_count = 0
    for k in ("count", "total", "active_events"):
        if isinstance(refresh_resp.get(k), (int, float)):
            total_count = int(refresh_resp[k])
            break

    # Fallback : interroger /api/predicthq/status
    if total_count == 0:
        try:
            headers = {"Authorization": f"Bearer {token}"}
            r = session.get(f"{BASE_URL}/api/predicthq/status", headers=headers, timeout=20)
            if r.status_code == 200:
                data = r.json()
                total_count = int(data.get("active_events", 0))
        except Exception as e:
            print(f"  [status fallback] {e}")

    new_count = max(0, total_count - last_count)
    print(f"  Refresh OK — total: {total_count}, nouveaux: {new_count} (delta vs last={last_count})")

    # Sauvegarder pour le prochain run
    save_last_count(today, total_count)

    if new_count >= NEW_EVENTS_THRESHOLD:
        write_notif(today, new_count, total_count)
    else:
        print(f"  RAS — delta {new_count} < seuil {NEW_EVENTS_THRESHOLD}, pas de notification")

    return new_count, total_count


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"[predicthq_refresh] ÉCHEC: {e}", file=sys.stderr)
        sys.exit(1)
