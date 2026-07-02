/**
 * usePredictHQ — Hooks React Query pour les données PredictHQ
 * ─────────────────────────────────────────────────────────────────────────────
 * Récupère en quasi temps réel les événements PredictHQ et leur impact (boost)
 * sur la demande par zone. Tous les hooks sont résilients : si l'API n'est pas
 * disponible (clé manquante, endpoint absent), ils renvoient des valeurs neutres
 * sans casser l'UI.
 *
 * Endpoints backend (server/routes.ts) :
 *   GET /api/predicthq/events        → { events:[{...demand_boost, is_active}], active_count, fetched_at }
 *   GET /api/predicthq/status        → { connected, has_key, active_events, max_boost, last_fetch }
 *   GET /api/predicthq/surges        → { surges:[{ date, intensity, phq_attendance_sum }] }
 *   GET /api/predicthq/boost-preview → { hour, boostByZone }
 *
 *   usePredictHQ()             → events[], boostByZone, isConnected, activeEventCount
 *   usePredictHQSurges()       → surges[] (pics à venir, 7 jours)
 *   usePredictHQBoostPreview() → boostByZone pour une heure donnée
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { classifyEventProximity, PROXIMITY_SORT_ORDER } from "@/lib/eventProximity";
import type { EventProximity } from "@/lib/eventProximity";

export type { EventProximity };

// ─── Types backend bruts ─────────────────────────────────────────────────────

interface RawPredictHQEvent {
  id: string;
  title: string;
  category?: string;
  start?: string;
  end?: string;
  rank?: number;
  local_rank?: number;
  phq_attendance?: number;
  lat?: number;
  lng?: number;
  zone_id?: string;
  zone_name?: string;
  demand_boost?: number;
  is_active?: boolean;
  hours_until_start?: number;
}

interface RawEventsResponse {
  events?: RawPredictHQEvent[];
  total?: number;
  active_count?: number;
  fetched_at?: string;
}

interface RawStatusResponse {
  status?: "connected" | "disconnected" | "no_key";
  connected?: boolean;
  has_key?: boolean;
  active_events?: number;
  max_boost?: number;
  last_fetch?: string | null;
  cache_age_seconds?: number | null;
  error?: string | null;
}

type SurgeIntensity = "low" | "medium" | "high" | "extreme";

interface RawSurge {
  date: string;
  phq_attendance_sum?: number;
  intensity?: SurgeIntensity;
}

interface RawSurgesResponse {
  surges?: RawSurge[];
}

// ─── Types normalisés exposés à l'UI ──────────────────────────────────────────

export interface PredictHQEvent {
  id: string;
  title: string;
  category?: string;
  zone_id?: string;
  zone_name?: string;
  start?: string;
  end?: string;
  boost?: number;          // ← demand_boost normalisé
  rank?: number;
  attendance?: number;
  is_active?: boolean;
  /** Minutes signées avant le début (start). Négatif = déjà commencé. null si pas de start. */
  minutesUntilStart?: number | null;
  /** Classe de proximité horaire pour le code couleur UI. */
  proximity?: EventProximity;
  /** Libellé court prêt à afficher : « dans 42 min », « 18:30 », « en cours ». */
  timeLabel?: string;
}

export interface PredictHQSurge {
  date: string;            // ISO
  label?: string;          // "mercredi 25 juin"
  title?: string;          // ex: "Pic extrême — 120k attendus"
  zone_name?: string;
  boost?: number;          // intensité convertie en multiplicateur
  intensity?: SurgeIntensity;
  attendance?: number;
}

const REALTIME = 3_000;          // 3s — quasi temps réel
const SURGES_INTERVAL = 60_000;  // 1 min

/** Enrichit un événement avec proximity/minutesUntilStart/timeLabel selon l'horloge locale. */
function enrichEventProximity(ev: PredictHQEvent, now: Date): PredictHQEvent {
  const info = classifyEventProximity(ev.start, ev.end, now);
  return { ...ev, ...info };
}

// ─── Conversion intensité surge → boost approximatif ──────────────────────────
function intensityToBoost(intensity?: SurgeIntensity): number {
  switch (intensity) {
    case "extreme": return 2.2;
    case "high":    return 1.8;
    case "medium":  return 1.4;
    case "low":     return 1.15;
    default:        return 1.0;
  }
}

function surgeTitle(s: RawSurge): string {
  const att = s.phq_attendance_sum ?? 0;
  const lbl: Record<SurgeIntensity, string> = {
    extreme: "Pic extrême",
    high: "Forte demande",
    medium: "Demande élevée",
    low: "Demande modérée",
  };
  const base = lbl[(s.intensity ?? "low") as SurgeIntensity];
  return att > 0 ? `${base} — ${Math.round(att / 1000)}k attendus` : base;
}

function formatDayLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  } catch {
    return iso;
  }
}

// ─── usePredictHQ ──────────────────────────────────────────────────────────────

export interface UsePredictHQResult {
  events: PredictHQEvent[];
  boostByZone: Record<string, number>;
  isConnected: boolean;
  activeEventCount: number;
  lastUpdated: string | null;
  hasKey: boolean;
  maxBoost: number;
  isLoading: boolean;
  isError: boolean;
}

