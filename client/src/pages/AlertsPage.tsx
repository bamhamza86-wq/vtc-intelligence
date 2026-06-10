import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Bell, BellOff, Clock, Euro, AlertTriangle, Zap, Cloud,
  Train, CheckCheck, Crosshair, Navigation, CalendarClock,
  ChevronRight, Timer, RefreshCw, AlertCircle, MapPin
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

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
  },
  high: {
    label: "Haute",
    color: "#f59e0b",
    bg: "bg-amber-500/10",
    border: "border-amber-500/40",
    borderL: "border-l-amber-400",
    textClass: "text-amber-400",
  },
  medium: {
    label: "Moyenne",
    color: "#3b82f6",
    bg: "bg-blue-500/10",
    border: "border-blue-500/40",
    borderL: "border-l-blue-400",
    textClass: "text-blue-400",
  },
  low: {
    label: "Faible",
    color: "#64748b",
    bg: "bg-slate-500/10",
    border: "border-slate-500/20",
    borderL: "border-l-slate-500",
    textClass: "text-muted-foreground",
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

function timeLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expiré";
  const mins = Math.floor(diff / 60000);
  return mins < 60 ? `${mins}min` : `${Math.floor(mins / 60)}h${mins % 60 > 0 ? `${mins % 60}m` : ""}`;
}

// ─── Top 4 Alerte Card (horizontale) ─────────────────────────────────────────

function AlertTopCard({ alert, isSelected, onClick }: {
  alert: Alert; isSelected: boolean; onClick: () => void;
}) {
  const cfg = PRIORITY_CONFIG[alert.priority] || PRIORITY_CONFIG.low;
  const TypeIcon = TYPE_ICONS[alert.type] || Bell;
  const isNew = !alert.is_read;

  return (
    <div
      onClick={onClick}
      style={{
        minWidth: "152px",
        maxWidth: "152px",
        borderColor: isSelected ? cfg.color : undefined,
        boxShadow: isSelected ? `0 0 0 2px ${cfg.color}40` : undefined,
      }}
      className={`cursor-pointer flex-shrink-0 rounded-xl border p-3 transition-all duration-200 ${cfg.bg} ${
        isSelected ? "" : "border-border hover:border-muted-foreground/40"
      } ${alert.is_read ? "opacity-60" : ""}`}
    >
      {/* Header : icon + priorité */}
      <div className="flex items-center justify-between mb-2">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: `${cfg.color}20`, border: `1px solid ${cfg.color}40` }}
        >
          <TypeIcon size={15} style={{ color: cfg.color }} />
        </div>
        <div className="flex items-center gap-1">
          {isNew && (
            <span
              className="w-2 h-2 rounded-full animate-pulse flex-shrink-0"
              style={{ background: cfg.color }}
            />
          )}
          <span className="text-[9px] font-bold" style={{ color: cfg.color }}>{cfg.label}</span>
        </div>
      </div>

      {/* Titre */}
      <p className="text-[11px] font-semibold leading-tight mb-1.5 line-clamp-2">{alert.title}</p>

      {/* Revenus estimés */}
      {alert.estimated_revenue && (
        <div className="flex items-center gap-1 text-[10px] text-green-400 font-semibold mb-1">
          <Euro size={9} />~{alert.estimated_revenue}€
        </div>
      )}

      {/* Expire */}
      <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
        <Clock size={8} />
        {timeLeft(alert.expires_at)}
      </div>
    </div>
  );
}

// ─── Detail alerte sélectionnée ───────────────────────────────────────────────

