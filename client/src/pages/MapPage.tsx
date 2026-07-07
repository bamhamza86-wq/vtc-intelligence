import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, REALTIME_INTERVAL, SLOW_INTERVAL, STATIC_INTERVAL } from "@/lib/queryClient";
// ── Pull-to-refresh : wrapper tactile + retour haptique ──────────────────────
import { PullToRefresh } from "@/components/PullToRefresh";
import { haptic } from "@/lib/haptics";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { GpsFreshness } from "@/components/GpsFreshness";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, Clock, Zap, Plane, ChevronDown, ChevronUp, Navigation, Radio, MapPin, Radar as RadarIcon } from "lucide-react";
import { UpdateWidget } from "@/components/UpdateWidget";
import { RouteSourceBadge } from "@/components/RouteSourceBadge";
import { PredictHQBadge } from "@/components/PredictHQBadge";
import { RecoWhereToGo } from "@/components/RecoWhereToGo";
import { usePredictHQ } from "@/hooks/usePredictHQ";
import { useZonesSummary } from "@/hooks/useZonesSummary";
import { useRepositioningAlerts } from "@/hooks/useRepositioningAlerts";
import type { EventProximity } from "@/lib/eventProximity";
import { RareEventBanner } from "@/components/RareEventBanner";
import { RoutingSourceBanner } from "@/components/RoutingSourceBanner";
// ─── Lot Beta : pastille de fraîcheur (RecommendationBanner retiré, remplacé par RecoWhereToGo) ─
import { DataFreshnessBadge } from "@/components/DataFreshnessBadge";
import { ZoneSignalPanel } from "@/components/ZoneSignalPanel";
import { ZoneChat } from "@/components/ZoneChat";
import { AvoidZonesCard } from "@/components/AvoidZonesCard";
import { Flame } from "lucide-react";
import StationOverlay from "@/components/StationOverlay";
// ─── Couche UX Avancée (Itération 3) : calque bornes de recharge électrique (§6.4) ───
import { ChargingStationsMap } from "@/components/ChargingStationsMap";
import { BatteryCharging } from "lucide-react";

const COLORS = { ultraHigh: "#22c55e", high: "#86efac", medium: "#fbbf24", low: "#f97316", veryLow: "#ef4444" };

