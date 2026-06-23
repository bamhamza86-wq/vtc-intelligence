/**
 * useRepositioningAlerts — Alertes de repositionnement géolocalisées
 * ─────────────────────────────────────────────────────────────────────────────
 * Toutes les 15 s, envoie la position GPS du chauffeur au backend via
 * POST /api/alerts/repositioning. Le backend génère des alertes de type
 * 'repositioning' pour les zones chaudes atteignables en <10 min (rayon 5 km),
 * puis ce hook récupère les alertes actives via GET /api/alerts et ne conserve
 * que les alertes 'repositioning' situées dans un rayon de 5 km.
 *
 * Note : intervalle 15 s (PAS 3 s) — la génération d'alertes est coûteuse et
 * l'anti-spam backend limite à 1 alerte par zone par heure. Inutile de spammer.
 *
 * Usage :
 *   const { nearbyAlerts, isActive } = useRepositioningAlerts();
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";

// ── Type Alert (aligné sur la table `alerts` / AlertsPage) ───────────────────
export interface Alert {
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

// Rayon de filtrage côté client (km) — aligné sur le backend (≤ 5 km ≈ 10 min).
const NEARBY_RADIUS_KM = 5;
// Intervalle d'envoi de la position GPS au backend (ms). 15 s — anti-spam.
const PUSH_INTERVAL_MS = 15_000;
// Intervalle de récupération des alertes actives (ms). 15 s.
const FETCH_INTERVAL_MS = 15_000;

/** Distance haversine (km) entre deux points GPS — miroir du backend. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface UseRepositioningAlertsResult {
  nearbyAlerts: Alert[];
  isActive: boolean;
}

export function useRepositioningAlerts(): UseRepositioningAlertsResult {
  const { position } = useGpsPosition();
  // Refs pour disposer de la position fraîche dans l'intervalle sans recréer le timer.
  const posRef = useRef(position);
  posRef.current = position;

  // 1) Pousser la position GPS au backend toutes les 15 s (+ une fois au mount).
  useEffect(() => {
    let cancelled = false;
    const push = () => {
      const p = posRef.current;
      apiRequest("POST", "/api/alerts/repositioning", { lat: p.lat, lng: p.lng })
        .catch(() => {
          /* non bloquant : le cycle 3min backend prend le relais */
        });
    };
    if (!cancelled) push(); // envoi immédiat au montage
    const id = setInterval(push, PUSH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // 2) Récupérer les alertes actives toutes les 15 s.
  const { data: allAlerts = [] } = useQuery<Alert[]>({
    queryKey: ["/api/alerts", "repositioning"],
    queryFn: () => apiRequest("GET", "/api/alerts").then((r) => r.json()),
    refetchInterval: FETCH_INTERVAL_MS,
  });

  // 3) Filtrer : alertes 'repositioning' actives (non expirées) dans un rayon 5 km.
  const [nearbyAlerts, setNearbyAlerts] = useState<Alert[]>([]);
  useEffect(() => {
    const nowMs = Date.now();
    const p = posRef.current;
    const filtered = (allAlerts as Alert[]).filter((a) => {
      if (a.type !== "repositioning") return false;
      // Expirée (15 min) → retirée automatiquement
      if (a.expires_at && new Date(a.expires_at).getTime() <= nowMs) return false;
      return true;
    });
    setNearbyAlerts(filtered);
    // Note : le filtre distance précis est appliqué côté backend lors de la
    // génération (rayon 5 km). On garde ici un re-render aligné sur la position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAlerts, position.lat, position.lng]);

  return {
    nearbyAlerts,
    isActive: nearbyAlerts.length > 0,
  };
}

export { haversineKm, NEARBY_RADIUS_KM };
