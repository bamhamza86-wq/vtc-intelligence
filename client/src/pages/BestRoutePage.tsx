import { useState, useEffect, useRef, useCallback } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { GpsFreshness } from "@/components/GpsFreshness";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Navigation, MapPin, TrendingUp, Clock, Zap, Car,
  RefreshCw, AlertCircle, CheckCircle2, Crosshair, Route,
  Plane, CalendarClock, ChevronRight, Timer, AlertTriangle,
  Star, Euro, Activity
} from "lucide-react";
import { UpdateWidget } from "@/components/UpdateWidget";
import { RouteSourceBadge } from "@/components/RouteSourceBadge";
import { PredictHQBadge } from "@/components/PredictHQBadge";

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
  distanceSource?: string;
  // ─── PredictHQ — impact événementiel ───
  phq_boost?: number;
  phq_boost_active?: boolean;
  combined_event_boost?: number;
  phq_event_title?: string;
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

interface Slot {
  slotId: string;
  label: string;
  eventTime: string;
  departAt: string;
  arriveBy: string;
  etaMin: number;
  distKm: number;
  bufferMin: number;
  urgency: "now" | "soon" | "upcoming" | "later";
  detail?: string;
  flightCallsign?: string;
  flightOrigin?: string;
}

interface EventBlock {
  eventId: string | number;
  eventName: string;
  zoneId: string;
  zoneName: string;
  zoneType: string;
  zoneLat: number;
  zoneLng: number;
  etaMin: number;
  distKm: number;
  demandBoost: number;
  eventType: string;
  clickedAt: string;
  slots: Slot[];
  mapsUrl: string;
}

interface EventScheduleResponse {
  userPosition: { lat: number; lng: number };
  clickedAt: string;
  computedAt: string;
  eventBlocks: EventBlock[];
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

function getZoneTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    airport: "✈️", transport: "🚊", business: "🏢",
    entertainment: "🎭", residential: "🏘️",
  };
  return icons[type] || "📍";
}

function getEventTypeIcon(type: string): string {
  const m: Record<string, string> = {
    airport: "✈️", match: "⚽", concert: "🎵", salon: "🏛️",
    festival: "🎪", congres: "🎤", transport: "🚉", flight_wave: "✈️",
    flight_forecast: "📡",
  };
  return m[type] || "📅";
}

