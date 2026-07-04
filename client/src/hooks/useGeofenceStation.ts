/**
 * useGeofenceStation.ts — Détection auto d'entrée en zone gare/aéroport (Lot C)
 * ─────────────────────────────────────────────────────────────────────────────
 * Retourne le contexte station si le chauffeur est dans un géofence, avec
 * fetch du contexte (prochains vols/trains, zones de récupération) via
 * `/api/station/context`. Débounce 30 s pour éviter les allers-retours bordure.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGpsPosition } from "./useGpsPosition";
import { API_BASE, getAuthToken } from "@/lib/queryClient";

// ─── Géofences IDF (lat, lng, rayon m) ─────────────────────────────────────────
const GEOFENCES: { id: string; label: string; lat: number; lng: number; radiusM: number }[] = [
  { id: "CDG-T2",  label: "CDG Terminal 2",      lat: 49.0097, lng: 2.5479, radiusM: 3000 },
  { id: "ORY",     label: "Orly",                lat: 48.7233, lng: 2.3794, radiusM: 2000 },
  { id: "GDN",     label: "Gare du Nord",        lat: 48.8809, lng: 2.3553, radiusM: 400  },
  { id: "GDL",     label: "Gare de Lyon",        lat: 48.8443, lng: 2.3739, radiusM: 400  },
  { id: "GSL",     label: "Gare Saint-Lazare",   lat: 48.8756, lng: 2.3252, radiusM: 300  },
  { id: "GMP",     label: "Gare Montparnasse",   lat: 48.8407, lng: 2.3200, radiusM: 300  },
];

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface StationContext {
  station: string | null;
  label?: string;
  queueEstimate?: number;
  nextArrivals?: { time: string; source: "flight" | "train"; label: string }[];
  recommendedDropoffZones?: string[];
}

export function useGeofenceStation() {
  const { position } = useGpsPosition();
  const [currentStation, setCurrentStation] = useState<string | null>(null);
  const lastChangeAt = useRef(0);

  // Détection avec débounce 30 s
  useEffect(() => {
    if (!position) return;
    const match = GEOFENCES.find(
      (g) => distanceM(position.lat, position.lng, g.lat, g.lng) <= g.radiusM
    );
    const detected = match?.id ?? null;
    if (detected !== currentStation) {
      const now = Date.now();
      if (now - lastChangeAt.current > 30_000) {
        setCurrentStation(detected);
        lastChangeAt.current = now;
      }
    }
  }, [position?.lat, position?.lng, currentStation]);

  // Fetch contexte station si dans un géofence
  const query = useQuery<StationContext>({
    queryKey: ["station-context", currentStation, position?.lat, position?.lng],
    queryFn: async () => {
      if (!currentStation || !position) return { station: null };
      const token = getAuthToken();
      const res = await fetch(
        `${API_BASE}/api/station/context?lat=${position.lat}&lng=${position.lng}`,
        {
          headers: token
            ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token }
            : {},
        }
      );
      if (!res.ok) return { station: null };
      return (await res.json()) as StationContext;
    },
    enabled: !!currentStation && !!position,
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const isInside = !!currentStation;

  const label = useMemo(() => {
    if (!currentStation) return undefined;
    return GEOFENCES.find((g) => g.id === currentStation)?.label;
  }, [currentStation]);

  return {
    station: currentStation,
    label,
    context: query.data,
    isInside,
    isLoading: query.isLoading,
  };
}
