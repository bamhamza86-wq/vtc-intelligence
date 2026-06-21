#!/usr/bin/env python3
"""
predicthq_daily_digest.py — Cron VTC Intelligence
Digest quotidien des événements PredictHQ pour les 7 prochains jours.
Schedule: 0 4 * * *   (04h00 UTC = 06h00 CEST)

Flux :
  1. Appel DIRECT à l'API PredictHQ (pas via le serveur VTC).
  2. Calcule le demand_boost de chaque event (rank + attendance).
  3. Mappe chaque event vers la zone VTC la plus proche.
  4. Sauvegarde cron_tracking/predicthq/digest_{date}.json.
  5. Si un event de rank >= 70 démarre dans les prochaines 24h →
     écrit pending_notif_{date}_urgent.json.
"""
import json
import math
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

WORKSPACE = Path("/home/user/workspace")
TRACKING = WORKSPACE / "cron_tracking" / "predicthq"
TRACKING.mkdir(parents=True, exist_ok=True)

PHQ_KEY = "H6vO4zDmjgTpPlXZUrewsFE-NLPD1wTHeowBiRHo"
PHQ_BASE = "https://api.predicthq.com/v1"

CATEGORIES = "concerts,sports,festivals,performing-arts,community,conferences,expos"
CENTER = "48.9200,2.3900"  # centre 93 (z_93_centre)
URGENT_RANK = 70
URGENT_WINDOW_H = 24

# ─── Zones VTC (14) ───────────────────────────────────────────────────────────
ZONES = {
    'z_cdg': (49.0097, 2.5479), 'z_orly': (48.7262, 2.3652),
    'z_saint_denis_gare': (48.9362, 2.3560), 'z_bobigny_gare': (48.9011, 2.4400),
    'z_aubervilliers': (48.9144, 2.3831), 'z_plaine_commune': (48.9221, 2.3427),
    'z_le_bourget': (48.9411, 2.4256), 'z_villepinte': (48.9668, 2.5311),
    'z_tremblay': (48.9578, 2.5756), 'z_epinay_gennevilliers': (48.9510, 2.3120),
    'z_montreuil': (48.8636, 2.4432), 'z_aulnay': (48.9395, 2.4978),
    'z_93_centre': (48.9200, 2.3900), 'z_stade_france': (48.9244, 2.3600),
}


def nearest_zone(lat, lng):
    """Distance euclidienne simple → retourne le zone_id le plus proche."""
    best_id, best_d = None, float("inf")
    for zid, (zlat, zlng) in ZONES.items():
        d = math.hypot(lat - zlat, lng - zlng)
        if d < best_d:
            best_d, best_id = d, zid
    return best_id


def calc_boost(rank, attendance):
    if rank >= 80:
        return min(2.5, 2.0 + attendance / 50000)
    elif rank >= 60:
        return min(2.0, 1.5 + attendance / 100000)
    elif rank >= 40:
        return 1.3
    else:
        return 1.1


def _now_utc():
    return datetime.now(timezone.utc)


def _today_cest():
    return (_now_utc() + timedelta(hours=2)).strftime("%Y-%m-%d")


def fetch_events():
    """GET /v1/events sur 7 jours, rank_level 3-5, catégories ciblées."""
    today = _now_utc().strftime("%Y-%m-%d")
    end = (_now_utc() + timedelta(days=7)).strftime("%Y-%m-%d")
    params = {
        "within": f"40km@{CENTER}",
        "category": CATEGORIES,
        "active.gte": today,
        "active.lte": end,
        "rank_level": "3,4,5",
        "limit": "50",
    }
    headers = {
        "Authorization": f"Bearer {PHQ_KEY}",
        "Accept": "application/json",
    }
    r = requests.get(f"{PHQ_BASE}/events/", params=params, headers=headers, timeout=30)
    r.raise_for_status()
    data = r.json()
    return data.get("results", []), data.get("count", 0)


