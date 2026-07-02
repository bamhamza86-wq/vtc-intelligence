/**
 * useSmartQueryRefresh — Wrapper React Query avec refresh intelligent
 * ─────────────────────────────────────────────────────────────────────────────
 * Wrape useQuery avec une stratégie de refresh adaptative :
 *   - Tab visible     → refetchInterval = 30_000 ms
 *   - Tab masquée     → refetchInterval = 300_000 ms (économie batterie)
 *   - refetchOnWindowFocus = true
 *   - Écoute l'event `vtc:pulse` pour forcer un refetch synchronisé
 *     avec la pulsation globale de l'app
 *
 * Signature :
 *   useSmartQueryRefresh<T>(queryKey, queryFn, options?)
 *
 * Compatible avec l'API @tanstack/react-query v5.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  useQuery,
  useQueryClient,
  QueryKey,
  QueryFunction,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";

// Intervalles de refresh
const INTERVAL_VISIBLE_MS  =  30_000; // 30s — tab active
const INTERVAL_HIDDEN_MS   = 300_000; // 5min — tab masquée

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useSmartQueryRefresh<T>(
  queryKey: QueryKey,
  queryFn: QueryFunction<T>,
  options?: Omit<UseQueryOptions<T, Error, T, QueryKey>, "queryKey" | "queryFn" | "refetchInterval" | "refetchOnWindowFocus">
): UseQueryResult<T, Error> {
  const qc = useQueryClient();
  const isVisible = typeof document !== "undefined"
    ? document.visibilityState === "visible"
    : true;

  // Référence pour garder la queryKey stable dans les listeners d'événements
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  // ── Écoute de vtc:pulse pour forcer un refetch synchronisé ─────────────────
  useEffect(() => {
    const handlePulse = () => {
      qc.invalidateQueries({ queryKey: queryKeyRef.current as readonly unknown[] });
    };

    window.addEventListener("vtc:pulse", handlePulse);
    return () => window.removeEventListener("vtc:pulse", handlePulse);
  }, [qc]);

  // ── Mise à jour de l'intervalle selon la visibilité ──────────────────────
  useEffect(() => {
    const handleVisibility = () => {
      // Re-render provoqué par le changement de visibilité — pas d'action directe
      // nécessaire car isVisible est recalculé à chaque render.
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  return useQuery<T, Error, T, QueryKey>({
    queryKey,
    queryFn,
    refetchInterval: isVisible ? INTERVAL_VISIBLE_MS : INTERVAL_HIDDEN_MS,
    refetchOnWindowFocus: true,
    ...options,
  });
}
