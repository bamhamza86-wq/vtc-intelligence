import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { GpsFreshness } from "@/components/GpsFreshness";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Plane, Navigation, Clock, Euro, AlertTriangle, Zap, Star,
  CheckCheck, Crosshair, CalendarClock, TrendingUp, MapPin,
  ArrowRight, Timer, RefreshCw, ChevronRight, Wifi, WifiOff,
  Target, Flame, Activity, Calendar, BellRing, Hourglass,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import PredictionPanel from "@/components/PredictionPanel";
import { RouteSourceBadge } from "@/components/RouteSourceBadge";
import { TomTomStatusPill } from "@/components/TomTomStatusPill";
import { PredictHQBadge } from "@/components/PredictHQBadge";
import { usePredictHQSurges, type PredictHQSurge } from "@/hooks/usePredictHQ";

// ─── Événements à venir (PredictHQ, 7 jours) ────────────────────────────
function formatSurgeDay(s: PredictHQSurge): string {
  if (s.label) return s.label;
  if (!s.date) return "À venir";
  try {
    const d = new Date(s.date);
    return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  } catch {
    return s.date;
  }
}

function UpcomingEventsSection() {
  const { surges, isLoading } = usePredictHQSurges();
  const next = surges.slice(0, 3);
  if (isLoading || next.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Calendar size={14} className="text-emerald-400" />
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Événements à venir (7 jours)
        </h2>
      </div>
      <div className="space-y-2">
        {next.map((s, i) => {
          const boost = s.boost ?? s.intensity ?? 1.0;
          return (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
              <Flame size={16} className="text-emerald-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium capitalize truncate">
                  {formatSurgeDay(s)}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {s.title || "Pic de demande"}{s.zone_name ? ` — ${s.zone_name}` : ""}
                </div>
              </div>
              <PredictHQBadge boost={boost} eventTitle={s.title} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Levier 7 : Badge fiabilité modèle J-7 ────────────────────────────────
interface ModelReliability {
  window_days: number; samples: number;
  mae: number; rmse: number; bias: number;
  score_0_100: number; last_updated: string; _ts: number;
}

/**
 * Badge inline affichant le score de fiabilité du modèle sur J-7.
 * Couleur : vert ≥ 70, orange 50-70, rouge < 50. Tooltip : mae, rmse, samples.
 * Rafraîchi toutes les 60s (donnée agrégée, pas besoin du temps réel 3s).
 */
function ModelReliabilityBadge() {
  const { data } = useQuery<ModelReliability>({
    queryKey: ["/api/model/reliability"],
    queryFn: () => apiRequest("GET", "/api/model/reliability").then((r) => r.json()),
    refetchInterval: 60_000,
  });
  if (!data) return null;

  const score = data.score_0_100;
  // Code couleur : vert ≥ 70, orange 50-70, rouge < 50
  const color = score >= 70 ? "#22c55e" : score >= 50 ? "#f59e0b" : "#ef4444";
  const tooltip =
    `Fiabilité du modèle sur ${data.window_days} jours\n` +
    `MAE : ${data.mae} · RMSE : ${data.rmse} · biais : ${data.bias}\n` +
    `Échantillons : ${data.samples} pts`;

  return (
    <span
      data-testid="model-reliability-badge"
      title={tooltip}
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full cursor-help"
      style={{ background: `${color}22`, color, border: `1px solid ${color}66` }}
    >
      <Activity size={10} />
      Fiabilité modèle J-7 : {score}/100 ({data.samples} pts)
    </span>
  );
}

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
  etaMin?: number;
  distKm?: number;
  departAt?: string;
  departAtHM?: string;
}

interface TimelineEntry {
  time: string;
  timeHM: string;
  hour: number;
  type: "flight_wave" | "event_start" | "event_end" | "peak_start" | "peak_end" | "rush" | "dead_zone";
  label: string;
  zoneId: string;
  zoneName: string;
  etaMin: number;
  distKm: number;
  expectedDemand: number;
  estimatedRevenue: number;
  recommendation: string;
  priority: "critical" | "high" | "medium" | "low";
  departAt: string;
  departAtHM: string;
  flightData?: { arrivals: number; peak: string; nextWave?: string; paxVtc: number };
  isNow: boolean;
  isPast: boolean;
}

interface TopZone {
  zoneId: string;
  zoneName: string;
  score: number;
  surge: number;
  fare: number;
  etaMin: number;
  distKm: number;
}

interface RealFlight {
  callsign: string;
  airport: string;
  estimatedArrival?: string;
  origin?: string;
  paxVtc: number;
  vtcBoost: number;
}

interface SmartPlan {
  userPosition: { lat: number; lng: number };
  clickedAt: string;
  computedAt: string;
  currentHour: number;
  dayType: string;
  top4Alerts: Alert[];
  bestSlot: TimelineEntry | null;
  bestScore: number;
  timeline: TimelineEntry[];
  etaCdg: { etaMin: number; distKm: number; zone: string; name: string; distanceSource?: string };
  etaOrly: { etaMin: number; distKm: number; zone: string; name: string; distanceSource?: string };
  topZonesNow: TopZone[];
  hourlyScores: Record<string, { topZone: string; topScore: number; mean: number }>;
  realFlights: RealFlight[];
  flightSource: string;
  primarySource?: string;
}

// ─── Configs ───────────────────────────────────────────────────────────────────

const PRIORITY_CFG = {
  critical: { label: "Critique", color: "#ef4444", bg: "bg-red-500/10", border: "border-red-500/40", text: "text-red-400", dot: "bg-red-500" },
  high:     { label: "Haute",    color: "#f59e0b", bg: "bg-amber-500/10", border: "border-amber-500/40", text: "text-amber-400", dot: "bg-amber-400" },
  medium:   { label: "Moyenne",  color: "#3b82f6", bg: "bg-blue-500/10", border: "border-blue-500/40", text: "text-blue-400", dot: "bg-blue-400" },
  low:      { label: "Faible",   color: "#64748b", bg: "bg-slate-500/10", border: "border-slate-500/20", text: "text-slate-400", dot: "bg-slate-500" },
};

const TYPE_CFG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  flight_wave:  { icon: <Plane size={13} />,        color: "text-cyan-400",   label: "Vague vols" },
  peak_start:   { icon: <TrendingUp size={13} />,   color: "text-emerald-400", label: "Pic demande" },
  peak_end:     { icon: <Activity size={13} />,     color: "text-slate-400",  label: "Fin pic" },
  event_start:  { icon: <Calendar size={13} />,     color: "text-purple-400", label: "Événement" },
  event_end:    { icon: <BellRing size={13} />,     color: "text-orange-400", label: "Sortie event" },
  rush:         { icon: <Flame size={13} />,         color: "text-red-400",    label: "Rush" },
  dead_zone:    { icon: <Clock size={13} />,         color: "text-slate-500",  label: "Zone creuse" },
};

const ALERT_ICONS: Record<string, React.ReactNode> = {
  event_ending:           <CalendarClock size={15} />,
  long_ride_opportunity:  <Plane size={15} />,
  demand_spike:           <Zap size={15} />,
  weather_alert:          <AlertTriangle size={15} />,
  surge_active:           <Flame size={15} />,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  } catch { return "--:--"; }
}

function minutesUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

function countdownStr(mins: number): string {
  if (mins <= 0) return "Maintenant";
  if (mins < 60) return `dans ${mins}min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `dans ${h}h${m > 0 ? m + "min" : ""}`;
}

function peakBadge(peak: string) {
  const map: Record<string, string> = { surge: "text-red-400", high: "text-amber-400", medium: "text-emerald-400", low: "text-slate-400" };
  return <span className={`text-[10px] font-semibold uppercase tracking-wider ${map[peak] ?? "text-slate-400"}`}>{peak}</span>;
}

// ─── Sous-composants ────────────────────────────────────────────────────────────

/** Top 4 alerte en carte horizontale scrollable */
function AlertTopCard({ alert, idx }: { alert: Alert; idx: number }) {
  const cfg = PRIORITY_CFG[alert.priority];
  const icon = ALERT_ICONS[alert.type] ?? <BellRing size={15} />;
  const minsDepart = alert.departAtHM
    ? minutesUntil(alert.departAt!)
    : null;

  return (
    <div
      className={`min-w-[200px] max-w-[220px] flex-shrink-0 rounded-xl border ${cfg.border} ${cfg.bg}
        p-3 flex flex-col gap-2 snap-start cursor-default select-none`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-1">
        <div className={`flex items-center gap-1.5 ${cfg.text}`}>
          {icon}
          <span className="text-[10px] font-semibold uppercase tracking-wider">{cfg.label}</span>
        </div>
        {alert.estimated_revenue && (
          <span className="text-[11px] font-bold text-emerald-400">+{alert.estimated_revenue}€</span>
        )}
      </div>
      {/* Titre */}
      <p className="text-[12px] font-semibold text-foreground leading-tight line-clamp-2">
        {alert.title}
      </p>
      {/* ETA GPS */}
      {alert.departAtHM && (
        <div className="flex items-center gap-1 mt-auto">
          <Navigation size={11} className="text-cyan-400 shrink-0" />
          <span className="text-[11px] text-cyan-300 font-medium">
            Partir à {alert.departAtHM}
          </span>
          {minsDepart !== null && (
            <span className={`text-[10px] ml-auto ${minsDepart <= 10 ? "text-red-400 font-bold" : "text-muted-foreground"}`}>
              {countdownStr(minsDepart)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Créneau optimal — bloc hero */
function BestSlotHero({ slot, score }: { slot: TimelineEntry; score: number }) {
  const cfg = PRIORITY_CFG[slot.priority];
  const typeCfg = TYPE_CFG[slot.type] ?? TYPE_CFG.peak_start;
  const minsDepart = minutesUntil(slot.departAt);
  const isFlight = slot.type === "flight_wave" || slot.type === "peak_start";

  return (
    <div className={`rounded-2xl border-2 ${cfg.border} bg-gradient-to-br from-background to-${cfg.bg} p-4 space-y-3`}>
      {/* Badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${cfg.dot} animate-pulse`} />
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Créneau Optimal
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Star size={12} className="text-amber-400" />
          <span className="text-[11px] font-bold text-amber-400">Score {score.toFixed(0)}</span>
        </div>
      </div>

      {/* Zone + heure */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className={`text-xl font-bold ${cfg.text}`}>{slot.timeHM}</p>
          <p className="text-sm font-semibold text-foreground leading-tight mt-0.5">{slot.zoneName}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
            <span className={typeCfg.color}>{typeCfg.icon}</span>
            {slot.label}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-lg font-bold text-emerald-400">~{slot.estimatedRevenue}€<span className="text-xs font-normal text-muted-foreground">/h</span></p>
          <p className="text-[11px] text-muted-foreground">{slot.distKm}km · {slot.etaMin}min</p>
        </div>
      </div>

      {/* Départ recommandé */}
      <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-3 space-y-1.5`}>
        <div className="flex items-center gap-2">
          <Navigation size={14} className="text-cyan-400 shrink-0" />
          <span className="text-[12px] font-semibold text-cyan-300">Heure de départ recommandée</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-2xl font-black text-foreground">{slot.departAtHM}</span>
          <span className={`text-sm font-bold ${minsDepart <= 0 ? "text-red-400" : minsDepart <= 15 ? "text-red-400 animate-pulse" : minsDepart <= 30 ? "text-amber-400" : "text-emerald-400"}`}>
            {countdownStr(minsDepart)}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">{slot.recommendation}</p>
      </div>

      {/* Données vols temps réel */}
      {slot.flightData && (
        <div className="flex items-center gap-3 pt-1 border-t border-border/30">
          <Plane size={12} className="text-cyan-400" />
          <span className="text-[11px] text-muted-foreground">
            {slot.flightData.arrivals} arrivées · {slot.flightData.paxVtc} pax VTC ·
          </span>
          {peakBadge(slot.flightData.peak)}
        </div>
      )}
    </div>
  );
}

/** Ligne timeline */
function TimelineRow({ entry, isFirst }: { entry: TimelineEntry; isFirst?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = PRIORITY_CFG[entry.priority];
  const typeCfg = TYPE_CFG[entry.type] ?? TYPE_CFG.peak_start;
  const minsDepart = minutesUntil(entry.departAt);
  const isFuture = !entry.isPast;
  const isUrgent = minsDepart >= 0 && minsDepart <= 20;

  return (
    <div
      className={`relative flex gap-3 ${entry.isPast ? "opacity-40" : ""}`}
      onClick={() => isFuture && setExpanded(v => !v)}
    >
      {/* Ligne verticale + dot */}
      <div className="flex flex-col items-center">
        <div className={`w-3 h-3 rounded-full border-2 mt-1 shrink-0 z-10
          ${entry.isNow ? `${cfg.dot} border-white animate-pulse shadow-lg` : `border-border bg-background`}`} />
        <div className="w-px flex-1 bg-border/40 mt-1" />
      </div>

      {/* Contenu */}
      <div className={`flex-1 pb-4 ${isFuture ? "cursor-pointer" : ""}`}>
        <div className={`rounded-xl border ${isFuture ? cfg.border : "border-border/30"} 
          ${isFuture ? cfg.bg : "bg-muted/20"} p-3 space-y-2`}>
          {/* Header row */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-bold text-foreground shrink-0">{entry.timeHM}</span>
              <span className={`text-[10px] font-semibold ${typeCfg.color} flex items-center gap-1`}>
                {typeCfg.icon}{typeCfg.label}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {isFuture && (
                <span className="text-[11px] font-bold text-emerald-400">~{entry.estimatedRevenue}€/h</span>
              )}
              {isUrgent && <span className="text-[10px] text-red-400 font-bold animate-pulse">URGENT</span>}
            </div>
          </div>

          {/* Label + zone */}
          <p className="text-[12px] font-medium text-foreground leading-snug">{entry.label}</p>

          {/* Départ (uniquement si futur) */}
          {isFuture && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Navigation size={11} className="text-cyan-400 shrink-0" />
                <span className="text-[11px] text-cyan-300 font-semibold">
                  Partir {entry.departAtHM}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  · ETA {entry.etaMin}min · {entry.distKm}km
                </span>
              </div>
              <span className={`text-[10px] font-medium ${minsDepart <= 0 ? "text-red-400" : minsDepart <= 30 ? "text-amber-400" : "text-slate-400"}`}>
                {countdownStr(minsDepart)}
              </span>
            </div>
          )}

          {/* Détail expandable */}
          {isFuture && expanded && (
            <div className="pt-2 border-t border-border/30 space-y-2">
              <p className="text-[11px] text-muted-foreground leading-relaxed">{entry.recommendation}</p>
              {entry.flightData && (
                <div className="flex items-center gap-2 text-[11px]">
                  <Plane size={11} className="text-cyan-400" />
                  <span className="text-muted-foreground">
                    {entry.flightData.arrivals} arrivées · {entry.flightData.paxVtc} passagers VTC · Pic: 
                  </span>
                  {peakBadge(entry.flightData.peak)}
                </div>
              )}
              {entry.flightData?.nextWave && (
                <div className="flex items-center gap-1 text-[11px] text-purple-400">
                  <Timer size={11} />
                  <span>Prochaine vague : {formatTime(entry.flightData.nextWave)}</span>
                </div>
              )}
            </div>
          )}

          {/* Chevron expand */}
          {isFuture && (
            <div className={`flex justify-end text-muted-foreground/50 transition-transform ${expanded ? "rotate-90" : ""}`}>
              <ChevronRight size={14} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Carte zone actuelle */
function ZoneCard({ zone }: { zone: TopZone }) {
  const score = zone.score;
  const color = score >= 70 ? "text-emerald-400" : score >= 45 ? "text-amber-400" : "text-slate-400";
  const bar = score >= 70 ? "bg-emerald-500" : score >= 45 ? "bg-amber-500" : "bg-slate-500";

  return (
    <div className="flex-shrink-0 w-[130px] rounded-xl border border-border/40 bg-muted/30 p-2.5 snap-start">
      <p className="text-[11px] font-semibold text-foreground leading-tight line-clamp-2 mb-1.5">
        {zone.zoneName.replace(" — ", "\n")}
      </p>
      <div className="flex items-center justify-between mb-1">
        <span className={`text-sm font-black ${color}`}>{score.toFixed(0)}</span>
        <span className="text-[10px] text-muted-foreground">{zone.etaMin}min</span>
      </div>
      <div className="h-1 bg-border/30 rounded-full overflow-hidden">
        <div className={`h-full ${bar} rounded-full`} style={{ width: `${score}%` }} />
      </div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-muted-foreground">{zone.fare.toFixed(0)}€ moy</span>
        <span className="text-[10px] text-amber-400">×{zone.surge.toFixed(1)}</span>
      </div>
    </div>
  );
}

/** Heatmap rentabilité horaire */
function HourlyHeatmap({ scores, currentHour }: { scores: Record<string, { topZone: string; topScore: number; mean: number }>; currentHour: number }) {
  const hours = Object.keys(scores).map(Number).sort((a, b) => a - b);
  const maxMean = Math.max(...hours.map(h => scores[h]?.mean ?? 0), 1);

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
        Rentabilité horaire (aujourd'hui)
      </p>
      <div className="flex gap-1 overflow-x-auto pb-1 snap-x">
        {hours.map(h => {
          const sc = scores[h];
          if (!sc) return null;
          const ratio = sc.mean / maxMean;
          const isNow = h === currentHour;
          const color = sc.mean >= 60 ? "bg-emerald-500" : sc.mean >= 40 ? "bg-amber-500" : sc.mean >= 25 ? "bg-blue-500" : "bg-slate-600";
          return (
            <div key={h} className={`flex-shrink-0 w-9 flex flex-col items-center gap-0.5 snap-start
              ${isNow ? "ring-1 ring-white/30 rounded-lg" : ""}`}>
              <div className="w-full h-10 flex items-end rounded-t overflow-hidden bg-border/20">
                <div className={`w-full ${color} rounded-t transition-all`} style={{ height: `${Math.max(10, ratio * 100)}%` }} />
              </div>
              <span className={`text-[9px] font-bold ${isNow ? "text-white" : "text-muted-foreground"}`}>{h}h</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Page principale ────────────────────────────────────────────────────────────

// ─── THÈME 6 : Optimiseur temps mort ────────────────────────────────────────
interface IdleReco {
  zone_id: string;
  zone_name: string;
  lat: number;
  lng: number;
  score_now: number;
  score_next_hour: number;
  avg_score: number;
  eta_min: number;
  repo_cost_min: number;
  net_score: number;
  action: string;
  reason: string;
  distance_source?: string;
}

function IdleOptimizer({ position }: { position: { lat: number; lng: number } }) {
  const { data } = useQuery<{ recommendations: IdleReco[] }>({
    queryKey: ["/api/idle-optimizer", position.lat, position.lng],
    queryFn: () => apiRequest("GET", `/api/idle-optimizer?lat=${position.lat}&lng=${position.lng}`).then(r => r.json()),
    refetchInterval: 3_000,
  });
  const { data: profile } = useQuery<any>({
    queryKey: ["/api/driver-profile"],
    queryFn: () => apiRequest("GET", "/api/driver-profile").then(r => r.json()),
    refetchInterval: 3_000,
  });

  let preferred: string[] = [];
  try { preferred = Array.isArray(profile?.preferred_zones) ? profile.preferred_zones : JSON.parse(profile?.preferred_zones ?? "[]"); } catch { preferred = []; }
  const workStart = profile?.work_hours_start ?? 0;
  const workEnd = profile?.work_hours_end ?? 24;
  const avoidHighway = Boolean(profile?.avoid_highway);
  const curHour = new Date().getHours();
  const outsideHours = curHour < workStart || curHour >= workEnd;

  const recos = (data?.recommendations ?? []).slice(0, 3);
  if (recos.length === 0) return null;

  // zones autoroutières (aéroports/expo accessibles par A1/A86/A104)
  const HIGHWAY_ZONES = ["z_cdg", "z_orly", "z_villepinte", "z_tremblay", "z_le_bourget", "z_aulnay"];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Hourglass size={14} className="text-violet-400" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Optimiseur temps mort
        </span>
        {outsideHours && (
          <Badge variant="outline" className="text-[9px] text-muted-foreground ml-auto">Hors plage de travail</Badge>
        )}
      </div>
      <div className="space-y-2">
        {recos.map(r => {
          const isPreferred = preferred.includes(r.zone_id);
          const usesHighway = avoidHighway && HIGHWAY_ZONES.includes(r.zone_id);
          return (
          <div key={r.zone_id} className={`rounded-xl border p-3 space-y-1.5 ${isPreferred ? "border-teal-400 bg-teal-500/10" : "border-violet-500/20 bg-violet-500/5"} ${outsideHours ? "opacity-50" : ""}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold truncate flex items-center gap-1.5">
                {r.zone_name}
                {isPreferred && <Star size={12} className="text-teal-400 fill-teal-400" />}
              </span>
              <Badge className="bg-violet-600 text-white text-xs">Score {r.avg_score}</Badge>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><Timer size={11} />{r.eta_min} min</span>
              <span className="flex items-center gap-1"><TrendingUp size={11} />{r.score_now}→{r.score_next_hour}</span>
              <RouteSourceBadge source={r.distance_source} className="ml-auto" />
            </div>
            <p className="text-[11px] text-foreground">{r.action}</p>
            <p className="text-[10px] text-muted-foreground">{r.reason}</p>
            {usesHighway && (
              <p className="text-[10px] text-amber-400 flex items-center gap-1"><AlertTriangle size={10} />Itinéraire autoroutier (vous préférez les éviter)</p>
            )}
            <Button
              size="sm"
              className="w-full h-9 mt-1 bg-violet-600 hover:bg-violet-500 text-white"
              onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`, "_blank")}
            >
              <Navigation size={14} className="mr-1.5" />Y aller
            </Button>
          </div>
          );
        })}
      </div>
    </div>
  );
}

export default function SmartPlanPage() {
  // ── GPS temps réel (hook global — position toujours fraîche + fallback Bd Ney) ──
  const { position, status: gpsStatus, isFallback, lastUpdatedAt, error: gpsError } = useGpsPosition();
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const lastFetchTs = useRef<number>(0);

  // Référence toujours à jour vers la dernière position du hook : garantit qu'un
  // fetch utilise la position FRAÎCHE au moment de l'appel (jamais celle du montage).
  const positionRef = useRef(position);
  useEffect(() => { positionRef.current = position; }, [position.lat, position.lng]);

  // ── Mutation smart-plan ────────────────────────────────────────────────────
  const mutation = useMutation<SmartPlan, Error, { lat: number; lng: number; clickedAt: string }>({
    mutationFn: body => apiRequest("POST", "/api/smart-plan", body).then(r => r.json()),
  });

  // fetchPlan lit TOUJOURS la position courante du hook (via positionRef) au moment
  // de l'appel — jamais une position mise en cache au montage.
  const fetchPlan = useCallback((force = false) => {
    const now = Date.now();
    if (!force && now - lastFetchTs.current < 30000) return; // throttle 30s
    lastFetchTs.current = now;
    const pos = positionRef.current;
    const clickedAt = new Date().toISOString();
    setLastFetchedAt(clickedAt);
    mutation.mutate({ lat: pos.lat, lng: pos.lng, clickedAt });
  }, [mutation]);

  // Auto-fetch dès GPS disponible / quand la position change
  useEffect(() => {
    if (!mutation.data && !mutation.isPending) {
      fetchPlan();
    }
  }, [position.lat, position.lng]);

  // Rafraîchissement temps réel : on tente un refetch toutes les 3s.
  // Le throttle interne de fetchPlan (30s) protège l'API ; ce tick garantit
  // que les données trafic/ETA restent fraîches sans intervention manuelle.
  useEffect(() => {
    const id = setInterval(() => fetchPlan(), 3000);
    return () => clearInterval(id);
  }, [fetchPlan]);

  const plan = mutation.data;
  const isLoading = mutation.isPending;
  const error = mutation.error;

  // Sections désactivées (conservées pour réactivation future). Type `boolean`
  // (et non littéral `false`) pour que le narrowing des gardes `&& plan` s'applique.
  const SHOW_LEGACY_SECTIONS: boolean = false;

  // ── Rendu ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground pb-24">

      {/* ── Header ── */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border/50 px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Target size={18} className="text-cyan-400" />
          <span className="text-sm font-bold">Smart Planning</span>
          {/* Levier 7 — Badge fiabilité modèle J-7 */}
          <ModelReliabilityBadge />
        </div>
        <div className="flex items-center gap-2">
          {/* Rappel état routage TomTom en haut de page */}
          <TomTomStatusPill />
          <GpsFreshness lastUpdatedAt={lastUpdatedAt} isFallback={isFallback} />
          {plan && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="text-muted-foreground">Données trafic :</span>
              <RouteSourceBadge source={plan.primarySource} size="xs" />
            </div>
          )}
          {plan && (
            <div className="text-[10px] text-muted-foreground">
              {plan.flightSource === "opensky" ? (
                <span className="text-cyan-400 flex items-center gap-0.5"><Wifi size={9} />Live</span>
              ) : (
                <span className="text-muted-foreground">Heuristique</span>
              )}
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={isLoading}
            onClick={() => fetchPlan(true)}
          >
            <RefreshCw size={12} className={isLoading ? "animate-spin" : ""} />
            {isLoading ? "Calcul…" : "Actualiser"}
          </Button>
        </div>
      </div>

      {/* ── Erreur GPS (fallback Bd Ney conservé) ── */}
      {(gpsError || isFallback) && gpsStatus !== "pending" && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 text-[11px] flex items-center gap-1.5">
          <AlertTriangle size={12} />
          <span>{gpsError ?? "GPS indisponible — position par défaut (Bd Ney) utilisée"}</span>
        </div>
      )}

      {/* ── THÈME 1 & 6 : Prédiction IA + Optimiseur temps mort (toujours visibles) ── */}
      <div className="px-4 pt-4 space-y-5">
        <PredictionPanel />
        <UpcomingEventsSection />
        <IdleOptimizer position={position} />
      </div>

      {/* ── Loading skeleton ── */}
      {isLoading && (
        <div className="px-4 py-4 space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <div className="flex gap-3 overflow-hidden">
              {[0,1,2,3].map(i => <Skeleton key={i} className="h-28 w-52 shrink-0 rounded-xl" />)}
            </div>
          </div>
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-24 rounded-xl" />
          <div className="space-y-3">
            {[0,1,2,3,4].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
        </div>
      )}

      {/* ── Erreur API ── */}
      {error && !isLoading && (
        <div className="mx-4 mt-4 p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
          Erreur : {error.message}
        </div>
      )}

      {/* ── Pas encore de plan ── */}
      {!plan && !isLoading && !error && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center py-16">
          <div className="w-16 h-16 rounded-full bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center">
            <Target size={28} className="text-cyan-400" />
          </div>
          <div>
            <p className="font-semibold text-foreground">Planification intelligente</p>
            <p className="text-sm text-muted-foreground mt-1">
              Croise vols CDG/Orly temps réel, alertes prioritaires et position GPS pour calculer votre créneau optimal.
            </p>
          </div>
          <Button
            className="mt-2 bg-cyan-600 hover:bg-cyan-500 text-white"
            disabled={isLoading}
            onClick={() => fetchPlan(true)}
          >
            <Crosshair size={16} className="mr-2" />
            Calculer mon plan
          </Button>
        </div>
      )}

      {/* ── CONTENU PRINCIPAL ── */}
      {plan && !isLoading && (
        <div className="px-4 py-4 space-y-5">

          {/* ── SECTION 1 : TOP 4 ALERTES HORIZONTALES ── */}
          {plan.top4Alerts.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <BellRing size={14} className="text-red-400" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Alertes prioritaires ({plan.top4Alerts.length})
                </span>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-2 snap-x -mx-1 px-1">
                {plan.top4Alerts.map((a, i) => (
                  <AlertTopCard key={a.id} alert={a} idx={i} />
                ))}
              </div>
            </div>
          )}

          {/* ── SECTION 2 : CRÉNEAU OPTIMAL ── */}
          {plan.bestSlot && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Star size={14} className="text-amber-400" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Meilleure opportunité maintenant
                </span>
              </div>
              <BestSlotHero slot={plan.bestSlot} score={plan.bestScore} />
            </div>
          )}

          {/* ── SECTION 3 : ETA Aéroports + Vols temps réel ── (DÉSACTIVÉE — redondant avec onglet Trajet ; conservée pour réactivation future) */}
          {SHOW_LEGACY_SECTIONS && plan && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Plane size={14} className="text-cyan-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                Aéroports — position actuelle
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[plan.etaCdg, plan.etaOrly].map(ap => (
                <div key={ap.zone} className="rounded-xl border border-border/40 bg-muted/20 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Plane size={12} className="text-cyan-400" />
                    <span className="text-[11px] font-bold text-foreground">{ap.name.split(" — ")[0]}</span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-lg font-black text-cyan-400">{ap.etaMin}min</span>
                    <span className="text-[11px] text-muted-foreground">{ap.distKm}km</span>
                    <RouteSourceBadge source={ap.distanceSource ?? plan.primarySource} size="xs" className="ml-auto" />
                  </div>
                  {/* Vols temps réel pour cet aéroport */}
                  {plan.realFlights.filter(f => f.airport === ap.zone.replace("z_", "").toUpperCase()).slice(0, 2).map(f => (
                    <div key={f.callsign} className="flex items-center gap-1 text-[10px]">
                      <span className="text-cyan-300 font-mono">{f.callsign}</span>
                      {f.estimatedArrival && (
                        <span className="text-muted-foreground">→ {formatTime(f.estimatedArrival)}</span>
                      )}
                      <span className="text-emerald-400 ml-auto">{f.paxVtc} VTC</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          )}

          {/* ── SECTION 4 : TOP ZONES MAINTENANT ── (DÉSACTIVÉE — redondant avec la Carte ; conservée pour réactivation future) */}
          {SHOW_LEGACY_SECTIONS && plan && plan.topZonesNow.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <MapPin size={14} className="text-emerald-400" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Zones rentables maintenant
                </span>
                <span className="text-[10px] text-muted-foreground ml-1">{plan.currentHour}h{new Date().getMinutes().toString().padStart(2,"0")}</span>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1 snap-x">
                {plan.topZonesNow.map(z => <ZoneCard key={z.zoneId} zone={z} />)}
              </div>
            </div>
          )}

          {/* ── SECTION 5 : HEATMAP HORAIRE ── */}
          {Object.keys(plan.hourlyScores).length > 0 && (
            <HourlyHeatmap scores={plan.hourlyScores} currentHour={plan.currentHour} />
          )}

          {/* ── SECTION 6 : CHRONOLOGIE JOURNÉE ── */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CalendarClock size={14} className="text-purple-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                Chronologie de la journée
              </span>
              <span className="text-[10px] text-muted-foreground">
                ({plan.timeline.filter(t => !t.isPast).length} créneaux à venir)
              </span>
            </div>
            <div className="relative">
              {(() => {
                const upcomingSlots = plan.timeline
                  .filter(t => !t.isPast)
                  .slice(0, 5);
                const remaining = plan.timeline.filter(t => !t.isPast).length - 5;
                return (
                  <>
                    {upcomingSlots.map((entry, i) => (
                      <TimelineRow key={`${entry.time}_${entry.zoneId}_${i}`} entry={entry} isFirst={i === 0} />
                    ))}
                    {remaining > 0 && (
                      <p className="text-xs text-muted-foreground text-center py-2">
                        + {remaining} créneaux à venir
                      </p>
                    )}
                  </>
                );
              })()}
              {plan.timeline.filter(t => !t.isPast).length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">
                  Aucun créneau identifié pour la journée.
                </p>
              )}
            </div>
          </div>

          {/* ── Footer ── */}
          {lastFetchedAt && (
            <div className="flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground py-2">
              <Clock size={10} />
              <span>Calculé à {formatTime(lastFetchedAt)}</span>
              {plan.userPosition && (
                <span className="ml-2">
                  · GPS {plan.userPosition.lat.toFixed(4)}, {plan.userPosition.lng.toFixed(4)}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
