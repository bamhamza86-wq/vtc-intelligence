#!/usr/bin/env python3
"""
api_changelog_scan.py — Cron VTC Intelligence
Scan hebdomadaire des changelogs des APIs VTC (PredictHQ, TomTom, Uber, Drivee).
Schedule: 0 6 * * 1   (06h00 UTC = 08h00 CEST, chaque lundi)

Flux :
  1. Auth POST /api/auth/login (root / 12345678) avec retry cold-start.
  2. GET /api/platforms/credentials → connaître les plateformes configurées.
  3. Pour chaque API : fetch des pages de changelog connues via requests (timeout 15s).
  4. Extraction du texte utile (BeautifulSoup si dispo, sinon regex simple).
  5. Comparaison du hash MD5 du contenu avec le dernier snapshot.
  6. Détection de mots-clés ("new endpoint", "nouveau", "API", ...).
  7. Si hash différent ET mot-clé trouvé → flag comme changement.
  8. Si changement sur >= 1 API → écrit pending_notif_{today}_api_scan.json (in-app).
  9. Sauvegarde un snapshot last_changelog_{platform}_{date}.txt par plateforme.

Robuste : ne plante jamais sur une URL inaccessible (try/except complet, skip timeout).
"""
import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

# BeautifulSoup optionnel — fallback regex si absent
try:
    from bs4 import BeautifulSoup  # type: ignore
    _HAS_BS4 = True
except Exception:
    _HAS_BS4 = False

WORKSPACE = Path("/home/user/workspace")
TRACKING = WORKSPACE / "cron_tracking" / "api_scan"
TRACKING.mkdir(parents=True, exist_ok=True)

BASE_URL = "https://vtc-one.pplx.app/port/5000"

# Retries cold-start (sandbox E2B peut être suspendu)
COLD_START_DELAYS = [10, 20, 30, 40, 40, 40]
AUTH_TIMEOUT = 40
URL_TIMEOUT = 15  # timeout par URL de changelog

# User-agent réaliste pour éviter les 403 sur les sites publics
HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

CHANGELOGS = {
    "predicthq": [
        "https://docs.predicthq.com/changelog",
        "https://www.predicthq.com/blog",
    ],
    "tomtom": [
        "https://developer.tomtom.com/changelog",
    ],
    "uber_fleet": [
        "https://developer.uber.com/docs/businesses/changelog",
        "https://developer.uber.com/docs/riders/changelog",
    ],
    "drivee": [
        "https://www.drivee.fr",  # surveiller toute nouveauté API
    ],
}

# Mots-clés indiquant un changement pertinent pour VTC
KEYWORDS = [
    "new endpoint", "nouveau", "api", "endpoint", "feature",
    "transportation", "driver", "fleet", "93", "cdg", "orly",
]


def _now_utc():
    return datetime.now(timezone.utc)


def _today_cest():
    return (_now_utc() + timedelta(hours=2)).strftime("%Y-%m-%d")


def login(session, username="root", password="12345678"):
    """Auth avec retry sur cold-start (ConnectionError / timeout / 5xx).
    Retourne le token, ou None si l'auth échoue (le scan continue quand même)."""
    url = f"{BASE_URL}/api/auth/login"
    body = {"username": username, "password": password}
    for i, delay in enumerate(COLD_START_DELAYS):
        try:
            r = session.post(url, json=body, timeout=AUTH_TIMEOUT)
            if r.status_code == 200:
                token = r.json().get("token")
                if token:
                    return token
                print(f"  [auth] pas de token: {r.text[:200]}")
                return None
            if r.status_code >= 500 and i < len(COLD_START_DELAYS) - 1:
                print(f"  [auth] HTTP {r.status_code} — cold-start, retry dans {delay}s...")
                time.sleep(delay)
                continue
            print(f"  [auth] HTTP {r.status_code}: {r.text[:200]}")
            return None
        except (requests.exceptions.ConnectionError,
                requests.exceptions.ReadTimeout,
                requests.exceptions.Timeout) as e:
            if i < len(COLD_START_DELAYS) - 1:
                print(f"  [auth] {type(e).__name__} — retry dans {delay}s ({i+1}/{len(COLD_START_DELAYS)})...")
                time.sleep(delay)
            else:
                print(f"  [auth] échouée après {len(COLD_START_DELAYS)} retries: {e}")
                return None
    return None


