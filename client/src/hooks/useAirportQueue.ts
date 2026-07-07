/**
 * useAirportQueue — Hooks React Query pour la queue aéroport communautaire
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoints backend (server/airportEngine.ts + server/routes.ts) :
 *   POST /api/airport/queue/join   { airport, terminal } → { position, wait_min_estimated, detail_fr, total_queue }
 *   POST /api/airport/queue/leave  → { left }
 *   GET  /api/airport/queue/status → { in_queue, airport, my_position, total_queue, wait_min_estimated, detail_fr, joined_at }
 *   POST /api/airport/dropoff      { airport } → { priority_until, seconds_remaining }
 *   GET  /api/airport/my-priority  → { active, seconds_remaining, airport }
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type AirportCode = "CDG" | "ORY" | "LBG";

export interface QueueStatus {
  in_queue: boolean;
  airport: AirportCode | null;
  my_position: number | null;
  total_queue: number;
  wait_min_estimated: number | null;
  detail_fr: string | null;
  joined_at: string | null;
}

export interface PriorityStatus {
  active: boolean;
  seconds_remaining: number;
  airport: AirportCode | null;
}

const STATUS_INTERVAL = 5_000;
const PRIORITY_INTERVAL = 3_000;

export function useAirportQueueStatus() {
  const { data, isLoading, isError } = useQuery<QueueStatus>({
    queryKey: ["/api/airport/queue/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/airport/queue/status");
      return res.json();
    },
    refetchInterval: STATUS_INTERVAL,
    staleTime: 2_000,
    retry: 1,
  });

  return {
    status: data ?? {
      in_queue: false,
      airport: null,
      my_position: null,
      total_queue: 0,
      wait_min_estimated: null,
      detail_fr: null,
      joined_at: null,
    },
    isLoading,
    isError,
  };
}

export function useJoinAirportQueue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ airport, terminal }: { airport: AirportCode; terminal?: string | null }) => {
      const res = await apiRequest("POST", "/api/airport/queue/join", { airport, terminal: terminal || null });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/airport/queue/status"] });
    },
  });
}

export function useLeaveAirportQueue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/airport/queue/leave");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/airport/queue/status"] });
    },
  });
}

export function useAirportPriority() {
  const { data, isLoading } = useQuery<PriorityStatus>({
    queryKey: ["/api/airport/my-priority"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/airport/my-priority");
      return res.json();
    },
    refetchInterval: PRIORITY_INTERVAL,
    staleTime: 1_000,
    retry: 1,
  });

  return {
    priority: data ?? { active: false, seconds_remaining: 0, airport: null },
    isLoading,
  };
}

export function useRegisterDropoff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (airport: AirportCode) => {
      const res = await apiRequest("POST", "/api/airport/dropoff", { airport });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/airport/my-priority"] });
    },
  });
}

// ─── Détection proximité aéroport (rayon 2 km) ──────────────────────────────
export interface AirportProximity {
  code: AirportCode;
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
}

const AIRPORTS: { code: AirportCode; name: string; lat: number; lng: number }[] = [
  { code: "CDG", name: "Aéroport CDG — Roissy", lat: 49.0097, lng: 2.5479 },
  { code: "ORY", name: "Aéroport d'Orly", lat: 48.7262, lng: 2.3652 },
  { code: "LBG", name: "Le Bourget", lat: 48.9694, lng: 2.4414 },
];

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Retourne l'aéroport le plus proche si dans un rayon de 2km, sinon null. */
export function findNearbyAirport(lat: number | null | undefined, lng: number | null | undefined): AirportProximity | null {
  if (lat == null || lng == null) return null;
  let closest: AirportProximity | null = null;
  for (const ap of AIRPORTS) {
    const d = distanceKm(lat, lng, ap.lat, ap.lng);
    if (d <= 2 && (!closest || d < closest.distanceKm)) {
      closest = { ...ap, distanceKm: d };
    }
  }
  return closest;
}
