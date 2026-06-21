"""
vtc_api_client.py — Client HTTP robuste pour vtc-one.pplx.app
Utilise requests (PAS urllib) pour éviter les 403 liés au proxy Cloudflare/__Host- cookie.
Cold-start retry avec delays progressifs.
"""
import requests
import time

BASE_URL = "https://vtc-one.pplx.app/port/5000"
COLD_START_DELAYS = [5, 10, 15, 20, 25, 30]

_SESSION = None

def _get_session():
    global _SESSION
    if _SESSION is None:
        _SESSION = requests.Session()
        _SESSION.headers.update({"Content-Type": "application/json"})
    return _SESSION


def login(username="root", password="12345678"):
    """Authentifie et retourne le token JWT. Retry sur cold-start (403/connexion)."""
    s = _get_session()
    url = f"{BASE_URL}/api/auth/login"
    body = {"username": username, "password": password}

    for i, delay in enumerate(COLD_START_DELAYS):
        try:
            r = s.post(url, json=body, timeout=20)
            if r.status_code == 200:
                token = r.json().get("token")
                if token:
                    return token
                raise ValueError(f"Pas de token dans la réponse: {r.text[:200]}")
            # 403 = cold-start probable
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
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"Auth exception: {e}")

    raise RuntimeError("Auth échouée après tous les retries")


def get_profitability(token, hour):
    """GET /api/profitability?hour={h} → list 14 objets {zone_id, profitability_index, ...}"""
    s = _get_session()
    r = s.get(f"{BASE_URL}/api/profitability",
              params={"hour": hour},
              headers={"Authorization": f"Bearer {token}"},
              timeout=20)
    r.raise_for_status()
    return r.json()


def get_routing_status(token):
    """GET /api/routing-status → dict {routing_priority: 'tomtom'|'osrm'|'calibrated', tomtomHits, ...}
    La clé TomTom est gérée côté serveur ; ce client ne fait que lire le statut."""
    s = _get_session()
    r = s.get(f"{BASE_URL}/api/routing-status",
              headers={"Authorization": f"Bearer {token}"},
              timeout=10)
    r.raise_for_status()
    return r.json()


def get_history(token, date_str, hour):
    """GET /api/history?date={date}&hour={h}
    Retourne dict {zones: {zone_id: {profitability_index: N, ...}}} ou list."""
    s = _get_session()
    r = s.get(f"{BASE_URL}/api/history",
              params={"date": date_str, "hour": hour},
              headers={"Authorization": f"Bearer {token}"},
              timeout=20)
    r.raise_for_status()
    return r.json()


def get_events(token):
    """GET /api/events → liste événements actifs."""
    s = _get_session()
    r = s.get(f"{BASE_URL}/api/events",
              headers={"Authorization": f"Bearer {token}"},
              timeout=20)
    r.raise_for_status()
    return r.json()


def get_alerts(token):
    """GET /api/alerts → liste alertes transport/météo."""
    s = _get_session()
    r = s.get(f"{BASE_URL}/api/alerts",
              headers={"Authorization": f"Bearer {token}"},
              timeout=20)
    r.raise_for_status()
    return r.json()


def parse_history_zones(hist_raw, zones):
    """Parse la réponse /api/history quel que soit le format (dict ou list).
    Retourne {zone_id: profitability_index}."""
    result = {}
    if isinstance(hist_raw, dict) and "zones" in hist_raw:
        for z, v in hist_raw["zones"].items():
            if z in zones and isinstance(v, dict) and "profitability_index" in v:
                result[z] = v["profitability_index"]
    elif isinstance(hist_raw, list):
        for item in hist_raw:
            z = item.get("zone_id")
            if z in zones:
                result[z] = item.get("profitability_index", 0)
    return result


if __name__ == "__main__":
    print("Test vtc_api_client.py (requests)...")
    tok = login()
    print(f"  Auth OK — token: {tok[:16]}...")
    data = get_profitability(tok, 8)
    print(f"  /api/profitability?hour=8 → {len(data)} zones")
    if data:
        print(f"  Exemple: {data[0]}")
    print("PASS")