function getUrgencyConfig(urgency: Slot["urgency"]) {
  switch (urgency) {
    case "now":      return { color: "#ef4444", bg: "bg-red-500/15",    border: "border-red-500/40",    label: "PARTEZ MAINTENANT", pulse: true };
    case "soon":     return { color: "#f97316", bg: "bg-orange-500/15", border: "border-orange-500/40", label: "Bientôt",            pulse: true };
    case "upcoming": return { color: "#fbbf24", bg: "bg-yellow-500/15", border: "border-yellow-500/40", label: "Dans 1h",            pulse: false };
    case "later":    return { color: "#64748b", bg: "bg-slate-500/10",  border: "border-slate-500/20",  label: "Plus tard",          pulse: false };
  }
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function fmtTimeSec(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function minutesFromNow(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

// ─── Carte OpenStreetMap (Leaflet via CDN — pas de refus connexion) ──────────

function LeafletMap({ userPos, zonePos, zoneName }: {
  userPos: { lat: number; lng: number };
  zonePos?: { lat: number; lng: number; name: string };
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  useEffect(() => {
    // Charger Leaflet via CDN si pas encore chargé
    const loadLeaflet = async () => {
      if (!(window as any).L) {
        // CSS
        if (!document.getElementById("leaflet-css")) {
          const link = document.createElement("link");
          link.id = "leaflet-css";
          link.rel = "stylesheet";
          link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
          document.head.appendChild(link);
        }
        // JS
        await new Promise<void>((resolve, reject) => {
          if (document.getElementById("leaflet-js")) { resolve(); return; }
          const script = document.createElement("script");
          script.id = "leaflet-js";
          script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
          script.onload = () => resolve();
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      return (window as any).L;
    };

    loadLeaflet().then((L: any) => {
      if (!containerRef.current || mapRef.current) return;

      const centerLat = zonePos ? (userPos.lat + zonePos.lat) / 2 : userPos.lat;
      const centerLng = zonePos ? (userPos.lng + zonePos.lng) / 2 : userPos.lng;

      const map = L.map(containerRef.current, { zoomControl: true, attributionControl: false });
      mapRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
      }).addTo(map);

      // Marqueur utilisateur (bleu pulsé)
      const userIcon = L.divIcon({
        html: `<div style="width:14px;height:14px;background:#3b82f6;border:2px solid white;border-radius:50%;box-shadow:0 0 0 6px rgba(59,130,246,0.25);"></div>`,
        className: "", iconAnchor: [7, 7],
      });
      L.marker([userPos.lat, userPos.lng], { icon: userIcon })
        .addTo(map)
        .bindPopup("📍 Votre position");

      if (zonePos) {
        const zoneIcon = L.divIcon({
          html: `<div style="width:18px;height:18px;background:#22c55e;border:2px solid white;border-radius:50%;box-shadow:0 0 0 5px rgba(34,197,94,0.25);"></div>`,
          className: "", iconAnchor: [9, 9],
        });
        L.marker([zonePos.lat, zonePos.lng], { icon: zoneIcon })
          .addTo(map)
          .bindPopup(`🎯 ${zoneName}`);

        // Ligne entre user et zone
        L.polyline([[userPos.lat, userPos.lng], [zonePos.lat, zonePos.lng]], {
          color: "#22c55e", weight: 2, dashArray: "6 4", opacity: 0.8,
        }).addTo(map);

        // Fit bounds
        const bounds = L.latLngBounds(
          [userPos.lat, userPos.lng],
          [zonePos.lat, zonePos.lng]
        );
        map.fitBounds(bounds, { padding: [40, 40] });
      } else {
        map.setView([userPos.lat, userPos.lng], 14);
      }
    }).catch(() => {});

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [userPos.lat, userPos.lng, zonePos?.lat, zonePos?.lng]);

  return (
    <div
      ref={containerRef}
      style={{ height: "260px", borderRadius: "12px", overflow: "hidden", background: "#1e293b" }}
      className="border border-border"
    />
  );
}

// ─── Carte petite pour GPS wait ───────────────────────────────────────────────

function GpsWaitMap({ pos }: { pos: { lat: number; lng: number } | null }) {
  if (!pos) return null;
  return (
    <div style={{ height: "140px", borderRadius: "10px", overflow: "hidden" }} className="border border-border mt-3">
      <LeafletMap userPos={pos} zoneName="" />
    </div>
  );
}

// ─── Carte zone verticale (sous la map principale) ───────────────────────────

function ZoneCardVertical({ zone, rank, isSelected, onClick, userPos }: {
  zone: ZoneResult; rank: number; isSelected: boolean; onClick: () => void;
  userPos: { lat: number; lng: number };
}) {
  const color = getScoreColor(zone.globalScore);
  return (
    <div
      onClick={onClick}
      style={{
        borderColor: isSelected ? color : undefined,
        boxShadow: isSelected ? `0 0 0 2px ${color}30` : undefined,
        background: isSelected ? `${color}08` : undefined,
      }}
      className="cursor-pointer rounded-2xl border border-border p-4 transition-all duration-200 hover:border-muted-foreground/40"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center font-black text-xs text-black flex-shrink-0"
            style={{ background: color }}
          >
            {rank === 1 ? <Star size={14} fill="black" /> : rank}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm">{getZoneTypeIcon(zone.zone.type)}</span>
              <span className="font-semibold text-sm leading-tight">{zone.zone.name}</span>
              {rank === 1 && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400">TOP</span>
              )}
              <RouteSourceBadge source={zone.distanceSource ?? "calibrated"} size="xs" />
            </div>
            {zone.phq_boost != null && zone.phq_boost > 1.0 && (
              <div className="mt-1">
                <PredictHQBadge boost={zone.phq_boost} eventTitle={zone.phq_event_title} compact />
              </div>
            )}
            <p className="text-[10px] text-muted-foreground italic mt-0.5 leading-tight">{zone.reason}</p>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="font-black text-2xl leading-none" style={{ color }}>{zone.globalScore}</div>
          <div className="text-[10px] text-muted-foreground">{getScoreLabel(zone.globalScore)}</div>
        </div>
      </div>

      {/* KPIs grid */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        {[
          { icon: <MapPin size={11} />, label: "Route", value: `${zone.distanceKm}km` },
          { icon: <Clock size={11} />, label: "ETA", value: `~${zone.etaMinutes}min` },
          { icon: <Zap size={11} />, label: "Surge", value: `×${zone.surgeMultiplier}` },
          { icon: <Euro size={11} />, label: "Tarif", value: `~${zone.estimatedRevenue}€` },
        ].map((m, i) => (
          <div key={i} className="flex flex-col items-center gap-0.5 p-2 rounded-lg bg-background/50 text-center">
            <span className="text-primary">{m.icon}</span>
            <span className="text-[9px] text-muted-foreground">{m.label}</span>
            <span className="text-xs font-bold">{m.value}</span>
          </div>
        ))}
      </div>

      {/* Rentabilité bar */}
      <div className="mb-3">
        <div className="flex justify-between text-[9px] text-muted-foreground mb-1">
          <span>Rentabilité</span>
          <span style={{ color }}>{zone.profitabilityIndex}/100</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${zone.profitabilityIndex}%`, background: color }}
          />
        </div>
      </div>

      {/* Bouton Google Maps (lien externe — pas iframe) */}
      <a
        href={`https://www.google.com/maps/dir/${userPos.lat},${userPos.lng}/${zone.zone.lat},${zone.zone.lng}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 w-full py-2 rounded-xl text-sm font-semibold text-black transition-opacity hover:opacity-90"
        style={{ background: color }}
        onClick={(e) => e.stopPropagation()}
      >
        <Navigation size={14} />
        Naviguer — Google Maps
      </a>
    </div>
  );
}

// ─── Slot de positionnement (card chronologique) ─────────────────────────────

function SlotCard({ slot, zoneId, zoneLat, zoneLng, userLat, userLng }: {
  slot: Slot; zoneId: string; zoneLat: number; zoneLng: number; userLat: number; userLng: number;
}) {
  const cfg = getUrgencyConfig(slot.urgency);
  const minsUntilDepart = minutesFromNow(slot.departAt);
  const mapsUrl = `https://www.google.com/maps/dir/${userLat},${userLng}/${zoneLat},${zoneLng}`;

  return (
    <div className={`rounded-xl border p-3 ${cfg.bg} ${cfg.border} transition-all`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold leading-snug mb-0.5">{slot.label}</div>
          {slot.detail && (
            <div className="text-[10px] text-muted-foreground">{slot.detail}</div>
          )}
        </div>
        <div
          className={`flex-shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full ${cfg.bg} border ${cfg.border} flex items-center gap-1`}
          style={{ color: cfg.color }}
        >
          {cfg.pulse && <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block" style={{ background: cfg.color }} />}
          {cfg.label}
        </div>
      </div>

      {/* Timeline visuelle */}
      <div className="grid grid-cols-3 gap-1 mb-2.5">
        <div className="flex flex-col items-center text-center">
          <div className="text-[9px] text-muted-foreground mb-0.5">Partez à</div>
          <div className="text-sm font-black tabular-nums" style={{ color: cfg.color }}>
            {fmtTimeSec(slot.departAt)}
          </div>
          {minsUntilDepart > 0 && (
            <div className="text-[9px] text-muted-foreground">dans {minsUntilDepart}min</div>
          )}
          {minsUntilDepart <= 0 && (
            <div className="text-[9px] font-bold" style={{ color: cfg.color }}>MAINTENANT</div>
          )}
        </div>
        <div className="flex flex-col items-center justify-center">
          <div className="flex items-center gap-1 text-muted-foreground">
            <div className="h-px w-4 bg-muted-foreground/40" />
            <div className="text-[9px] whitespace-nowrap">{slot.etaMin}min</div>
            <div className="h-px w-4 bg-muted-foreground/40" />
          </div>
          <div className="text-[9px] text-muted-foreground">{slot.distKm}km</div>
        </div>
        <div className="flex flex-col items-center text-center">
          <div className="text-[9px] text-muted-foreground mb-0.5">Arrivée</div>
          <div className="text-sm font-black tabular-nums text-blue-400">{fmtTimeSec(slot.arriveBy)}</div>
          {slot.bufferMin > 0 && (
            <div className="text-[9px] text-muted-foreground">{slot.bufferMin}min avant</div>
          )}
        </div>
      </div>

      <a
        href={mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg text-[10px] font-semibold text-black transition-opacity hover:opacity-90"
        style={{ background: cfg.color }}
        onClick={(e) => e.stopPropagation()}
      >
        <Navigation size={11} />
        Naviguer maintenant
      </a>
    </div>
  );
}

// ─── Bloc événement complet ───────────────────────────────────────────────────

function EventBlockComponent({ block, userPos, isExpanded, onToggle }: {
  block: EventBlock; userPos: { lat: number; lng: number }; isExpanded: boolean; onToggle: () => void;
}) {
  const nextSlot = block.slots[0];
  const nextCfg = nextSlot ? getUrgencyConfig(nextSlot.urgency) : null;
  const hasUrgent = block.slots.some(s => s.urgency === "now" || s.urgency === "soon");

  return (
    <div className={`rounded-2xl border overflow-hidden transition-all duration-300 ${
      hasUrgent ? "border-orange-500/40" : "border-border"
    }`}>
      <button
        onClick={onToggle}
        className="w-full text-left p-4 flex items-center gap-3 hover:bg-muted/30 transition-colors"
      >
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-lg flex-shrink-0">
          {getEventTypeIcon(block.eventType)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="font-semibold text-sm leading-tight truncate">{block.eventName}</span>
            {hasUrgent && (
              <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">URGENT</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-0.5"><MapPin size={9} /> {block.distKm}km</span>
            <span className="flex items-center gap-0.5"><Clock size={9} /> ~{block.etaMin}min</span>
            {block.demandBoost > 1.1 && (
              <span className="flex items-center gap-0.5 text-green-400"><Zap size={9} /> ×{block.demandBoost.toFixed(2)}</span>
            )}
            <span className="text-[9px] text-muted-foreground/60">
              {block.slots.length} créneau{block.slots.length > 1 ? "x" : ""}
            </span>
          </div>
          {nextSlot && !isExpanded && (
            <div className="mt-1 text-[10px] font-semibold flex items-center gap-1" style={{ color: nextCfg?.color }}>
              <Timer size={9} />
              Prochain départ : {fmtTimeSec(nextSlot.departAt)}
              {minutesFromNow(nextSlot.departAt) > 0
                ? ` (dans ${minutesFromNow(nextSlot.departAt)}min)`
                : " · MAINTENANT"}
            </div>
          )}
        </div>
        <ChevronRight
          size={16}
          className={`flex-shrink-0 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}
        />
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground bg-muted/30 rounded-lg px-3 py-1.5">
            <Crosshair size={9} className="text-blue-400" />
            <span>Calculé à <strong className="text-blue-400">{fmtTimeSec(block.clickedAt)}</strong> depuis votre GPS</span>
          </div>
          {block.slots.map((slot) => (
            <SlotCard
              key={slot.slotId}
              slot={slot}
              zoneId={block.zoneId}
              zoneLat={block.zoneLat}
              zoneLng={block.zoneLng}
              userLat={userPos.lat}
              userLng={userPos.lng}
            />
          ))}
          <a
            href={block.mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-xs font-semibold border border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
          >
            <Navigation size={12} />
            Voir sur Google Maps
          </a>
        </div>
      )}
    </div>
  );
}

// ─── Page principale ───────────────────────────────────────────────────────────

export default function BestRoutePage() {
  // ── GPS temps réel (hook global, position toujours fraîche + fallback Bd Ney) ──
  const { position, status: gpsStatus, isFallback, lastUpdatedAt, refresh } = useGpsPosition();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BestRouteResponse | null>(null);
  const [eventSchedule, setEventSchedule] = useState<EventScheduleResponse | null>(null);
  const [eventLoading, setEventLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expandedEvent, setExpandedEvent] = useState<string | number | null>(null);
  const lastComputeRef = useRef<number>(0);
  const lastEventRef = useRef<number>(0);

  // Relance une lecture GPS (utilisé par le bouton "Réessayer" si refusé)
  const startGeolocation = useCallback(() => {
    setError(null);
    refresh();
  }, [refresh]);

  const compute = useCallback(async (pos: { lat: number; lng: number }) => {
    setLoading(true); setError(null);
    try {
      const resp = await apiRequest("POST", "/api/best-route", pos);
      const data: BestRouteResponse = await resp.json();
      setResult(data); setSelectedIdx(0);
    } catch (e: any) {
      setError(`Erreur calcul : ${e.message}`);
    } finally { setLoading(false); }
  }, []);

  const computeEvents = useCallback(async (pos: { lat: number; lng: number }) => {
    setEventLoading(true);
    try {
      const clickedAt = new Date().toISOString();
      const resp = await apiRequest("POST", "/api/best-route/event-schedule", { ...pos, clickedAt });
      const data: EventScheduleResponse = await resp.json();
      setEventSchedule(data);
    } catch (e: any) {
      console.warn("Event schedule error:", e.message);
    } finally { setEventLoading(false); }
  }, []);

  useEffect(() => {
    // position est toujours valide (fallback Bd Ney si GPS indisponible).
    // On recalcule dès qu'une position est disponible — fraîche au moment de l'appel.
    const now = Date.now();
    if (now - lastComputeRef.current < 30000 && result) return;
    lastComputeRef.current = now;
    compute(position);
    if (now - lastEventRef.current > 60000) {
      lastEventRef.current = now;
      computeEvents(position);
    }
  }, [position.lat, position.lng]);

  // ─── États d'attente ───────────────────────────────────────────────────────

  const renderIdle = () => (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-6">
      <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
        <Route size={36} className="text-primary" />
      </div>
      <div>
        <h2 className="text-xl font-bold mb-2">Meilleur Trajet</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          Activez la géolocalisation pour voir les 4 meilleures zones + créneaux en temps réel.
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3 w-full max-w-xs">
        {[
          { icon: <Crosshair size={16} />, label: "GPS temps réel" },
          { icon: <TrendingUp size={16} />, label: "Top 4 zones" },
          { icon: <CalendarClock size={16} />, label: "Créneaux vols" },
        ].map((f, i) => (
          <div key={i} className="flex flex-col items-center gap-1 p-3 rounded-lg bg-card border border-border text-xs text-muted-foreground">
            <span className="text-primary">{f.icon}</span>
            {f.label}
          </div>
        ))}
      </div>
      <Button onClick={startGeolocation} size="lg" className="gap-2 px-8">
        <Crosshair size={18} /> Activer la géolocalisation
      </Button>
      <p className="text-xs text-muted-foreground opacity-60">Position jamais stockée</p>
    </div>
  );

  const renderRequesting = () => (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-5">
      <div className="w-16 h-16 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
      <div>
        <p className="font-semibold">Acquisition de la position…</p>
        <p className="text-sm text-muted-foreground mt-1">Autorisez l'accès à votre position.</p>
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

  // ─── Rendu résultat ────────────────────────────────────────────────────────

  const renderResult = (data: BestRouteResponse) => {
    const selectedZone = data.top5[selectedIdx];
    return (
      <div className="flex flex-col gap-5 pb-8">

        {/* Header position + rafraîchir */}
        <div className="flex items-center justify-between px-4 pt-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_0_4px_rgba(59,130,246,0.2)] animate-pulse" />
            <span className="text-xs text-muted-foreground tabular-nums">
              {data.userPosition.lat.toFixed(4)}, {data.userPosition.lng.toFixed(4)}
            </span>
            <span className="text-[10px] text-muted-foreground opacity-50">
              {data.hour}h — {data.dayType === "weekday" ? "Semaine" : "Week-end"}
            </span>
          </div>
          <Button
            variant="outline" size="sm"
            onClick={() => position && (compute(position), computeEvents(position))}
            disabled={loading || eventLoading}
            className="h-7 gap-1.5 text-xs"
          >
            <RefreshCw size={12} className={(loading || eventLoading) ? "animate-spin" : ""} />
            {(loading || eventLoading) ? "Calcul…" : "Rafraîchir"}
          </Button>
        </div>

        {/* Indicateur de source globale ETA */}
        <div className="flex items-center gap-2 px-4 -mt-2">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Source ETA :</span>
          <RouteSourceBadge source={data.all?.[0]?.distanceSource ?? "calibrated"} size="xs" />
        </div>

        <div className="px-4">
          <UpdateWidget compact={true} className="w-full" />
        </div>

        {/* ── CARTE OSM (Leaflet) ───────────────────────────────────────────── */}
        <div className="px-4">
          <div className="flex items-center gap-2 mb-2">
            <MapPin size={13} className="text-primary" />
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Carte — {selectedZone?.zone.name ?? "Votre position"}
            </span>
          </div>
          <LeafletMap
            userPos={data.userPosition}
            zonePos={selectedZone ? { lat: selectedZone.zone.lat, lng: selectedZone.zone.lng, name: selectedZone.zone.name } : undefined}
            zoneName={selectedZone?.zone.name ?? ""}
          />
        </div>

        {/* ── TOP 4 ZONES — Cartes verticales sous la map ─────────────────── */}
        <div className="px-4">
          {(() => {
            const best = data.top5[0];
            const ceb = best?.combined_event_boost ?? best?.phq_boost ?? 1.0;
            if (!best || ceb <= 1.3) return null;
            return (
              <div className="flex items-center gap-2 rounded-2xl border border-emerald-400/50 bg-emerald-500/10 px-4 py-3 mb-3">
                <Zap size={16} className="text-emerald-400 animate-pulse flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-emerald-300">⚡ Événement en cours</div>
                  <div className="text-[11px] text-emerald-200/80 truncate">
                    {best.phq_event_title || "Pic de demande détecté"} — {best.zone.name}
                  </div>
                </div>
                <div className="ml-auto">
                  <PredictHQBadge boost={ceb} eventTitle={best.phq_event_title} />
                </div>
              </div>
            );
          })()}
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={14} className="text-primary" />
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Top 4 zones rentables
            </h2>
            <div className="text-[10px] text-muted-foreground opacity-50 ml-auto">
              {data.top5.length} zones analysées
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {data.top5.slice(0, 4).map((z, i) => (
              <ZoneCardVertical
                key={z.zone.id}
                zone={z}
                rank={i + 1}
                isSelected={selectedIdx === i}
                onClick={() => setSelectedIdx(i)}
                userPos={data.userPosition}
              />
            ))}
          </div>
        </div>

        {/* ── ÉVÉNEMENTS — Créneaux chronologiques ─────────────────────────── */}
        <div className="px-4">
          <div className="flex items-center gap-2 mb-3">
            <CalendarClock size={14} className="text-primary" />
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Événements — Créneaux de positionnement
            </h2>
            {eventLoading && <RefreshCw size={10} className="animate-spin text-muted-foreground ml-auto" />}
          </div>

          {!eventSchedule && !eventLoading && (
            <div className="rounded-xl border border-dashed border-border p-6 text-center">
              <p className="text-xs text-muted-foreground">Chargement des événements…</p>
            </div>
          )}

          {eventSchedule && eventSchedule.eventBlocks.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-6 text-center">
              <CalendarClock size={24} className="text-muted-foreground mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">Aucun événement actif avec créneau disponible dans les 3h.</p>
            </div>
          )}

          {eventSchedule && eventSchedule.eventBlocks.length > 0 && (
            <div className="flex flex-col gap-3">
              {eventSchedule.eventBlocks.some(b => b.slots.some(s => s.urgency === "now" || s.urgency === "soon")) && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/30 text-xs text-orange-400">
                  <AlertTriangle size={13} />
                  <span className="font-semibold">Positionnement urgent recommandé sur une ou plusieurs zones</span>
                </div>
              )}
              {eventSchedule.eventBlocks.map((block) => (
                <EventBlockComponent
                  key={block.eventId}
                  block={block}
                  userPos={data.userPosition}
                  isExpanded={expandedEvent === block.eventId}
                  onToggle={() => setExpandedEvent(prev => prev === block.eventId ? null : block.eventId)}
                />
              ))}
            </div>
          )}

          {eventSchedule && (
            <div className="mt-3 text-[10px] text-muted-foreground opacity-50 text-center">
              Créneaux calculés à {fmtTimeSec(eventSchedule.computedAt)} ·
              Mise à jour auto toutes les 60s
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-full">
      {/* Header sticky */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Route size={18} className="text-primary" />
          <div>
            <h1 className="font-bold text-sm leading-none">Meilleur Trajet</h1>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Top 4 zones + créneaux depuis votre GPS
            </p>
          </div>
          <div className="ml-auto">
            <GpsFreshness lastUpdatedAt={lastUpdatedAt} isFallback={isFallback} />
          </div>
        </div>
      </div>

      {gpsStatus === "pending" && !result && renderRequesting()}
      {(gpsStatus === "denied" || gpsStatus === "error" || gpsStatus === "unavailable") && !result && !loading && renderDenied()}
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
