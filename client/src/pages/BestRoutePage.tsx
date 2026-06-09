import { useState, useEffect, useRef, useCallback } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Navigation, MapPin, TrendingUp, Clock, Zap, Car,
  RefreshCw, AlertCircle, CheckCircle2, Crosshair, Route
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ZoneResult {
  zone: { id: string; name: string; lat: number; lng: number; type: string };
  distanceKm: number;
  etaMinutes: number;
  profitabilityIndex: number;
  surgeMultiplier: number;
  flightBoost: number;
  avgFare: number;
  longRideProbability: number;
  ratioDO: number;
  globalScore: number;
  estimatedRevenue: number;
  reason: string;
  waypoints: { lat: number; lng: number; label: string }[];
}

interface BestRouteResponse {
  userPosition: { lat: number; lng: number };
  hour: number;
  dayType: string;
  recommendation: ZoneResult;
  top5: ZoneResult[];
  all: ZoneResult[];
  computedAt: string;
}

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

function getScoreBg(score: number): string {
  if (score >= 80) return "bg-green-500/10 border-green-500/30 text-green-400";
  if (score >= 60) return "bg-green-400/10 border-green-400/30 text-green-300";
  if (score >= 40) return "bg-yellow-500/10 border-yellow-500/30 text-yellow-400";
  if (score >= 25) return "bg-orange-500/10 border-orange-500/30 text-orange-400";
  return "bg-red-500/10 border-red-500/30 text-red-400";
}

function getZoneTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    airport: "✈️", transport: "🚊", business: "🏢",
    entertainment: "🎭", residential: "🏘️",
  };
  return icons[type] || "📍";
}

// ─── Chargeur Leaflet ─────────────────────────────────────────────────────────

function useLeaflet(ready: boolean) {
  const [loaded, setLoaded] = useState(!!(window as any).L);

  useEffect(() => {
    if (!ready || (window as any).L) { setLoaded(true); return; }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
  }, [ready]);

  return loaded;
}

// ─── Carte BestRoute ─────────────────────────────────────────────────────────

function BestRouteMap({ data, selectedIdx }: { data: BestRouteResponse; selectedIdx: number }) {
  const mapRef = useRef<any>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<any[]>([]);
  const linesRef = useRef<any[]>([]);
  const leafletLoaded = useLeaflet(true);

  useEffect(() => {
    if (!leafletLoaded || !mapDivRef.current) return;
    const L = (window as any).L;

    if (!mapRef.current) {
      mapRef.current = L.map(mapDivRef.current, { zoomControl: true, attributionControl: false });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "© CartoDB",
        subdomains: "abcd",
        maxZoom: 16,
      }).addTo(mapRef.current);
    }

    const map = mapRef.current;

    // Nettoyage anciens éléments
    markersRef.current.forEach(m => m.remove());
    linesRef.current.forEach(l => l.remove());
    markersRef.current = [];
    linesRef.current = [];

    const { lat, lng } = data.userPosition;

    // Marqueur position utilisateur (pulsant)
    const userIcon = L.divIcon({
      html: `<div style="width:16px;height:16px;border-radius:50%;background:#3b82f6;border:3px solid white;box-shadow:0 0 0 4px rgba(59,130,246,0.3);animation:pulse 2s infinite;"></div>
             <style>@keyframes pulse{0%,100%{box-shadow:0 0 0 4px rgba(59,130,246,0.3)}50%{box-shadow:0 0 0 8px rgba(59,130,246,0.1)}}</style>`,
      className: "", iconSize: [16, 16], iconAnchor: [8, 8],
    });
    const userMarker = L.marker([lat, lng], { icon: userIcon })
      .addTo(map)
      .bindPopup("<b>📍 Votre position</b>");
    markersRef.current.push(userMarker);

    // Marqueurs + lignes zones top5
    data.top5.forEach((z, i) => {
      const isSelected = i === selectedIdx;
      const color = isSelected ? getScoreColor(z.globalScore) : "#475569";
      const rank = i + 1;
      const zoneIcon = L.divIcon({
        html: `<div style="width:${isSelected ? 36 : 28}px;height:${isSelected ? 36 : 28}px;border-radius:50%;background:${color};border:${isSelected ? 3 : 2}px solid white;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:${isSelected ? 14 : 11}px;color:${isSelected ? '#000' : '#fff'};box-shadow:0 2px 8px rgba(0,0,0,0.5);transition:all 0.3s;">${rank}</div>`,
        className: "", iconSize: [isSelected ? 36 : 28, isSelected ? 36 : 28],
        iconAnchor: [isSelected ? 18 : 14, isSelected ? 18 : 14],
      });

      const marker = L.marker([z.zone.lat, z.zone.lng], { icon: zoneIcon })
        .addTo(map)
        .bindPopup(`
          <div style="min-width:180px;">
            <b>#${rank} ${z.zone.name}</b><br/>
            <span style="color:${color};font-weight:bold;">Score ${z.globalScore}</span><br/>
            📍 ${z.distanceKm} km — ⏱ ${z.etaMinutes} min<br/>
            💶 ~${z.estimatedRevenue}€/course<br/>
            <small>${z.reason}</small>
          </div>
        `);
      markersRef.current.push(marker);

      // Ligne utilisateur → zone
      const line = L.polyline(
        [[lat, lng], [z.zone.lat, z.zone.lng]],
        {
          color: isSelected ? getScoreColor(z.globalScore) : "#334155",
          weight: isSelected ? 3 : 1.5,
          opacity: isSelected ? 0.9 : 0.4,
          dashArray: isSelected ? undefined : "5,8",
        }
      ).addTo(map);
      linesRef.current.push(line);
    });

    // Ajuster le zoom pour tout voir
    const allLatLngs = [
      [lat, lng],
      ...data.top5.map(z => [z.zone.lat, z.zone.lng]),
    ] as [number, number][];
    const bounds = L.latLngBounds(allLatLngs);
    map.fitBounds(bounds, { padding: [40, 40] });

  }, [leafletLoaded, data, selectedIdx]);

  return (
    <div
      ref={mapDivRef}
      style={{ height: "320px", borderRadius: "12px", overflow: "hidden" }}
      className="border border-border"
    />
  );
}

