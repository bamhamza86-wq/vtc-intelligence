#!/usr/bin/env python3
"""
predicthq_daily_digest.py — Cron VTC Intelligence
Digest quotidien des événements PredictHQ pour les 7 prochains jours.
Schedule: 0 4 * * *   (04h00 UTC = 06h00 CEST)

Flux (PROXY via serveur VTC — pas d'appel direct à api.predicthq.com) :
  1. Auth POST /api/auth/login avec retry cold-start.
  2. POST /api/predicthq/refresh  — force le chargement des events dans la DB.
  3. GET  /api/predicthq/events   — récupère tous les events actifs en DB.
  4. GET  /api/predicthq/status   — total, max_boost, last_fetch.
  5. Calcule les events urgents (rank >= 70, démarrent dans < 24h).
  6. Sauvegarde digest_{date}.json.
  7. Si events urgents → pending_notif_{date}_urgent.json.
  8. Termine silencieusement sinon.
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

URGENT_RANK = 70
URGENT_WINDOW_H = 24

# Retries cold-start (sandbox E2B peut être suspendu)
COLD_START_DELAYS = [10, 20, 30, 40, 40, 40]
AUTH_TIMEOUT = 40
API_TIMEOUT = 90


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
                raise RuntimeError(f"Auth échouée: {e}")
    raise RuntimeError("Auth échouée (boucle épuisée)")


def call_refresh(session, token):
    """Force le refresh PredictHQ sur le serveur (mise à jour DB)."""
    url = f"{BASE_URL}/api/predicthq/refresh"
    headers = {"Authorization": f"Bearer {token}"}
    for attempt in range(3):
        try:
            r = session.post(url, headers=headers, json={}, timeout=API_TIMEOUT)
            if r.status_code == 200:
                data = r.json()
                print(f"  Refresh OK — count={data.get('count', '?')}")
                return data
            print(f"  [refresh] HTTP {r.status_code} (attempt {attempt+1})")
        except (requests.exceptions.ReadTimeout, requests.exceptions.Timeout) as e:
            print(f"  [refresh] timeout attempt {attempt+1}: {e}")
        except requests.exceptions.RequestException as e:
            print(f"  [refresh] erreur attempt {attempt+1}: {e}")
        if attempt < 2:
            time.sleep(15)
    return {}


def fetch_all_events(session, token):
    """GET /api/predicthq/events (sans zone_id = tous les events en DB)."""
    url = f"{BASE_URL}/api/predicthq/events"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = session.get(url, headers=headers, timeout=30)
        if r.status_code == 200:
            data = r.json()
            return data.get("events", []), data.get("total", 0)
    except Exception as e:
        print(f"  [fetch_events] {e}")
    return [], 0


def fetch_status(session, token):
    """GET /api/predicthq/status."""
    url = f"{BASE_URL}/api/predicthq/status"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = session.get(url, headers=headers, timeout=20)
        if r.status_code == 200:
            return r.json()
    except Exception as e:
        print(f"  [status] {e}")
    return {}


def hours_until(start_str):
    """Calcule les heures avant le début d'un event."""
    try:
        s = str(start_str).replace("Z", "+00:00")
        if "T" not in s:
            s = s + "T00:00:00+00:00"
        start = datetime.fromisoformat(s)
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        return (start - _now_utc()).total_seconds() / 3600.0
    except Exception:
        return float("inf")


def write_urgent_notif(today, urgent):
    rows = "\n".join(
        f"- **{e.get('title', '?')}** ({e.get('category', '?')}) "
        f"— rank {e.get('rank', '?')}, zone `{e.get('zone_id', '?')}`, "
        f"boost ×{e.get('demand_boost', 1.0)}, début {str(e.get('start', e.get('start_time', '')))[:10]}"
        for e in urgent
    )
    title = f"🚨 PredictHQ — {len(urgent)} événement(s) majeur(s) dans les 24h ({today})"
    body = (
        f"## Événements majeurs imminents — {today}\n\n"
        f"{len(urgent)} événement(s) de rank ≥ {URGENT_RANK} démarrent "
        f"dans les prochaines {URGENT_WINDOW_H}h :\n\n"
        f"{rows}\n\n"
        f"### Recommandation\n"
        f"Anticiper la hausse de demande sur les zones concernées — "
        f"voir le dashboard https://vtc-one.pplx.app"
    )
    path = TRACKING / f"pending_notif_{today}_urgent.json"
    path.write_text(
        json.dumps(
            {"title": title, "body": body, "channels": ["in_app"]},
            indent=2,
            ensure_ascii=False,
        )
    )
    print(f"  Notif URGENTE écrite: {path.name}")


def run():
    today = _today_cest()
    ts = _now_utc().isoformat()
    print(f"[{ts}] CRON predicthq_daily_digest — digest 7j {today}")

    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})

    token = login(session)
    print("  Auth OK")

    # 1) Forcer un refresh pour avoir les données fraîches
    call_refresh(session, token)

    # 2) Récupérer tous les events depuis la DB via le serveur VTC
    events, total_api = fetch_all_events(session, token)
    print(f"  Events récupérés: {len(events)} (total API: {total_api})")

    # 3) Status global
    status = fetch_status(session, token)
    active_events = status.get("active_events", len(events))
    max_boost = status.get("max_boost", 1.0)
    last_fetch = status.get("last_fetch", ts)

    # 4) Agrégation par zone
    by_zone = {}
    for e in events:
        zid = e.get("zone_id", "unknown")
        by_zone.setdefault(zid, 0)
        by_zone[zid] += 1

    # 5) Events urgents (rank >= 70, dans les 24 prochaines heures)
    urgent = [
        e for e in events
        if (e.get("rank", 0) >= URGENT_RANK
            and 0 <= hours_until(e.get("start") or e.get("start_time", "")) <= URGENT_WINDOW_H)
    ]

    # 6) Sauvegarder le digest
    digest = {
        "date": today,
        "generated_at": ts,
        "source": "vtc-one.pplx.app (proxy DB)",
        "status": status,
        "active_events": active_events,
        "max_boost": max_boost,
        "last_phq_fetch": last_fetch,
        "events_returned": len(events),
        "events_by_zone": by_zone,
        "urgent_count": len(urgent),
        "urgent_events": urgent,
        "events": events,
    }
    out_path = TRACKING / f"digest_{today}.json"
    out_path.write_text(json.dumps(digest, indent=2, ensure_ascii=False))
    print(f"  Digest sauvegardé: {out_path.name} ({len(events)} events, {len(by_zone)} zones)")

    # 7) Notification si events urgents
    if urgent:
        write_urgent_notif(today, urgent)
    else:
        print(f"  RAS — aucun event de rank >= {URGENT_RANK} dans les {URGENT_WINDOW_H}h")

    return len(events), len(urgent)


if __name__ == "__main__":
    try:
        n, u = run()
        print(f"\nOK — {n} events sauvegardés, {u} urgents.")
    except Exception as e:
        print(f"[predicthq_daily_digest] ÉCHEC: {e}", file=sys.stderr)
        sys.exit(1)