function AlertDetail({ alert, onMarkRead, isPending }: {
  alert: Alert; onMarkRead: () => void; isPending: boolean;
}) {
  const cfg = PRIORITY_CONFIG[alert.priority] || PRIORITY_CONFIG.low;
  const TypeIcon = TYPE_ICONS[alert.type] || Bell;

  return (
    <div
      className={`rounded-xl border p-4 ${cfg.bg} ${cfg.border}`}
    >
      <div className="flex items-start gap-3 mb-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: `${cfg.color}20`, border: `1px solid ${cfg.color}40` }}
        >
          <TypeIcon size={18} style={{ color: cfg.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-0.5">
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
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1"
            onClick={onMarkRead}
            disabled={isPending}
          >
            <CheckCheck size={12} />Lu
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Slot card (créneau de positionnement) ────────────────────────────────────

function SlotCard({ slot, zoneLat, zoneLng, userLat, userLng }: {
  slot: Slot; zoneLat: number; zoneLng: number; userLat: number; userLng: number;
}) {
  const cfg = getUrgencyConfig(slot.urgency);
  const minsUntilDepart = minutesFromNow(slot.departAt);
  const mapsUrl = `https://www.google.com/maps/dir/${userLat},${userLng}/${zoneLat},${zoneLng}`;

  return (
    <div className={`rounded-xl border p-3 ${cfg.bg} ${cfg.border}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold leading-snug mb-0.5">{slot.label}</div>
          {slot.detail && <div className="text-[10px] text-muted-foreground">{slot.detail}</div>}
        </div>
        <div
          className={`flex-shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 ${cfg.bg} ${cfg.border}`}
          style={{ color: cfg.color }}
        >
          {cfg.pulse && (
            <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block" style={{ background: cfg.color }} />
          )}
          {cfg.label}
        </div>
      </div>

      {/* Timeline */}
      <div className="grid grid-cols-3 gap-1 mb-2.5">
        <div className="flex flex-col items-center text-center">
          <div className="text-[9px] text-muted-foreground mb-0.5">Partez à</div>
          <div className="text-sm font-black tabular-nums" style={{ color: cfg.color }}>
            {fmtTime(slot.departAt)}
          </div>
          {minsUntilDepart > 0
            ? <div className="text-[9px] text-muted-foreground">dans {minsUntilDepart}min</div>
            : <div className="text-[9px] font-bold" style={{ color: cfg.color }}>MAINTENANT</div>
          }
        </div>

        <div className="flex flex-col items-center justify-center">
          <div className="flex items-center gap-0.5 text-muted-foreground">
            <div className="h-px w-4 bg-muted-foreground/40" />
            <span className="text-[9px] whitespace-nowrap">{slot.etaMin}min</span>
            <div className="h-px w-4 bg-muted-foreground/40" />
          </div>
          <div className="text-[9px] text-muted-foreground">{slot.distKm}km</div>
        </div>

        <div className="flex flex-col items-center text-center">
          <div className="text-[9px] text-muted-foreground mb-0.5">Arrivée</div>
          <div className="text-sm font-black tabular-nums text-blue-400">{fmtTime(slot.arriveBy)}</div>
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

function EventBlockCard({ block, userPos, isExpanded, onToggle }: {
  block: EventBlock;
  userPos: { lat: number; lng: number };
  isExpanded: boolean;
  onToggle: () => void;
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
        className="w-full text-left p-3.5 flex items-center gap-3 hover:bg-muted/30 transition-colors"
      >
        <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-base flex-shrink-0">
          {getEventTypeIcon(block.eventType)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="font-semibold text-sm leading-tight truncate">{block.eventName}</span>
            {hasUrgent && (
              <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">
                URGENT
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-0.5"><MapPin size={9} /> {block.distKm}km</span>
            <span className="flex items-center gap-0.5"><Clock size={9} /> ~{block.etaMin}min</span>
            {block.demandBoost > 1.1 && (
              <span className="flex items-center gap-0.5 text-green-400">
                <Zap size={9} /> ×{block.demandBoost.toFixed(2)}
              </span>
            )}
            <span className="text-[9px] text-muted-foreground/60">
              {block.slots.length} créneau{block.slots.length > 1 ? "x" : ""}
            </span>
          </div>

          {nextSlot && !isExpanded && (
            <div className="mt-0.5 text-[10px] font-semibold flex items-center gap-1" style={{ color: nextCfg?.color }}>
              <Timer size={9} />
              Prochain départ : {fmtTime(nextSlot.departAt)}
              {minutesFromNow(nextSlot.departAt) > 0
                ? ` (dans ${minutesFromNow(nextSlot.departAt)}min)`
                : " · MAINTENANT"
              }
            </div>
          )}
        </div>

        <ChevronRight
          size={16}
          className={`flex-shrink-0 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}
        />
      </button>

      {isExpanded && (
        <div className="px-3.5 pb-3.5 flex flex-col gap-2.5">
          {/* Timestamp GPS clic */}
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground bg-muted/30 rounded-lg px-3 py-1.5">
            <Crosshair size={9} className="text-blue-400" />
            <span>
              Calculé depuis votre GPS à{" "}
              <strong className="text-blue-400">{fmtTimeSec(block.clickedAt)}</strong>
            </span>
          </div>

          {block.slots.map((slot) => (
            <SlotCard
              key={slot.slotId}
              slot={slot}
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

// ─── GPS Mini Banner ──────────────────────────────────────────────────────────

function GpsBanner({ status, position, onActivate }: {
  status: string;
  position: { lat: number; lng: number } | null;
  onActivate: () => void;
}) {
  if (status === "granted" && position) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-xs text-green-400">
        <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
        <span className="tabular-nums">
          GPS actif — {position.lat.toFixed(4)}, {position.lng.toFixed(4)}
        </span>
      </div>
    );
  }
  if (status === "requesting") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-400">
        <div className="w-3 h-3 rounded-full border border-blue-400/50 border-t-blue-400 animate-spin flex-shrink-0" />
        Acquisition GPS…
      </div>
    );
  }
  return (
    <button
      onClick={onActivate}
      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30 text-xs text-primary w-full hover:bg-primary/15 transition-colors"
    >
      <Crosshair size={12} />
      <span>Activer GPS pour les créneaux de positionnement</span>
      <ChevronRight size={12} className="ml-auto" />
    </button>
  );
}

// ─── Page principale ───────────────────────────────────────────────────────────

export default function AlertsPage() {
  // ── Alertes ────────────────────────────────────────────────────────────────
  const { data: alerts = [], isLoading } = useQuery({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then(r => r.json()),
    refetchInterval: 30000,
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
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
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
    } catch (e) {
      console.warn("Event schedule error:", e);
    } finally {
      setEventLoading(false);
    }
  }, []);

  // Auto-fetch événements dès que GPS accordé (max 1x/60s)
  useEffect(() => {
    if (!position || gpsStatus !== "granted") return;
    const now = Date.now();
    if (now - lastEventRef.current < 60000 && eventSchedule) return;
    lastEventRef.current = now;
    fetchEvents(position);
  }, [position]);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [selectedAlertIdx, setSelectedAlertIdx] = useState(0);

  const allAlerts = alerts as Alert[];
  const unread = allAlerts.filter(a => !a.is_read);
  const top4 = [...unread, ...allAlerts.filter(a => a.is_read)].slice(0, 4);
  const selectedAlert = top4[selectedAlertIdx];

  // ── Render ─────────────────────────────────────────────────────────────────

  if (isLoading) return (
    <div className="p-4 space-y-3">
      {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
    </div>
  );

  if (allAlerts.length === 0) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-center px-4">
      <BellOff size={40} className="text-muted-foreground/40" />
      <p className="font-medium">Aucune alerte active</p>
      <p className="text-sm text-muted-foreground">Les opportunités apparaîtront ici en temps réel</p>
    </div>
  );

  return (
    <div className="min-h-full">

      {/* ── Header sticky ────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell size={17} className="text-primary" />
            <div>
              <h1 className="font-bold text-sm leading-none">Alertes</h1>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {unread.length} non lue{unread.length > 1 ? "s" : ""} · Top 4 + créneaux GPS
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

      <div className="flex flex-col gap-5 pb-8 pt-4">

        {/* ── GPS Banner ───────────────────────────────────────────────────── */}
        <div className="px-4">
          <GpsBanner status={gpsStatus} position={position} onActivate={startGps} />
        </div>

        {/* ── TOP 4 ALERTES — scroll horizontal ────────────────────────────── */}
        <div className="px-4">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={13} className="text-primary" />
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Top 4 alertes actives
            </h2>
          </div>

          <div
            className="flex gap-3 overflow-x-auto pb-2"
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          >
            {top4.map((alert, i) => (
              <AlertTopCard
                key={alert.id}
                alert={alert}
                isSelected={selectedAlertIdx === i}
                onClick={() => setSelectedAlertIdx(i)}
              />
            ))}
          </div>

          {/* Détail de l'alerte sélectionnée */}
          {selectedAlert && (
            <div className="mt-3">
              <AlertDetail
                alert={selectedAlert}
                onMarkRead={() => markRead.mutate(selectedAlert.id)}
                isPending={markRead.isPending}
              />
            </div>
          )}
        </div>

        {/* ── ÉVÉNEMENTS — Créneaux chronologiques GPS ─────────────────────── */}
        <div className="px-4">
          <div className="flex items-center gap-2 mb-3">
            <CalendarClock size={13} className="text-primary" />
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Événements — Créneaux de positionnement
            </h2>
            {eventLoading && <RefreshCw size={10} className="animate-spin text-muted-foreground ml-auto" />}
            {!eventLoading && eventSchedule && position && (
              <button
                onClick={() => fetchEvents(position)}
                className="ml-auto text-[10px] text-muted-foreground hover:text-primary flex items-center gap-1"
              >
                <RefreshCw size={9} /> Actualiser
              </button>
            )}
          </div>

          {/* GPS non activé */}
          {gpsStatus === "idle" && (
            <div className="rounded-xl border border-dashed border-border p-5 text-center">
              <Crosshair size={22} className="text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground mb-3">
                Activez le GPS pour voir les créneaux de positionnement calculés depuis votre position exacte.
              </p>
              <Button size="sm" onClick={startGps} className="gap-2 text-xs">
                <Crosshair size={13} />
                Activer GPS
              </Button>
            </div>
          )}

          {/* GPS refusé */}
          {gpsStatus === "denied" && (
            <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4 text-center">
              <AlertCircle size={20} className="text-orange-400 mx-auto mb-2" />
              <p className="text-xs text-orange-400">
                GPS refusé — autorisez la géolocalisation dans les paramètres du navigateur.
              </p>
            </div>
          )}

          {/* Chargement */}
          {(gpsStatus === "granted" || gpsStatus === "requesting") && eventLoading && !eventSchedule && (
            <div className="flex flex-col items-center py-8 gap-2">
              <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              <p className="text-xs text-muted-foreground">Calcul des créneaux…</p>
            </div>
          )}

          {/* Aucun événement */}
          {eventSchedule && eventSchedule.eventBlocks.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-5 text-center">
              <CalendarClock size={22} className="text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">
                Aucun événement avec créneau disponible dans les 3h.
              </p>
            </div>
          )}

          {/* Événements */}
          {eventSchedule && eventSchedule.eventBlocks.length > 0 && (
            <div className="flex flex-col gap-3">
              {/* Alerte urgence */}
              {eventSchedule.eventBlocks.some(b =>
                b.slots.some(s => s.urgency === "now" || s.urgency === "soon")
              ) && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/30 text-xs text-orange-400">
                  <AlertTriangle size={12} />
                  <span className="font-semibold">Positionnement urgent recommandé</span>
                </div>
              )}

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
            <div className="mt-3 text-[10px] text-muted-foreground opacity-50 text-center">
              Calculé à {fmtTimeSec(eventSchedule.computedAt)} ·
              GPS : {eventSchedule.userPosition.lat.toFixed(4)}, {eventSchedule.userPosition.lng.toFixed(4)} ·
              Actualisé auto toutes les 60s
            </div>
          )}
        </div>

        {/* ── Liste complète des alertes ────────────────────────────────────── */}
        {allAlerts.length > 4 && (
          <div className="px-4">
            <div className="flex items-center gap-2 mb-3">
              <Bell size={13} className="text-muted-foreground" />
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Toutes les alertes
              </h2>
            </div>
            <div className="flex flex-col gap-2">
              {allAlerts.slice(4).map((alert) => {
                const cfg = PRIORITY_CONFIG[alert.priority] || PRIORITY_CONFIG.low;
                const TypeIcon = TYPE_ICONS[alert.type] || Bell;
                return (
                  <div
                    key={alert.id}
                    className={`rounded-xl border-l-4 ${cfg.borderL} border border-border p-3 ${alert.is_read ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      <TypeIcon size={15} className={`mt-0.5 flex-shrink-0 ${cfg.textClass}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <p className="font-semibold text-xs">{alert.title}</p>
                          <span className={`text-[9px] font-bold flex-shrink-0 ${cfg.textClass}`}>{cfg.label}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground mb-1.5">{alert.message}</p>
                        <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
                          {alert.estimated_revenue && (
                            <span className="text-green-400 font-medium">~{alert.estimated_revenue}€</span>
                          )}
                          <span>Expire dans {timeLeft(alert.expires_at)}</span>
                        </div>
                      </div>
                    </div>
                    {!alert.is_read && (
                      <div className="mt-2 flex justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-xs gap-1"
                          onClick={() => markRead.mutate(alert.id)}
                          disabled={markRead.isPending}
                        >
                          <CheckCheck size={11} />Lu
                        </Button>
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
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
            <p className="text-xs font-semibold mb-3 text-primary">Stratégies clés</p>
            <div className="space-y-2 text-xs text-muted-foreground">
              {[
                ["①", "CDG/Orly — Flux arrivées", "Positionnez-vous 30min avant atterrissage. Courses 35-55€ vers Paris/La Défense."],
                ["②", "Stade de France sortie", "80 000 spec. = surge ×4. Rue Jules Rimet, 20min avant le coup de sifflet final."],
                ["③", "Villepinte / Le Bourget", "Salons pro = clients business → longues courses garanties. Tarifs 30-50€."],
                ["④", "Pointe matinale 93 (6h-9h)", "Plaine Commune, Aulnay, Tremblay vers La Défense/Paris. Ratio D/O > 2.5×."],
                ["⑤", "Nuit IDF (22h-3h)", "CDG actif 24h. Taxis rares = surge élevé. Courses 40-70€ depuis l'aéroport."],
              ].map(([num, title, desc]) => (
                <div key={num} className="flex gap-2">
                  <span className="text-amber-400 font-bold flex-shrink-0">{num}</span>
                  <span><strong>{title}</strong> — {desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
