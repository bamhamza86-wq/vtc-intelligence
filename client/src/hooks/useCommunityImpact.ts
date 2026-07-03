/**
 * useCommunityImpact — Levier 9 : pondération communautaire des zones
 * ─────────────────────────────────────────────────────────────────────────────
 * Récupère la carte des impacts communautaires (signalements terrain 1-tap)
 * depuis l'endpoint /api/community/impact, rafraîchie toutes les 5s.
 *
 * Chaque zone porte un compteur positive/negative et un boost_pct borné ±8%
 * appliqué côté serveur sur profitability_index de /api/top-zones.
 *
 *   • useCommunityImpact(zoneId) → { impact } pour la zone ciblée
 *   • useCommunityImpact()       → { allImpacts } pour l'ensemble des zones
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface CommunityImpact {
  positive: number;
  negative: number;
  boost_pct: number;
}

interface CommunityImpactResponse {
  impacts: Record<string, CommunityImpact>;
  _ts: number;
}

// ── Hook principal ──────────────────────────────────────────────────────────────
export function useCommunityImpact(zoneId?: string) {
  const { data } = useQuery<CommunityImpactResponse>({
    queryKey: ["/api/community/impact"],
    // apiRequest(method, url) renvoie une Response → .json() pour extraire le corps
    queryFn: () => apiRequest("GET", "/api/community/impact").then((r) => r.json()),
    refetchInterval: 5000, // 5s — signalements quasi temps réel
  });

  const impact = zoneId ? data?.impacts?.[zoneId] ?? null : null;
  return { impact, allImpacts: data?.impacts || {} };
}
