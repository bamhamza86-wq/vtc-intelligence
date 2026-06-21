/**
 * useRoutingOriginSync — Synchronise l'origine du cache routing backend
 * ─────────────────────────────────────────────────────────────────────────────
 * Quand la position GPS du chauffeur change de plus de 500m par rapport à la
 * dernière origine connue du backend, on appelle POST /api/routing/update-origin
 * pour invalider le cache OSRM/Google des zones et recalculer depuis la vraie
 * position.
 *
 * Throttle : au maximum 1 appel toutes les 5 minutes (évite de marteler l'API
 * Google/OSRM pendant que le chauffeur roule).
 *
 * À monter une seule fois (ex. dans App.tsx) pour toute l'application.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useGpsPosition, GPS_FALLBACK } from "@/hooks/useGpsPosition";

const MIN_DISTANCE_M = 500;          // seuil de déplacement (mètres)
const THROTTLE_MS    = 5 * 60 * 1000; // 5 minutes max entre deux appels

// Distance Haversine en mètres
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // rayon Terre en mètres
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function useRoutingOriginSync(): void {
  const { position, rawPosition } = useGpsPosition();

  // Dernière origine envoyée au backend (init = fallback Bd Ney, l'origine par défaut serveur)
  const lastSyncedOrigin = useRef<{ lat: number; lng: number }>({ ...GPS_FALLBACK });
  const lastSyncTs       = useRef<number>(0);
  const inFlight         = useRef<boolean>(false);

  useEffect(() => {
    // On ne synchronise QUE sur une vraie position GPS (pas le fallback)
    if (!rawPosition) return;

    const now = Date.now();
    const dist = haversineM(
      lastSyncedOrigin.current.lat, lastSyncedOrigin.current.lng,
      position.lat, position.lng,
    );

    // Conditions : déplacement > 500m ET throttle 5 min respecté
    if (dist < MIN_DISTANCE_M) return;
    if (now - lastSyncTs.current < THROTTLE_MS) return;
    if (inFlight.current) return;

    inFlight.current = true;
    lastSyncTs.current = now;

    apiRequest("POST", "/api/routing/update-origin", {
      lat: position.lat,
      lng: position.lng,
    })
      .then(r => r.json())
      .then((res) => {
        if (res?.ok) {
          lastSyncedOrigin.current = { lat: position.lat, lng: position.lng };
          console.log(`[routing-sync] origine mise à jour (${res.zones} zones, source=${res.source})`);
        }
      })
      .catch((e) => console.warn("[routing-sync] échec update-origin:", e))
      .finally(() => { inFlight.current = false; });
  }, [position.lat, position.lng, rawPosition]);
}
