"""
vtc_collect_morning_6h.py — CRON 29554453
Collecte prédictions rush matin (h=5..9) pour 14 zones.
Exécuté à 06h00 CEST / 04h00 UTC, lun-ven.
Fix 19/06: ré-authentification par heure (token JWT peut expirer en ~30min).
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

ZONES_14 = [
    "z_cdg", "z_orly", "z_bobigny_gare", "z_plaine_commune", "z_le_bourget",
    "z_saint_denis_gare", "z_aubervilliers", "z_epinay_gennevilliers",
    "z_montreuil", "z_aulnay", "z_villepinte", "z_tremblay",
    "z_93_centre", "z_stade_france"
]
RUSH_HOURS = [5, 6, 7, 8, 9]


def run():
    now_utc = datetime.now(timezone.utc)
    today   = (now_utc + timedelta(hours=2)).strftime("%Y-%m-%d")
    ts      = now_utc.isoformat()

    print(f"[{ts}] CRON 29554453 — collecte prédictions matin {today}")

    predictions = {}
    token = None
    routing_source = "unknown"

    for h in RUSH_HOURS:
        # Re-authentification à chaque heure (token peut expirer en ~30min)
        if token is None:
            token = login()
            print(f"  Auth OK (h={h})")
            # Logger la source ETA active (TomTom / OSRM / calibrated) après auth
            try:
                routing_status = get_routing_status(token)
                routing_source = routing_status.get("routing_priority", "unknown")
                print(f"  Source ETA active: {routing_source}"
                      f" (tomtomHits={routing_status.get('tomtomHits', 'n/a')})")
            except Exception as e:
                print(f"  routing-status: ERREUR {e}")
        
        try:
            raw = get_profitability(token, h)
            for item in raw:
                z = item.get("zone_id")
                if z in ZONES_14:
                    predictions.setdefault(z, {})[str(h)] = item.get("profitability_index", 0)
            print(f"  h={h}: {sum(1 for z in predictions if str(h) in predictions[z])} zones")
        except Exception as e:
            # 401 = token expiré → ré-authentifier
            if "401" in str(e) or "Unauthorized" in str(e):
                print(f"  h={h}: 401 — ré-auth...")
                token = login()
                raw = get_profitability(token, h)
                for item in raw:
                    z = item.get("zone_id")
                    if z in ZONES_14:
                        predictions.setdefault(z, {})[str(h)] = item.get("profitability_index", 0)
                print(f"  h={h} (retry): {sum(1 for z in predictions if str(h) in predictions[z])} zones")
            else:
                print(f"  h={h}: ERREUR {e}")

    out_path = DIAG_DIR / f"predictions_{today}.json"
    out_path.write_text(json.dumps({
        "date": today, "collected_at": ts,
        "routing_source": routing_source,
        "predictions": predictions
    }, indent=2))
    print(f"  Sauvegardé: {len(predictions)} zones × {len(RUSH_HOURS)} heures → {out_path}")
    return len(predictions), len(RUSH_HOURS)


if __name__ == "__main__":
    z, h = run()
    print(f"\nOK — {z} zones × {h} heures sauvegardées.")
