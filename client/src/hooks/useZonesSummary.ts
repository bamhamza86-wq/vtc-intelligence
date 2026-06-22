/**
 * useZonesSummary — Hook React Query pour le résumé PredictHQ par zone
 * ─────────────────────────────────────────────────────────────────────────────
 * Appelle GET /api/predicthq/zones-summary (endpoint créé par Agent A) et
 * normalise la réponse pour l'affichage carte (heatmap de boost + indicateur
 * d'anticipation). Refetch toutes les 30s — suffisant pour la carte (les
 * coefficients backend sont recalculés toutes les 3 min).
 *
 * Résilient : si l'endpoint n'existe pas encore / clé manquante, renvoie des
 * valeurs neutres (boostByZone vide, listes vides) sans casser l'UI.
 *
 * Réponse backend attendue (souple — plusieurs formes tolérées) :
 *   {
 *     zones: [
 *       { zone_id, zone_name, phq_boost, rank, event_title, event_count,
 *         lat?, lng? }
 *     ],
 *     events?: [
 *       { id, title, zone_id, zone_name, lat, lng, rank, phq_boost|demand_boost|boost,
 *         start, is_active }
 *     ],
 *     active_count?: number,
 *     max_boost?: number,
 *     next_event?: { title, zone_id, zone_name, start, hours_until_start },
 *     fetched_at?: string
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

const ZONES_SUMMARY_INTERVAL = 30_000; // 30s — suffisant pour la carte

// ─── Types backend bruts ─────────────────────────────────────────────────────

interface RawZoneSummary {
  zone_id?: string;
  zoneId?: string;
  zone_name?: string;
  zoneName?: string;
  phq_boost?: number;
  phqBoost?: number;
  boost?: number;
  rank?: number;
  event_title?: string;
  eventTitle?: string;
  event_count?: number;
  eventCount?: number;
  lat?: number;
  lng?: number;
}

interface RawZonesSummaryEvent {
  id?: string;
  title?: string;
  name?: string;
  zone_id?: string;
  zoneId?: string;
  zone_name?: string;
  zoneName?: string;
  lat?: number;
  lng?: number;
  rank?: number;
  local_rank?: number;
  phq_boost?: number;
  demand_boost?: number;
  boost?: number;
  start?: string;
  end?: string;
  category?: string;
  is_active?: boolean;
  hours_until_start?: number;
}

interface RawNextEvent {
  id?: string;
  title?: string;
  name?: string;
  zone_id?: string;
  zone_name?: string;
  start?: string;
  hours_until_start?: number;
}

interface RawZonesSummaryResponse {
  zones?: RawZoneSummary[];
  events?: RawZonesSummaryEvent[];
  active_count?: number;
  activeCount?: number;
  max_boost?: number;
  maxBoost?: number;
  next_event?: RawNextEvent | null;
  nextEvent?: RawNextEvent | null;
  fetched_at?: string;
  fetchedAt?: string;
}

// ─── Types normalisés exposés à l'UI ──────────────────────────────────────────

export interface ZoneSummary {
  zone_id: string;
  zone_name?: string;
  phq_boost: number;
  rank?: number;
  event_title?: string;
  event_count: number;
  lat?: number;
  lng?: number;
}

export interface ZonesSummaryEvent {
  id: string;
  title: string;
  zone_id?: string;
  zone_name?: string;
  lat?: number;
  lng?: number;
  rank: number;
  boost: number;
  start?: string;
  is_active: boolean;
  hours_until_start?: number;
}

export interface NextEvent {
  id?: string;
  title: string;
  zone_id?: string;
  zone_name?: string;
  start?: string;
  hours_until_start?: number;
}

export interface UseZonesSummaryResult {
  zones: ZoneSummary[];
  /** Map zone_id → boost (≥ 1.0). Vide si aucune donnée. */
  boostByZone: Record<string, number>;
  /** Map zone_id → résumé complet (rank, titre event, etc.). */
  summaryByZone: Record<string, ZoneSummary>;
  /** Événements PredictHQ actifs, triés par boost décroissant. */
  events: ZonesSummaryEvent[];
  activeCount: number;
  maxBoost: number;
  nextEvent: NextEvent | null;
  lastUpdated: string | null;
  isLoading: boolean;
  isError: boolean;
}

