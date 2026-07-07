/**
 * RadarPage — Radar aérien communautaire plein écran (Flightradar24-like)
 * ─────────────────────────────────────────────────────────────────────────────
 * Référence rapport : §1 (signal surge communautaire) et §15.9 (Wow factor —
 * "Carte façon radar aérien pour la densité de demande" — le wow central de
 * l'application : un feed live communautaire immersif).
 *
 * Consomme le flux SSE /api/community/radar-stream (5s) et envoie un
 * heartbeat de position floue toutes les 30s via /api/community/radar/heartbeat.
 * Affiche stats live, légende, filtres (blips/heatspots/corridors) et le
 * canvas CommunityRadar en plein écran.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "wouter";
import { X, Radar as RadarIcon, Users, Flame, Route as RouteIcon, TrendingUp } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, API_BASE, getAuthToken } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import CommunityRadar, {
  type RadarBlip,
  type RadarHeatspot,
  type RadarConvergence,
  type HotCorridor,
} from "@/components/CommunityRadar";

const RADIUS_KM = 5;

// Estimation tarif simplifiée (cohérente avec geoDistance.estimateRideGain,
// version compacte pour les bulles d'info du radar).
function estimateFareSimple(distanceKm: number): number {
  const BASE_FARE = 5;
  const PRICE_PER_KM = 1.4;
  return BASE_FARE + PRICE_PER_KM * Math.max(distanceKm, 1);
}

interface DensityForecastPoint {
  horizon_min: 15 | 30 | 60;
  projected_density: number;
  trend: "hausse" | "stable" | "baisse";
}

export default function RadarPage() {
  const { position } = useGpsPosition();
  const [blips, setBlips] = useState<RadarBlip[]>([]);
  const [heatspots, setHeatspots] = useState<RadarHeatspot[]>([]);
  const [convergences, setConvergences] = useState<RadarConvergence[]>([]);
  const [arrivals, setArrivals] = useState<{ blip_id: string; eta_min: number; distance_km: number }[]>([]);
  const [activeCount, setActiveCount] = useState<number>(0);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // ── Filtres d'affichage ───────────────────────────────────────────────────
  const [showBlips, setShowBlips] = useState(true);
  const [showHeatspots, setShowHeatspots] = useState(true);
  const [showCorridors, setShowCorridors] = useState(true);

  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);

  // ── Corridors communautaires (rafraîchi périodiquement, moins volatile) ──
  const { data: corridorsData } = useQuery<{ corridors: HotCorridor[] }>({
    queryKey: ["/api/community/radar/hot-corridors"],
    queryFn: () => apiRequest("GET", "/api/community/radar/hot-corridors?limit=10").then((r) => r.json()),
    refetchInterval: 30000,
  });
  const corridors = corridorsData?.corridors ?? [];

  // ── Projection densité 15/30/60min ────────────────────────────────────────
  const { data: forecastData } = useQuery<{ forecast: DensityForecastPoint[] }>({
    queryKey: ["/api/community/radar/density-forecast", position.lat, position.lng],
    queryFn: () =>
      apiRequest("GET", `/api/community/radar/density-forecast?lat=${position.lat}&lng=${position.lng}&radius_km=${RADIUS_KM}`).then((r) => r.json()),
    refetchInterval: 30000,
  });
  const forecast = forecastData?.forecast ?? [];

  // ── Heartbeat position floue toutes les 30s ───────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const sendHeartbeat = () => {
      if (cancelled) return;
      apiRequest("POST", "/api/community/radar/heartbeat", {
        lat: position.lat,
        lng: position.lng,
        speed_kmh: undefined,
      }).catch(() => {});
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.lat, position.lng]);

  // ── Flux SSE radar (blips/heatspots/convergences/arrivals) ───────────────
  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const token = getAuthToken();
      const params = new URLSearchParams({
        lat: String(position.lat),
        lng: String(position.lng),
        radius_km: String(RADIUS_KM),
      });
      if (token) params.set("token", token); // fallback si EventSource ne supporte pas les headers custom

      const url = `${API_BASE}/api/community/radar-stream?${params.toString()}`;
      // EventSource ne permet pas de headers Authorization — on s'appuie sur
      // withCredentials (cookies) si présent, sinon la query token ci-dessus
      // est ignorée côté serveur (requireAuth lit Authorization/X-Auth-Token).
      // Fallback robuste : si le flux échoue en 401, on bascule sur un polling léger.
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.addEventListener("radar", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setBlips(data.blips ?? []);
          setHeatspots(data.heatspots ?? []);
          setConvergences(data.convergences ?? []);
          setArrivals(data.arrivals ?? []);
          setActiveCount(data.active_count_5km ?? 0);
          setLastUpdate(new Date());
          setConnected(true);
          retryRef.current = 0;
        } catch {}
      });

      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es.close();
        const delay = Math.min(1000 * Math.pow(2, retryRef.current), 20000);
        retryRef.current++;
        setTimeout(connect, delay);
      };
    }

    connect();
    return () => { cancelled = true; esRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.lat, position.lng]);

  const trendLabel = useCallback((t: "hausse" | "stable" | "baisse") => {
    if (t === "hausse") return { icon: "↗", color: "text-emerald-400" };
    if (t === "baisse") return { icon: "↘", color: "text-red-400" };
    return { icon: "→", color: "text-white/60" };
  }, []);

  return (
    <div className="fixed inset-0 z-[200] bg-black flex flex-col" data-testid="radar-page">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-safe pt-3 pb-2 border-b border-white/10 bg-black/95">
        <div className="flex items-center gap-2">
          <RadarIcon size={20} className="text-emerald-400" />
          <div>
            <div className="text-white font-bold text-sm leading-tight">Radar communautaire</div>
            <div className="text-[10px] text-white/50 leading-tight">
              {connected ? (
                <span className="text-emerald-400">● En direct</span>
              ) : (
                <span className="text-amber-400">● Reconnexion…</span>
              )}
              {lastUpdate && <span className="ml-1">— {lastUpdate.toLocaleTimeString("fr-FR")}</span>}
            </div>
          </div>
        </div>
        <Link
          href="/"
          aria-label="Fermer le radar"
          title="Fermer"
          className="flex items-center justify-center rounded-full bg-white/10 text-white active:scale-95 transition-all"
          style={{ width: 44, height: 44 }}
          data-testid="button-close-radar"
        >
          <X size={20} />
        </Link>
      </div>

      {/* Stats live */}
      <div className="grid grid-cols-3 gap-2 px-3 py-2 bg-black/90 border-b border-white/10">
        <div className="flex flex-col items-center justify-center rounded-lg bg-white/5 py-2" data-testid="stat-active-drivers">
          <div className="flex items-center gap-1 text-emerald-400"><Users size={13} /><span className="text-base font-bold">{activeCount}</span></div>
          <div className="text-[9px] text-white/50 text-center leading-tight">chauffeurs actifs<br />rayon {RADIUS_KM}km</div>
        </div>
        <div className="flex flex-col items-center justify-center rounded-lg bg-white/5 py-2" data-testid="stat-heatspots">
          <div className="flex items-center gap-1 text-orange-400"><Flame size={13} /><span className="text-base font-bold">{heatspots.length}</span></div>
          <div className="text-[9px] text-white/50 text-center leading-tight">zones chaudes</div>
        </div>
        <div className="flex flex-col items-center justify-center rounded-lg bg-white/5 py-2" data-testid="stat-convergences">
          <div className="flex items-center gap-1 text-red-400"><span className="text-sm">⚠</span><span className="text-base font-bold">{convergences.length}</span></div>
          <div className="text-[9px] text-white/50 text-center leading-tight">convergences</div>
        </div>
      </div>

      {/* Radar canvas */}
      <div className="flex-1 relative overflow-hidden">
        <CommunityRadar
          center={{ lat: position.lat, lng: position.lng }}
          blips={blips}
          heatspots={heatspots}
          convergences={convergences}
          corridors={showCorridors ? corridors : []}
          radiusKm={RADIUS_KM}
          showBlips={showBlips}
          showHeatspots={showHeatspots}
          showCorridors={showCorridors}
          estimateFare={estimateFareSimple}
        />

        {/* Arrivées vers ma zone */}
        {arrivals.length > 0 && (
          <div className="absolute top-2 left-2 right-2 flex flex-wrap gap-1.5 pointer-events-none">
            {arrivals.slice(0, 3).map((a) => (
              <div key={a.blip_id} className="rounded-full bg-cyan-500/20 border border-cyan-400/40 px-2.5 py-1 text-[10px] text-cyan-300 backdrop-blur">
                🚗 Chauffeur à {a.distance_km}km — arrivée ~{a.eta_min}min
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Projection densité 15/30/60min */}
      {forecast.length > 0 && (
        <div className="flex items-center justify-around px-3 py-2 bg-black/90 border-t border-white/10">
          <div className="flex items-center gap-1 text-white/50 text-[10px]"><TrendingUp size={12} /> Projection</div>
          {forecast.map((f) => {
            const t = trendLabel(f.trend);
            return (
              <div key={f.horizon_min} className="flex flex-col items-center">
                <span className="text-[9px] text-white/40">{f.horizon_min}min</span>
                <span className={`text-xs font-bold ${t.color}`}>{f.projected_density} {t.icon}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Filtres + légende */}
      <div className="px-3 py-2.5 pb-safe bg-black/95 border-t border-white/10 space-y-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => setShowBlips((v) => !v)}
            aria-pressed={showBlips}
            data-testid="button-toggle-blips"
            className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-semibold whitespace-nowrap transition-colors ${showBlips ? "bg-emerald-500/90 text-white" : "bg-white/10 text-white/60"}`}
            style={{ minHeight: 44 }}
          >
            <Users size={13} /> Chauffeurs
          </button>
          <button
            type="button"
            onClick={() => setShowHeatspots((v) => !v)}
            aria-pressed={showHeatspots}
            data-testid="button-toggle-heatspots"
            className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-semibold whitespace-nowrap transition-colors ${showHeatspots ? "bg-orange-500/90 text-white" : "bg-white/10 text-white/60"}`}
            style={{ minHeight: 44 }}
          >
            <Flame size={13} /> Zones chaudes
          </button>
          <button
            type="button"
            onClick={() => setShowCorridors((v) => !v)}
            aria-pressed={showCorridors}
            data-testid="button-toggle-corridors"
            className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-semibold whitespace-nowrap transition-colors ${showCorridors ? "bg-sky-500/90 text-white" : "bg-white/10 text-white/60"}`}
            style={{ minHeight: 44 }}
          >
            <RouteIcon size={13} /> Corridors
          </button>
        </div>

        <div className="flex items-center gap-3 text-[10px] text-white/50 flex-wrap">
          <div className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-emerald-400" /> Chauffeur</div>
          <div className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-orange-400" /> Zone chaude</div>
          <div className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-400" /> Convergence</div>
          <div className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-cyan-400" /> Vous (centre)</div>
        </div>

        {activeCount === 0 && (
          <div className="text-[10px] text-white/40 italic">
            Pas assez de chauffeurs proches pour afficher le radar en respectant l'anonymat (minimum 5 requis).
          </div>
        )}
      </div>
    </div>
  );
}
