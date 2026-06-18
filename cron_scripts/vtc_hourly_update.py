"""
vtc_hourly_update.py — CRON b3ed8968
Monitoring horaire prédits vs historique + auto-retrain conditionnel.
Exécuté toutes les heures (0 * * * * UTC).

IMPORTANT: Ce script se clone depuis GitHub si les dépendances sont absentes.
"""
import sys, os, json, math, subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ── Bootstrap : s'assurer que vtc_api_client est disponible ─────────────────
SCRIPT_DIR = Path(__file__).parent.resolve()
REPO_URL   = "https://github.com/bamhamza86-wq/vtc-intelligence.git"
REPO_DIR   = Path("/home/user/workspace/vtc-repo")

def _ensure_deps():
    """Clone/pull le repo si vtc_api_client manque."""
    client_paths = [
        SCRIPT_DIR / "vtc_api_client.py",
        REPO_DIR / "cron_scripts" / "vtc_api_client.py",
        Path("/home/user/workspace/cron_scripts/vtc_api_client.py"),
    ]
    for p in client_paths:
        if p.exists():
            sys.path.insert(0, str(p.parent))
            return str(p.parent)

    # Aucun client trouvé — cloner le repo
    print("  [bootstrap] vtc_api_client manquant — clone repo...")
    try:
        if not REPO_DIR.exists():
            subprocess.run(["git", "clone", "--depth=1", REPO_URL, str(REPO_DIR)],
                           capture_output=True, timeout=60)
        else:
            subprocess.run(["git", "-C", str(REPO_DIR), "pull", "--ff-only"],
                           capture_output=True, timeout=30)
        client_in_repo = REPO_DIR / "cron_scripts" / "vtc_api_client.py"
        if client_in_repo.exists():
            sys.path.insert(0, str(client_in_repo.parent))
            return str(client_in_repo.parent)
    except Exception as e:
        print(f"  [bootstrap] Clone échoué: {e}")
    raise ImportError("Impossible de trouver vtc_api_client.py")

_client_dir = _ensure_deps()

from vtc_api_client import login, get_profitability, get_history, parse_history_zones

# ── Configuration ────────────────────────────────────────────────────────────
BASE = Path("/home/user/workspace/cron_tracking/vtc_hourly")
BASE.mkdir(parents=True, exist_ok=True)

ZONES = [
    "z_cdg", "z_orly", "z_bobigny_gare", "z_plaine_commune", "z_le_bourget",
    "z_saint_denis_gare", "z_aubervilliers", "z_epinay_gennevilliers",
    "z_montreuil", "z_aulnay", "z_villepinte", "z_tremblay",
    "z_93_centre", "z_stade_france"
]
ALERTE_MAE   = 15.0
ALERTE_KL    = 0.05
ALERTE_FLAGS = 3


def kl_divergence(p_vals, q_vals):
    eps = 1e-9
    sp, sq = sum(p_vals) + eps, sum(q_vals) + eps
    p = [v / sp for v in p_vals]
    q = [v / sq for v in q_vals]
    return sum(pi * math.log((pi + eps) / (qi + eps)) for pi, qi in zip(p, q))