// ─── Carte mini GPS en cours ──────────────────────────────────────────────────

function GpsWaitMap({ pos }: { pos: { lat: number; lng: number } | null }) {
  const mapRef = useRef<any>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const leafletLoaded = useLeaflet(!!pos);

  useEffect(() => {
    if (!leafletLoaded || !pos || !mapDivRef.current) return;
    const L = (window as any).L;
    if (!mapRef.current) {
      mapRef.current = L.map(mapDivRef.current, { zoomControl: false, attributionControl: false });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        subdomains: "abcd", maxZoom: 16,
      }).addTo(mapRef.current);
    }
    const userIcon = (window as any).L.divIcon({
      html: `<div style="width:14px;height:14px;border-radius:50%;background:#3b82f6;border:2px solid white;box-shadow:0 0 0 6px rgba(59,130,246,0.25);"></div>`,
      className: "", iconSize: [14, 14], iconAnchor: [7, 7],
    });
    mapRef.current.setView([pos.lat, pos.lng], 14);
    (window as any).L.marker([pos.lat, pos.lng], { icon: userIcon }).addTo(mapRef.current);
  }, [leafletLoaded, pos]);

  if (!pos) return null;
  return (
    <div
      ref={mapDivRef}
      style={{ height: "150px", borderRadius: "10px", overflow: "hidden" }}
      className="border border-border mt-3"
    />
  );
}

// ─── Carte résultat zone sélectionnée ────────────────────────────────────────

