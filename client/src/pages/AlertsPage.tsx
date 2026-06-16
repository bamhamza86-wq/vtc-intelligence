import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, REALTIME_INTERVAL } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Bell, BellOff, Clock, Euro, AlertTriangle, Zap, Cloud,
  Train, CheckCheck, Crosshair, Navigation, CalendarClock,
  ChevronDown, Timer, RefreshCw, AlertCircle, MapPin,
  Plane, TrendingUp, Users, ArrowRight
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import SurgeTransparencyWidget from "@/components/SurgeTransparencyWidget";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Alert {
  id: number;
  type: string;
  title: string;
  message: string;
  zone_id?: string;
  priority: "critical" | "high" | "medium" | "low";
  estimated_revenue?: number;
  expires_at: string;
  created_at: string;
  is_read: number;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PRIORITY_CONFIG = {
  critical: {
    label: "Critique",
    color: "#ef4444",
    bg: "bg-red-500/10",
    border: "border-red-500/40",
    borderL: "border-l-red-500",
    textClass: "text-red-400",
    gradFrom: "from-red-500/20",
    gradTo: "to-red-500/5",
  },
  high: {
    label: "Haute",
    color: "#f59e0b",
    bg: "bg-amber-500/10",
    border: "border-amber-500/40",
    borderL: "border-l-amber-400",
    textClass: "text-amber-400",
    gradFrom: "from-amber-500/20",
    gradTo: "to-amber-500/5",
  },
  medium: {
    label: "Moyenne",
    color: "#3b82f6",
    bg: "bg-blue-500/10",
    border: "border-blue-500/40",
    borderL: "border-l-blue-400",
    textClass: "text-blue-400",
    gradFrom: "from-blue-500/20",
    gradTo: "to-blue-500/5",
  },
  low: {
    label: "Faible",
    color: "#64748b",
    bg: "bg-slate-500/10",
    border: "border-slate-500/20",
    borderL: "border-l-slate-500",
    textClass: "text-muted-foreground",
    gradFrom: "from-slate-500/15",
    gradTo: "to-slate-500/5",
  },
} as const;

const TYPE_ICONS: Record<string, any> = {
  demand_spike: Zap,
  event_ending: AlertTriangle,
  weather_boost: Cloud,
  transport_disruption: Train,
  long_ride_opportunity: Bell,
};

function getEventTypeIcon(type: string): string {
  const m: Record<string, string> = {
    airport: "✈️", match: "⚽", concert: "🎵", salon: "🏛️",
    festival: "🎪", congres: "🎤", transport: "🚉",
    flight_wave: "✈️", flight_forecast: "📡", conference: "🏛️", event: "🎭",
  };
  return m[type] || "📅";
}

function getUrgencyConfig(urgency: Slot["urgency"]) {
  switch (urgency) {
    case "now":      return { color: "#ef4444", bg: "bg-red-500/15",    border: "border-red-500/40",    label: "PARTEZ MAINTENANT", badge: "MAINTENANT", pulse: true };
    case "soon":     return { color: "#f97316", bg: "bg-orange-500/15", border: "border-orange-500/40", label: "Bientôt",            badge: "BIENTÔT",    pulse: true };
    case "upcoming": return { color: "#fbbf24", bg: "bg-yellow-500/15", border: "border-yellow-500/40", label: "Dans 1h",            badge: "DANS 1H",    pulse: false };
    case "later":    return { color: "#64748b", bg: "bg-slate-500/10",  border: "border-slate-500/20",  label: "Plus tard",          badge: "PLUS TARD",  pulse: false };
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

function countdownLabel(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "MAINTENANT";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h${mins % 60 > 0 ? `${mins % 60}m` : ""}`;
}

function timeLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expiré";
  const mins = Math.floor(diff / 60000);
  return mins < 60 ? `${mins}min` : `${Math.floor(mins / 60)}h${mins % 60 > 0 ? `${mins % 60}m` : ""}`;
}

// ─── Countdown live (tick 1s) ─────────────────────────────────────────────────

function LiveCountdown({ iso, color }: { iso: string; color: string }) {
  const [label, setLabel] = useState(countdownLabel(iso));
  useEffect(() => {
    const id = setInterval(() => setLabel(countdownLabel(iso)), 1000);
    return () => clearInterval(id);
  }, [iso]);
  return <span style={{ color }} className="font-black tabular-nums">{label}</span>;
}


// ─── Détail alerte sélectionnée ───────────────────────────────────────────────

function AlertDetail({ alert, onMarkRead, isPending }: {
  alert: Alert; onMarkRead: () => void; isPending: boolean;
}) {
  const cfg = PRIORITY_CONFIG[alert.priority] || PRIORITY_CONFIG.low;
  const TypeIcon = TYPE_ICONS[alert.type] || Bell;

  return (
    <div className={`rounded-2xl border p-4 ${cfg.bg} ${cfg.border} transition-all duration-200`}>
      <div className="flex items-start gap-3 mb-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: `${cfg.color}20`, border: `1px solid ${cfg.color}40` }}
        >
          <TypeIcon size={18} style={{ color: cfg.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-1">
            <p className="font-bold text-sm leading-tight">{alert.title}</p>
            <span
              className="text-[9px] font-bold px-2 py-0.5 rounded-full flex-shrink-0"
              style={{ background: `${cfg.color}20`, color: cfg.color, border: `1px solid ${cfg.color}40` }}
            >
              {cfg.label}
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{alert.message}</p>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
          {alert.estimated_revenue && (
            <span className="flex items-center gap-1 text-green-400 font-semibold">
              <Euro size={10} />~{alert.estimated_revenue}€ estimés
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock size={10} />Expire dans {timeLeft(alert.expires_at)}
          </span>
        </div>
        {!alert.is_read && (
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={onMarkRead} disabled={isPending}>
            <CheckCheck size={12} />Lu
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Slot card (créneau de positionnement) ────────────────────────────────────

function SlotCard({ slot, zoneLat, zoneLng, userLat, userLng, isAirport }: {
  slot: Slot; zoneLat: number; zoneLng: number; userLat: number; userLng: number; isAirport?: boolean;
}) {
  const cfg = getUrgencyConfig(slot.urgency);
  const minsUntilDepart = minutesFromNow(slot.departAt);
  const mapsUrl = `https://www.google.com/maps/dir/${userLat},${userLng}/${zoneLat},${zoneLng}`;
  const isPast = minsUntilDepart < -2;
  const isVeryUrgent = slot.urgency === "now" || slot.urgency === "soon";

  if (isPast) return null;

  return (
    <div
      className={`rounded-2xl border overflow-hidden transition-all ${cfg.bg} ${cfg.border}`}
      style={isVeryUrgent ? { boxShadow: `0 0 0 1px ${cfg.color}40, 0 2px 12px ${cfg.color}20` } : {}}
    >
      {/* Label vol / créneau */}
      <div className="px-3.5 pt-3 pb-2 flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold leading-snug">{slot.label}</p>
          {slot.detail && (
            <p className="text-[10px] text-muted-foreground mt-0.5">{slot.detail}</p>
          )}
        </div>
        <div
          className="flex-shrink-0 flex items-center gap-1 text-[9px] font-bold px-2 py-1 rounded-full border"
          style={{ color: cfg.color, borderColor: `${cfg.color}50`, background: `${cfg.color}15` }}
        >
          {cfg.pulse && (
            <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block" style={{ background: cfg.color }} />
          )}
          {cfg.badge}
        </div>
      </div>

      {/* Timeline principale */}
      <div className="px-3.5 pb-3">
        <div className="flex items-center gap-2 mb-3">

          {/* Départ chauffeur */}
          <div className="flex-1 rounded-xl p-2.5 text-center"
            style={{ background: `${cfg.color}12`, border: `1px solid ${cfg.color}30` }}>
            <p className="text-[9px] text-muted-foreground mb-0.5 uppercase tracking-wide">Partez à</p>
            <p className="text-lg font-black tabular-nums leading-none" style={{ color: cfg.color }}>
              {fmtTime(slot.departAt)}
            </p>
            <p className="text-[9px] mt-0.5">
              {minsUntilDepart > 0
                ? <span className="text-muted-foreground">dans <LiveCountdown iso={slot.departAt} color={cfg.color} /></span>
                : <span style={{ color: cfg.color }} className="font-bold animate-pulse">MAINTENANT</span>
              }
            </p>
          </div>

          {/* Flèche + trajet */}
          <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
            <ArrowRight size={14} className="text-muted-foreground/60" />
            <span className="text-[9px] text-muted-foreground">{slot.etaMin}min</span>
            <span className="text-[9px] text-muted-foreground">{slot.distKm}km</span>
          </div>

          {/* Arrivée sur zone */}
          <div className="flex-1 rounded-xl p-2.5 text-center bg-blue-500/10 border border-blue-500/25">
            <p className="text-[9px] text-muted-foreground mb-0.5 uppercase tracking-wide">Arrivée zone</p>
            <p className="text-lg font-black tabular-nums leading-none text-blue-400">
              {fmtTime(slot.arriveBy)}
            </p>
            {slot.bufferMin > 0 && (
              <p className="text-[9px] text-muted-foreground mt-0.5">{slot.bufferMin}min avant</p>
            )}
          </div>

          {/* Heure événement (vol atterrissage ou début) */}
          {isAirport && (
            <>
              <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                <Plane size={12} className="text-muted-foreground/60" />
                <span className="text-[9px] text-muted-foreground">atterro.</span>
              </div>
              <div className="flex-1 rounded-xl p-2.5 text-center bg-purple-500/10 border border-purple-500/25">
                <p className="text-[9px] text-muted-foreground mb-0.5 uppercase tracking-wide">Vol arrive</p>
                <p className="text-base font-black tabular-nums leading-none text-purple-400">
                  {fmtTime(slot.eventTime)}
                </p>
                {slot.flightCallsign && (
                  <p className="text-[9px] text-purple-400/70 mt-0.5 font-bold">{slot.flightCallsign}</p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Bouton naviguer */}
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full py-2 rounded-xl text-[11px] font-bold text-black transition-all hover:opacity-90 active:scale-95"
          style={{ background: cfg.color }}
          onClick={(e) => e.stopPropagation()}
        >
          <Navigation size={12} />
          Naviguer maintenant
        </a>
      </div>
    </div>
  );
}

// ─── Bloc événement complet ───────────────────────────────────────────────────

function EventBlockCard({ block, userPos, isExpanded, onToggle }: {
  block: EventBlock;
  userPos: { lat: number; lng: number };
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const nextSlot = block.slots.find(s => minutesFromNow(s.departAt) > -2);
  const nextCfg = nextSlot ? getUrgencyConfig(nextSlot.urgency) : null;
  const hasUrgent = block.slots.some(s => s.urgency === "now" || s.urgency === "soon");
  const visibleSlots = block.slots.filter(s => minutesFromNow(s.departAt) > -2);
  const isAirport = block.zoneType === "airport";

  return (
    <div className={`rounded-2xl border overflow-hidden transition-all duration-300 ${
      hasUrgent ? "border-orange-500/40" : "border-border"
    }`} style={hasUrgent ? { boxShadow: "0 0 0 1px rgba(249,115,22,0.3)" } : {}}>

      {/* Header cliquable */}
      <button
        onClick={onToggle}
        className="w-full text-left p-4 flex items-center gap-3 hover:bg-muted/30 transition-colors"
      >
        {/* Icône */}
        <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center text-xl flex-shrink-0">
          {getEventTypeIcon(block.eventType)}
        </div>

        {/* Infos */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            <span className="font-bold text-sm leading-tight">{block.eventName}</span>
            {hasUrgent && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30 animate-pulse">
                URGENT
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-1">
            <span className="flex items-center gap-0.5"><MapPin size={9} />{block.distKm}km</span>
            <span className="flex items-center gap-0.5"><Clock size={9} />~{block.etaMin}min trajet</span>
            {block.demandBoost > 1.1 && (
              <span className="flex items-center gap-0.5 text-green-400 font-semibold">
                <TrendingUp size={9} />×{block.demandBoost.toFixed(2)}
              </span>
            )}
            <span className="text-muted-foreground/50">
              {visibleSlots.length} créneau{visibleSlots.length > 1 ? "x" : ""}
            </span>
          </div>

          {/* Prochain créneau */}
          {nextSlot && !isExpanded && (
            <div
              className="flex items-center gap-1.5 text-[11px] font-bold"
              style={{ color: nextCfg?.color }}
            >
              <Timer size={10} />
              Prochain départ :{" "}
              <span className="tabular-nums">{fmtTime(nextSlot.departAt)}</span>
              <span className="font-normal text-muted-foreground text-[10px]">
                {minutesFromNow(nextSlot.departAt) > 0
                  ? `(dans ${minutesFromNow(nextSlot.departAt)}min)`
                  : "· MAINTENANT"
                }
              </span>
            </div>
          )}
        </div>

        <ChevronDown
          size={16}
          className={`flex-shrink-0 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
        />
      </button>

      {/* Contenu expandé */}
      {isExpanded && (
        <div className="px-4 pb-4 flex flex-col gap-3">

          {/* GPS clic timestamp */}
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground bg-muted/40 rounded-xl px-3 py-2">
            <Crosshair size={10} className="text-blue-400 flex-shrink-0" />
            <span>
              Calculé depuis votre position GPS à{" "}
              <strong className="text-blue-400 tabular-nums">{fmtTimeSec(block.clickedAt)}</strong>
              {" "}· ETA trajet{" "}
              <strong className="text-foreground">{block.etaMin} min</strong>
              {" "}({block.distKm} km)
            </span>
          </div>

          {/* Créneaux */}
          {visibleSlots.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">
              Aucun créneau disponible dans les 3h.
            </p>
          ) : (
            visibleSlots.map((slot) => (
              <SlotCard
                key={slot.slotId}
                slot={slot}
                zoneLat={block.zoneLat}
                zoneLng={block.zoneLng}
                userLat={userPos.lat}
                userLng={userPos.lng}
                isAirport={isAirport}
              />
            ))
          )}

          {/* Maps global */}
          <a
            href={block.mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-xs font-semibold border border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
          >
            <Navigation size={12} />
            Voir sur Google Maps
          </a>
        </div>
      )}
    </div>
  );
}

// ─── GPS Banner ──────────────────────────────────────────────────────────────

function GpsBanner({ status, position, onActivate }: {
  status: string;
  position: { lat: number; lng: number } | null;
  onActivate: () => void;
}) {
  if (status === "granted" && position) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-green-500/10 border border-green-500/25 text-xs text-green-400">
        <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
        <span className="tabular-nums font-medium">
          GPS actif — {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
        </span>
      </div>
    );
  }
  if (status === "requesting") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-500/10 border border-blue-500/25 text-xs text-blue-400">
        <div className="w-3 h-3 rounded-full border border-blue-400/50 border-t-blue-400 animate-spin flex-shrink-0" />
        Acquisition GPS…
      </div>
    );
  }
  return (
    <button
      onClick={onActivate}
      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary/10 border border-primary/30 text-xs text-primary w-full hover:bg-primary/15 transition-colors"
    >
      <Crosshair size={13} />
      <span className="font-medium">Activer GPS pour les créneaux de positionnement</span>
      <ArrowRight size={12} className="ml-auto" />
    </button>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function AlertsPage() {

  // ── Alertes ────────────────────────────────────────────────────────────────
  const { data: alerts = [], isLoading } = useQuery({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then(r => r.json()),
    refetchInterval: 3_000,  // alertes: refresh 3s temps réel
  });

  const markRead = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/alerts/${id}/read`).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/alerts"] }),
  });

  // ── GPS ────────────────────────────────────────────────────────────────────
  const [gpsStatus, setGpsStatus] = useState<"idle" | "requesting" | "granted" | "denied">("idle");
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const startGps = useCallback(() => {
    if (!navigator.geolocation) return;
    setGpsStatus("requesting");
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({
          lat: Math.round(pos.coords.latitude * 100000) / 100000,
          lng: Math.round(pos.coords.longitude * 100000) / 100000,
        });
        setGpsStatus("granted");
      },
      () => setGpsStatus("denied"),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  }, []);

  useEffect(() => () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
  }, []);

  // ── Événements chronologiques ──────────────────────────────────────────────
  const [eventSchedule, setEventSchedule] = useState<EventScheduleResponse | null>(null);
  const [eventLoading, setEventLoading] = useState(false);
  const [expandedEvent, setExpandedEvent] = useState<string | number | null>(null);
  const lastEventRef = useRef<number>(0);

  const fetchEvents = useCallback(async (pos: { lat: number; lng: number }) => {
    setEventLoading(true);
    try {
      const clickedAt = new Date().toISOString();
      const resp = await apiRequest("POST", "/api/best-route/event-schedule", { ...pos, clickedAt });
      const data: EventScheduleResponse = await resp.json();
      setEventSchedule(data);
      // Auto-ouvrir le premier événement urgent
      const urgentBlock = data.eventBlocks.find(b =>
        b.slots.some(s => s.urgency === "now" || s.urgency === "soon")
      );
      if (urgentBlock) setExpandedEvent(urgentBlock.eventId);
    } catch (e) {
      console.warn("Event schedule error:", e);
    } finally {
      setEventLoading(false);
    }
  }, []);

  // Auto-fetch événements dès GPS accordé (max 1x/60s)
  useEffect(() => {
    if (!position || gpsStatus !== "granted") return;
    const now = Date.now();
    if (now - lastEventRef.current < 60000 && eventSchedule) return;
    lastEventRef.current = now;
    fetchEvents(position);
  }, [position]);

  // ── UI state ───────────────────────────────────────────────────────────────

  const allAlerts = alerts as Alert[];
  const unread = allAlerts.filter(a => !a.is_read);

  // ── Déduplication par zone_id — garder la plus haute priorité par zone ──
  const PRIO_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const seenZones = new Map<string, Alert>();
  const dedupedAlerts: Alert[] = [];
  for (const al of allAlerts) {
    const key = al.zone_id || `no-zone-${al.id}`;
    const existing = seenZones.get(key);
    if (!existing || PRIO_RANK[al.priority] < PRIO_RANK[existing.priority]) {
      seenZones.set(key, al);
    }
  }
  // Reconstruire dans l'ordre original en ne gardant que le winner par zone
  const winnerIds = new Set(Array.from(seenZones.values()).map(a => a.id));
  for (const al of allAlerts) {
    if (winnerIds.has(al.id)) dedupedAlerts.push(al);
  }

  // ── État accordéon alertes ──
  const [expandedAlertId, setExpandedAlertId] = useState<number | null>(null);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (isLoading) return (
    <div className="p-4 space-y-3">
      {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)}
    </div>
  );

  if (allAlerts.length === 0) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-center px-4">
      <BellOff size={40} className="text-muted-foreground/40" />
      <p className="font-medium">Aucune alerte active</p>
      <p className="text-sm text-muted-foreground">Les opportunités apparaîtront ici en temps réel</p>
    </div>
  );

  const totalSlotsUrgent = eventSchedule?.eventBlocks.reduce((acc, b) =>
    acc + b.slots.filter(s => s.urgency === "now" || s.urgency === "soon").length, 0) ?? 0;

  return (
    <div className="min-h-full">

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Bell size={18} className="text-primary" />
            <div>
              <h1 className="font-bold text-sm leading-none">Alertes & Positionnement</h1>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {unread.length} alerte{unread.length > 1 ? "s" : ""} · GPS temps réel
                {totalSlotsUrgent > 0 && (
                  <span className="ml-1 text-orange-400 font-semibold">· {totalSlotsUrgent} créneau{totalSlotsUrgent > 1 ? "x" : ""} urgent{totalSlotsUrgent > 1 ? "s" : ""}</span>
                )}
              </p>
            </div>
          </div>
          {unread.length > 0 && (
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-2.5 w-2.5 rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-6 pb-10 pt-4">

        {/* ── GPS Banner ───────────────────────────────────────────────────── */}
        <div className="px-4">
          <GpsBanner status={gpsStatus} position={position} onActivate={startGps} />
        </div>

        {/* ── THÈME 5 : Transparence surge ─────────────────────────────────── */}
        <div className="px-4">
          <SurgeTransparencyWidget />
        </div>

        {/* ── ÉVÉNEMENTS — Créneaux GPS chronologiques ─────────────────────── */}
        <div className="px-4">
          <div className="flex items-center gap-2 mb-3">
            <CalendarClock size={13} className="text-primary" />
            <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
              Créneaux de positionnement
            </h2>
            {eventLoading && <RefreshCw size={10} className="animate-spin text-muted-foreground ml-1" />}
            {!eventLoading && eventSchedule && position && (
              <button
                onClick={() => fetchEvents(position)}
                className="ml-auto text-[10px] text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
              >
                <RefreshCw size={9} />Actualiser
              </button>
            )}
          </div>

          {/* GPS idle */}
          {gpsStatus === "idle" && (
            <div className="rounded-2xl border border-dashed border-border p-6 text-center">
              <Crosshair size={26} className="text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm font-medium mb-1">Position GPS requise</p>
              <p className="text-xs text-muted-foreground mb-4">
                Activez le GPS pour calculer vos créneaux de positionnement en temps réel.
                Les heures de départ sont calculées à la seconde près depuis votre position.
              </p>
              <Button size="sm" onClick={startGps} className="gap-2">
                <Crosshair size={13} />
                Activer GPS
              </Button>
            </div>
          )}

          {/* GPS refusé */}
          {gpsStatus === "denied" && (
            <div className="rounded-2xl border border-orange-500/25 bg-orange-500/5 p-4 text-center">
              <AlertCircle size={22} className="text-orange-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-orange-400 mb-1">GPS refusé</p>
              <p className="text-xs text-muted-foreground">
                Autorisez la géolocalisation dans les paramètres de votre navigateur.
              </p>
            </div>
          )}

          {/* Chargement */}
          {(gpsStatus === "granted" || gpsStatus === "requesting") && eventLoading && !eventSchedule && (
            <div className="flex flex-col items-center py-10 gap-3">
              <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              <p className="text-xs text-muted-foreground">Calcul des créneaux depuis votre GPS…</p>
            </div>
          )}

          {/* Alerte urgence globale */}
          {eventSchedule && totalSlotsUrgent > 0 && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-orange-500/10 border border-orange-500/30 text-xs text-orange-400 mb-3">
              <AlertTriangle size={13} className="flex-shrink-0" />
              <span className="font-bold">
                {totalSlotsUrgent} positionnement{totalSlotsUrgent > 1 ? "s" : ""} urgent{totalSlotsUrgent > 1 ? "s" : ""} — partez maintenant !
              </span>
            </div>
          )}

          {/* Aucun événement */}
          {eventSchedule && eventSchedule.eventBlocks.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border p-5 text-center">
              <CalendarClock size={22} className="text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">
                Aucun créneau disponible dans les 3h.
              </p>
            </div>
          )}

          {/* Blocs événements */}
          {eventSchedule && eventSchedule.eventBlocks.length > 0 && (
            <div className="flex flex-col gap-3">
              {eventSchedule.eventBlocks.map((block) => (
                <EventBlockCard
                  key={block.eventId}
                  block={block}
                  userPos={eventSchedule.userPosition}
                  isExpanded={expandedEvent === block.eventId}
                  onToggle={() =>
                    setExpandedEvent(prev => prev === block.eventId ? null : block.eventId)
                  }
                />
              ))}
            </div>
          )}

          {/* Métadonnées */}
          {eventSchedule && (
            <div className="mt-4 text-[10px] text-muted-foreground/40 text-center leading-relaxed">
              Calculé à {fmtTimeSec(eventSchedule.computedAt)}{" "}
              · GPS {eventSchedule.userPosition.lat.toFixed(4)},{eventSchedule.userPosition.lng.toFixed(4)}{" "}
              · Actualisation auto 60s
            </div>
          )}
        </div>

        {/* ── Toutes les alertes — liste unifiée dédoublonnée avec accordéon ─── */}
        {dedupedAlerts.length > 0 && (
          <div className="px-4">
            <div className="flex items-center gap-2 mb-3">
              <Bell size={13} className="text-muted-foreground" />
              <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                Alertes actives
              </h2>
              <span className="ml-1 text-[10px] text-muted-foreground/60">
                {dedupedAlerts.length} zone{dedupedAlerts.length > 1 ? "s" : ""}
              </span>
              {unread.length > 0 && (
                <span className="ml-auto text-[10px] font-bold text-red-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />
                  {unread.length} non lu{unread.length > 1 ? "es" : "e"}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              {dedupedAlerts.map((alert) => {
                const cfg = PRIORITY_CONFIG[alert.priority] || PRIORITY_CONFIG.low;
                const TypeIcon = TYPE_ICONS[alert.type] || Bell;
                const isOpen = expandedAlertId === alert.id;
                return (
                  <div key={alert.id}>
                    {/* Carte cliquable */}
                    <button
                      className={`w-full text-left rounded-2xl border p-3.5 transition-all duration-200
                        ${isOpen ? `${cfg.bg} ${cfg.border}` : "border-border hover:border-muted-foreground/40 bg-card"}
                        ${alert.is_read ? "opacity-60" : ""}`}
                      onClick={() => setExpandedAlertId(prev => prev === alert.id ? null : alert.id)}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                          style={{ background: `${cfg.color}20`, border: `1px solid ${cfg.color}40` }}
                        >
                          <TypeIcon size={16} style={{ color: cfg.color }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <p className="font-bold text-xs leading-tight">{alert.title}</p>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {!alert.is_read && (
                                <span className="w-1.5 h-1.5 rounded-full animate-pulse flex-shrink-0"
                                  style={{ background: cfg.color }} />
                              )}
                              <span
                                className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                                style={{ background: `${cfg.color}20`, color: cfg.color, border: `1px solid ${cfg.color}30` }}
                              >{cfg.label}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                            {alert.estimated_revenue && (
                              <span className="flex items-center gap-0.5 text-green-400 font-semibold">
                                <Euro size={9} />~{alert.estimated_revenue}€
                              </span>
                            )}
                            <span className="flex items-center gap-0.5">
                              <Clock size={9} />{timeLeft(alert.expires_at)}
                            </span>
                            <ChevronDown
                              size={13}
                              className={`ml-auto transition-transform duration-200 text-muted-foreground/60
                                ${isOpen ? "rotate-180" : ""}`}
                            />
                          </div>
                        </div>
                      </div>
                    </button>

                    {/* Détail expandé — accordéon vertical */}
                    {isOpen && (
                      <div className="mt-1 rounded-2xl border border-border bg-muted/20 p-4 transition-all duration-200">
                        <p className="text-xs text-muted-foreground leading-relaxed mb-3">{alert.message}</p>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
                            {alert.estimated_revenue && (
                              <span className="flex items-center gap-1 text-green-400 font-semibold">
                                <Euro size={10} />~{alert.estimated_revenue}€ estimés
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <Clock size={10} />Expire dans {timeLeft(alert.expires_at)}
                            </span>
                          </div>
                          {!alert.is_read && (
                            <Button
                              size="sm" variant="ghost" className="h-7 text-xs gap-1 flex-shrink-0"
                              onClick={(e) => { e.stopPropagation(); markRead.mutate(alert.id); }}
                              disabled={markRead.isPending}
                            >
                              <CheckCheck size={12} />Lu
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Stratégies clés ───────────────────────────────────────────────── */}
        <div className="px-4">
          <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp size={13} className="text-primary" />
              <p className="text-xs font-bold text-primary">Stratégies de positionnement</p>
            </div>
            <div className="space-y-2.5 text-xs text-muted-foreground">
              {[
                ["✈️", "CDG / Orly — Vols arrivées", "Positionnez-vous 20–30 min avant atterrissage. Courses 35–55€ vers Paris / La Défense."],
                ["⚽", "Stade de France — Sortie match", "80 000 spec. → surge ×4. Rue Jules Rimet, 20 min avant coup de sifflet final."],
                ["🏛️", "Villepinte / Le Bourget", "Salons pro = clients business → longues courses garanties. Tarifs 30–50€."],
                ["🌅", "Pointe matinale 93 (6h–9h)", "Plaine Commune, Aulnay, Tremblay vers La Défense / Paris. Ratio D/O > 2.5×."],
                ["🌙", "Nuit IDF (22h–3h)", "CDG actif 24h. Taxis rares = surge élevé. Courses 40–70€ depuis l'aéroport."],
              ].map(([icon, title, desc]) => (
                <div key={title} className="flex gap-2.5 items-start">
                  <span className="flex-shrink-0 text-base leading-none mt-0.5">{icon}</span>
                  <span><strong className="text-foreground/80">{title}</strong> — {desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
