/**
 * useLiveRefresh — Hook pulsation temps réel global
 * ─────────────────────────────────────────────────────────────────────────────
 * Gère une pulsation (tick) toutes les 30 secondes pour synchroniser
 * les re-fetch de toutes les queries de l'application.
 *
 * Fonctionnalités :
 *   - Tick toutes les 30s via setInterval
 *   - Émet `vtc:pulse` sur window à chaque tick pour permettre aux queries
 *     de se re-fetch de façon synchronisée
 *   - Détecte document.visibilityState : quand l'onglet redevient visible,
 *     force un tick immédiat
 *
 * Retourne :
 *   - lastPulseAt : Date — moment du dernier tick
 *   - isFresh     : (maxAgeSec: number) => boolean — vérifie la fraîcheur
 *   - tickCount   : number — nombre de ticks depuis le montage
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useCallback, useRef } from "react";

// Intervalle de pulsation en millisecondes
const PULSE_INTERVAL_MS = 30_000; // 30 secondes

export interface UseLiveRefreshResult {
  lastPulseAt: Date;
  isFresh: (maxAgeSec: number) => boolean;
  tickCount: number;
}

// ── Fonction utilitaire pour émettre le pulse ─────────────────────────────────
function emitPulse(): void {
  window.dispatchEvent(new CustomEvent("vtc:pulse"));
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useLiveRefresh(): UseLiveRefreshResult {
  const [lastPulseAt, setLastPulseAt] = useState<Date>(() => new Date());
  const [tickCount, setTickCount] = useState<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Déclenchement d'un tick ─────────────────────────────────────────────────
  const tick = useCallback(() => {
    const now = new Date();
    setLastPulseAt(now);
    setTickCount((c) => c + 1);
    emitPulse();
  }, []);

  // ── Mise en place du setInterval + visibilitychange ────────────────────────
  useEffect(() => {
    // Démarrer l'intervalle principal
    intervalRef.current = setInterval(tick, PULSE_INTERVAL_MS);

    // Tick immédiat quand l'onglet redevient visible (retour de background)
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        tick();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [tick]);

  // ── Vérifie si le dernier pulse est dans la fenêtre de fraîcheur ───────────
  const isFresh = useCallback(
    (maxAgeSec: number): boolean => {
      const ageSec = (Date.now() - lastPulseAt.getTime()) / 1000;
      return ageSec <= maxAgeSec;
    },
    [lastPulseAt]
  );

  return {
    lastPulseAt,
    isFresh,
    tickCount,
  };
}
