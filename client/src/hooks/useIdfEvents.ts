/**
 * useIdfEvents — Hooks React Query pour le calendrier IDF, les perturbations
 * transport, les points de dépose et la prévision de demande post-événement.
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoints backend (server/airportEngine.ts) :
 *   GET /api/events/idf-calendar?days=7      → { events:[...] }
 *   GET /api/transport/disruptions?zone_id=  → { disruptions:[...] }
 *   GET /api/events/dropoff-point?venue_key=&salle= → { lat,lng,side,notes_fr,... }
 *   GET /api/events/post-demand?event_id=    → { peak_min_after_end, expected_burst, best_zones }
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface IdfCalendarEntry {
  source: "predicthq" | "recurrent";
  key: string;
  name: string;
  venue_key: string | null;
  zone_id: string;
  event_type: string;
  start_time: string;
  end_time: string;
  expected_attendance: number;
  demand_boost: number;
  impact_level: "faible" | "modere" | "eleve" | "extreme";
}

const CALENDAR_INTERVAL = 60_000; // 1 min — données peu volatiles
const DISRUPTIONS_INTERVAL = 15_000; // 15s — plus réactif (alerte grève)

export function useIdfCalendar(days = 7) {
  const { data, isLoading, isError } = useQuery<{ events: IdfCalendarEntry[]; count: number }>({
    queryKey: ["/api/events/idf-calendar", String(days)],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/events/idf-calendar?days=${days}`);
      return res.json();
    },
    refetchInterval: CALENDAR_INTERVAL,
    staleTime: 30_000,
    retry: 1,
  });

  const events = (data?.events ?? []).slice().sort((a, b) => b.demand_boost - a.demand_boost);
  const top5 = events.slice(0, 5);

  return { events: data?.events ?? [], top5, isLoading, isError };
}

export interface TransitDisruption {
  id: number;
  source: "RATP" | "SNCF" | "IDFM";
  line_or_service: string;
  severity: "mineure" | "moderee" | "majeure";
  impact_desc: string;
  zone_id: string | null;
  active_from: string;
  active_until: string | null;
}

export function useTransitDisruptions(zoneId?: string) {
  const { data, isLoading, isError } = useQuery<{ disruptions: TransitDisruption[] }>({
    queryKey: zoneId ? ["/api/transport/disruptions", zoneId] : ["/api/transport/disruptions"],
    queryFn: async () => {
      const url = zoneId ? `/api/transport/disruptions?zone_id=${encodeURIComponent(zoneId)}` : "/api/transport/disruptions";
      const res = await apiRequest("GET", url);
      return res.json();
    },
    refetchInterval: DISRUPTIONS_INTERVAL,
    staleTime: 5_000,
    retry: 1,
  });

  const disruptions = data?.disruptions ?? [];
  return { disruptions, hasActive: disruptions.length > 0, isLoading, isError };
}

export interface DropoffPoint {
  lat: number;
  lng: number;
  side: string;
  notes_fr: string;
  walking_distance_m: number;
  salle_name: string;
}

export function useDropoffPoint(venueKey: string | null, salle?: string) {
  const { data, isLoading, isError } = useQuery<DropoffPoint>({
    queryKey: venueKey ? ["/api/events/dropoff-point", venueKey, salle || ""] : ["/api/events/dropoff-point", "none"],
    queryFn: async () => {
      const params = new URLSearchParams({ venue_key: venueKey || "" });
      if (salle) params.set("salle", salle);
      const res = await apiRequest("GET", `/api/events/dropoff-point?${params.toString()}`);
      return res.json();
    },
    enabled: !!venueKey,
    staleTime: 60_000,
    retry: 1,
  });

  return { point: data ?? null, isLoading, isError };
}

export interface PostEventDemand {
  event_id: string;
  event_name: string;
  peak_min_after_end: number;
  expected_burst: string;
  best_zones: { zone_id: string; reason_fr: string }[];
}

export function usePostEventDemand(eventId: string | null) {
  const { data, isLoading, isError } = useQuery<PostEventDemand>({
    queryKey: eventId ? ["/api/events/post-demand", eventId] : ["/api/events/post-demand", "none"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/events/post-demand?event_id=${encodeURIComponent(eventId || "")}`);
      return res.json();
    },
    enabled: !!eventId,
    staleTime: 30_000,
    retry: 1,
  });

  return { demand: data ?? null, isLoading, isError };
}