def fetch_platforms(session, token):
    """GET /api/platforms/credentials → liste des plateformes configurées.
    Retourne une liste de noms de plateformes (lowercase), ou [] si indispo."""
    if not token:
        return []
    url = f"{BASE_URL}/api/platforms/credentials"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = session.get(url, headers=headers, timeout=20)
        if r.status_code == 200:
            data = r.json()
            names = []
            if isinstance(data, list):
                for c in data:
                    if isinstance(c, dict):
                        nm = c.get("platform") or c.get("name") or c.get("id")
                        if nm:
                            names.append(str(nm).lower())
            print(f"  Plateformes configurées: {names or '(aucune retournée)'}")
            return names
        print(f"  [platforms] HTTP {r.status_code}")
    except Exception as e:
        print(f"  [platforms] {e}")
    return []


def extract_text(html):
    """Extrait le texte utile d'une page HTML. BeautifulSoup si dispo, sinon regex."""
    if not html:
        return ""
    if _HAS_BS4:
        try:
            soup = BeautifulSoup(html, "html.parser")
            for tag in soup(["script", "style", "noscript"]):
                tag.decompose()
            text = soup.get_text(separator=" ")
        except Exception:
            text = _regex_strip(html)
    else:
        text = _regex_strip(html)
    # Normaliser les espaces
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _regex_strip(html):
    """Fallback : supprime script/style/balises via regex simple."""
    html = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?s)<[^>]+>", " ", html)
    # Décodage basique de quelques entités
    for ent, ch in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                    ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")):
        html = html.replace(ent, ch)
    return html


def fetch_page(session, url):
    """Fetch une URL. Retourne le texte extrait ou None si erreur/timeout."""
    try:
        r = session.get(url, headers=HTTP_HEADERS, timeout=URL_TIMEOUT)
        if r.status_code == 200:
            return extract_text(r.text)
        print(f"    [{url}] HTTP {r.status_code} — skip")
    except (requests.exceptions.ReadTimeout, requests.exceptions.Timeout):
        print(f"    [{url}] timeout {URL_TIMEOUT}s — skip")
    except requests.exceptions.RequestException as e:
        print(f"    [{url}] {type(e).__name__}: {e} — skip")
    except Exception as e:
        print(f"    [{url}] erreur inattendue: {e} — skip")
    return None


def find_keywords(text):
    """Retourne la liste des mots-clés trouvés dans le texte (lowercase)."""
    if not text:
        return []
    low = text.lower()
    found = []
    for kw in KEYWORDS:
        if kw in low:
            found.append(kw)
    return found


def load_last_snapshot(platform):
    """Charge le hash du snapshot le plus récent pour une plateforme.
    Retourne (hash, filename) ou (None, None)."""
    candidates = sorted(
        TRACKING.glob(f"last_changelog_{platform}_*.txt"), reverse=True
    )
    for f in candidates:
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
            # Le hash est stocké en première ligne "# md5: <hash>"
            m = re.match(r"#\s*md5:\s*([0-9a-f]+)", content)
            if m:
                return m.group(1), f.name
            # Sinon recalculer sur le corps
            body = content.split("\n", 1)[-1]
            return hashlib.md5(body.encode("utf-8")).hexdigest(), f.name
        except Exception:
            continue
    return None, None


def save_snapshot(platform, today, combined_text, content_hash):
    """Sauvegarde le snapshot du jour (hash en en-tête + texte)."""
    path = TRACKING / f"last_changelog_{platform}_{today}.txt"
    header = f"# md5: {content_hash}\n# scanned_at: {_now_utc().isoformat()}\n"
    # Limiter la taille stockée (10000 premiers caractères suffisent pour le diff)
    body = combined_text[:10000]
    try:
        path.write_text(header + body, encoding="utf-8")
        print(f"    snapshot écrit: {path.name}")
    except Exception as e:
        print(f"    [snapshot {platform}] erreur écriture: {e}")