def run():
    now_utc = datetime.now(timezone.utc)
    H_utc   = now_utc.hour
    H_cest  = (H_utc + 2) % 24
    H_prev  = (H_cest - 1) % 24
    today   = (now_utc + timedelta(hours=2)).strftime("%Y-%m-%d")
    yesterday = (now_utc + timedelta(hours=2) - timedelta(days=1)).strftime("%Y-%m-%d")
    dow     = (now_utc + timedelta(hours=2)).strftime("%A").lower()
    day_type = "weekend" if dow in ("saturday", "sunday") else "weekday"
    ts = now_utc.isoformat()

    print(f"[{ts}] CRON b3ed8968 — h={H_prev}→{H_cest} CEST ({today} {day_type})")

    # ── Auth ─────────────────────────────────────────────────────────────────
    try:
        token = login()
        print("  Auth OK")
    except Exception as e:
        _log_error(ts, today, H_prev, day_type, dow, str(e))
        return

    # ── Prédits (H_prev) ─────────────────────────────────────────────────────
    try:
        raw = get_profitability(token, H_prev)
        predicted = {item["zone_id"]: item["profitability_index"]
                     for item in raw if item.get("zone_id") in ZONES}
        print(f"  Prédits h={H_prev}: {len(predicted)} zones")
    except Exception as e:
        _log_error(ts, today, H_prev, day_type, dow, f"profitability: {e}")
        return

    # ── Historique ───────────────────────────────────────────────────────────
    historical = {}
    for date_try in [today, yesterday]:
        try:
            hist_raw = get_history(token, date_try, H_prev)
            historical = parse_history_zones(hist_raw, ZONES)
            if historical:
                print(f"  Historique h={H_prev} ({date_try}): {len(historical)} zones")
                break
        except Exception:
            pass

    if not historical:
        bl_path = BASE / f"baseline_h{H_prev:02d}.json"
        if bl_path.exists():
            bl = json.loads(bl_path.read_text())
            historical = bl.get("scores", {})
            print(f"  Historique: fallback baseline h={H_prev}")
        else:
            print(f"  Historique: aucune donnée h={H_prev} — init baseline")
            _save_baseline(today, H_prev, predicted, mae=0.0)
            _append_log(ts, today, H_prev, day_type, dow, 0.0, 0.0, 0, True, False, False)
            return

    # ── Métriques ────────────────────────────────────────────────────────────
    deltas, p_vals, q_vals, flags = [], [], [], []
    for z in ZONES:
        pred = predicted.get(z)
        hist = historical.get(z)
        if not pred or not hist or pred <= 0 or hist <= 0:
            continue
        delta = pred - hist
        err   = abs(delta) / hist * 100
        deltas.append(delta)
        p_vals.append(float(pred))
        q_vals.append(float(hist))
        if err > 20:
            flags.append({"zone": z, "pred": pred, "hist": hist,
                          "err_pct": round(err, 1),
                          "dir": "SOUS-ESTIMÉ" if pred < hist else "SUR-ESTIMÉ"})

    if not deltas:
        print("  Pas assez de données communes")
        _append_log(ts, today, H_prev, day_type, dow, 0.0, 0.0, 0, False, False, False)
        return

    MAE  = sum(abs(d) for d in deltas) / len(deltas)
    KL   = kl_divergence(p_vals, q_vals)
    flags_count = len(flags)
    alerte = (MAE > ALERTE_MAE) or (KL > ALERTE_KL) or (flags_count >= ALERTE_FLAGS)

    print(f"  MAE={MAE:.2f} KL={KL:.4f} flags={flags_count} alerte={alerte}")
    for f in flags[:3]:
        print(f"    ⚠ {f['zone']}: pred={f['pred']} hist={f['hist']} err={f['err_pct']}% {f['dir']}")

    # ── Baseline glissant ─────────────────────────────────────────────────────
    bl_update = False
    if MAE < 10 and flags_count < 3:
        _save_baseline(today, H_prev, predicted, MAE)
        bl_update = True

    # ── Résultat ──────────────────────────────────────────────────────────────
    result = {
        "date": today, "run_at": ts, "h": H_prev, "H_cest": H_cest,
        "day_type": day_type, "mae": round(MAE, 2), "kl": round(KL, 4),
        "flags_count": flags_count, "flags": flags, "bl_update": bl_update,
        "alerte": alerte, "zones_checked": len(deltas)
    }
    (BASE / f"result_{today}_h{H_prev:02d}.json").write_text(json.dumps(result, indent=2))

    # ── Réentraînement ────────────────────────────────────────────────────────
    retrain_triggered = False
    retrain_status    = None
    mae_after         = None
    improvement       = None
    zones_optimized   = []

    if alerte:
        lock_path = BASE / f"retrain_lock_{today}.json"
        do_retrain = True
        if lock_path.exists():
            lock = json.loads(lock_path.read_text())
            try:
                lock_ts = datetime.fromisoformat(lock["run_at"].replace("Z", "+00:00"))
                if (now_utc - lock_ts).total_seconds() < 7200:
                    print("  Retrain SKIPPED (verrou < 2h)")
                    do_retrain = False
            except Exception:
                pass

        if do_retrain:
            lock_path.write_text(json.dumps({"run_at": ts, "mae": round(MAE, 2),
                                              "kl": round(KL, 4), "flags": flags_count}))
            retrain_triggered = True
            retrain_script = _find_retrain_script()
            if retrain_script:
                try:
                    ret = subprocess.run(
                        ["python3", retrain_script],
                        capture_output=True, text=True, timeout=120
                    )
                    print(f"  Retrain: {ret.stdout[-200:].strip()}")
                    rpt_path = Path(f"/home/user/workspace/cron_tracking/vtc_retrain/retrain_report_{today}.json")
                    if rpt_path.exists():
                        rpt = json.loads(rpt_path.read_text())
                        retrain_status  = rpt.get("deploy_status")
                        mae_after       = rpt.get("cv_mae_new")
                        improvement     = rpt.get("improvement_pct")
                        zones_optimized = rpt.get("zones_optimized", [])
                except Exception as e:
                    retrain_status = f"error: {e}"
            else:
                retrain_status = "script_not_found"
                print("  vtc_retrain.py introuvable")

    _append_log(ts, today, H_prev, day_type, dow, MAE, KL, flags_count,
                bl_update, alerte, retrain_triggered,
                retrain_status=retrain_status,
                flagged_zones=[f["zone"] for f in flags])

    # ── Notification ──────────────────────────────────────────────────────────
    if alerte:
        _write_notif(H_prev, H_cest, today, day_type, MAE, KL, flags,
                     retrain_status, MAE, mae_after, improvement, zones_optimized, ts)

    print(f"  Done. bl_update={bl_update} retrain={retrain_triggered} status={retrain_status}")


