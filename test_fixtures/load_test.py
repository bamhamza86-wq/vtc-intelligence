#!/usr/bin/env python3
"""
load_test.py — Harness de charge VTC Intelligence
─────────────────────────────────────────────────────────────────────────────
Simule sous concurrence réelle :
  • 100 chauffeurs polling /api/best-zone-now toutes les 3 s pendant 30 s
  • 20 signalements simultanés (10 sur Stade de France, 10 sur CDG)
  • 5 connexions SSE ouvertes en parallèle qui écoutent zones:updated
  • Mesure latence p50/p95/p99 par endpoint et broadcast SSE

Cible SLA : p95 < 300 ms sur best_zone_now ET signal, taux d'erreur = 0.

Design issu du council 3-modèles :
  • aiohttp + uvloop (concurrence I/O sans GIL)
  • time.perf_counter_ns() (horloge monotone nanoseconde)
  • Warm-up 5 requêtes rejetées (amortir DNS/JIT/SQLite cache)
  • SSE ouvert avant burst, corrélation par timestamp premier tick post-burst
  • Note explicite : zones:updated est périodique 3 min → SSE informational
  • JSON report + console + exit code

Usage :
  python3 test_fixtures/load_test.py [--base URL] [--drivers N] [--signals N] [--duration S]
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiohttp

try:
    import uvloop  # type: ignore
    _HAS_UVLOOP = True
except ImportError:
    _HAS_UVLOOP = False


# ─── Configuration par défaut ────────────────────────────────────────────────
# Note : sur pplx.app, toutes les routes serveur passent par /port/5000/
DEFAULT_BASE = "https://vtc-one.pplx.app/port/5000"
LOGIN = {"username": "root", "password": "12345678"}
DEFAULT_DRIVERS = 100
DEFAULT_SIGNALS = 20
DEFAULT_DURATION = 30.0  # secondes
POLL_INTERVAL = 3.0
WARMUP_CALLS = 5
SSE_CONNECTIONS = 5
N_PROBES = 20  # nb de probes SSE espacées de 500 ms
SLA_MS = 300.0

# Zones cibles pour les signalements (Stade de France + CDG)
STADE_DE_FRANCE = (48.9245, 2.3601)
CDG = (49.0097, 2.5479)

# Grille de positions chauffeurs répartis IDF autour Paris intra-muros et petite couronne
IDF_GRID = [
    (48.8566 + (i % 10) * 0.02 - 0.10, 2.3522 + (i // 10) * 0.03 - 0.15)
    for i in range(100)
]


# ─── Structures de mesure ────────────────────────────────────────────────────
@dataclass
class Sample:
    endpoint: str
    latency_ns: int
    status: int
    error: Optional[str] = None


@dataclass
class Metrics:
    samples: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    sse_events: list = field(default_factory=list)  # (t_recv_ns, event_name, listener_id, data)
    signal_burst_start_ns: int = 0
    probe_sent: dict = field(default_factory=dict)  # trace_id -> t_send_ns (client)
    probe_recv: dict = field(default_factory=dict)  # trace_id -> [(t_recv_ns, listener_id), ...]

    def record(self, endpoint: str, latency_ns: int, status: int, error: Optional[str] = None):
        s = Sample(endpoint, latency_ns, status, error)
        self.samples.append(s)
        if error or status >= 400:
            self.errors.append(s)


# ─── Utilitaires ─────────────────────────────────────────────────────────────
def perf_ns() -> int:
    return time.perf_counter_ns()


def percentiles(values_ns: list[int]) -> dict:
    if not values_ns:
        return {"n": 0}
    ms = [v / 1e6 for v in values_ns]
    ms_sorted = sorted(ms)
    return {
        "n": len(ms),
        "min_ms": round(ms_sorted[0], 2),
        "p50_ms": round(statistics.median(ms_sorted), 2),
        "p95_ms": round(ms_sorted[int(len(ms_sorted) * 0.95)] if len(ms_sorted) > 1 else ms_sorted[0], 2),
        "p99_ms": round(ms_sorted[int(len(ms_sorted) * 0.99)] if len(ms_sorted) > 1 else ms_sorted[0], 2),
        "max_ms": round(ms_sorted[-1], 2),
        "avg_ms": round(statistics.mean(ms_sorted), 2),
    }


# ─── Auth ────────────────────────────────────────────────────────────────────
async def login(session: aiohttp.ClientSession, base: str) -> str:
    async with session.post(f"{base}/api/auth/login", json=LOGIN, timeout=aiohttp.ClientTimeout(total=30)) as r:
        r.raise_for_status()
        data = await r.json()
        token = data.get("token")
        if not token:
            raise RuntimeError(f"Pas de token : {data}")
        return token


# ─── Warm-up ─────────────────────────────────────────────────────────────────
async def warmup(session: aiohttp.ClientSession, base: str, headers: dict):
    """5 requêtes rejetées pour amortir DNS/TLS/cache serveur."""
    for _ in range(WARMUP_CALLS):
        try:
            async with session.get(f"{base}/api/current", headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as r:
                await r.read()
        except Exception:
            pass


# ─── Zones sources ───────────────────────────────────────────────────────────
async def fetch_zones(session: aiohttp.ClientSession, base: str, headers: dict) -> tuple[list[dict], list[dict], list[dict]]:
    """Retourne (toutes_zones, zones_stade_de_france, zones_cdg).
    Sélectionne par proximité haversine < 5km."""
    async with session.get(f"{base}/api/top-zones?limit=200", headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as r:
        r.raise_for_status()
        zones = await r.json()

    def near(zlat, zlng, target, km=5.0):
        # Haversine simplifiée
        import math
        dlat = math.radians(zlat - target[0])
        dlng = math.radians(zlng - target[1])
        a = math.sin(dlat/2)**2 + math.cos(math.radians(target[0])) * math.cos(math.radians(zlat)) * math.sin(dlng/2)**2
        return 6371 * 2 * math.asin(math.sqrt(a)) <= km

    sdf = []
    cdg = []
    for z in zones:
        zone = z.get("zone") or {}
        lat = zone.get("center_lat") or zone.get("lat") or z.get("lat")
        lng = zone.get("center_lng") or zone.get("lng") or z.get("lng")
        if lat is None or lng is None:
            continue
        if near(lat, lng, STADE_DE_FRANCE):
            sdf.append(z)
        if near(lat, lng, CDG):
            cdg.append(z)
    return zones, sdf, cdg


# ─── Driver polling ──────────────────────────────────────────────────────────
async def driver_loop(session: aiohttp.ClientSession, base: str, headers: dict,
                      pos: tuple[float, float], duration: float, metrics: Metrics, stop: asyncio.Event):
    """Chaque chauffeur poll best-zone-now et profitability toutes les 3s."""
    lat, lng = pos
    end = time.monotonic() + duration
    while time.monotonic() < end and not stop.is_set():
        for endpoint in ("best-zone-now", "profitability"):
            t0 = perf_ns()
            try:
                if endpoint == "best-zone-now":
                    url = f"{base}/api/best-zone-now?lat={lat}&lng={lng}"
                else:
                    url = f"{base}/api/profitability"
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as r:
                    await r.read()
                    metrics.record(endpoint, perf_ns() - t0, r.status)
            except asyncio.TimeoutError:
                metrics.record(endpoint, perf_ns() - t0, 0, "timeout")
            except Exception as e:
                metrics.record(endpoint, perf_ns() - t0, 0, type(e).__name__)
        try:
            await asyncio.wait_for(stop.wait(), timeout=POLL_INTERVAL)
            break
        except asyncio.TimeoutError:
            pass


# ─── Signal burst ────────────────────────────────────────────────────────────
async def post_signal(session: aiohttp.ClientSession, base: str, headers: dict,
                       zone_id: str, sig_type: str, metrics: Metrics):
    t0 = perf_ns()
    try:
        async with session.post(
            f"{base}/api/zones/{zone_id}/signal",
            json={"type": sig_type},
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as r:
            await r.read()
            metrics.record("signal", perf_ns() - t0, r.status)
    except Exception as e:
        metrics.record("signal", perf_ns() - t0, 0, type(e).__name__)


async def signal_burst(session: aiohttp.ClientSession, base: str, headers: dict,
                        sdf_zones: list, cdg_zones: list, n_signals: int, metrics: Metrics):
    """N signaux simultanés répartis Stade de France / CDG."""
    if not sdf_zones and not cdg_zones:
        print("  [signal_burst] AUCUNE zone SDF/CDG trouvée — burst annulé", file=sys.stderr)
        return
    tasks = []
    for i in range(n_signals):
        pool = sdf_zones if i % 2 == 0 else cdg_zones
        if not pool:
            pool = sdf_zones or cdg_zones
        z = pool[i % len(pool)]
        zone_id = z.get("zone_id") or (z.get("zone") or {}).get("id")
        if not zone_id:
            continue
        sig_type = "positive" if i % 3 else "negative"
        tasks.append(post_signal(session, base, headers, zone_id, sig_type, metrics))
    metrics.signal_burst_start_ns = perf_ns()
    await asyncio.gather(*tasks)


# ─── SSE listener ────────────────────────────────────────────────────────────
async def sse_listener(session: aiohttp.ClientSession, base: str, headers: dict,
                        listener_id: int, stop: asyncio.Event, metrics: Metrics):
    """Écoute /api/stream, parse event+data, corrèle load:probe par trace_id."""
    url = f"{base}/api/stream"
    try:
        async with session.get(url, headers={**headers, "Accept": "text/event-stream"},
                                timeout=aiohttp.ClientTimeout(total=None, connect=10)) as resp:
            if resp.status != 200:
                metrics.errors.append(Sample(f"sse_{listener_id}", 0, resp.status, "sse_open_failed"))
                return
            current_event = None
            async for raw in resp.content:
                if stop.is_set():
                    break
                line = raw.decode("utf-8", errors="ignore").strip()
                if line.startswith("event:"):
                    current_event = line.split(":", 1)[1].strip()
                elif line.startswith("data:") and current_event:
                    t_recv = perf_ns()
                    raw_data = line.split(":", 1)[1].strip()
                    parsed = None
                    try:
                        parsed = json.loads(raw_data)
                    except json.JSONDecodeError:
                        pass
                    metrics.sse_events.append((t_recv, current_event, listener_id, parsed))
                    # Corrélation probe SSE
                    if current_event == "load:probe" and isinstance(parsed, dict):
                        tid = parsed.get("trace_id")
                        if tid:
                            metrics.probe_recv.setdefault(tid, []).append((t_recv, listener_id))
                    current_event = None
                elif not line:
                    current_event = None
    except asyncio.CancelledError:
        pass
    except Exception as e:
        metrics.errors.append(Sample(f"sse_{listener_id}", 0, 0, f"sse_error:{type(e).__name__}"))


# ─── Burst probes SSE ─ mesure e2e réelle hors tick 3 min ─────────────────
async def probe_sse_burst(session: aiohttp.ClientSession, base: str, headers: dict,
                            n_probes: int, metrics: Metrics):
    """Envoie N probes espacées de 500 ms sur POST /api/load/probe-broadcast.
    Chaque probe porte un trace_id unique. Le listener SSE corrèle pour mesurer
    la latence e2e ingestion → broadcast → réception client."""
    for i in range(n_probes):
        trace_id = f"probe-{int(time.time()*1000)}-{i}"
        metrics.probe_sent[trace_id] = perf_ns()
        try:
            async with session.post(
                f"{base}/api/load/probe-broadcast",
                json={"trace_id": trace_id},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=5),
            ) as r:
                await r.read()
                if r.status != 200:
                    metrics.errors.append(Sample("probe_send", 0, r.status, "probe_http_error"))
        except Exception as e:
            metrics.errors.append(Sample("probe_send", 0, 0, f"probe:{type(e).__name__}"))
        await asyncio.sleep(0.5)


# ─── Runner principal ────────────────────────────────────────────────────────
async def run_harness(base: str, n_drivers: int, n_signals: int, duration: float,
                       report_path: Path) -> dict:
    print(f"═══ VTC-One Load Test — {n_drivers} chauffeurs, {n_signals} signaux, {duration}s ═══")
    print(f"  Base URL   : {base}")
    print(f"  uvloop     : {'oui' if _HAS_UVLOOP else 'non (asyncio par défaut)'}")
    print(f"  SLA cible  : p95 < {SLA_MS} ms sur best_zone_now et signal")

    metrics = Metrics()
    connector = aiohttp.TCPConnector(limit=500, ttl_dns_cache=300, force_close=False, enable_cleanup_closed=True)
    timeout = aiohttp.ClientTimeout(total=None)

    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        # 1) Login
        t0 = perf_ns()
        token = await login(session, base)
        print(f"  Auth OK ({(perf_ns() - t0)/1e6:.0f} ms)")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        # 2) Warm-up
        print(f"  Warm-up ({WARMUP_CALLS} requêtes rejetées)...")
        await warmup(session, base, headers)

        # 3) Zones cibles
        print("  Récupération zones cibles (Stade de France + CDG)...")
        all_zones, sdf_zones, cdg_zones = await fetch_zones(session, base, headers)
        print(f"    zones totales : {len(all_zones)} · Stade de France : {len(sdf_zones)} · CDG : {len(cdg_zones)}")

        # 4) SSE listeners AVANT le burst
        stop = asyncio.Event()
        sse_tasks = [
            asyncio.create_task(sse_listener(session, base, headers, i, stop, metrics))
            for i in range(SSE_CONNECTIONS)
        ]
        await asyncio.sleep(1.0)  # laisser le temps aux SSE de s'établir
        sse_ready_ns = perf_ns()
        print(f"  {SSE_CONNECTIONS} connexions SSE établies")

        # 5) Burst signaux + drivers + probes SSE en parallèle
        print(f"  Lancement burst {n_signals} signaux + {n_drivers} chauffeurs + {N_PROBES} probes SSE ({duration}s)...")
        driver_tasks = [
            asyncio.create_task(driver_loop(session, base, headers, IDF_GRID[i % len(IDF_GRID)], duration, metrics, stop))
            for i in range(n_drivers)
        ]
        burst_task = asyncio.create_task(signal_burst(session, base, headers, sdf_zones, cdg_zones, n_signals, metrics))
        probe_task = asyncio.create_task(probe_sse_burst(session, base, headers, N_PROBES, metrics))

        run_start_ns = perf_ns()
        await burst_task
        burst_end_ns = perf_ns()
        print(f"  Burst signaux terminé en {(burst_end_ns - run_start_ns)/1e6:.0f} ms")

        # 6) Attendre fin des drivers ET probes
        await asyncio.gather(*driver_tasks, probe_task)
        # Laisser 2s aux SSE listeners pour recevoir les derniers events
        await asyncio.sleep(2.0)
        run_end_ns = perf_ns()

        # 7) Fermer SSE
        stop.set()
        for t in sse_tasks:
            t.cancel()
        await asyncio.gather(*sse_tasks, return_exceptions=True)

    # ─── Agrégation ─────────────────────────────────────────────────────────
    by_endpoint = defaultdict(list)
    for s in metrics.samples:
        if not s.error and s.status < 400:
            by_endpoint[s.endpoint].append(s.latency_ns)

    endpoint_stats = {ep: percentiles(vals) for ep, vals in by_endpoint.items()}

    # Latence SSE : premier event zones:updated après le burst (informational)
    sse_broadcast_ms = None
    sse_event_counts: dict = defaultdict(int)
    for t_recv, ev_name, *_ in metrics.sse_events:
        sse_event_counts[ev_name] += 1
        if ev_name == "zones:updated" and sse_broadcast_ms is None and t_recv > metrics.signal_burst_start_ns:
            sse_broadcast_ms = (t_recv - metrics.signal_burst_start_ns) / 1e6

    # Latence probe SSE e2e : t_send client → t_recv client via broadcast serveur
    # Pour chaque probe reçue par au moins un listener, prendre le PREMIER recv
    probe_e2e_ns = []
    for tid, t_send in metrics.probe_sent.items():
        recvs = metrics.probe_recv.get(tid)
        if recvs:
            t_recv = min(r[0] for r in recvs)
            probe_e2e_ns.append(t_recv - t_send)
    probe_e2e_stats = percentiles(probe_e2e_ns) if probe_e2e_ns else {"n": 0}
    probes_lost = len(metrics.probe_sent) - len(probe_e2e_ns)

    # ─── Verdict ────────────────────────────────────────────────────────────
    n_errors = len(metrics.errors)
    verdict_reasons = []
    best_p95 = endpoint_stats.get("best-zone-now", {}).get("p95_ms", float("inf"))
    signal_p95 = endpoint_stats.get("signal", {}).get("p95_ms", float("inf"))

    if best_p95 >= SLA_MS:
        verdict_reasons.append(f"best-zone-now p95={best_p95}ms ≥ {SLA_MS}ms")
    if signal_p95 >= SLA_MS:
        verdict_reasons.append(f"signal p95={signal_p95}ms ≥ {SLA_MS}ms")
    if n_errors > 0:
        verdict_reasons.append(f"{n_errors} erreur(s) sur {len(metrics.samples)} requêtes")
    probe_p95 = probe_e2e_stats.get("p95_ms", float("inf"))
    if probe_e2e_stats.get("n", 0) > 0 and probe_p95 >= SLA_MS:
        verdict_reasons.append(f"probe SSE e2e p95={probe_p95}ms ≥ {SLA_MS}ms")

    verdict = "PASS" if not verdict_reasons else "FAIL"

    report = {
        "run_id": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "config": {
            "base_url": base,
            "n_drivers": n_drivers,
            "n_signals": n_signals,
            "duration_s": duration,
            "sse_connections": SSE_CONNECTIONS,
            "sla_ms": SLA_MS,
            "uvloop": _HAS_UVLOOP,
        },
        "total_duration_s": round((run_end_ns - sse_ready_ns) / 1e9, 2),
        "endpoints": endpoint_stats,
        "requests_total": len(metrics.samples),
        "errors_total": n_errors,
        "errors_sample": [
            {"endpoint": e.endpoint, "status": e.status, "error": e.error}
            for e in metrics.errors[:10]
        ],
        "sse": {
            "connections": SSE_CONNECTIONS,
            "events_received": dict(sse_event_counts),
            "signal_burst_to_first_zones_updated_ms": round(sse_broadcast_ms, 2) if sse_broadcast_ms else None,
            "note_zones_updated": (
                "'zones:updated' est périodique (cycle serveur 3 min). "
                "Informational only — non inclus dans le verdict SLA."
            ),
            "probe_e2e": {
                "description": "Latence réelle client→serveur→broadcast→client via /api/load/probe-broadcast",
                "probes_sent": len(metrics.probe_sent),
                "probes_delivered": len(probe_e2e_ns),
                "probes_lost": probes_lost,
                **probe_e2e_stats,
            },
        },
        "verdict": verdict,
        "verdict_reasons": verdict_reasons,
    }

    # ─── Rapport ────────────────────────────────────────────────────────────
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print()
    print("═══ Résultats ═══")
    print(f"  Durée totale       : {report['total_duration_s']}s")
    print(f"  Requêtes totales   : {report['requests_total']}")
    print(f"  Erreurs            : {report['errors_total']}")
    print()
    print(f"  {'Endpoint':<20} {'n':>6} {'p50':>8} {'p95':>8} {'p99':>8} {'max':>8}  (ms)")
    print(f"  {'-'*20} {'-'*6} {'-'*8} {'-'*8} {'-'*8} {'-'*8}")
    for ep in sorted(endpoint_stats.keys()):
        s = endpoint_stats[ep]
        mark = " ✅" if s.get("p95_ms", 0) < SLA_MS else " ❌"
        print(f"  {ep:<20} {s['n']:>6} {s['p50_ms']:>8.1f} {s['p95_ms']:>8.1f} {s['p99_ms']:>8.1f} {s['max_ms']:>8.1f}{mark}")
    print()
    print(f"  SSE events         : {dict(sse_event_counts)}")
    if sse_broadcast_ms:
        print(f"  SSE burst→zones:updated : {sse_broadcast_ms:.0f} ms (informational, tick 3 min)")
    if probe_e2e_stats.get("n", 0) > 0:
        pe = probe_e2e_stats
        pmark = " ✅" if pe.get("p95_ms", 0) < SLA_MS else " ❌"
        print(f"  SSE probe e2e      : n={pe['n']}/{len(metrics.probe_sent)} "
              f"p50={pe['p50_ms']:.1f}ms p95={pe['p95_ms']:.1f}ms p99={pe['p99_ms']:.1f}ms{pmark}")
    print()
    print(f"  ═══ VERDICT : {verdict} ═══")
    if verdict_reasons:
        for r in verdict_reasons:
            print(f"    ✗ {r}")
    print()
    print(f"  Rapport JSON : {report_path}")

    return report


def main():
    ap = argparse.ArgumentParser(description="Harness de charge VTC-One")
    ap.add_argument("--base", default=DEFAULT_BASE, help=f"URL de base (défaut : {DEFAULT_BASE})")
    ap.add_argument("--drivers", type=int, default=DEFAULT_DRIVERS)
    ap.add_argument("--signals", type=int, default=DEFAULT_SIGNALS)
    ap.add_argument("--duration", type=float, default=DEFAULT_DURATION)
    ap.add_argument("--output", type=Path, default=Path("/home/user/workspace/vtc-repo/test_fixtures/load_test_report.json"))
    args = ap.parse_args()

    if _HAS_UVLOOP:
        uvloop.install()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        report = asyncio.run(run_harness(args.base, args.drivers, args.signals, args.duration, args.output))
        sys.exit(0 if report["verdict"] == "PASS" else 1)
    except KeyboardInterrupt:
        print("\n[load_test] interrompu", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