def write_notif(today, changes):
    """Écrit pending_notif_{today}_api_scan.json avec résumé des changements."""
    n = len(changes)
    rows = []
    for ch in changes:
        kws = ", ".join(ch["keywords"][:6])
        urls = ", ".join(ch["urls"])
        rows.append(
            f"- **{ch['platform']}** — hash modifié, mots-clés : {kws}\n"
            f"  - pages : {urls}"
        )
    body_rows = "\n".join(rows)
    title = f"🔌 APIs VTC — {n} changelog(s) modifié(s) ({today})"
    body = (
        f"## Scan hebdomadaire des changelogs APIs — {today}\n\n"
        f"{n} plateforme(s) avec un changelog modifié et des mots-clés pertinents :\n\n"
        f"{body_rows}\n\n"
        f"### Recommandation\n"
        f"Vérifier les nouveautés API (nouveaux endpoints, features transport/fleet) "
        f"et leur impact potentiel sur l'intégration VTC. "
        f"Voir le dashboard https://vtc-one.pplx.app"
    )
    path = TRACKING / f"pending_notif_{today}_api_scan.json"
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
    print(f"[{ts}] CRON api_changelog_scan — scan hebdo changelogs {today}")
    print(f"  BeautifulSoup: {'dispo' if _HAS_BS4 else 'absent (fallback regex)'}")

    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})

    # 1) Auth (non bloquant — le scan des URLs publiques continue même sans token)
    token = login(session)
    if token:
        print("  Auth OK")
    else:
        print("  Auth indisponible — scan des URLs publiques quand même")

    # 2) Plateformes configurées (informatif)
    configured = fetch_platforms(session, token)

    # 3-7) Scan de chaque plateforme
    changes = []  # plateformes avec changement détecté
    summary = {}  # détail par plateforme pour le rapport

    for platform, urls in CHANGELOGS.items():
        print(f"\n  === {platform} ===")
        texts = []
        ok_urls = []
        all_keywords = set()
        for url in urls:
            text = fetch_page(session, url)
            if text:
                texts.append(text)
                ok_urls.append(url)
                all_keywords.update(find_keywords(text))

        if not texts:
            print(f"    aucune page accessible — skip {platform}")
            summary[platform] = {"status": "no_page", "urls_ok": []}
            continue

        combined = "\n\n".join(texts)
        content_hash = hashlib.md5(combined.encode("utf-8")).hexdigest()

        prev_hash, prev_file = load_last_snapshot(platform)
        changed = prev_hash is not None and prev_hash != content_hash
        first_run = prev_hash is None

        kw_list = sorted(all_keywords)
        has_kw = len(kw_list) > 0

        print(f"    hash actuel : {content_hash}")
        print(f"    hash précédent : {prev_hash or '(aucun — 1er run)'}")
        print(f"    mots-clés : {kw_list or '(aucun)'}")

        # Flag changement : hash différent ET mot-clé trouvé
        flagged = changed and has_kw
        if flagged:
            print(f"    ⚠ CHANGEMENT DÉTECTÉ ({platform})")
            changes.append({
                "platform": platform,
                "keywords": kw_list,
                "urls": ok_urls,
                "hash": content_hash,
                "prev_hash": prev_hash,
            })

        summary[platform] = {
            "status": "first_run" if first_run else ("changed" if changed else "unchanged"),
            "flagged": flagged,
            "hash": content_hash,
            "prev_hash": prev_hash,
            "keywords": kw_list,
            "urls_ok": ok_urls,
        }

        # Sauvegarder le snapshot du jour
        save_snapshot(platform, today, combined, content_hash)

    # Rapport de run
    report_path = TRACKING / f"scan_report_{today}.json"
    report_path.write_text(
        json.dumps(
            {
                "date": today,
                "scanned_at": ts,
                "configured_platforms": configured,
                "changes_detected": len(changes),
                "summary": summary,
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    print(f"\n  Rapport: {report_path.name}")

    # 8) Notification si changement sur >= 1 API
    if changes:
        write_notif(today, changes)
    else:
        print("  RAS — aucun changelog modifié avec mot-clé pertinent, pas de notification")

    return len(changes)


if __name__ == "__main__":
    try:
        n = run()
        print(f"\nOK — {n} changement(s) détecté(s).")
    except Exception as e:
        print(f"[api_changelog_scan] ÉCHEC: {e}", file=sys.stderr)
        sys.exit(1)