function getProfitColor(idx: number) {
  if (idx >= 75) return COLORS.ultraHigh;
  if (idx >= 60) return COLORS.high;
  if (idx >= 40) return COLORS.medium;
  if (idx >= 25) return COLORS.low;
  return COLORS.veryLow;
}
function getProfitLabel(idx: number) {
  if (idx >= 75) return "Ultra rentable";
  if (idx >= 60) return "Rentable";
  if (idx >= 40) return "Neutre";
  if (idx >= 25) return "Faible";
  return "Saturé";
}
function getPeakColor(level: string) {
  return { low: "#6b7280", medium: "#fbbf24", high: "#f97316", surge: "#ef4444" }[level] || "#6b7280";
}
function getPeakLabel(level: string) {
  return { low: "Flux faible", medium: "Flux modéré", high: "Flux élevé", surge: "SURGE" }[level] || level;
}
function fmtTime(iso: string | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(iso: string | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

// ─── Events PredictHQ — style marker selon le rank ────────────────────────────
function getEventRankStyle(rank: number): { color: string; size: number; pulsing: boolean; dot: string } {
  if (rank >= 80) return { color: "#ef4444", size: 40, pulsing: true, dot: "🔴" };
  if (rank >= 60) return { color: "#f97316", size: 30, pulsing: false, dot: "🟠" };
  return { color: "#eab308", size: 20, pulsing: false, dot: "🟡" };
}

// Code couleur selon la proximité horaire :
//   imminent (< 1h ou en cours) → rouge pulsant
//   soon     (< 3h)              → orange
//   today    (plus tard)         → style neutre basé sur le rank
function getEventProximityStyle(
  proximity: EventProximity | undefined,
  rank: number,
): { color: string; size: number; pulsing: boolean; dot: string } {
  if (proximity === "imminent") return { color: "#ef4444", size: 42, pulsing: true, dot: "🔴" };
  if (proximity === "soon") return { color: "#f97316", size: 32, pulsing: false, dot: "🟠" };
  return getEventRankStyle(rank);
}

// ─── Heatmap boost PredictHQ — teinte de l'overlay zone selon le phq_boost ─────
function getBoostHeatStyle(boost: number): { color: string; opacity: number; pulsing: boolean } | null {
  if (boost < 1.1) return null;                                  // 1.0 → transparent (inchangé)
  if (boost < 1.3) return { color: "#fde047", opacity: 0.15, pulsing: false };   // jaune léger
  if (boost < 1.5) return { color: "#f97316", opacity: 0.25, pulsing: false };   // orange
  if (boost < 2.0) return { color: "#fb5607", opacity: 0.35, pulsing: false };   // rouge-orange
  return { color: "#ef4444", opacity: 0.5, pulsing: true };                       // rouge vif pulsant
}
function getEventDot(rank: number): string {
  return getEventRankStyle(rank).dot;
}

function MapLoader() {
  useEffect(() => {
    if ((window as any).L) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    document.head.appendChild(script);
  }, []);
  return null;
}

// ─── Panel vols compact ───────────────────────────────────────────────────────
function FlightPanel({ flightData }: { flightData: any }) {
  const [expanded, setExpanded] = useState(false);
  if (!flightData) return null;
  const { cdg, orly, flights, source } = flightData;

  return (
    <div className="bg-card border-b border-border px-3 py-2">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between text-xs font-semibold"
      >
        <span className="flex items-center gap-1.5">
          <Plane size={13} className="text-sky-400" />
          <span className="text-sky-400">Vols temps réel</span>
          <span className="ml-2 flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: getPeakColor(cdg.peak_level) }} />
              <span className="text-muted-foreground">CDG</span>
              <span className="font-bold" style={{ color: getPeakColor(cdg.peak_level) }}>{cdg.arrivals_next_hour} arr/h</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: getPeakColor(orly.peak_level) }} />
              <span className="text-muted-foreground">Orly</span>
              <span className="font-bold" style={{ color: getPeakColor(orly.peak_level) }}>{orly.arrivals_next_hour} arr/h</span>
            </span>
          </span>
        </span>
        <span className="text-muted-foreground flex items-center gap-1">
          <span className="text-[10px] opacity-60">{source === "opensky" ? "OpenSky" : "Heuristique"}</span>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {/* CDG */}
          <div className="rounded-lg p-2 border" style={{ borderColor: getPeakColor(cdg.peak_level) + "66" }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-sky-300">✈ CDG — Roissy</span>
              <Badge className="text-[9px] py-0 px-1" style={{ background: getPeakColor(cdg.peak_level) + "33", color: getPeakColor(cdg.peak_level), border: `1px solid ${getPeakColor(cdg.peak_level)}66` }}>
                {getPeakLabel(cdg.peak_level)}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-1 text-[10px]">
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Arrivées/h</p>
                <p className="font-bold text-sm" style={{ color: getPeakColor(cdg.peak_level) }}>{cdg.arrivals_next_hour}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Départs/h</p>
                <p className="font-bold text-sm">{cdg.departures_next_hour}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Pax VTC</p>
                <p className="font-bold text-green-400">{cdg.passenger_volume_estimate}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Boost ×</p>
                <p className="font-bold text-amber-400">{cdg.vtc_demand_boost.toFixed(2)}</p>
              </div>
            </div>
            {cdg.next_wave_eta && (
              <p className="text-[10px] text-amber-400 mt-1">
                ⏰ Prochaine vague : {fmtTime(cdg.next_wave_eta)}
              </p>
            )}
          </div>

          {/* Orly */}
          <div className="rounded-lg p-2 border" style={{ borderColor: getPeakColor(orly.peak_level) + "66" }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-sky-300">✈ Orly</span>
              <Badge className="text-[9px] py-0 px-1" style={{ background: getPeakColor(orly.peak_level) + "33", color: getPeakColor(orly.peak_level), border: `1px solid ${getPeakColor(orly.peak_level)}66` }}>
                {getPeakLabel(orly.peak_level)}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-1 text-[10px]">
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Arrivées/h</p>
                <p className="font-bold text-sm" style={{ color: getPeakColor(orly.peak_level) }}>{orly.arrivals_next_hour}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Départs/h</p>
                <p className="font-bold text-sm">{orly.departures_next_hour}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Pax VTC</p>
                <p className="font-bold text-green-400">{orly.passenger_volume_estimate}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Boost ×</p>
                <p className="font-bold text-amber-400">{orly.vtc_demand_boost.toFixed(2)}</p>
              </div>
            </div>
            {orly.next_wave_eta && (
              <p className="text-[10px] text-amber-400 mt-1">
                ⏰ Prochaine vague : {fmtTime(orly.next_wave_eta)}
              </p>
            )}
          </div>

          {/* Liste des vols arrivants */}
          {flights && flights.length > 0 && (
            <div className="col-span-2 mt-1">
              <p className="text-[10px] font-semibold text-muted-foreground mb-1">Prochains atterrissages</p>
              <div className="space-y-0.5 max-h-24 overflow-y-auto">
                {flights.slice(0, 10).map((f: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-[10px] py-0.5 border-b border-border/40">
                    <span className="font-mono font-bold text-sky-300 w-16">{f.callsign}</span>
                    <span className="text-muted-foreground flex-1 px-1">{f.origin_airport || f.origin_country || "—"}</span>
                    <span className="text-green-400 mr-2">{f.airport}</span>
                    <span className="text-amber-400">{fmtTime(f.estimated_arrival)}</span>
                    <span className="text-muted-foreground ml-2 w-12 text-right">~{f.passengers_estimate} pax</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function MapPage() {
  // ── GPS temps réel (hook global — position toujours fraîche + fallback Bd Ney) ──
  const { position, isFallback, lastUpdatedAt } = useGpsPosition();

  // ── Pull-to-refresh : invalide les queries clés puis déclenche haptic ────────
  const queryClient = useQueryClient();
  const onRefresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["/api/top-zones"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/profitability"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/events"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/routing-status"] }),
    ]);
    haptic("success");
  }, [queryClient]);

  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const eventMarkersRef = useRef<any[]>([]);
  const flightMarkersRef = useRef<any[]>([]);
  const sncfMarkersRef = useRef<any[]>([]);
  const phqEventMarkersRef = useRef<any[]>([]);   // markers PredictHQ (rank-based)
  const heatLayersRef = useRef<any[]>([]);        // overlays heatmap de boost
  const driverMarkerRef = useRef<any>(null);
  const now = new Date();
  const [selectedHour, setSelectedHour] = useState(now.getHours());
  const [dayType, setDayType] = useState([0,6].includes(now.getDay()) ? "weekend" : "weekday");
  const [selectedZone, setSelectedZone] = useState<any>(null);
  const [eventsPanelOpen, setEventsPanelOpen] = useState(true);
  // ─── Couche Communautaire : toggle heatmap H3-like + calque Leaflet dédié ───
  const [showCommunityHeat, setShowCommunityHeat] = useState(false);
  // ─── Couche UX Avancée : toggle calque « Bornes ⚡ » (§6.4) ───
  const [showChargingStations, setShowChargingStations] = useState(false);
  const communityHeatLayersRef = useRef<any[]>([]);
  const { boostByZone: phqBoostByZone } = usePredictHQ();
  // Résumé PredictHQ par zone (refetch 30s) — heatmap, panel événements, anticipation.
  const {
    boostByZone: phqSummaryBoostByZone,
    events: phqEvents,
    activeCount: phqActiveCount,
    maxBoost: phqMaxBoost,
    nextEvent: phqNextEvent,
  } = useZonesSummary();
  // Boost effectif par zone : on prend le max entre les events temps réel (3s) et le résumé (30s).
  const effectiveBoostByZone: Record<string, number> = { ...phqBoostByZone };
  for (const [zid, b] of Object.entries(phqSummaryBoostByZone)) {
    effectiveBoostByZone[zid] = Math.max(effectiveBoostByZone[zid] ?? 1.0, b);
  }

  // ── Alertes de repositionnement GPS (zones chaudes <10 min) ──────────────
  // nearbyAlerts = alertes 'repositioning' actives dans un rayon 5 km.
  const { nearbyAlerts } = useRepositioningAlerts();

  /** Centre la carte sur une zone (depuis le panel événements). */
  function focusZone(zoneId: string | undefined) {
    if (!zoneId || !mapInstance.current) return;
    const z = (zones as any[]).find((zz: any) => zz.id === zoneId);
    if (z) {
      mapInstance.current.setView([z.lat, z.lng], 13, { animate: true });
      const prof = (profitability as any[]).find((p: any) => p.zone_id === zoneId);
      if (prof) setSelectedZone({ zone: z, prof });
    }
  }

  const { data: zones = [] } = useQuery({ queryKey: ["/api/zones"], queryFn: () => apiRequest("GET", "/api/zones").then(r => r.json()), refetchInterval: STATIC_INTERVAL, staleTime: 30_000 });
  // ETA des zones calculé depuis la VRAIE position GPS du chauffeur (lat/lng frais).
  const { data: profitability = [] } = useQuery({ queryKey: ["/api/profitability", selectedHour, dayType, position.lat, position.lng], queryFn: () => apiRequest("GET", `/api/profitability?hour=${selectedHour}&dayType=${dayType}&lat=${position.lat}&lng=${position.lng}`).then(r => r.json()), refetchInterval: REALTIME_INTERVAL });
  const { data: topZones = [] } = useQuery({ queryKey: ["/api/top-zones", selectedHour, dayType], queryFn: () => apiRequest("GET", `/api/top-zones?hour=${selectedHour}&dayType=${dayType}&limit=5`).then(r => r.json()), refetchInterval: REALTIME_INTERVAL });
  // ─── Lot Beta (Levier 5) : source du _ts pour la pastille de fraîcheur ───
  // /api/top-zones ne renvoie pas de _ts ; on s'appuie sur /api/best-zone-now
  // (même donnée temps réel, refetch 3s) qui expose un timestamp `_ts`.
  const { data: topZonesData } = useQuery<{ _ts?: number }>({ queryKey: ["/api/best-zone-now", "freshness", position.lat, position.lng], queryFn: () => apiRequest("GET", `/api/best-zone-now?lat=${position.lat}&lng=${position.lng}`).then(r => r.json()), refetchInterval: 3000 });
  const { data: events = [] } = useQuery({ queryKey: ["/api/events"], queryFn: () => apiRequest("GET", "/api/events").then(r => r.json()), refetchInterval: SLOW_INTERVAL, staleTime: 20_000 });
  // ─── Couche Communautaire : heatmap H3-like (grille 500m) + zones à éviter ───
  const { data: communityHeatmap } = useQuery<{ cells: any[] }>({
    queryKey: ["/api/community/heatmap"],
    queryFn: () => apiRequest("GET", "/api/community/heatmap").then(r => r.json()),
    refetchInterval: showCommunityHeat ? 10_000 : false,
    enabled: showCommunityHeat,
  });
  // Météo Open-Meteo — refetch toutes les 15min (aligné sur le cache backend TTL 15min)
  const { data: weather } = useQuery<{ condition: { code: number; description: string; precipitation_mm: number; windspeed_kmh: number; demand_boost: number; icon: string; updated_at: string }; zones_impacted: string[] }>({
    queryKey: ["/api/weather/current"],
    queryFn: () => apiRequest("GET", "/api/weather/current").then(r => r.json()),
    refetchInterval: 900000, // 15 min
    staleTime: 600_000,
  });
  const { data: flightData } = useQuery({
    queryKey: ["/api/flights"],
    queryFn: () => apiRequest("GET", "/api/flights").then(r => r.json()),
    refetchInterval: 3 * 60 * 1000, // 3 min (aligné sur cache backend TTL 3min)
    staleTime: 2 * 60 * 1000,
  });
  // Signaux SNCF trains (heuristique) — rafraîchi toutes les 5 min (cache backend TTL 5min)
  const { data: sncfData } = useQuery<{
    active_signals: Array<{
      gare_id: string; gare_name: string; heure: number; departures_count: number;
      is_peak: boolean; zones_impacted: string[]; demand_boost: number; type: string; updated_at: string;
    }>;
    total_boost: number; peak_zones: string[]; next_peak_hour: number; updated_at: string;
  }>({
    queryKey: ["/api/sncf/signals"],
    queryFn: () => apiRequest("GET", "/api/sncf/signals").then(r => r.json()),
    refetchInterval: 300000, // 5 min
    staleTime: 4 * 60 * 1000,
  });
  // Statut routing ETA temps réel (TomTom / OSRM / Calibré) — rafraîchi toutes les 3s.
  const { data: routingStatus } = useQuery({
    queryKey: ["/api/routing-status"],
    queryFn: () => apiRequest("GET", "/api/routing-status").then(r => r.json()),
    refetchInterval: 3_000,
  });
  // Source ETA active globale : champ backend explicite, sinon dérivée.
  const etaSource: string = routingStatus?.activeSource
    ?? routingStatus?.routing_priority
    ?? (routingStatus?.tomtom_source_active ? "tomtom"
      : routingStatus?.osrmAvailable ? "osrm" : "calibrated");

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    const tryInit = () => {
      const L = (window as any).L;
      if (!L) { setTimeout(tryInit, 300); return; }
      // ──────────────────────────────────────────────────────────────────────────────
      // Centrage GPS temps réel : on lit la position singleton (déjà dispo si
      // watchPosition est actif depuis une autre page) plutôt qu'une constante Paris.
      // Fallback : Bd Ney (48.8976, 2.3299) si GPS pas encore accordé.
      const _gpsCenter = (window as any).__gpsLastPosition
        ?? { lat: 48.8976, lng: 2.3299 };
      const map = L.map(mapRef.current, { center: [_gpsCenter.lat, _gpsCenter.lng], zoom: 13, zoomControl: true });
      L.tileLayer("https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=fr", {
        attribution: "© Google Maps",
        subdomains: ["0","1","2","3"],
        maxZoom: 20,
        tileSize: 256,
      }).addTo(map);
      mapInstance.current = map;
    };
    setTimeout(tryInit, 500);
  }, []);

  // ── Marqueur chauffeur (position GPS temps réel) ────────────────────────────
  // Marqueur bleu pulsant qui suit la position du chauffeur en continu.
  useEffect(() => {
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }

      // Icône bleue pulsante (CSS inline, point central + halo animé)
      const driverIcon = L.divIcon({
        className: "",
        html: `<div style="position:relative;width:18px;height:18px;">
          <span style="position:absolute;top:50%;left:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(59,130,246,0.35);animation:gpsPulse 1.6s ease-out infinite;"></span>
          <span style="position:absolute;top:50%;left:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#3b82f6;border:2px solid #fff;box-shadow:0 0 6px rgba(59,130,246,0.9);"></span>
        </div>
        <style>@keyframes gpsPulse{0%{transform:scale(0.6);opacity:0.9;}100%{transform:scale(2.6);opacity:0;}}</style>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });

      if (driverMarkerRef.current) {
        // Mise à jour de la position du marqueur existant (temps réel)
        driverMarkerRef.current.setLatLng([position.lat, position.lng]);
      } else {
        driverMarkerRef.current = L.marker([position.lat, position.lng], {
          icon: driverIcon,
          zIndexOffset: 2000,
          interactive: true,
        }).addTo(mapInstance.current);
        driverMarkerRef.current.bindPopup(
          isFallback
            ? "📍 Position par défaut (Bd Ney) — GPS indisponible"
            : "📍 Votre position (GPS temps réel)"
        );
      }
    };
    render();
  }, [position.lat, position.lng, isFallback]);

  // ──────────────────────────────────────────────────────────────────────
  // Recentrage GPS : dès que la première position GPS réelle est reçue (passage
  // isFallback=true → false), recentrer la carte sur la vraie position.
  // N'est exécuté qu'une fois (ref flag) pour ne pas perturber les zooms manuels.
  const gpsFirstCenterDone = useRef(false);
  useEffect(() => {
    if (!isFallback && !gpsFirstCenterDone.current && mapInstance.current) {
      gpsFirstCenterDone.current = true;
      mapInstance.current.setView([position.lat, position.lng], 13, { animate: true });
    }
  }, [isFallback, position.lat, position.lng]);

  // Markers zones profitabilité
  useEffect(() => {
    if (!zones.length || !profitability.length) return;
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }
      markersRef.current.forEach(m => m.remove());
      markersRef.current = [];
      heatLayersRef.current.forEach(m => m.remove());
      heatLayersRef.current = [];
      const profMap: any = Object.fromEntries((profitability as any[]).map((p: any) => [p.zone_id, p]));
      (zones as any[]).forEach((zone: any) => {
        const prof = profMap[zone.id];
        if (!prof) return;
        const idx = prof.profitability_index ?? prof.profitabilityIndex ?? 0;
        const color = getProfitColor(idx);
        const radius = 20 + (idx / 100) * 30;
        const isAirport = zone.type === "airport";
        const flightBoost = prof.flight_boost ?? prof.flightBoost ?? 1.0;

        // ── Heatmap boost PredictHQ : overlay coloré sous le cercle de la zone ──
        const phqBoost = effectiveBoostByZone[zone.id] ?? prof.phq_boost ?? prof.phqBoost ?? 1.0;
        const heat = getBoostHeatStyle(phqBoost);
        if (heat) {
          const heatCircle = L.circleMarker([zone.lat, zone.lng], {
            radius: (isAirport ? radius + 4 : radius) + 22,
            fillColor: heat.color,
            fillOpacity: heat.opacity,
            color: heat.color,
            weight: heat.pulsing ? 2 : 1,
            opacity: heat.pulsing ? 0.7 : 0.35,
            interactive: false,
            className: heat.pulsing ? "phq-heat-pulse" : "",
          }).addTo(mapInstance.current);
          heatLayersRef.current.push(heatCircle);
        }

        const circle = L.circleMarker([zone.lat, zone.lng], {
          radius: isAirport ? radius + 4 : radius,
          fillColor: color,
          fillOpacity: 0.65,
          color: isAirport ? "#38bdf8" : color,
          weight: isAirport ? 3 : 2,
          opacity: 0.9,
          dashArray: isAirport ? "6,3" : undefined,
        }).addTo(mapInstance.current);

        circle.on("click", () => setSelectedZone({ zone, prof }));

        // Étiquette — airports avec icône avion + boost vols
        const labelHtml = isAirport
          ? `<div style="background:rgba(0,0,0,0.85);color:white;padding:3px 7px;border-radius:6px;font-size:11px;font-weight:700;white-space:nowrap;border:2px solid #38bdf8;line-height:1.4;">
               ✈ ${zone.name.split("—")[0].trim()}<br>
               <span style="color:${color}">${Math.round(idx)}%</span>
               ${flightBoost > 1.0 ? `<span style="color:#fbbf24;font-size:10px;"> ×${flightBoost.toFixed(2)} ✈</span>` : ""}
             </div>`
          : `<div style="background:rgba(0,0,0,0.75);color:white;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid ${color};line-height:1.3;">${zone.name.split(" ").slice(0,2).join(" ")}<br><span style="color:${color}">${Math.round(idx)}%</span></div>`;

        const label = L.divIcon({ className: "", html: labelHtml, iconAnchor: [0, 0] });
        const lm = L.marker([zone.lat + (isAirport ? 0.004 : 0.002), zone.lng], { icon: label, interactive: false }).addTo(mapInstance.current);
        markersRef.current.push(circle, lm);
      });
    };
    render();
    // JSON.stringify du boost effectif → re-render heatmap quand le boost PredictHQ change
  }, [zones, profitability, JSON.stringify(effectiveBoostByZone)]);

  // ── Couche Communautaire : heatmap H3-like (cellules 500m teintées) ─────────
  // Rectangles Leaflet (pas de nouvelle dep) — teinte selon dominant_context,
  // opacité selon fraîcheur (freshness 0-1), taille selon count (intensité visuelle).
  useEffect(() => {
    const CONTEXT_COLOR: Record<string, string> = {
      surge: "#22c55e", dead: "#6b7280", traffic: "#f97316",
      event: "#a855f7", safety: "#ef4444", wc: "#38bdf8", charging: "#facc15",
    };
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }
      communityHeatLayersRef.current.forEach(r => r.remove());
      communityHeatLayersRef.current = [];
      if (!showCommunityHeat) return;
      const cells = communityHeatmap?.cells ?? [];
      const CELL_DEG = 500 / 111_320; // ~500m en degrés lat, approximation aussi pour lng
      cells.forEach((cell: any) => {
        const color = CONTEXT_COLOR[cell.dominant_context] || "#22c55e";
        const bounds: [[number, number], [number, number]] = [
          [cell.lat - CELL_DEG / 2, cell.lng - CELL_DEG / 2],
          [cell.lat + CELL_DEG / 2, cell.lng + CELL_DEG / 2],
        ];
        const rect = L.rectangle(bounds, {
          color,
          weight: 1,
          fillColor: color,
          // Opacité pondérée par fraîcheur (signal frais = plus visible) et intensité.
          fillOpacity: Math.max(0.08, Math.min(0.55, cell.freshness * 0.5 * (cell.intensity / 2))),
          opacity: Math.max(0.2, cell.freshness),
          interactive: true,
        }).addTo(mapInstance.current);
        rect.bindTooltip(
          `${cell.count} signalement${cell.count > 1 ? "s" : ""} · ${cell.dominant_context} · fraîcheur ${Math.round(cell.freshness * 100)}%`,
          { direction: "top", sticky: true }
        );
        communityHeatLayersRef.current.push(rect);
      });
    };
    render();
  }, [showCommunityHeat, communityHeatmap]);

  // ── Markers événements PredictHQ actifs (rank-based, pulsant) ───────────────
  // Place un marker à la position lat/lng de chaque event actif. Si l'event n'a
  // pas de coordonnées propres, on retombe sur la position de sa zone.
  useEffect(() => {
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }
      phqEventMarkersRef.current.forEach(m => m.remove());
      phqEventMarkersRef.current = [];
      const zoneById: Record<string, any> = Object.fromEntries((zones as any[]).map((z: any) => [z.id, z]));
      phqEvents.forEach((ev) => {
        let lat = ev.lat;
        let lng = ev.lng;
        if ((lat == null || lng == null) && ev.zone_id && zoneById[ev.zone_id]) {
          lat = zoneById[ev.zone_id].lat;
          lng = zoneById[ev.zone_id].lng;
        }
        if (lat == null || lng == null) return;
        const rank = ev.rank ?? 0;
        // Code couleur basé sur la proximité horaire (rouge <1h, orange <3h), sinon rank.
        const { color, size, pulsing } = getEventProximityStyle(ev.proximity, rank);
        const half = size / 2;
        const icon = L.divIcon({
          className: "",
          html: `<div style="position:relative;width:${size}px;height:${size}px;">
            ${pulsing ? `<span style="position:absolute;top:50%;left:50%;width:${size}px;height:${size}px;margin:-${half}px 0 0 -${half}px;border-radius:50%;background:${color}59;animation:phqEventPulse 1.6s ease-out infinite;"></span>` : ""}
            <span style="position:absolute;top:50%;left:50%;width:${size}px;height:${size}px;margin:-${half}px 0 0 -${half}px;border-radius:50%;background:${color}cc;border:2px solid #fff;box-shadow:0 0 ${pulsing ? 10 : 6}px ${color};"></span>
          </div>
          <style>@keyframes phqEventPulse{0%{transform:scale(0.6);opacity:0.85;}100%{transform:scale(2.4);opacity:0;}}</style>`,
          iconSize: [size, size],
          iconAnchor: [half, half],
        });
        const m = L.marker([lat, lng], { icon, zIndexOffset: 1500, interactive: true }).addTo(mapInstance.current);
        const startTime = ev.start
          ? new Date(ev.start).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
          : "";
        const timeSpan = ev.timeLabel
          ? `<span style="color:${color};font-weight:600;">⏱ ${ev.timeLabel}</span>`
          : "";
        m.bindTooltip(
          `<div style="font-size:11px;line-height:1.45;">
            <strong>${getEventDot(rank)} ${ev.title}</strong><br>
            ${startTime ? `🕒 ${startTime}` : ""}${timeSpan ? " · " + timeSpan : ""}<br>
            <span style="color:#f59e0b;">boost ×${(ev.boost ?? 1).toFixed(2)}</span> · <span style="color:#9ca3af;">rank ${rank}</span>
          </div>`,
          { direction: "top", offset: [0, -half], opacity: 0.96, className: "phq-event-tooltip" }
        );
        m.on("click", () => focusZone(ev.zone_id));
        phqEventMarkersRef.current.push(m);
      });
    };
    render();
  }, [JSON.stringify(phqEvents.map(e => [e.id, e.rank, e.boost, e.lat, e.lng, e.zone_id, e.proximity, e.timeLabel])), zones]);

  // Markers événements (incluant vols injectés)
  useEffect(() => {
    if (!(events as any[]).length) return;
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }
      eventMarkersRef.current.forEach(m => m.remove());
      eventMarkersRef.current = [];
      // ─── Lot Beta (Levier 3) : filtrage PredictHQ du jour courant ──────────
      // On ne conserve que les événements dont le début tombe aujourd'hui,
      // triés par rank décroissant, limités aux 5 plus forts.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
      const nowTs = Date.now();
      const todayEvents = (events as any[])
        .filter((e: any) => {
          const startDate = new Date(e.start || e.start_local || e.start_time || e.datetime);
          return startDate >= today && startDate < tomorrow;
        })
        .sort((a: any, b: any) => (b.rank || 0) - (a.rank || 0))
        .slice(0, 5);
      // Anti-chevauchement : on n'affiche que les 3 événements les plus forts (boost
      // décroissant). Les labels restants sont décalés verticalement de façon progressive.
      const sortedEvents = [...todayEvents]
        .filter((e: any) => e.zone)
        .sort((a: any, b: any) => (b.demand_boost ?? 1) - (a.demand_boost ?? 1))
        .slice(0, 3);
      sortedEvents.forEach((event: any, index: number) => {
        if (!event.zone) return;
        // ─── Couleur pastille selon proximité temporelle de l'événement ──────
        const startDate = new Date(event.start || event.start_local || event.start_time || event.datetime);
        const minutesToEvent = (startDate.getTime() - nowTs) / 60000;
        const proximityColor =
          minutesToEvent < 60 ? "#ef4444"          // rouge  : imminent (< 1h)
          : minutesToEvent < 180 ? "#f97316"       // orange : proche (1–3h)
          : "#22c55e";                             // vert   : lointain (≥ 3h)
        const isFlightEvent = event.event_type === "flight_wave" || event.event_type === "flight_forecast";
        const isForecast = event.event_type === "flight_forecast";
        // Lot Beta : les événements PredictHQ (non-vol) prennent la couleur de proximité temporelle.
        const bgColor = isFlightEvent ? (isForecast ? "#38bdf8" : "#0ea5e9") : proximityColor;
        const textColor = "#000";
        const prefix = isFlightEvent ? "✈" : "⚡";
        const label = event.name.substring(0, 26);
        // Décalage vertical progressif (en px) pour éviter la superposition des labels.
        const labelOffset: [number, number] = [0, -30 + (index % 3) * 20];
        const icon = L.divIcon({
          className: "",
          html: `<div style="background:${bgColor};color:${textColor};padding:3px 8px;border-radius:14px;font-size:10px;font-weight:800;white-space:nowrap;box-shadow:0 3px 12px ${bgColor}99;border:2px solid #fff;">${prefix} ${label}</div>`,
          iconAnchor: [labelOffset[0], labelOffset[1]],
        });
        const latOffset = isFlightEvent ? 0.010 : 0.006;
        const m = L.marker([event.zone.lat + latOffset, event.zone.lng + 0.005], { icon, zIndexOffset: 1000 }).addTo(mapInstance.current);
        m.bindPopup(`
          <div style="font-size:12px;min-width:220px;">
            <strong>${event.name}</strong><br>
            ${event.description || ""}<br>
            ${!isFlightEvent ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${proximityColor};margin-right:4px;"></span><span>${minutesToEvent < 60 ? "Imminent" : minutesToEvent < 180 ? "Proche" : "Lointain"} (≈${Math.max(0, Math.round(minutesToEvent))} min)</span><br>` : ""}
            <span style="color:#f59e0b;">Boost ×${(event.demand_boost ?? 1).toFixed(2)}</span>
            ${event.expected_attendance ? `<br>~${event.expected_attendance} pass. VTC estim.` : ""}
          </div>
        `);
        eventMarkersRef.current.push(m);
      });
    };
    render();
  }, [events, profitability]);

  // Markers vols individuels (petits avions sur la carte pour les 8 prochains atterrissages)
  useEffect(() => {
    if (!flightData?.flights?.length) return;
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }
      flightMarkersRef.current.forEach(m => m.remove());
      flightMarkersRef.current = [];

      // CDG et Orly coords
      const airportCoords: Record<string, [number, number]> = {
        CDG: [49.0097, 2.5479],
        ORLY: [48.7262, 2.3652],
      };

      (flightData.flights as any[]).slice(0, 12).forEach((f: any, i: number) => {
        const base = airportCoords[f.airport] || airportCoords.CDG;
        // Disposition en arc autour de l'aéroport
        const angle = (i / 12) * 2 * Math.PI;
        const r = 0.018 + (i % 3) * 0.006;
        const lat = base[0] + r * Math.cos(angle);
        const lng = base[1] + r * Math.sin(angle);

        const arrivalIn = f.estimated_arrival
          ? Math.max(0, Math.round((new Date(f.estimated_arrival).getTime() - Date.now()) / 60000))
          : "?";

        const icon = L.divIcon({
          className: "",
          html: `<div title="${f.callsign} — ${f.origin_airport || "?"} → ${f.airport} dans ${arrivalIn}min" style="font-size:14px;cursor:pointer;filter:drop-shadow(0 0 4px #38bdf8);">✈</div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        const m = L.marker([lat, lng], { icon, zIndexOffset: 500 }).addTo(mapInstance.current);
        m.bindPopup(`
          <div style="font-size:11px;">
            <strong>✈ ${f.callsign}</strong><br>
            ${f.origin_airport ? `Origine : ${f.origin_airport}` : ""}<br>
            Arrivée : <strong>${fmtTime(f.estimated_arrival)}</strong> (${arrivalIn} min)<br>
            ~${f.passengers_estimate || "?"} passagers<br>
            <span style="color:#fbbf24;">Aéroport : ${f.airport}</span>
          </div>
        `);
        flightMarkersRef.current.push(m);
      });
    };
    render();
  }, [flightData]);

  // Markers gares SNCF — affichés si boost SNCF > 0.15 (orange 0.15-0.25, rouge >0.25)
  useEffect(() => {
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }
      sncfMarkersRef.current.forEach(m => m.remove());
      sncfMarkersRef.current = [];
      const signals = sncfData?.active_signals ?? [];
      if (!signals.length) return;

      // Coordonnées GPS des gares (alignées sur GARE_ZONE_MAPPING côté serveur)
      const gareCoords: Record<string, [number, number]> = {
        gare_du_nord: [48.8809, 2.3553],
        gare_cdg: [49.0044, 2.5703],
        villepinte_expo: [48.9744, 2.5159],
        stade_de_france: [48.9245, 2.3601],
      };

      signals.forEach((sig) => {
        if (sig.demand_boost <= 0.15) return; // seuil d'affichage
        const coord = gareCoords[sig.gare_id];
        if (!coord) return;
        const color = sig.demand_boost > 0.25 ? "#dc2626" : "#f97316"; // rouge / orange
        const pct = Math.round(sig.demand_boost * 100);
        const icon = L.divIcon({
          className: "",
          html: `<div title="${sig.gare_name} — +${pct}% demande" style="font-size:18px;cursor:pointer;filter:drop-shadow(0 0 5px ${color});">🚉</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        const m = L.marker(coord, { icon, zIndexOffset: 800 }).addTo(mapInstance.current);
        m.bindPopup(`
          <div style="font-size:12px;min-width:200px;">
            <strong>🚉 ${sig.gare_name}</strong><br>
            <span style="color:${color};font-weight:700;">+${pct}% demande</span> | ${sig.departures_count} trains/h<br>
            <span style="color:#94a3b8;">${sig.type.toUpperCase()}${sig.is_peak ? " · heure de pointe" : ""}</span><br>
            Zones : ${sig.zones_impacted.join(", ")}
          </div>
        `);
        sncfMarkersRef.current.push(m);
      });
    };
    render();
  }, [sncfData]);

  const fmtH = (h: number) => `${h.toString().padStart(2,"0")}:00`;

  return (
    // ── PullToRefresh — englobe tout le contenu de la page ───────────────────
    // Le wrapper est positionné en relatif et hérite de la hauteur fixe ;
    // la carte Leaflet (absolute fill) reste plein écran à l'intérieur.
    <PullToRefresh onRefresh={onRefresh}>
    <div className="relative flex flex-col" style={{ height: "calc(100vh - 8.5rem)" }}>
      {/* ─── Bandeau « Où aller maintenant » ─ rendu par <RecoWhereToGo /> plus bas.
           Ancien <RecommendationBanner /> retiré (doublon + sticky z-1200 qui
           écrasait le header, les filtres et le contenu du menu). ────────── */}
      {/* ─── Lot Beta (Levier 5) : pastille de fraîcheur des données, fixe en bas à gauche ───── */}
      <DataFreshnessBadge ts={topZonesData?._ts} position="bottom-left" />
      {/* ─── Bandeau alerte événement rare (Lot C) — premier enfant, au-dessus de la carte ───── */}
      <RareEventBanner />
      {/* --- Couche Aeroports/Evenements/Greves (Iteration 3) : fin evenement imminente --- */}
      <div className="px-3 pt-2">
        <EventEndingBanner />
      </div>
      {/* ─── Bandeau TomTom non connecté — visible si ETA sans trafic temps réel ─────────── */}
      <RoutingSourceBanner />
      <MapLoader />
      {/* Animation pulsante pour la heatmap de boost PredictHQ (boost ≥ 2.0) */}
      <style>{`@keyframes phqHeatPulse{0%,100%{opacity:0.35;}50%{opacity:0.7;}} .phq-heat-pulse{animation:phqHeatPulse 1.8s ease-in-out infinite;}`}</style>

      {/* ── Bandeau « Où aller maintenant » — meilleure zone + distance + gain + countdown pic ── */}
      <RecoWhereToGo
        position={position}
        topZones={topZones as any[]}
        onFocusZone={focusZone}
      />

      {/* ── Badge alertes de repositionnement GPS (zones chaudes <10 min) ──── */}
      {/* Affiché si au moins une alerte 'repositioning' active dans 5 km. */}
      {/* Clic → recentre la carte sur la zone. Disparaît quand l'alerte expire. */}
      {nearbyAlerts.length > 0 && (
        <div className="flex flex-col gap-1 px-3 py-2 bg-orange-500/10 border-b border-orange-500/40" data-testid="reposition-alerts">
          {nearbyAlerts.slice(0, 3).map((a) => {
            // Extraire le temps (Xmin) depuis le titre pour l'affichage compact.
            const minMatch = a.title.match(/(\d+)\s*min/);
            const minLabel = minMatch ? `${minMatch[1]} min` : "";
            return (
              <button
                key={a.id}
                onClick={() => focusZone(a.zone_id)}
                className="w-full flex items-center gap-2 rounded-md bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/50 px-2.5 py-1.5 text-left transition-colors"
                data-testid={`reposition-badge-${a.zone_id ?? a.id}`}
                title={a.message}
              >
                <span className="text-base shrink-0">📍</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[12px] font-bold text-orange-200 truncate">{a.title}</span>
                  <span className="block text-[10px] text-orange-300/80 truncate">{a.message}</span>
                </span>
                {minLabel && (
                  <span className="shrink-0 text-[11px] font-semibold text-orange-200 whitespace-nowrap">Zone chaude à {minLabel}</span>
                )}
                <Navigation size={14} className="text-orange-300 shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      {/* Barre de contrôle heure/jour */}
      <div className="bg-card border-b border-border px-3 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-48">
          <Clock size={14} className="text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground w-10 shrink-0">{fmtH(selectedHour)}</span>
          <Slider value={[selectedHour]} min={0} max={23} step={1} onValueChange={([v]) => setSelectedHour(v)} className="flex-1" data-testid="slider-hour" />
        </div>
        <Select value={dayType} onValueChange={setDayType}>
          <SelectTrigger className="w-32 h-8 text-xs" data-testid="select-day-type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="weekday">Semaine</SelectItem>
            <SelectItem value="weekend">Weekend</SelectItem>
          </SelectContent>
        </Select>
        {/* Indicateur Anticipation PredictHQ : X events actifs · boost max · prochain event */}
        {(phqActiveCount > 0 || phqNextEvent) && (
          <div
            className="flex items-center gap-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 px-2 py-1 text-[11px]"
            data-testid="phq-anticipation-indicator"
            title="Anticipation événementielle PredictHQ"
          >
            <Radio size={12} className="text-amber-400 shrink-0" />
            <span className="text-amber-300 font-semibold">{phqActiveCount} évén. actifs</span>
            {phqMaxBoost > 1.0 && (
              <span className="text-muted-foreground">· boost max <span className="text-amber-400 font-bold">×{phqMaxBoost.toFixed(1)}</span></span>
            )}
            {phqNextEvent && (
              <span className="text-muted-foreground hidden lg:inline">
                · prochain: <span className="text-foreground">{phqNextEvent.title.length > 22 ? phqNextEvent.title.slice(0, 22) + "…" : phqNextEvent.title}</span>
                {typeof phqNextEvent.hours_until_start === "number" && phqNextEvent.hours_until_start >= 0 && (
                  <> dans <span className="text-amber-400 font-bold">{Math.round(phqNextEvent.hours_until_start)}h</span></>
                )}
              </span>
            )}
          </div>
        )}
        {/* Badge météo : visible uniquement par pluie/orage/neige (boost > 0) */}
        {weather && weather.condition && weather.condition.demand_boost > 0 && (
          <div
            className="flex items-center gap-1.5 rounded-md bg-sky-500/10 border border-sky-500/30 px-2 py-1 text-[11px]"
            data-testid="weather-indicator"
            title={`Météo Open-Meteo — ${weather.condition.description}`}
          >
            <span className="text-sm leading-none">{weather.condition.icon}</span>
            <span className="text-sky-300 font-semibold">{weather.condition.description}</span>
            <span className="text-sky-400 font-bold">+{Math.round(weather.condition.demand_boost * 100)}% demande</span>
            {weather.condition.precipitation_mm > 0 && (
              <span className="text-muted-foreground hidden lg:inline">· {weather.condition.precipitation_mm.toFixed(1)} mm</span>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-3">
          <GpsFreshness lastUpdatedAt={lastUpdatedAt} isFallback={isFallback} />
          <UpdateWidget compact={true} />
        </div>
      </div>

      {/* Légende marqueur chauffeur */}
      <div className="bg-card/60 px-3 py-1 flex items-center gap-2 text-[10px] border-b border-border">
        <span className="relative inline-flex w-3 h-3">
          <span className="absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500 border border-white" />
        </span>
        <span className="text-muted-foreground">Votre position (GPS temps réel)</span>
      </div>

      {/* Panel vols temps réel */}
      <FlightPanel flightData={flightData} />

      {/* Légende simplifiée — 4 items essentiels (les détails sont visibles via les marqueurs) */}
      <div className="bg-card/80 px-3 py-1.5 flex items-center gap-3 text-xs border-b border-border">
        <div className="flex items-center gap-1"><span className="inline-block rounded-full" style={{ width: 8, height: 8, background: COLORS.ultraHigh }} /><span className="text-muted-foreground">Ultra rentable</span></div>
        <div className="flex items-center gap-1"><span className="inline-block rounded-full" style={{ width: 8, height: 8, background: COLORS.high }} /><span className="text-muted-foreground">Rentable</span></div>
        <div className="flex items-center gap-1"><span className="inline-block rounded-full" style={{ width: 8, height: 8, background: COLORS.medium }} /><span className="text-muted-foreground">Neutre/Faible</span></div>
        <div className="flex items-center gap-1"><span className="inline-block rounded-full" style={{ width: 8, height: 8, background: "#f59e0b" }} /><span className="text-muted-foreground">Événement actif</span></div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* isolate + overflow-hidden : plafonne les z-index Leaflet dans ce conteneur */}
        <div className="flex-1 relative overflow-hidden isolate">
          <div ref={mapRef} style={{ width: "100%", height: "100%" }} data-testid="map-container" />

          {/* Indicateur global — source ETA active (coin supérieur droit) */}
          <div className="absolute top-3 right-3 z-[1000] flex items-center gap-1.5 rounded-lg bg-black/75 backdrop-blur px-2.5 py-1.5 border border-white/10" data-testid="eta-source-indicator">
            <Navigation size={12} className="text-green-400" />
            <span className="text-[10px] text-white/70">Source ETA active</span>
            <RouteSourceBadge source={etaSource} size="xs" />
          </div>

          {/* ─── Couche Communautaire : toggle "Chaleur communauté" (heatmap H3-like) ─── */}
          {/* Positionné à gauche sur mobile pour éviter le FocusBubble (fixed right-2 z-40), à droite sur desktop */}
          <button
            type="button"
            onClick={() => setShowCommunityHeat((v) => !v)}
            data-testid="button-toggle-community-heat"
            aria-pressed={showCommunityHeat}
            className={`absolute top-14 left-3 sm:left-auto sm:right-3 z-[1000] flex items-center gap-1.5 rounded-lg backdrop-blur px-2.5 py-2 border transition-colors ${showCommunityHeat ? "bg-orange-500/90 border-orange-300/50 text-white" : "bg-black/75 border-white/10 text-white/70"}`}
            style={{ minHeight: 44 }}
          >
            <Flame size={14} />
            <span className="text-[10px] font-semibold">Chaleur communauté</span>
          </button>

          {/* ─── Couche UX Avancée : toggle « Bornes ⚡ » — bornes de recharge électrique à proximité (§6.4) ─── */}
          <button
            type="button"
            onClick={() => setShowChargingStations((v) => !v)}
            data-testid="button-toggle-charging-stations"
            aria-pressed={showChargingStations}
            className={`absolute top-[6.5rem] left-3 sm:left-auto sm:right-3 sm:top-24 z-[1000] flex items-center gap-1.5 rounded-lg backdrop-blur px-2.5 py-2 border transition-colors ${showChargingStations ? "bg-emerald-500/90 border-emerald-300/50 text-white" : "bg-black/75 border-white/10 text-white/70"}`}
            style={{ minHeight: 44 }}
          >
            <BatteryCharging size={14} />
            <span className="text-[10px] font-semibold">Bornes ⚡</span>
          </button>

          {/* Calque Leaflet des bornes de recharge (rendu invisible — gère ses propres markers) */}
          <ChargingStationsMap
            mapInstance={mapInstance}
            enabled={showChargingStations}
            lat={position?.lat ?? 48.8566}
            lng={position?.lng ?? 2.3522}
          />

          {/* ─── Couche Communautaire : carte "À éviter" (coin supérieur gauche, desktop) ─── */}
          <div className="hidden sm:block absolute top-14 left-3 z-[1000] w-64">
            <AvoidZonesCard onSelectZone={(zoneId) => focusZone(zoneId)} />
          </div>

          {/* ─── Bouton mode conduite :
               Mobile  → FAB flottant bottom-right (fixed) au-dessus nav bottom
               Desktop → bouton coin supérieur gauche (sticky dans la carte) ─── */}
          {/* FAB mobile */}
          <Link
            href="/drive"
            className="fixed bottom-20 right-4 z-[1100] sm:hidden flex items-center justify-center rounded-full h-14 w-14 bg-emerald-500 text-white shadow-2xl active:scale-95 transition-all border-2 border-emerald-300/50"
            data-testid="button-enter-drive"
            title="Mode conduite"
            aria-label="Mode conduite"
          >
            <span className="text-2xl leading-none">🚗</span>
          </Link>
          {/* Bouton desktop */}
          <Link
            href="/drive"
            className="hidden sm:flex absolute top-3 left-3 z-[1000] items-center gap-1.5 rounded-lg bg-emerald-500/90 backdrop-blur px-3 py-2 border border-emerald-300/40 text-white text-sm font-bold shadow-lg hover:bg-emerald-500 active:scale-95 transition-all"
            data-testid="button-enter-drive-desktop"
            title="Basculer en mode conduite plein écran"
          >
            <span className="text-lg leading-none">🚗</span>
            <span className="tracking-wide">Mode conduite</span>
          </Link>

          {/* ─── Radar aérien communautaire (rapport.md §5 + §13 wow#9) : FAB discret ─── */}
          {/* Mobile → FAB flottant au-dessus du bouton mode conduite */}
          <Link
            href="/radar"
            className="fixed bottom-36 right-4 z-[1100] sm:hidden flex items-center justify-center rounded-full h-12 w-12 bg-cyan-500/90 text-white shadow-2xl active:scale-95 transition-all border-2 border-cyan-300/50"
            data-testid="button-open-radar"
            title="Radar communautaire"
            aria-label="Ouvrir le radar aérien communautaire"
          >
            <RadarIcon size={20} />
          </Link>
          {/* Desktop → bouton discret coin supérieur gauche, sous le bouton mode conduite */}
          <Link
            href="/radar"
            className="hidden sm:flex absolute top-14 left-3 z-[1000] items-center gap-1.5 rounded-lg bg-cyan-500/90 backdrop-blur px-3 py-2 border border-cyan-300/40 text-white text-sm font-bold shadow-lg hover:bg-cyan-500 active:scale-95 transition-all"
            data-testid="button-open-radar-desktop"
            title="Radar aérien communautaire — voir les chauffeurs actifs autour de vous"
          >
            <RadarIcon size={16} />
            <span className="tracking-wide">Radar</span>
          </Link>

          {/* Popup zone sélectionnée — enrichie avec données vols */}
          {selectedZone && (() => {
            const p = selectedZone.prof;
            const profIdx = p.profitability_index ?? p.profitabilityIndex ?? 0;
            const ratioDs = p.ratio_ds ?? p.ratioDs ?? 0;
            const avgDist = p.avg_distance_km ?? p.avgDistanceKm ?? 0;
            const longRide = p.long_ride_probability ?? p.longRideProbability ?? 0;
            const surge = p.surge_multiplier ?? p.surgeMultiplier ?? 1;
            const flightBoost = p.flight_boost ?? p.flightBoost ?? 1.0;
            const etaToZone = p.eta_to_zone ?? p.etaToZone ?? p.eta_min ?? null;
            const isAirport = selectedZone.zone.type === "airport";
            const phqBoost = phqBoostByZone[selectedZone.zone.id] ?? p.phq_boost ?? 1.0;
            const phqEventTitle = p.phq_event_title ?? selectedZone.zone.phq_event_title;
            const airportKey = selectedZone.zone.id === "z_cdg" ? "cdg" : selectedZone.zone.id === "z_orly" ? "orly" : null;
            const airportStats = airportKey && flightData ? flightData[airportKey] : null;

            return (
              <div className="absolute bottom-4 left-4 right-4 z-[1000] max-w-sm pb-safe">
                <Card className="shadow-2xl border-primary/30">
                  <CardHeader className="pb-2 pt-3 px-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-sm">{selectedZone.zone.name}</CardTitle>
                        <p className="text-xs text-muted-foreground capitalize">{selectedZone.zone.type}</p>
                        {phqBoost > 1.0 && (
                          <div className="mt-1">
                            <PredictHQBadge boost={phqBoost} eventTitle={phqEventTitle} compact />
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full" style={{ background: getProfitColor(profIdx) }} />
                        <Badge variant="outline" className="text-xs py-0" style={{ borderColor: getProfitColor(profIdx), color: getProfitColor(profIdx) }}>{getProfitLabel(profIdx)}</Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-3">
                    <div className="grid grid-cols-3 gap-2 text-center mb-2">
                      <div className="bg-muted rounded p-1.5"><p className="text-[10px] text-muted-foreground">D/O ratio</p><p className="text-sm font-bold text-primary">{ratioDs.toFixed(1)}x</p></div>
                      <div className="bg-muted rounded p-1.5"><p className="text-[10px] text-muted-foreground">Dist. moy.</p><p className="text-sm font-bold">{avgDist.toFixed(1)} km</p></div>
                      <div className="bg-muted rounded p-1.5"><p className="text-[10px] text-muted-foreground">Longue</p><p className="text-sm font-bold text-green-500">{Math.round(longRide * 100)}%</p></div>
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>Score: <strong className="text-foreground">{Math.round(profIdx)}/100</strong></span>
                      {surge > 1 && <span className="text-amber-500 font-medium">⚡ Surge ×{surge.toFixed(2)}</span>}
                    </div>

                    {/* ETA temps réel depuis position GPS + badge source (TomTom/OSRM/Calibré) */}
                    {etaToZone != null && (
                      <div className="flex items-center justify-between text-xs mb-1 rounded-lg bg-muted/40 px-2 py-1.5">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <Navigation size={11} className="text-green-400" />
                          ETA trajet : <strong className="text-foreground tabular-nums">{Math.round(etaToZone)} min</strong>
                        </span>
                        {/* Badge source par zone : TomTom primaire, sinon fallback OSRM/Calibré */}
                        <span data-testid="map-eta-source-badge">
                          <RouteSourceBadge source={p.distance_source ?? p.distanceSource ?? "calibrated"} size="xs" />
                        </span>
                      </div>
                    )}

                    {/* Données vols si aéroport */}
                    {isAirport && airportStats && (
                      <div className="mt-2 rounded-lg p-2 border border-sky-500/30 bg-sky-950/30">
                        <p className="text-[10px] font-bold text-sky-400 mb-1 flex items-center gap-1">
                          <Plane size={10} /> Données vols en temps réel
                        </p>
                        <div className="grid grid-cols-2 gap-1 text-[10px]">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Arrivées/h :</span>
                            <span className="font-bold" style={{ color: getPeakColor(airportStats.peak_level) }}>{airportStats.arrivals_next_hour}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Départs/h :</span>
                            <span className="font-bold">{airportStats.departures_next_hour}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Pax VTC :</span>
                            <span className="font-bold text-green-400">~{airportStats.passenger_volume_estimate}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Boost vols :</span>
                            <span className="font-bold text-amber-400">×{flightBoost.toFixed(2)}</span>
                          </div>
                        </div>
                        <div className="mt-1 flex items-center justify-between">
                          <Badge className="text-[9px] py-0" style={{ background: getPeakColor(airportStats.peak_level) + "33", color: getPeakColor(airportStats.peak_level), border: `1px solid ${getPeakColor(airportStats.peak_level)}66` }}>
                            {getPeakLabel(airportStats.peak_level)}
                          </Badge>
                          {airportStats.next_wave_eta && (
                            <span className="text-[9px] text-amber-400">⏰ Prochaine vague {fmtTime(airportStats.next_wave_eta)}</span>
                          )}
                        </div>

                        {/* Liste vols arrivants pour cet aéroport */}
                        {flightData?.flights?.filter((f: any) => f.airport === (airportKey === "cdg" ? "CDG" : "ORLY")).slice(0, 4).map((f: any, i: number) => (
                          <div key={i} className="flex items-center justify-between text-[9px] border-t border-border/30 pt-0.5 mt-0.5">
                            <span className="font-mono font-bold text-sky-300">{f.callsign}</span>
                            <span className="text-muted-foreground">{f.origin_airport || "?"}</span>
                            <span className="text-amber-400">{fmtTime(f.estimated_arrival)}</span>
                            <span className="text-muted-foreground">{f.passengers_estimate} pax</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Boost vols pour zones proches (non-aéroport) */}
                    {!isAirport && flightBoost > 1.0 && (
                      <div className="mt-1.5 text-[10px] text-sky-400 bg-sky-950/30 rounded px-2 py-1 border border-sky-500/20">
                        ✈ Boost CDG/Orly actif sur cette zone : ×{flightBoost.toFixed(2)}
                      </div>
                    )}

                    {/* ─── Couche Communautaire : signalement enrichi + fil des signaux ────────── */}
                    <ZoneChat zoneId={selectedZone.zone.id} />

                    <button className="text-xs text-muted-foreground mt-2 hover:text-foreground" onClick={() => setSelectedZone(null)}>Fermer</button>
                  </CardContent>
                </Card>
              </div>
            );
          })()}
        </div>

        {/* Sidebar droite */}
        <div className="w-56 border-l border-border bg-card overflow-y-auto hidden md:block">
          {/* ── Panel collapsible « Événements actifs » (PredictHQ, trié par boost) ── */}
          {phqEvents.length > 0 && (
            <div className="border-b border-border" data-testid="phq-events-panel">
              <button
                onClick={() => setEventsPanelOpen(v => !v)}
                className="w-full p-3 flex items-center justify-between hover:bg-muted/40 transition-colors"
                data-testid="button-toggle-phq-events"
              >
                <span className="text-xs font-semibold flex items-center gap-1.5">
                  <Radio size={13} className="text-amber-400" />
                  Événements actifs
                  <span className="text-[10px] text-muted-foreground font-normal">({phqEvents.length})</span>
                </span>
                {eventsPanelOpen ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
              </button>
              {eventsPanelOpen && (
                <div className="divide-y divide-border">
                  {phqEvents.map((ev, i) => {
                    const rank = ev.rank ?? 0;
                    // Couleur basée sur la proximité pour surligner les events urgents.
                    const { color } = getEventProximityStyle(ev.proximity, rank);
                    // Bordure gauche colorée pour les events imminent/soon.
                    const urgentBorder = ev.proximity === "imminent"
                      ? "border-l-2 border-red-500"
                      : ev.proximity === "soon"
                        ? "border-l-2 border-orange-500"
                        : "";
                    return (
                      <div
                        key={ev.id || i}
                        className={`p-3 ${urgentBorder}`}
                        data-testid={`phq-event-${i}`}
                        data-proximity={ev.proximity ?? "today"}
                      >
                        <p className="text-xs font-medium flex items-start gap-1.5 leading-tight">
                          <span className="shrink-0">{getEventDot(rank)}</span>
                          <span className="truncate">{ev.title}{ev.zone_name ? <span className="text-muted-foreground font-normal"> — {ev.zone_name}</span> : null}</span>
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          rank {rank} · <span className="text-amber-400 font-semibold">boost ×{ev.boost.toFixed(2)}</span>
                          {ev.timeLabel ? (
                            <> · <span style={{ color, fontWeight: 600 }}>⏱ {ev.timeLabel}</span></>
                          ) : ev.start ? (
                            <> · {fmtDate(ev.start)}</>
                          ) : null}
                        </p>
                        {ev.zone_id && (
                          <button
                            onClick={() => focusZone(ev.zone_id)}
                            className="mt-1 text-[10px] flex items-center gap-1 hover:underline"
                            style={{ color }}
                            data-testid={`button-focus-zone-${i}`}
                          >
                            <MapPin size={10} /> Voir sur la carte
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {/* --- Couche Aeroports/Evenements/Greves (Iteration 3) : file aeroport si a proximite --- */}
          <div className="p-3 border-b border-border">
            <AirportQueueCard />
          </div>
          <div className="p-3 border-b border-border"><p className="text-[11px] font-semibold flex items-center gap-1.5"><TrendingUp size={12} className="text-primary" />Top 3 zones · {fmtH(selectedHour)}</p></div>
          <div className="divide-y divide-border">
            {/* Panneau condensé : Top 3 zones, une seule ligne compacte par zone */}
            {(topZones as any[]).slice(0, 3).map((item: any, i: number) => {
              const idx = item.profitability_index ?? item.profitabilityIndex ?? 0;
              const lrp = item.long_ride_probability ?? item.longRideProbability ?? 0;
              const flightBoost = item.flight_boost ?? item.flightBoost ?? 1.0;
              return (
                <button key={item.zone_id} className="w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors flex items-center gap-1.5" onClick={() => setSelectedZone({ zone: item.zone, prof: item })} data-testid={`button-zone-${item.zone_id}`}>
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0">#{i+1}</span>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: getProfitColor(idx) }} />
                  <span className="text-[11px] font-medium truncate">{item.zone?.name}</span>
                  {flightBoost > 1.05 && <Plane size={10} className="text-sky-400 shrink-0" />}
                  <span className="ml-auto text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">{Math.round(idx)} · <span className="text-green-500">{Math.round(lrp * 100)}% long</span></span>
                </button>
              );
            })}
          </div>

          {/* Événements sidebar — condensé : max 3, une ligne compacte par événement */}
          {(events as any[]).length > 0 && (
            <>
              <div className="p-3 border-t border-b border-border mt-2">
                <p className="text-[11px] font-semibold flex items-center gap-1.5"><Zap size={12} className="text-amber-500" />Événements actifs</p>
              </div>
              <div className="divide-y divide-border">
                {(events as any[]).slice(0, 3).map((event: any) => {
                  const isFlightEvt = event.event_type === "flight_wave" || event.event_type === "flight_forecast";
                  // Nom court (premier mot significatif) pour rester sur une seule ligne.
                  const shortName = (event.name || "").split(" ").slice(0, 2).join(" ");
                  const boost = (event.demand_boost ?? 1);
                  const pax = event.expected_attendance;
                  const paxLabel = pax ? (pax >= 1000 ? `${Math.round(pax / 1000)}k pax` : `${pax} pax`) : null;
                  return (
                    <div key={event.id} className="px-3 py-2 flex items-center gap-1.5 text-[11px]">
                      <span className="shrink-0">{isFlightEvt ? "✈" : "⚡"}</span>
                      <span className="font-medium truncate">{shortName}</span>
                      <span className="ml-auto text-muted-foreground shrink-0 whitespace-nowrap">×{boost.toFixed(1)}{paxLabel ? ` · ${paxLabel}` : ""}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* --- Couche Aeroports/Evenements/Greves (Iteration 3) : calendrier IDF centralise --- */}
          <div className="p-3 border-t border-border">
            <IDFCalendar />
          </div>
        </div>
      </div>
    </div>
    <StationOverlay />
    </PullToRefresh>
  );
}
