import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest, API_BASE, getAuthToken } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  CornerDownLeft, MapPin, Navigation, TrendingUp, Clock, Zap, Car,
  RefreshCw, AlertCircle, CheckCircle2, Crosshair, Route,
  ChevronRight, Target, Euro, Timer, Play, StopCircle, Search,
  ArrowRight, BarChart2, Activity,
} from "lucide-react";
import { UpdateWidget } from "@/components/UpdateWidget";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface RouteZone {
  zone: { id: string; name: string; lat: number; lng: number; type: string };
  distanceKm: number;
  etaMinutes: number;
  distToRoute: number;
  detourKm: number;
  detourMinutes: number;
  progressRatio: number;
  profitabilityIndex: number;
  surgeMultiplier: number;
  avgFare: number;
  estimatedRevenue: number;
  netGain: number;
  efficiency: number;
  routeScore: number;
  viability: boolean;
  reason: string;
  mapsDetourUrl: string;
}

interface ReturnJourneyResponse {
  userPosition: { lat: number; lng: number };
  destination: { lat: number; lng: number; name: string };
  directDistanceKm: number;
  directEtaMin: number;
  routeZones: RouteZone[];
  recommendation: RouteZone | null;
  hour: number;
  dayType: string;
  computedAt: string;
}

interface GeoResult { lat: number; lng: number; display_name: string; }

// ─── Helpers couleur ─────────────────────────────────────────────────────────

function getScoreColor(score: number): string {
  if (score >= 80) return "#22c55e";
  if (score >= 60) return "#86efac";
  if (score >= 40) return "#fbbf24";
  if (score >= 25) return "#f97316";
  return "#ef4444";
}

function getScoreLabel(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Rentable";
  if (score >= 40) return "Correct";
  if (score >= 25) return "Faible";
  return "Déconseillé";
}

function getZoneTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    airport: "✈️", transport: "🚊", business: "🏢",
    entertainment: "🎭", residential: "🏘️",
  };
  return icons[type] || "📍";
}