function ZoneCard({ zone, rank, isSelected, onClick }: {
  zone: ZoneResult; rank: number; isSelected: boolean; onClick: () => void;
}) {
  const color = getScoreColor(zone.globalScore);
  return (
    <div
      onClick={onClick}
      className={`cursor-pointer rounded-xl border p-3 transition-all duration-200 ${
        isSelected
          ? "border-primary bg-primary/5 shadow-lg ring-1 ring-primary/30"
          : "border-border bg-card hover:border-muted-foreground/40"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Rang */}
        <div
          className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-black"
          style={{ background: color }}
        >
          {rank}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-sm">{getZoneTypeIcon(zone.zone.type)}</span>
            <span className="font-semibold text-sm truncate">{zone.zone.name}</span>
            {rank === 1 && <Badge className="text-[10px] px-1.5 py-0 bg-green-500/20 text-green-400 border-green-500/30">⭐ TOP</Badge>}
          </div>

          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground mb-1">
            <span className="flex items-center gap-1">
              <MapPin size={10} /> {zone.distanceKm} km
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} /> ~{zone.etaMinutes} min
            </span>
            <span className="flex items-center gap-1">
              <Zap size={10} /> ×{zone.surgeMultiplier}
            </span>
            <span className="flex items-center gap-1">
              <TrendingUp size={10} /> {zone.ratioDO.toFixed(2)} D/O
            </span>
          </div>

          <p className="text-xs text-muted-foreground italic leading-tight">{zone.reason}</p>
        </div>

        <div className="flex-shrink-0 text-right">
          <div className="font-bold text-base" style={{ color }}>{zone.globalScore}</div>
          <div className="text-[10px] text-muted-foreground">{getScoreLabel(zone.globalScore)}</div>
          <div className="text-xs font-medium text-green-400 mt-0.5">~{zone.estimatedRevenue}€</div>
        </div>
      </div>
    </div>
  );
}

// ─── Page principale ───────────────────────────────────────────────────────────

export default function BestRoutePage() {
  const [gpsStatus, setGpsStatus] = useState<"idle" | "requesting" | "granted" | "denied" | "error">("idle");
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BestRouteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);

  // Géolocalisation continue (watch)
  const startGeolocation = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsStatus("error");
      setError("La géolocalisation n'est pas disponible sur cet appareil.");
      return;
    }
    setGpsStatus("requesting");
    setError(null);

    // Arrêter watch précédent
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const newPos = {
          lat: Math.round(pos.coords.latitude * 100000) / 100000,
          lng: Math.round(pos.coords.longitude * 100000) / 100000,
        };
        setPosition(newPos);
        setGpsStatus("granted");
      },
      (err) => {
        if (err.code === 1) {
          setGpsStatus("denied");
          setError("Accès à la position refusé. Veuillez autoriser la géolocalisation dans les paramètres de votre navigateur.");
        } else {
          setGpsStatus("error");
          setError(`Erreur GPS : ${err.message}`);
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 15000,
        timeout: 20000,
      }
    );
  }, []);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  // Calcul du meilleur trajet
  const compute = useCallback(async (pos: { lat: number; lng: number }) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await apiRequest("POST", "/api/best-route", pos);
      const data: BestRouteResponse = await resp.json();
      setResult(data);
      setSelectedIdx(0);
      setLastUpdate(new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch (e: any) {
      setError(`Erreur calcul itinéraire : ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-calcul quand la position change (max 1 fois / 30s)
  const lastComputeRef = useRef<number>(0);
  useEffect(() => {
    if (!position || gpsStatus !== "granted") return;
    const now = Date.now();
    if (now - lastComputeRef.current < 30000 && result) return;
    lastComputeRef.current = now;
    compute(position);
  }, [position]);

  // ─── Rendu état initial ────────────────────────────────────────────────────

  const renderIdle = () => (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-6">
      <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
        <Route size={36} className="text-primary" />
      </div>
      <div>
        <h2 className="text-xl font-bold mb-2">Meilleur Trajet</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          Activez la géolocalisation pour découvrir les zones les plus rentables
          depuis votre position actuelle, en temps réel.
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3 w-full max-w-xs">
        {[
          { icon: <Crosshair size={16} />, label: "GPS temps réel" },
          { icon: <TrendingUp size={16} />, label: "Score rentabilité" },
          { icon: <Navigation size={16} />, label: "Itinéraire optimal" },
        ].map((f, i) => (
          <div key={i} className="flex flex-col items-center gap-1 p-3 rounded-lg bg-card border border-border text-xs text-muted-foreground">
            <span className="text-primary">{f.icon}</span>
            {f.label}
          </div>
        ))}
      </div>
      <Button
        onClick={startGeolocation}
        size="lg"
        className="gap-2 px-8"
      >
        <Crosshair size={18} />
        Activer la géolocalisation
      </Button>
      <p className="text-xs text-muted-foreground opacity-60">
        Fonctionne sur téléphone et ordinateur · Position jamais stockée
      </p>
    </div>
  );

  const renderRequesting = () => (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-5">
      <div className="w-16 h-16 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
      <div>
        <p className="font-semibold">Acquisition de la position…</p>
        <p className="text-sm text-muted-foreground mt-1">
          Autorisez l'accès à votre position dans le popup du navigateur.
        </p>
      </div>
      {position && (
        <>
          <div className="flex items-center gap-2 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
            <CheckCircle2 size={14} />
            Position reçue : {position.lat.toFixed(4)}, {position.lng.toFixed(4)}
          </div>
          <GpsWaitMap pos={position} />
        </>
      )}
    </div>
  );

  const renderDenied = () => (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center gap-4">
      <AlertCircle size={40} className="text-orange-400" />
      <div>
        <p className="font-semibold text-orange-400">Accès refusé</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-xs">{error}</p>
      </div>
      <Button variant="outline" onClick={startGeolocation} className="gap-2">
        <RefreshCw size={15} /> Réessayer
      </Button>
    </div>
  );

  const renderResult = (data: BestRouteResponse) => (
    <div className="flex flex-col gap-4 pb-6">
      {/* Header position + rafraîchissement */}
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-blue-400 shadow-[0_0_0_4px_rgba(59,130,246,0.2)] animate-pulse" />
          <span className="text-xs text-muted-foreground">
            {data.userPosition.lat.toFixed(4)}, {data.userPosition.lng.toFixed(4)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdate && (
            <span className="text-[10px] text-muted-foreground opacity-60">MAJ {lastUpdate}</span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => position && compute(position)}
            disabled={loading}
            className="h-7 gap-1.5 text-xs"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {loading ? "Calcul…" : "Rafraîchir"}
          </Button>
        </div>
      </div>

      {/* Carte */}
      <div className="px-4">
        <BestRouteMap data={data} selectedIdx={selectedIdx} />
      </div>

      {/* Recommandation principale */}
      <div className="px-4">
        <div
          className="rounded-2xl border p-4 relative overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${getScoreColor(data.recommendation.globalScore)}15, transparent)`,
            borderColor: `${getScoreColor(data.recommendation.globalScore)}40`,
          }}
        >
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-lg">{getZoneTypeIcon(data.recommendation.zone.type)}</span>
                <span className="font-bold text-base">{data.recommendation.zone.name}</span>
                <Badge className="text-[10px] bg-green-500/20 text-green-400 border-green-500/30">⭐ RECOMMANDÉ</Badge>
              </div>
              <p className="text-xs text-muted-foreground italic">{data.recommendation.reason}</p>
            </div>
            <div className="text-right flex-shrink-0 ml-3">
              <div
                className="text-3xl font-black leading-none"
                style={{ color: getScoreColor(data.recommendation.globalScore) }}
              >
                {data.recommendation.globalScore}
              </div>
              <div className="text-xs text-muted-foreground">{getScoreLabel(data.recommendation.globalScore)}</div>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {[
              { icon: <MapPin size={13} />, label: "Distance", value: `${data.recommendation.distanceKm} km` },
              { icon: <Clock size={13} />, label: "ETA", value: `~${data.recommendation.etaMinutes} min` },
              { icon: <Zap size={13} />, label: "Surge", value: `×${data.recommendation.surgeMultiplier}` },
              { icon: <Car size={13} />, label: "Tarif moy.", value: `~${data.recommendation.estimatedRevenue}€` },
            ].map((m, i) => (
              <div key={i} className="flex flex-col items-center gap-0.5 p-2 rounded-lg bg-background/50">
                <span className="text-primary">{m.icon}</span>
                <span className="text-[10px] text-muted-foreground">{m.label}</span>
                <span className="text-xs font-bold">{m.value}</span>
              </div>
            ))}
          </div>

          {/* Lien navigation externe */}
          <a
            href={`https://www.google.com/maps/dir/${data.userPosition.lat},${data.userPosition.lng}/${data.recommendation.zone.lat},${data.recommendation.zone.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 flex items-center justify-center gap-2 w-full py-2 rounded-lg text-sm font-semibold transition-colors"
            style={{
              background: getScoreColor(data.recommendation.globalScore),
              color: "#000",
            }}
          >
            <Navigation size={15} />
            Ouvrir dans Google Maps
          </a>
        </div>
      </div>

      {/* Top 5 */}
      <div className="px-4">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Top 5 zones rentables depuis votre position
        </h3>
        <div className="flex flex-col gap-2">
          {data.top5.map((z, i) => (
            <ZoneCard
              key={z.zone.id}
              zone={z}
              rank={i + 1}
              isSelected={selectedIdx === i}
              onClick={() => setSelectedIdx(i)}
            />
          ))}
        </div>
      </div>

      {/* Métadonnées */}
      <div className="px-4">
        <div className="text-[10px] text-muted-foreground opacity-50 text-center">
          Calculé à {new Date(data.computedAt).toLocaleTimeString("fr-FR")} ·
          Heure : {data.hour}h · {data.dayType === "weekday" ? "Jour semaine" : "Week-end"} ·
          Mise à jour auto toutes les 30s
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-full">
      {/* Titre page */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Route size={18} className="text-primary" />
          <div>
            <h1 className="font-bold text-sm leading-none">Meilleur Trajet</h1>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Zone la plus rentable depuis votre position GPS
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

      {/* Contenu selon état */}
      {gpsStatus === "idle" && renderIdle()}
      {gpsStatus === "requesting" && !result && renderRequesting()}
      {(gpsStatus === "denied" || gpsStatus === "error") && !result && renderDenied()}
      {error && result && (
        <div className="mx-4 mt-3 flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <AlertCircle size={13} /> {error}
        </div>
      )}
      {loading && !result && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Calcul des zones rentables…</p>
        </div>
      )}
      {result && renderResult(result)}
    </div>
  );
}