def _find_retrain_script():
    candidates = [
        SCRIPT_DIR / "vtc_retrain.py",
        Path("/home/user/workspace/cron_scripts/vtc_retrain.py"),
        REPO_DIR / "cron_scripts" / "vtc_retrain.py",
        Path("/home/user/workspace/cron_tracking/vtc_retrain.py"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return None


def _save_baseline(today, hour, scores, mae):
    p = BASE / f"baseline_h{hour:02d}.json"
    p.write_text(json.dumps({
        "date": today, "hour": hour,
        "run_at": datetime.now(timezone.utc).isoformat(),
        "scores": scores, "mae": mae
    }, indent=2))


def _append_log(ts, today, h, day_type, dow, mae, kl, flags, bl_update,
                alerte, retrain, retrain_status=None, flagged_zones=None):
    entry = {
        "date": today, "run_at": ts, "h": h, "day_type": day_type, "dow": dow,
        "mae": round(mae, 2), "kl": round(kl, 4), "flags": flags,
        "bl_update": bl_update, "alerte": alerte, "retrain_triggered": retrain,
        "retrain_status": retrain_status, "flagged_zones": flagged_zones or []
    }
    with open(BASE / "run_log.jsonl", "a") as f:
        f.write(json.dumps(entry) + "\n")


def _log_error(ts, today, h, day_type, dow, msg):
    print(f"  ERREUR: {msg}")
    _append_log(ts, today, h, day_type, dow, 0.0, 0.0, 0,
                False, False, False, retrain_status=f"error: {msg}")


def _write_notif(H_prev, H_cest, today, day_type, MAE, KL, flags,
                 retrain_status, mae_before, mae_after, improvement,
                 zones_optimized, ts):
    top3 = flags[:3]
    top3_str = "\n".join(
        f"  {f['zone']}: prédit={f['pred']} hist={f['hist']} err={f['err_pct']}% {f['dir']}"
        for f in top3
    )
    reasons = []
    if MAE > 15:        reasons.append(f"MAE={MAE:.1f} > 15")
    if KL > 0.05:       reasons.append(f"KL={KL:.4f} > 0.05")
    if len(flags) >= 3: reasons.append(f"{len(flags)} flags ≥ 3")

    if retrain_status == "deployed" and mae_after is not None:
        title = (f"✅ VTC Auto-retrain — {H_prev}h→{H_cest}h | "
                 f"MAE {mae_before:.1f}→{mae_after:.1f} pts ({improvement:+.1f}%)")
        body = (f"**Tranche {H_prev}h → {H_cest}h CEST — {today} ({day_type})**\n\n"
                f"**Déclencheur :** {' / '.join(reasons)}\n\n"
                f"**Réentraînement :** ✅ Seeds déployés automatiquement\n"
                f"  MAE {mae_before:.1f} → {mae_after:.1f} pts ({improvement:+.1f}%)\n"
                f"  Zones optimisées : {', '.join(zones_optimized)}\n\n"
                f"**Dashboard :** https://vtc-one.pplx.app\n\n"
                f"Modèle auto-recalibré — aucune action manuelle requise.")
    else:
        title = (f"⚠️ VTC Alerte modèle — {H_prev}h→{H_cest}h | "
                 f"MAE={MAE:.1f} KL={KL:.4f} — Intervention requise")
        body = (f"**Tranche {H_prev}h → {H_cest}h CEST — {today} ({day_type})**\n\n"
                f"**Déclencheurs :**\n" + "\n".join(f"- {r}" for r in reasons) + "\n\n"
                f"**Top zones dégradées :**\n{top3_str}\n\n"
                f"**Réentraînement :** {retrain_status or 'non déclenché'}\n\n"
                f"**Action requise :** Vérifier storage.ts → seeds/peakHours/demandBoost\n\n"
                f"**Dashboard :** https://vtc-one.pplx.app (h={H_prev})")

    notif_path = BASE / f"pending_notif_{today}_h{H_prev:02d}.json"
    notif_path.write_text(json.dumps({
        "title": title, "body": body,
        "channels": ["in_app", "push"],
        "url": "https://vtc-one.pplx.app",
        "schedule_description": "Toutes les heures",
        "run_at": ts
    }, indent=2, ensure_ascii=False))
    print(f"  Notif écrite: {notif_path.name}")


if __name__ == "__main__":
    run()