function fmtTimeSec(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtChrono(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// ─── Helper Leaflet chargement CDN ───────────────────────────────────────────

async function ensureLeaflet(): Promise<any> {
  if ((window as any).L) return (window as any).L;
  if (!document.getElementById("leaflet-css")) {
    const link = document.createElement("link");
    link.id = "leaflet-css";
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);
  }
  await new Promise<void>((resolve, reject) => {
    if (document.getElementById("leaflet-js")) { resolve(); return; }
    const script = document.createElement("script");
    script.id = "leaflet-js";
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return (window as any).L;
}

// ─── Carte Leaflet OSM — trajet retour (user → zone → destination) ────────────

function JourneyMap({
  userPos, dest, selectedZone,
}: {
  userPos: { lat: number; lng: number };
  dest: { lat: number; lng: number };
  selectedZone: RouteZone | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);

  useEffect(() => {
    ensureLeaflet().then((L: any) => {
      if (!containerRef.current) return;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }

      const points: [number, number][] = [[userPos.lat, userPos.lng]];
      if (selectedZone) points.push([selectedZone.zone.lat, selectedZone.zone.lng]);
      points.push([dest.lat, dest.lng]);

      const map = L.map(containerRef.current, { zoomControl: true, attributionControl: false });
      mapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(map);

      // Marqueur utilisateur
      const userIcon = L.divIcon({ html: `<div style="width:14px;height:14px;background:#3b82f6;border:2px solid white;border-radius:50%;box-shadow:0 0 0 6px rgba(59,130,246,0.2);"></div>`, className: "", iconAnchor: [7,7] });
      L.marker([userPos.lat, userPos.lng], { icon: userIcon }).addTo(map).bindPopup("📍 Votre position");

      // Marqueur zone (si sélectionnée)
      if (selectedZone) {
        const zIcon = L.divIcon({ html: `<div style="width:16px;height:16px;background:#22c55e;border:2px solid white;border-radius:50%;box-shadow:0 0 0 5px rgba(34,197,94,0.2);"></div>`, className: "", iconAnchor: [8,8] });
        L.marker([selectedZone.zone.lat, selectedZone.zone.lng], { icon: zIcon }).addTo(map).bindPopup(`🎯 ${selectedZone.zone.name}`);
      }

      // Marqueur destination
      const destIcon = L.divIcon({ html: `<div style="width:18px;height:18px;background:#f97316;border:2px solid white;border-radius:4px;box-shadow:0 0 0 4px rgba(249,115,22,0.2);transform:rotate(45deg);"></div>`, className: "", iconAnchor: [9,9] });
      L.marker([dest.lat, dest.lng], { icon: destIcon }).addTo(map).bindPopup("🏠 Destination");

      // Trajet polyline
      L.polyline(points, { color: "#22c55e", weight: 3, dashArray: selectedZone ? "8 4" : undefined, opacity: 0.85 }).addTo(map);

      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [40, 40] });
    }).catch(() => {});
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [userPos.lat, userPos.lng, dest.lat, dest.lng, selectedZone?.zone.id]);

  return (
    <div ref={containerRef} style={{ height: "280px", borderRadius: "12px", overflow: "hidden", background: "#1e293b" }} className="border border-border" />
  );
}

function DestPreviewMap({ dest }: { dest: { lat: number; lng: number } }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);

  useEffect(() => {
    ensureLeaflet().then((L: any) => {
      if (!containerRef.current || mapRef.current) return;
      const map = L.map(containerRef.current, { zoomControl: false, attributionControl: false });
      mapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(map);
      const destIcon = L.divIcon({ html: `<div style="width:16px;height:16px;background:#f97316;border:2px solid white;border-radius:4px;transform:rotate(45deg);"></div>`, className: "", iconAnchor: [8,8] });
      L.marker([dest.lat, dest.lng], { icon: destIcon }).addTo(map).bindPopup("🏠 Destination");
      map.setView([dest.lat, dest.lng], 14);
    }).catch(() => {});
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [dest.lat, dest.lng]);

  return (
    <div ref={containerRef} style={{ height: "160px", borderRadius: "10px", overflow: "hidden", background: "#1e293b" }} className="border border-border mt-3" />
  );
}

// ─── Carte zone (liste top 5) ─────────────────────────────────────────────────

function RouteZoneCard({ zone, rank, isSelected, onClick }: {
  zone: RouteZone; rank: number; isSelected: boolean; onClick: () => void;
}) {
  const color = getScoreColor(zone.routeScore);
  return (
    <div
      onClick={onClick}
      style={{
        borderColor: isSelected ? color : undefined,
        boxShadow: isSelected ? `0 0 0 2px ${color}40` : undefined,
        opacity: zone.viability ? 1 : 0.55,
      }}
      className={`cursor-pointer rounded-2xl border p-4 transition-all duration-200 ${
        isSelected ? "bg-primary/5" : "border-border bg-card hover:border-muted-foreground/40"
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center font-black text-xs text-black flex-shrink-0"
            style={{ background: color }}
          >
            {rank}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-sm">{getZoneTypeIcon(zone.zone.type)}</span>
              <span className="font-semibold text-sm truncate">{zone.zone.name}</span>
            </div>
            <p className="text-[10px] text-muted-foreground italic mt-0.5 line-clamp-1">{zone.reason}</p>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="font-black text-lg leading-none" style={{ color }}>{zone.routeScore}</div>
          <div className="text-[9px] text-muted-foreground">{getScoreLabel(zone.routeScore)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-0.5"><Route size={9} /> dév. {zone.distToRoute}km</span>
        <span className="flex items-center gap-0.5"><Navigation size={9} /> +{zone.detourKm}km</span>
        <span className="flex items-center gap-0.5 text-green-400 font-semibold"><Euro size={9} /> ~{zone.estimatedRevenue}€</span>
        {zone.viability ? (
          <Badge variant="outline" className="text-[9px] py-0 px-1.5 border-green-500/40 text-green-400">Rentable</Badge>
        ) : (
          <Badge variant="outline" className="text-[9px] py-0 px-1.5 border-red-500/40 text-red-400">Pas rentable</Badge>
        )}
      </div>
    </div>
  );
}

// ─── Page principale ───────────────────────────────────────────────────────────

export default function ReturnJourneyPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // GPS — hook singleton partagé (maximumAge=3s, fallback Bd Ney)
  const { position: gpsPos, status: gpsStatus, isFallback } = useGpsPosition();
  const position = gpsPos; // toujours valide (fallback Bd Ney si GPS refusé)

  // Destination
  const [destQuery, setDestQuery] = useState("");
  const [geoResults, setGeoResults] = useState<GeoResult[]>([]);
  const [geoLoading, setGeoLoading] = useState(false);
  const [destination, setDestination] = useState<{ lat: number; lng: number; name: string } | null>(null);

  // Calcul
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReturnJourneyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const lastComputeRef = useRef<number>(0);

  // Course en cours
  const [rideActive, setRideActive] = useState(false);
  const [rideStartTs, setRideStartTs] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [rideDistance, setRideDistance] = useState("");
  const [rideFare, setRideFare] = useState("");
  const [rideZone, setRideZone] = useState<RouteZone | null>(null);
  const [completing, setCompleting] = useState(false);

  // ─── GPS — géré par le hook singleton useGpsPosition ─────────────────────
  // startGeolocation = no-op : le hook démarre automatiquement watchPosition
  const startGeolocation = useCallback(() => { /* hook gère automatiquement */ }, []);

  // ─── Chrono course ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!rideActive || rideStartTs === null) return;
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - rideStartTs) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [rideActive, rideStartTs]);

  // ─── Géocodage Nominatim ──────────────────────────────────────────────────
  const geocode = useCallback(async () => {
    const q = destQuery.trim();
    if (!q) return;
    setGeoLoading(true);
    setGeoResults([]);
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=fr&format=json&limit=3`;
      const resp = await fetch(url, { headers: { "Accept-Language": "fr" } });
      const data = await resp.json();
      const results: GeoResult[] = (data as any[]).map((d) => ({
        lat: parseFloat(d.lat),
        lng: parseFloat(d.lon),
        display_name: d.display_name,
      }));
      setGeoResults(results);
      if (results.length === 0) {
        toast({ title: "Aucun résultat", description: "Essayez une autre adresse." });
      }
    } catch (e: any) {
      toast({ title: "Erreur de géocodage", description: e.message, variant: "destructive" });
    } finally {
      setGeoLoading(false);
    }
  }, [destQuery, toast]);

  const selectDestination = (g: GeoResult) => {
    setDestination({ lat: g.lat, lng: g.lng, name: g.display_name.split(",")[0] });
    setGeoResults([]);
    setResult(null);
    lastComputeRef.current = 0;
  };

  const clearDestination = () => {
    setDestination(null);
    setDestQuery("");
    setGeoResults([]);
    setResult(null);
  };

  // ─── Calcul return-journey ──────────────────────────────────────────────────
  const compute = useCallback(async (
    pos: { lat: number; lng: number },
    dest: { lat: number; lng: number; name: string },
  ) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await apiRequest("POST", "/api/return-journey", {
        lat: pos.lat, lng: pos.lng,
        destLat: dest.lat, destLng: dest.lng, destName: dest.name,
      });
      const data: ReturnJourneyResponse = await resp.json();
      setResult(data);
      setSelectedIdx(0);
    } catch (e: any) {
      setError(`Erreur calcul retour : ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-calcul quand GPS + destination disponibles (max 1x/45s)
  useEffect(() => {
    if (!destination || rideActive) return;  // position toujours valide (fallback Bd Ney)
    const now = Date.now();
    if (now - lastComputeRef.current < 45000 && result) return;
    lastComputeRef.current = now;
    compute(position, destination);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, destination]);

  // ─── Course : démarrage / fin / annulation ───────────────────────────────────
  const startRide = (zone: RouteZone) => {
    setRideZone(zone);
    setRideActive(true);
    setRideStartTs(Date.now());
    setElapsedSec(0);
    setRideDistance(zone.distanceKm ? String(zone.distanceKm) : "");
    setRideFare(zone.estimatedRevenue ? String(zone.estimatedRevenue) : "");
  };

  const cancelRide = () => {
    setRideActive(false);
    setRideStartTs(null);
    setElapsedSec(0);
    setRideZone(null);
    setRideDistance("");
    setRideFare("");
  };

  const completeRide = async () => {
    const distance_km = parseFloat(rideDistance);
    const fare = parseFloat(rideFare);
    const duration_min = Math.max(1, Math.round(elapsedSec / 60));
    if (isNaN(distance_km) || isNaN(fare) || distance_km <= 0 || fare <= 0) {
      toast({ title: "Données invalides", description: "Renseignez distance et tarif.", variant: "destructive" });
      return;
    }
    setCompleting(true);
    try {
      const resp = await apiRequest("POST", "/api/rides/complete", {
        pickup_zone_id: rideZone?.zone.id ?? "unknown",
        dropoff_zone_id: destination ? "dest" : "unknown",
        distance_km,
        duration_min,
        fare,
      });
      const data = await resp.json();
      const net = data?.ride?.net_profit ?? 0;
      toast({ title: "Course enregistrée", description: `Net : ${net}€` });

      // Invalider les queries impactées
      queryClient.invalidateQueries({ queryKey: ["/api/rides/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rides"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profitability"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });

      // Rafraîchir les alertes côté serveur
      try { await apiRequest("POST", "/api/alerts/refresh", {}); } catch { /* non bloquant */ }

      // Retour à l'état calcul pour chercher la prochaine course
      cancelRide();
      setResult(null);
      lastComputeRef.current = 0;
      if (position && destination) compute(position, destination);
    } catch (e: any) {
      toast({ title: "Erreur enregistrement", description: e.message, variant: "destructive" });
    } finally {
      setCompleting(false);
    }
  };

  const selectedZone = result?.routeZones[selectedIdx] ?? null;

  // ─── États d'attente ────────────────────────────────────────────────────────
  const renderDestinationInput = () => (
    <div className="px-4 pt-4">
      <div className="flex items-center gap-2 mb-2">
        <Target size={14} className="text-primary" />
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Destination de retour
        </h2>
      </div>
      <div className="flex gap-2">
        <Input
          value={destQuery}
          onChange={(e) => setDestQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") geocode(); }}
          placeholder="Ex : Paris 10ème, Montrouge, adresse…"
          className="flex-1"
        />
        <Button onClick={geocode} disabled={geoLoading || !destQuery.trim()} className="gap-1.5">
          {geoLoading ? <RefreshCw size={15} className="animate-spin" /> : <Search size={15} />}
          Chercher
        </Button>
      </div>

      {/* Résultats géocodage */}
      {geoResults.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {geoResults.map((g, i) => (
            <button
              key={i}
              onClick={() => selectDestination(g)}
              className="text-left p-2.5 rounded-lg border border-border bg-card hover:border-primary transition-colors flex items-center gap-2"
            >
              <MapPin size={13} className="text-primary flex-shrink-0" />
              <span className="text-xs leading-tight line-clamp-2">{g.display_name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Destination sélectionnée */}
      {destination && (
        <div className="mt-3 p-3 rounded-xl border border-primary/30 bg-primary/5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <CornerDownLeft size={14} className="text-primary flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{destination.name}</div>
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  {destination.lat.toFixed(4)}, {destination.lng.toFixed(4)}
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={clearDestination} className="h-7 text-xs flex-shrink-0">
              Effacer
            </Button>
          </div>
          <DestPreviewMap dest={destination} />
        </div>
      )}
    </div>
  );

  const renderGpsSection = () => (
    <div className="px-4 pt-4">
      <div className="flex items-center gap-2 mb-2">
        <Crosshair size={14} className="text-primary" />
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Position GPS</h2>
      </div>
      {gpsStatus === "granted" && position ? (
        <div className="flex items-center gap-2 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
          <div className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_0_4px_rgba(59,130,246,0.2)] animate-pulse" />
          <span className="tabular-nums">{position.lat.toFixed(4)}, {position.lng.toFixed(4)}</span>
          <CheckCircle2 size={14} className="ml-auto" />
        </div>
      ) : gpsStatus === "pending" ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-card border border-border rounded-lg px-3 py-2">
          <div className="w-4 h-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          Acquisition de la position…
        </div>
      ) : (gpsStatus === "denied" || gpsStatus === "error") ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2">
            <AlertCircle size={13} /> {error}
          </div>
          <Button variant="outline" onClick={startGeolocation} className="gap-2 w-full">
            <RefreshCw size={15} /> Réessayer
          </Button>
        </div>
      ) : (
        <Button onClick={startGeolocation} className="gap-2 w-full">
          <Crosshair size={16} /> Activer la géolocalisation
        </Button>
      )}
    </div>
  );

  const renderComputeSection = () => (
    <div className="px-4 pt-4">
      <Button
        onClick={() => position && destination && compute(position, destination)}
        disabled={loading || !position || !destination}
        size="lg"
        className="w-full gap-2"
      >
        {loading
          ? <><RefreshCw size={16} className="animate-spin" /> Calcul en cours…</>
          : <><Route size={16} /> Calculer la meilleure course</>}
      </Button>
      {(!position || !destination) && (
        <p className="text-[11px] text-muted-foreground text-center mt-2">
          {!destination ? "Choisissez une destination" : "Activez la géolocalisation"} pour lancer le calcul.
        </p>
      )}
    </div>
  );

  // ─── KPI grid recommandation ──────────────────────────────────────────────────
  const renderKpis = (zone: RouteZone) => (
    <div className="grid grid-cols-3 gap-2 mb-3">
      {[
        { icon: <BarChart2 size={12} />, label: "Score", value: String(zone.routeScore), color: getScoreColor(zone.routeScore) },
        { icon: <Navigation size={12} />, label: "Détour", value: `+${zone.detourKm}km / +${zone.detourMinutes}min` },
        { icon: <Euro size={12} />, label: "Gain net", value: `+${zone.netGain}€`, color: zone.netGain > 0 ? "#22c55e" : "#ef4444" },
        { icon: <Activity size={12} />, label: "Efficacité", value: `${zone.efficiency}€/min` },
        { icon: <TrendingUp size={12} />, label: "Rentabilité", value: `${zone.profitabilityIndex}/100` },
        { icon: <Zap size={12} />, label: "D/O ratio", value: `×${zone.surgeMultiplier}` },
      ].map((m, i) => (
        <div key={i} className="flex flex-col items-center gap-0.5 p-2 rounded-lg bg-background/50 text-center">
          <span className="text-primary">{m.icon}</span>
          <span className="text-[9px] text-muted-foreground">{m.label}</span>
          <span className="text-xs font-bold" style={{ color: m.color }}>{m.value}</span>
        </div>
      ))}
    </div>
  );

  // ─── Carte recommandation principale ─────────────────────────────────────────
  const renderRecommendation = (zone: RouteZone) => {
    const color = getScoreColor(zone.routeScore);
    const enChemin = zone.progressRatio >= 0.1 && zone.progressRatio <= 0.9;
    return (
      <div className="px-4">
        <div className="flex items-center gap-2 mb-3">
          <Target size={14} className="text-primary" />
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Recommandation — meilleure course en chemin
          </h2>
        </div>
        <div
          className="rounded-2xl border p-4"
          style={{ background: `${color}15`, borderColor: `${color}55` }}
        >
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xl">{getZoneTypeIcon(zone.zone.type)}</span>
              <div className="min-w-0">
                <div className="font-bold text-base leading-tight truncate">{zone.zone.name}</div>
                <p className="text-[11px] text-muted-foreground italic mt-0.5">{zone.reason}</p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 flex-shrink-0">
              <Badge
                className="text-[9px] py-0.5 px-2 text-black"
                style={{ background: color }}
              >
                {enChemin ? "EN CHEMIN" : "LÉGÈREMENT DÉVIÉ"}
              </Badge>
              <div className="font-black text-2xl leading-none" style={{ color }}>{zone.routeScore}</div>
            </div>
          </div>

          {/* Barre de progression sur le trajet */}
          <div className="mb-3">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span>Position</span>
              <span>Progression sur le trajet : {Math.round(zone.progressRatio * 100)}%</span>
              <span>Destination</span>
            </div>
            <div className="relative h-2 rounded-full bg-background/60 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(0, zone.progressRatio * 100))}%`, background: color }}
              />
            </div>
          </div>

          {renderKpis(zone)}

          <a
            href={zone.mapsDetourUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-sm font-semibold text-black transition-opacity hover:opacity-90 mb-2"
            style={{ background: color }}
          >
            <Navigation size={14} />
            Ouvrir le détour dans Google Maps
          </a>

          {!rideActive && (
            <Button onClick={() => startRide(zone)} className="w-full gap-2" variant="outline">
              <Play size={15} /> Démarrer la course
            </Button>
          )}
        </div>
      </div>
    );
  };

  // ─── Course en cours ──────────────────────────────────────────────────────────
  const renderActiveRide = () => (
    <div className="px-4">
      <div className="rounded-2xl border border-primary/40 bg-primary/5 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={15} className="text-primary animate-pulse" />
          <h2 className="text-sm font-bold">Course en cours{rideZone ? ` — ${rideZone.zone.name}` : ""}</h2>
        </div>

        {/* Chrono */}
        <div className="flex flex-col items-center justify-center py-3 mb-3 rounded-xl bg-background/60">
          <div className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
            <Timer size={11} /> Durée écoulée
          </div>
          <div className="text-4xl font-black tabular-nums text-primary">{fmtChrono(elapsedSec)}</div>
          <div className="text-[10px] text-muted-foreground mt-1">
            ≈ {Math.max(1, Math.round(elapsedSec / 60))} min (auto)
          </div>
        </div>

        {/* Champs éditables */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
              <MapPin size={10} /> Distance (km)
            </label>
            <Input
              type="number" inputMode="decimal" step="0.1"
              value={rideDistance}
              onChange={(e) => setRideDistance(e.target.value)}
              placeholder="km"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
              <Euro size={10} /> Tarif (€)
            </label>
            <Input
              type="number" inputMode="decimal" step="0.1"
              value={rideFare}
              onChange={(e) => setRideFare(e.target.value)}
              placeholder="€"
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button onClick={completeRide} disabled={completing} className="flex-1 gap-2">
            {completing
              ? <><RefreshCw size={15} className="animate-spin" /> Enregistrement…</>
              : <><CheckCircle2 size={15} /> Course terminée</>}
          </Button>
          <Button onClick={cancelRide} variant="outline" disabled={completing} className="gap-2">
            <StopCircle size={15} /> Annuler
          </Button>
        </div>
      </div>
    </div>
  );

  // ─── Rendu résultat complet ───────────────────────────────────────────────────
  const renderResult = (data: ReturnJourneyResponse) => (
    <div className="flex flex-col gap-5 pb-8">
      {/* Résumé trajet direct */}
      <div className="px-4">
        <div className="flex items-center justify-between gap-2 p-3 rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 text-xs">
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-muted-foreground tabular-nums">
              {data.userPosition.lat.toFixed(3)}, {data.userPosition.lng.toFixed(3)}
            </span>
            <ArrowRight size={12} className="text-muted-foreground" />
            <span className="font-semibold truncate max-w-[120px]">{data.destination.name}</span>
          </div>
          <Badge variant="outline" className="text-[10px] flex-shrink-0">
            trajet direct : {data.directDistanceKm}km — {data.directEtaMin}min
              {' · '}
              Arrivée : {new Date(Date.now() + data.directEtaMin * 60000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </Badge>
        </div>
      </div>

      <div className="px-4">
        <UpdateWidget compact={true} className="w-full" />
      </div>

      {/* Course en cours OU recommandation */}
      {rideActive
        ? renderActiveRide()
        : data.recommendation && renderRecommendation(data.recommendation)}

      {/* Carte */}
      <div className="px-4">
        <JourneyMap userPos={data.userPosition} dest={data.destination} selectedZone={selectedZone} />
      </div>

      {/* Top 5 zones en chemin */}
      {!rideActive && (
        <div className="px-4">
          <div className="flex items-center gap-2 mb-3">
            <Route size={14} className="text-primary" />
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Top {data.routeZones.length} zones en chemin
            </h2>
          </div>
          {data.routeZones.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center">
              <CornerDownLeft size={24} className="text-muted-foreground mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">Aucune zone rentable détectée sur ce trajet de retour.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {data.routeZones.map((z, i) => (
                <RouteZoneCard
                  key={z.zone.id}
                  zone={z}
                  rank={i + 1}
                  isSelected={selectedIdx === i}
                  onClick={() => setSelectedIdx(i)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="px-4 text-[10px] text-muted-foreground opacity-50 text-center">
        Calculé à {fmtTimeSec(data.computedAt)} · {data.hour}h — {data.dayType === "weekday" ? "Semaine" : "Week-end"} ·
        Auto-recalcul toutes les 45s
      </div>
    </div>
  );

  // ─── Layout principal ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-full">
      {/* Header sticky */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <CornerDownLeft size={18} className="text-primary" />
          <div>
            <h1 className="font-bold text-sm leading-none">Trajet de Retour</h1>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Meilleure course en chemin vers votre destination
            </p>
          </div>
          {gpsStatus === "granted" && position && (
            <div className="ml-auto flex items-center gap-1.5 text-xs text-green-400">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              GPS actif
            </div>
          )}
        </div>
      </div>

      {/* Sections de saisie (toujours visibles tant que pas de course active) */}
      {!rideActive && (
        <>
          {renderDestinationInput()}
          {renderGpsSection()}
          {renderComputeSection()}
        </>
      )}

      {/* Erreur de calcul */}
      {error && result && (
        <div className="mx-4 mt-3 flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <AlertCircle size={13} /> {error}
        </div>
      )}

      {/* Loading initial */}
      {loading && !result && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Recherche de la meilleure course en chemin…</p>
        </div>
      )}

      {/* Résultat */}
      {result && <div className="mt-2">{renderResult(result)}</div>}
    </div>
  );
}
