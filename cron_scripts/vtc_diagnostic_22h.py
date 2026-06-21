"""
vtc_diagnostic_22h.py — CRON af286c4e
Diagnostic prédictions matin vs scores réels soir + notification email.
Exécuté à 22h00 CEST / 20h00 UTC, lun-ven.
"""
import sys, json
from datetime import datetime, timezone, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
for p in [SCRIPT_DIR, Path("/home/user/workspace/cron_scripts")]:
    if (p / "vtc_api_client.py").exists():
        sys.path.insert(0, str(p)); break

from vtc_api_client import login, get_profitability, get_routing_status

DIAG_DIR = Path("/home/user/workspace/cron_tracking/vtc_diagnostic")
DIAG_DIR.mkdir(parents=True, exist_ok=True)

ZONES_93 = [
    "z_bobigny_gare", "z_plaine_commune", "z_le_bourget", "z_saint_denis_gare",
    "z_aubervilliers", "z_epinay_gennevilliers", "z_montreuil", "z_aulnay",
    "z_villepinte", "z_tremblay", "z_93_centre", "z_stade_france"
]
RUSH_HOURS  = [5, 6, 7, 8, 9]
ERR_THRESH  = 20.0


def run():
    now_utc  = datetime.now(timezone.utc)
    today    = (now_utc + timedelta(hours=2)).strftime("%Y-%m-%d")
    tomorrow = (now_utc + timedelta(hours=2, days=1)).strftime("%Y-%m-%d")
    ts       = now_utc.isoformat()
    cest_now = (now_utc + timedelta(hours=2)).strftime("%d/%m/%Y %H:%M CEST")

    print(f"[{ts}] CRON af286c4e — diagnostic {today}")

    token = login()
    print("  Auth OK")

    # Source ETA active au moment du diagnostic (soir)
    routing_source_now = "unknown"
    tomtom_hits = None
    try:
        routing_status = get_routing_status(token)
        routing_source_now = routing_status.get("routing_priority", "unknown")
        tomtom_hits = routing_status.get("tomtomHits")
        print(f"  Source ETA active (soir): {routing_source_now} (tomtomHits={tomtom_hits})")
    except Exception as e:
        print(f"  routing-status: ERREUR {e}")

    # Scores réels soir + source distance par zone
    real_scores, tomorrow_preds = {}, {}
    zone_source_now = {}
    for h in RUSH_HOURS:
        raw = get_profitability(token, h)
        for item in raw:
            z = item.get("zone_id")
            if z in ZONES_93:
                idx = item.get("profitability_index", 0)
                real_scores.setdefault(z, {})[str(h)] = idx
                tomorrow_preds.setdefault(z, {})[str(h)] = idx
                # distanceSource désormais retourné par /api/profitability
                ds = item.get("distanceSource")
                if ds:
                    zone_source_now[z] = ds

    # Prédictions matin
    pred_path = DIAG_DIR / f"predictions_{today}.json"
    morning_preds = {}
    morning_routing_source = "unknown"
    if pred_path.exists():
        pred_data = json.loads(pred_path.read_text())
        morning_preds = pred_data.get("predictions", {})
        morning_routing_source = pred_data.get("routing_source", "unknown")
        print(f"  Prédictions matin: {len(morning_preds)} zones (source ETA matin: {morning_routing_source})")
    else:
        print(f"  ⚠ Pas de prédictions matin pour {today}")

    # Flags changement de source ETA (tomtom → osrm peut indiquer un quota épuisé)
    source_changed_global = (
        morning_routing_source not in ("unknown",)
        and routing_source_now not in ("unknown",)
        and morning_routing_source != routing_source_now
    )
    source_downgrade = (morning_routing_source == "tomtom" and routing_source_now != "tomtom")
    if source_changed_global:
        print(f"  ⚠ Source ETA changée: {morning_routing_source} → {routing_source_now}"
              + (" (DOWNGRADE — quota TomTom ?)" if source_downgrade else ""))

    # Calcul flags
    flagged = []
    for z in ZONES_93:
        for h in RUSH_HOURS:
            pred = morning_preds.get(z, {}).get(str(h))
            real = real_scores.get(z, {}).get(str(h))
            if pred and real and pred > 0 and real > 0:
                err = abs(real - pred) / pred * 100
                if err > ERR_THRESH:
                    flagged.append({
                        "zone": z, "hour": h,
                        "predicted": pred, "actual": real,
                        "error_pct": round(err, 1),
                        "direction": "SOUS-ESTIMÉ" if real > pred else "SUR-ESTIMÉ"
                    })

    flagged.sort(key=lambda x: x["error_pct"], reverse=True)
    print(f"  Flags: {len(flagged)}")

    # Sauvegarde
    (DIAG_DIR / f"diagnostic_{today}.json").write_text(json.dumps({
        "date": today, "run_at": ts,
        "zones_checked": len(ZONES_93), "hours_checked": len(RUSH_HOURS),
        "flags_count": len(flagged), "flagged": flagged,
        "routing_source_morning": morning_routing_source,
        "routing_source_evening": routing_source_now,
        "routing_source_changed": source_changed_global,
        "routing_source_downgrade": source_downgrade,
        "tomtom_hits": tomtom_hits,
        "zone_source_now": zone_source_now,
        "tomorrow_predictions": tomorrow_preds,
        "real_scores_22h": real_scores
    }, indent=2, ensure_ascii=False))

    with open(DIAG_DIR / "run_log.jsonl", "a") as f:
        f.write(json.dumps({"date": today, "flags": len(flagged), "run_at": ts}) + "\n")

    # Email
    if flagged:
        subj = f"⚠️ VTC Diagnostic {today} — {len(flagged)} anomalie(s) détectée(s)"
        rows = "\n".join(
            f"| {f['zone']} | h={f['hour']} | {f['predicted']} | {f['actual']}"
            f" | {f['error_pct']}% | {f['direction']} |"
            for f in flagged
        )
        anomaly = ("### ⚠️ Anomalies détectées\n\n"
                   "| Zone | Heure | Prédit | Réel | Erreur | Direction |\n"
                   "|------|-------|--------|------|--------|-----------|\n"
                   f"{rows}\n\n"
                   "**Recommandation :** Ajuster les poids avant le rush du lendemain matin.")
    else:
        subj   = f"✅ VTC Diagnostic {today} — Prédictions stables"
        anomaly = "### ✅ Aucune anomalie détectée\n\nToutes les prédictions sont dans la tolérance (±20%)."

    pred_rows = "\n".join(
        f"| {z} | {tomorrow_preds.get(z,{}).get('5','—')} "
        f"| {tomorrow_preds.get(z,{}).get('6','—')} "
        f"| {tomorrow_preds.get(z,{}).get('7','—')} "
        f"| {tomorrow_preds.get(z,{}).get('8','—')} "
        f"| {tomorrow_preds.get(z,{}).get('9','—')} |"
        for z in ZONES_93
    )
    pred_sec = (f"### 📊 Prédictions modèle pour demain matin ({tomorrow})\n\n"
                f"| Zone | h=5 | h=6 | h=7 | h=8 | h=9 |\n"
                f"|------|-----|-----|-----|-----|-----|\n"
                f"{pred_rows}")

    # ── Section Source données ETA (TomTom vs OSRM) ──────────────────────────
    src_label = {"tomtom": "TomTom", "osrm": "OSRM", "calibrated": "Calibré (interne)"}
    morning_lbl = src_label.get(morning_routing_source, morning_routing_source)
    evening_lbl = src_label.get(routing_source_now, routing_source_now)
    if source_downgrade:
        src_alert = ("\n\n**⚠️ Changement de source détecté :** "
                     f"{morning_lbl} (matin) → {evening_lbl} (soir). "
                     "Un passage TomTom → OSRM peut indiquer un **quota TomTom épuisé** "
                     "— les ETA peuvent être moins précis. À surveiller.")
    elif source_changed_global:
        src_alert = (f"\n\n**ℹ️ Changement de source :** {morning_lbl} (matin) → {evening_lbl} (soir).")
    else:
        src_alert = "\n\n✅ Source ETA stable sur la journée."
    tomtom_hits_line = f"\n- TomTom hits : {tomtom_hits}" if tomtom_hits is not None else ""
    src_sec = ("### 🛰️ Source données ETA\n\n"
               f"- Source active ce soir : **{evening_lbl}**\n"
               f"- Source au rush matin : **{morning_lbl}**{tomtom_hits_line}"
               f"{src_alert}")

    body = (f"# VTC Intelligence — Rapport diagnostic {today}\n\n"
            f"*Généré le {cest_now}*\n\n"
            f"{src_sec}\n\n"
            f"{anomaly}\n\n{pred_sec}\n\n"
            f"---\n*Seuil d'alerte : 20% d'écart prédit/réel*")

    draft_path = DIAG_DIR / f"email_draft_{today}.md"
    draft_path.write_text(f"# {subj}\n\n{body}")

    # Écrire notification pending pour le main agent
    (DIAG_DIR / f"pending_email_{today}.json").write_text(json.dumps({
        "subject": subj, "body": body,
        "flags_count": len(flagged), "date": today,
        "routing_source_morning": morning_routing_source,
        "routing_source_evening": routing_source_now,
        "routing_source_downgrade": source_downgrade
    }, indent=2, ensure_ascii=False))

    print(f"  Draft: {draft_path.name} | subject: {subj}")
    return len(flagged), subj, body


if __name__ == "__main__":
    n, subj, body = run()
    print(f"\nOK — {n} flags. Notification pending écrite.")