def map_event(raw):
    """Mappe un event brut → dict enrichi (zone, boost)."""
    coords = raw.get("geo", {}).get("geometry", {}).get("coordinates")
    lat, lng = CENTER.split(",")
    lat, lng = float(lat), float(lng)
    if isinstance(coords, list) and len(coords) >= 2:
        lng, lat = float(coords[0]), float(coords[1])
    elif isinstance(raw.get("location"), list) and len(raw["location"]) >= 2:
        lng, lat = float(raw["location"][0]), float(raw["location"][1])

    rank = int(raw.get("rank") or 0)
    attendance = int(raw.get("phq_attendance") or 0)
    start = raw.get("start") or raw.get("start_local") or _now_utc().isoformat()
    end = raw.get("end") or raw.get("end_local") or start
    spend = 0.0
    pesi = raw.get("predicted_event_spend_industries")
    if isinstance(pesi, dict):
        spend = float(pesi.get("transportation") or 0)
    elif raw.get("predicted_event_spend"):
        spend = float(raw["predicted_event_spend"])

    zone_id = nearest_zone(lat, lng)
    boost = round(calc_boost(rank, attendance), 2)

    return {
        "id": str(raw.get("id")),
        "title": raw.get("title", "(sans titre)"),
        "category": raw.get("category", "unknown"),
        "zone_id": zone_id,
        "start_time": start,
        "end_time": end,
        "rank": rank,
        "local_rank": int(raw.get("local_rank") or 0),
        "phq_attendance": attendance,
        "transport_spend": round(spend, 2),
        "demand_boost": boost,
        "lat": round(lat, 6),
        "lng": round(lng, 6),
    }


def hours_until(start_str):
    try:
        s = start_str.replace("Z", "+00:00")
        start = datetime.fromisoformat(s)
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        return (start - _now_utc()).total_seconds() / 3600.0
    except Exception:
        return float("inf")


def write_urgent_notif(today, urgent):
    rows = "\n".join(
        f"- **{e['title']}** ({e['category']}) — rank {e['rank']}, "
        f"zone `{e['zone_id']}`, boost ×{e['demand_boost']}, "
        f"début {e['start_time']}"
        for e in urgent
    )
    title = f"🚨 PredictHQ — {len(urgent)} événement(s) majeur(s) dans les 24h ({today})"
    body = (
        f"## Événements majeurs imminents — {today}\n\n"
        f"{len(urgent)} événement(s) de rank ≥ {URGENT_RANK} démarrent "
        f"dans les prochaines {URGENT_WINDOW_H}h :\n\n"
        f"{rows}\n\n"
        f"### Recommandation\n"
        f"Anticiper la hausse de demande sur les zones concernées."
    )
    path = TRACKING / f"pending_notif_{today}_urgent.json"
    path.write_text(
        json.dumps(
            {"title": title, "body": body, "channels": ["in_app"]},
            indent=2,
            ensure_ascii=False,
        )
    )
    print(f"  Notif URGENTE écrite: {path}")


def run():
    today = _today_cest()
    ts = _now_utc().isoformat()
    print(f"[{ts}] CRON predicthq_daily_digest — digest 7j {today}")

    raw_events, total = fetch_events()
    print(f"  API PredictHQ → {len(raw_events)} events (count total: {total})")

    events = []
    for raw in raw_events:
        try:
            events.append(map_event(raw))
        except Exception as e:
            print(f"  [map] skip event: {e}")

    # Agrégation par zone
    by_zone = {}
    for e in events:
        by_zone.setdefault(e["zone_id"], 0)
        by_zone[e["zone_id"]] += 1

    digest = {
        "date": today,
        "generated_at": ts,
        "total_count": total,
        "events_returned": len(events),
        "events_by_zone": by_zone,
        "events": events,
    }
    out_path = TRACKING / f"digest_{today}.json"
    out_path.write_text(json.dumps(digest, indent=2, ensure_ascii=False))
    print(f"  Digest sauvegardé: {out_path} ({len(events)} events, {len(by_zone)} zones)")

    # Événements majeurs imminents
    urgent = [
        e for e in events
        if e["rank"] >= URGENT_RANK and 0 <= hours_until(e["start_time"]) <= URGENT_WINDOW_H
    ]
    if urgent:
        write_urgent_notif(today, urgent)
    else:
        print("  RAS — aucun event majeur (rank ≥ 70) dans les prochaines 24h")

    return len(events), len(urgent)


if __name__ == "__main__":
    try:
        n, u = run()
        print(f"\nOK — {n} events sauvegardés, {u} urgents.")
    except Exception as e:
        print(f"[predicthq_daily_digest] ÉCHEC: {e}", file=sys.stderr)
        sys.exit(1)
