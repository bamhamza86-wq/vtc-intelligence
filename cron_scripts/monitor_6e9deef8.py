"""
monitor_6e9deef8.py — CRON 6e9deef8
Monitoring régression moteur quotidien 6h CEST.
"""
import sys, os, json, subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
for p in [SCRIPT_DIR, Path("/home/user/workspace/cron_scripts")]:
    if (p / "vtc_api_client.py").exists():
        sys.path.insert(0, str(p)); break

from vtc_api_client import login, get_profitability, get_events, get_alerts

BASE      = Path("/home/user/workspace/cron_tracking/6e9deef8")
BASELINES = BASE / "baselines_by_day"
BASE.mkdir(parents=True, exist_ok=True)
BASELINES.mkdir(parents=True, exist_ok=True)

ZONES = [
    "z_cdg", "z_orly", "z_bobigny_gare", "z_plaine_commune", "z_le_bourget",
    "z_saint_denis_gare", "z_aubervilliers", "z_epinay_gennevilliers",
    "z_montreuil", "z_aulnay", "z_villepinte", "z_tremblay",
    "z_93_centre", "z_stade_france"
]
RUSH_HOURS  = [5, 6, 7, 8, 9]
DELTA_ALERT = 15.0


def run():
    now_utc  = datetime.now(timezone.utc)
    today    = (now_utc + timedelta(hours=2)).strftime("%Y-%m-%d")
    ts       = now_utc.isoformat()
    dow      = (now_utc + timedelta(hours=2)).strftime("%A").lower()
    day_type = "weekend" if dow in ("saturday", "sunday") else "weekday"

    print(f"[{ts}] CRON 6e9deef8 — {today} {dow} ({day_type})")

    try:
        token = login()
        print("  Auth OK")
    except Exception as e:
        _log(ts, today, day_type, dow, 0, [], error=str(e))
        return

    # Collecte h=5..9
    scores = {z: {} for z in ZONES}
    for h in RUSH_HOURS:
        try:
            raw = get_profitability(token, h)
            for item in raw:
                z = item.get("zone_id")
                if z in ZONES:
                    scores[z][f"h{h}"] = item.get("profitability_index", 0)
        except Exception as e:
            print(f"  profitability h={h}: {e}")

    # Baseline
    bl_path = BASELINES / f"{dow}_baseline.json"
    if not bl_path.exists():
        print(f"  Baseline {dow} absent — initialisation")
        _save_baseline(bl_path, today, day_type, dow, scores)
        _update_main(today, scores)
        _log(ts, today, day_type, dow, 0, [], note=f"Baseline {dow} initialisé")
        return

    baseline = json.loads(bl_path.read_text())
    if baseline.get("day_type") != day_type:
        print(f"  Mismatch day_type — réinitialisation")
        _save_baseline(bl_path, today, day_type, dow, scores)
        _update_main(today, scores)
        _log(ts, today, day_type, dow, 0, [], note="Baseline réinitialisé (day_type mismatch)")
        return

    # Calcul deltas
    regressions = []
    for z in ZONES:
        avg_bl    = _avg(baseline.get("zones", {}).get(z, {}))
        avg_today = _avg(scores.get(z, {}))
        if avg_bl <= 0 or avg_today <= 0:
            continue
        delta_pct = (avg_today - avg_bl) / avg_bl * 100
        if abs(delta_pct) > DELTA_ALERT:
            regressions.append({"zone": z, "avg_baseline": round(avg_bl, 1),
                                 "avg_today": round(avg_today, 1),
                                 "delta_pct": round(delta_pct, 1)})

    # Events / alertes
    try:
        events = get_events(token)
        alerts = get_alerts(token)
        event_zones = {ev.get("zone_id") for ev in (events if isinstance(events, list) else [])
                       if isinstance(ev.get("zone_id"), str)}
        has_alert   = any(a.get("type") in ("transport_disruption", "meteo")
                          for a in (alerts if isinstance(alerts, list) else []))
    except Exception:
        event_zones, has_alert = set(), False

    suspects = []
    for r in regressions:
        if r["zone"] not in event_zones and not has_alert:
            r["cause"] = "RÉGRESSION SUSPECTE"
            suspects.append(r)
        else:
            r["cause"] = "event/alerte actif"

    print(f"  Suspects: {len(suspects)} / Régressions: {len(regressions)}")

    if suspects:
        _create_issue(today, suspects)
        _write_notif(today, ts, suspects)
    else:
        _save_baseline(bl_path, today, day_type, dow, scores)
        _update_main(today, scores)

    _log(ts, today, day_type, dow, len(suspects), suspects)
    _save_report(today, ts, day_type, dow, regressions, suspects)


def _avg(d):
    vals = [v for k, v in d.items() if k.startswith("h") and isinstance(v, (int, float)) and v > 0]
    return sum(vals) / len(vals) if vals else 0.0

def _save_baseline(path, today, day_type, dow, scores):
    path.write_text(json.dumps({
        "date": today, "day_type": day_type, "day_of_week": dow,
        "zones": {z: {f"h{h}": scores.get(z, {}).get(f"h{h}", 0) for h in RUSH_HOURS} for z in ZONES}
    }, indent=2))

def _update_main(today, scores):
    (BASE / "baseline_scores.json").write_text(json.dumps({
        "date": today, "run_at": datetime.now(timezone.utc).isoformat(), "scores": scores
    }, indent=2))

def _log(ts, today, day_type, dow, n, suspects, note=None, error=None):
    with open(BASE / "run_log.jsonl", "a") as f:
        f.write(json.dumps({
            "date": today, "run_at": ts, "day_type": day_type, "day_of_week": dow,
            "zones_checked": len(ZONES), "regressions_found": n,
            "flagged_zones": [r["zone"] for r in suspects],
            "note": note, "error": error
        }) + "\n")

def _save_report(today, ts, day_type, dow, all_r, suspects):
    (BASE / "last_run_report.json").write_text(json.dumps({
        "date": today, "run_at": ts, "day_type": day_type, "day_of_week": dow,
        "total_regressions": len(all_r), "suspects": len(suspects), "details": all_r
    }, indent=2))

def _create_issue(today, suspects):
    zones_str = ", ".join(r["zone"] for r in suspects)
    rows = "\n".join(f"| {r['zone']} | {r['avg_baseline']} | {r['avg_today']}"
                     f" | {r['delta_pct']:+.1f}% | {r['cause']} |" for r in suspects)
    title = f"⚠️ Régression moteur détectée — {today} [{zones_str}]"
    body  = (f"## Régression — {today}\n\n"
             f"| Zone | Score J-1 | Score J | Δ | Cause |\n"
             f"|------|-----------|---------|---|-------|\n{rows}\n\n"
             f"### Recommandation\nVérifier `storage.ts` → seeds/peakHours/demandBoost.\n"
             f"Relancer : `npx tsx scripts/test_engine_refinements.ts`")
    (BASE / f"pending_issue_{today}.json").write_text(
        json.dumps({"title": title, "body": body}, indent=2, ensure_ascii=False))

def _write_notif(today, ts, suspects):
    zones_str = ", ".join(r["zone"] for r in suspects)
    (BASE / f"pending_notif_{today}.json").write_text(json.dumps({
        "title": f"⚠️ Régression VTC détectée — {today}",
        "body": f"{len(suspects)} zone(s) suspecte(s) : {zones_str}",
        "channels": ["in_app"]
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    run()
