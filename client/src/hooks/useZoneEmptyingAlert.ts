/**
 * useZoneEmptyingAlert — Couche Communautaire : toast "zone en train de se vider"
 * ─────────────────────────────────────────────────────────────────────────────
 * Le backend détecte une séquence de signaux négative/dead en <15 min sur une
 * zone (voir communityEngine.maybeTriggerEmptyingAlert) et crée une alerte de
 * type 'zone_emptying' dans la table `alerts` existante. Ce hook interroge
 * GET /api/alerts (déjà utilisé par useRepositioningAlerts) et affiche un
 * toast dismissible pour toute nouvelle alerte de ce type.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

const FETCH_INTERVAL_MS = 15_000;

export interface EmptyingAlert {
  id: number;
  type: string;
  title: string;
  message: string;
  zone_id?: string;
  expires_at: string;
  created_at: string;
}

export function useZoneEmptyingAlert() {
  const seenIdsRef = useRef<Set<number>>(new Set());
  const [active, setActive] = useState<EmptyingAlert | null>(null);

  const { data: allAlerts = [] } = useQuery<EmptyingAlert[]>({
    queryKey: ["/api/alerts", "zone_emptying"],
    queryFn: () => apiRequest("GET", "/api/alerts").then((r) => r.json()),
    refetchInterval: FETCH_INTERVAL_MS,
  });

  useEffect(() => {
    const nowMs = Date.now();
    const fresh = (allAlerts as EmptyingAlert[]).find((a) => {
      if (a.type !== "zone_emptying") return false;
      if (a.expires_at && new Date(a.expires_at).getTime() <= nowMs) return false;
      return !seenIdsRef.current.has(a.id);
    });
    if (fresh) {
      seenIdsRef.current.add(fresh.id);
      setActive(fresh);
    }
  }, [allAlerts]);

  const dismiss = () => setActive(null);

  return { alert: active, dismiss };
}
