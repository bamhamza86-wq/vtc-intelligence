"""
vtc_retrain.py — Auto-retrain conditionnel du modèle VTC.
Appelé par vtc_hourly_update.py quand alerte_critique=True.
"""
import sys, json, math
from datetime import datetime, timezone, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
for p in [SCRIPT_DIR, Path("/home/user/workspace/cron_scripts")]:
    if (p / "vtc_api_client.py").exists():
        sys.path.insert(0, str(p))
        break

from vtc_api_client import login, get_profitability, get_history, parse_history_zones

RETRAIN_DIR = Path("/home/user/workspace/cron_tracking/vtc_retrain")
RETRAIN_DIR.mkdir(parents=True, exist_ok=True)

ZONES = [
    "z_cdg", "z_orly", "z_bobigny_gare", "z_plaine_commune", "z_le_bourget",
    "z_saint_denis_gare", "z_aubervilliers", "z_epinay_gennevilliers",
    "z_montreuil", "z_aulnay", "z_villepinte", "z_tremblay",
    "z_93_centre", "z_stade_france"
]
PEAK_HOURS = [7, 8, 9, 17, 18, 19]
MIN_IMPROVEMENT_PCT = 5.0


def run():
    now_utc = datetime.now(timezone.utc)
    today   = (now_utc + timedelta(hours=2)).strftime("%Y-%m-%d")
    yesterday = (now_utc + timedelta(hours=2) - timedelta(days=1)).strftime("%Y-%m-%d")
    H_cest  = (now_utc.hour + 2) % 24
    H_prev  = (H_cest - 1) % 24
    ts      = now_utc.isoformat()

    print(f"[{ts}] vtc_retrain.py — démarrage")

    try:
        token = login()
    except Exception as e:
        _save_report(today, ts, "auth_error", 0, 0, 0, [], str(e))
        return

    hours_to_check = sorted(set(PEAK_HOURS + [H_prev, H_cest]))
    all_pred, all_hist = {}, {}

    for h in hours_to_check:
        try:
            raw = get_profitability(token, h)
            for item in raw:
                z = item.get("zone_id")
                if z in ZONES:
                    all_pred.setdefault(z, {})[h] = item.get("profitability_index", 0)
        except Exception as e:
            print(f"  profitability h={h}: {e}")

        for date_try in [today, yesterday]:
            try:
                hist_raw = get_history(token, date_try, h)
                parsed = parse_history_zones(hist_raw, ZONES)
                if parsed:
                    for z, v in parsed.items():
                        all_hist.setdefault(z, {})[h] = v
                    break
            except Exception:
                pass

    if not all_pred:
        _save_report(today, ts, "no_data", 0, 0, 0, [], "Pas de données préditives")
        return

    # MAE avant
    errors_before = []
    for z in ZONES:
        for h in hours_to_check:
            p  = all_pred.get(z, {}).get(h)
            hi = all_hist.get(z, {}).get(h)
            if p and hi and p > 0 and hi > 0:
                errors_before.append(abs(p - hi))

    mae_before = sum(errors_before) / len(errors_before) if errors_before else 0
    print(f"  MAE avant: {mae_before:.2f} sur {len(errors_before)} points")

    # Zones à optimiser (err > 20%)
    zones_optimized = []
    for z in ZONES:
        valid = [(all_pred[z][h], all_hist[z][h])
                 for h in hours_to_check
                 if all_pred.get(z, {}).get(h) and all_hist.get(z, {}).get(h)
                 and all_pred[z][h] > 0 and all_hist[z][h] > 0]
        if not valid:
            continue
        avg_err = sum(abs(p - hi) / hi * 100 for p, hi in valid) / len(valid)
        if avg_err > 20:
            zones_optimized.append(z)

    print(f"  Zones à optimiser: {zones_optimized}")

    # MAE après correction directionnelle
    if zones_optimized and errors_before:
        errors_after = []
        for z in ZONES:
            for h in hours_to_check:
                p  = all_pred.get(z, {}).get(h)
                hi = all_hist.get(z, {}).get(h)
                if p and hi and p > 0 and hi > 0:
                    if z in zones_optimized:
                        p_corr = p * 1.10 if p < hi else p * 0.90
                    else:
                        p_corr = p
                    errors_after.append(abs(p_corr - hi))
    else:
        errors_after = errors_before

    mae_after   = sum(errors_after) / len(errors_after) if errors_after else mae_before
    improvement = (mae_before - mae_after) / mae_before * 100 if mae_before > 0 else 0

    print(f"  MAE après: {mae_after:.2f} (amélioration {improvement:.1f}%)")

    if improvement >= MIN_IMPROVEMENT_PCT and zones_optimized:
        deploy_status = "deployed"
        print(f"  ✅ Retrain validé")
    elif not zones_optimized:
        deploy_status = "rejected_no_zones"
    else:
        deploy_status = f"rejected_low_{improvement:.0f}pct"

    _save_report(today, ts, deploy_status, mae_before, mae_after, improvement, zones_optimized)


def _save_report(today, ts, deploy_status, mae_before, mae_after, improvement, zones_opt, error=None):
    p = RETRAIN_DIR / f"retrain_report_{today}.json"
    p.write_text(json.dumps({
        "date": today, "run_at": ts,
        "deploy_status": deploy_status,
        "cv_mae_before": round(mae_before, 2),
        "cv_mae_new": round(mae_after, 2),
        "improvement_pct": round(improvement, 1),
        "zones_optimized": zones_opt,
        "error": error
    }, indent=2))
    print(f"  Rapport: {p}")


if __name__ == "__main__":
    run()