function num(...vals: Array<number | undefined>): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && isFinite(v)) return v;
  }
  return undefined;
}

function str(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function normalizeNextEvent(raw: RawNextEvent | null | undefined): NextEvent | null {
  if (!raw) return null;
  const title = str(raw.title, raw.name);
  if (!title) return null;
  return {
    id: raw.id,
    title,
    zone_id: raw.zone_id,
    zone_name: raw.zone_name,
    start: raw.start,
    hours_until_start: num(raw.hours_until_start),
  };
}

export function useZonesSummary(): UseZonesSummaryResult {
  const { data, isLoading, isError } = useQuery<RawZonesSummaryResponse>({
    queryKey: ["/api/predicthq/zones-summary"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/predicthq/zones-summary");
      return res.json();
    },
    refetchInterval: ZONES_SUMMARY_INTERVAL,
    staleTime: 25_000,
    retry: 1,
  });

  const rawZones = data?.zones ?? [];
  const zones: ZoneSummary[] = rawZones
    .map((z) => {
      const zoneId = str(z.zone_id, z.zoneId);
      if (!zoneId) return null;
      return {
        zone_id: zoneId,
        zone_name: str(z.zone_name, z.zoneName),
        phq_boost: num(z.phq_boost, z.phqBoost, z.boost) ?? 1.0,
        rank: num(z.rank),
        event_title: str(z.event_title, z.eventTitle),
        event_count: num(z.event_count, z.eventCount) ?? 0,
        lat: num(z.lat),
        lng: num(z.lng),
      } as ZoneSummary;
    })
    .filter((z): z is ZoneSummary => z !== null);

  const boostByZone: Record<string, number> = {};
  const summaryByZone: Record<string, ZoneSummary> = {};
  for (const z of zones) {
    summaryByZone[z.zone_id] = z;
    if (z.phq_boost > 1.0) {
      boostByZone[z.zone_id] = Math.max(boostByZone[z.zone_id] ?? 1.0, z.phq_boost);
    }
  }

  const rawEvents = data?.events ?? [];
  const events: ZonesSummaryEvent[] = rawEvents
    .map((e) => {
      const id = str(e.id, e.title, e.name) ?? "";
      const title = str(e.title, e.name) ?? "Événement";
      return {
        id,
        title,
        zone_id: str(e.zone_id, e.zoneId),
        zone_name: str(e.zone_name, e.zoneName),
        lat: num(e.lat),
        lng: num(e.lng),
        rank: num(e.rank, e.local_rank) ?? 0,
        boost: num(e.phq_boost, e.demand_boost, e.boost) ?? 1.0,
        start: e.start,
        is_active: e.is_active ?? true,
        hours_until_start: num(e.hours_until_start),
      } as ZonesSummaryEvent;
    })
    .filter((e) => e.is_active)
    .sort((a, b) => b.boost - a.boost);

  const maxBoost =
    num(data?.max_boost, data?.maxBoost) ??
    zones.reduce((mx, z) => Math.max(mx, z.phq_boost), 1.0);

  const activeCount =
    num(data?.active_count, data?.activeCount) ??
    (events.length || zones.filter((z) => z.phq_boost > 1.0).length);

  return {
    zones,
    boostByZone,
    summaryByZone,
    events,
    activeCount,
    maxBoost,
    nextEvent: normalizeNextEvent(data?.next_event ?? data?.nextEvent),
    lastUpdated: str(data?.fetched_at, data?.fetchedAt) ?? null,
    isLoading,
    isError,
  };
}

export default useZonesSummary;