/** Options du hook usePredictHQ. */
export interface UsePredictHQOptions {
  /** Si true (défaut), ne renvoie que les événements du jour courant (calendaire local). */
  todayOnly?: boolean;
  /** Si true, garde aussi les events qui déjà passés dans la journée. Défaut : false (on filtre les past). */
  includePast?: boolean;
}

export function usePredictHQ(options: UsePredictHQOptions = {}): UsePredictHQResult {
  const { todayOnly = true, includePast = false } = options;

  const eventsQ = useQuery<RawEventsResponse>({
    queryKey: ["/api/predicthq/events"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/predicthq/events");
      return res.json();
    },
    refetchInterval: REALTIME,
    staleTime: 2_500,
    retry: 1,
  });

  const statusQ = useQuery<RawStatusResponse>({
    queryKey: ["/api/predicthq/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/predicthq/status");
      return res.json();
    },
    refetchInterval: REALTIME,
    staleTime: 2_500,
    retry: 1,
  });

  // Tick d'horloge : force un re-render toutes les 30 s pour que les libellés
  // « dans N min » et les seuils de proximité (rouge/orange) restent à jour
  // même en l'absence de nouveau fetch (l'API PredictHQ ne bouge qu'à l'heure).
  const [clockTick, setClockTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClockTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const now = new Date(clockTick);
  const rawEvents = eventsQ.data?.events ?? [];
  const baseEvents: PredictHQEvent[] = rawEvents.map((e) => ({
    id: e.id,
    title: e.title,
    category: e.category,
    zone_id: e.zone_id,
    zone_name: e.zone_name,
    start: e.start,
    end: e.end,
    boost: e.demand_boost ?? 1.0,
    rank: e.rank,
    attendance: e.phq_attendance,
    is_active: e.is_active,
  }));

  // Enrichissement proximité + filtrage jour courant.
  const enriched = baseEvents.map((e) => enrichEventProximity(e, now));
  let events = enriched;
  if (todayOnly) {
    events = events.filter((e) => e.proximity !== "future" && (includePast || e.proximity !== "past"));
  } else if (!includePast) {
    events = events.filter((e) => e.proximity !== "past");
  }
  // Tri : les plus imminents d'abord, puis par boost décroissant.
  events.sort((a, b) => {
    const pa = PROXIMITY_SORT_ORDER[a.proximity ?? "future"];
    const pb = PROXIMITY_SORT_ORDER[b.proximity ?? "future"];
    if (pa !== pb) return pa - pb;
    return (b.boost ?? 1) - (a.boost ?? 1);
  });

  // Le boostByZone reste calculé sur les events retenus (jour courant) → la
  // heatmap ne colorie plus des zones sur la base d'un event de demain.
  const boostByZone = deriveBoostFromEvents(events);
  const status = statusQ.data;
  const isConnected = status?.connected ?? status?.status === "connected" ?? false;
  // active_event_count reflète désormais les events du jour courant (cohérent avec la liste affichée).
  const activeEventCount = events.filter((e) => (e.boost ?? 1) > 1.0 || e.proximity === "imminent").length;

  return {
    events,
    boostByZone,
    isConnected,
    activeEventCount,
    lastUpdated: status?.last_fetch ?? eventsQ.data?.fetched_at ?? null,
    hasKey: status?.has_key ?? isConnected,
    maxBoost: status?.max_boost ?? 1.0,
    isLoading: eventsQ.isLoading || statusQ.isLoading,
    isError: eventsQ.isError,
  };
}

// ─── usePredictHQSurges ─────────────────────────────────────────────────────────

export function usePredictHQSurges() {
  const { data, isLoading, isError } = useQuery<RawSurgesResponse>({
    queryKey: ["/api/predicthq/surges"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/predicthq/surges");
      return res.json();
    },
    refetchInterval: SURGES_INTERVAL,
    staleTime: 30_000,
    retry: 1,
  });

  const surges: PredictHQSurge[] = (data?.surges ?? [])
    .map((s) => ({
      date: s.date,
      label: formatDayLabel(s.date),
      title: surgeTitle(s),
      boost: intensityToBoost(s.intensity),
      intensity: s.intensity,
      attendance: s.phq_attendance_sum,
    }))
    .sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return da - db;
    });

  return { surges, isLoading, isError };
}

// ─── usePredictHQBoostPreview ────────────────────────────────────────────────────

interface RawBoostPreview {
  hour?: number;
  boostByZone?: Record<string, number>;
}

export function usePredictHQBoostPreview(hour: number) {
  const { data, isLoading, isError } = useQuery<RawBoostPreview>({
    queryKey: ["/api/predicthq/boost-preview", String(hour)],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/predicthq/boost-preview?hour=${hour}`);
      return res.json();
    },
    refetchInterval: REALTIME,
    staleTime: 2_500,
    retry: 1,
    enabled: hour >= 0 && hour <= 23,
  });

  return {
    boostByZone: data?.boostByZone ?? {},
    isLoading,
    isError,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Construit une map zone→boost (boost max par zone parmi les events actifs). */
function deriveBoostFromEvents(events: PredictHQEvent[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const e of events) {
    const zid = e.zone_id;
    const boost = e.boost ?? 1.0;
    if (!zid || boost <= 1.0) continue;
    map[zid] = Math.max(map[zid] ?? 1.0, boost);
  }
  return map;
}
