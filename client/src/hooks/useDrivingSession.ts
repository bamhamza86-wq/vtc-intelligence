// ──────────────────────────────────────────────────────────────────────────────
// useDrivingSession — Suivi de la session de conduite en cours
// ──────────────────────────────────────────────────────────────────────────────
// Persiste le début de session dans localStorage (vtc.session_start_ts).
// Auto-initialise au premier render si la clé est absente.
// Se recalcule toutes les 60s via setInterval.
// ──────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
export type FatigueLevel = "fresh" | "warm" | "tired" | "exhausted";

export interface DrivingSession {
  hoursDriven: number;
  fatigueLevel: FatigueLevel;
  legalPauseNeeded: boolean;
  sessionStart: Date;
}

// ──────────────────────────────────────────────────────────────────────────────
// Constantes seuils (règles VTC France / Uber)
// ──────────────────────────────────────────────────────────────────────────────
const LS_KEY = "vtc.session_start_ts";
const INTERVAL_MS = 60_000; // recalcul toutes les 60s

function getOrInitSessionStart(): Date {
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored) {
      const d = new Date(stored);
      if (!isNaN(d.getTime())) return d;
    }
  } catch {
    // SSR / localStorage indisponible
  }
  const now = new Date();
  try {
    localStorage.setItem(LS_KEY, now.toISOString());
  } catch {
    // ignoré
  }
  return now;
}

function computeSession(start: Date): DrivingSession {
  const nowMs = Date.now();
  const startMs = start.getTime();
  const hoursDriven = Math.max(0, (nowMs - startMs) / 3_600_000);

  let fatigueLevel: FatigueLevel;
  if (hoursDriven >= 8) {
    fatigueLevel = "exhausted";
  } else if (hoursDriven >= 6) {
    fatigueLevel = "tired";
  } else if (hoursDriven >= 4) {
    fatigueLevel = "warm";
  } else {
    fatigueLevel = "fresh";
  }

  // Règle légale VTC France : pause obligatoire à partir de 6h de conduite
  const legalPauseNeeded = fatigueLevel === "tired" || fatigueLevel === "exhausted";

  return { hoursDriven, fatigueLevel, legalPauseNeeded, sessionStart: start };
}

// ──────────────────────────────────────────────────────────────────────────────
// Hook principal
// ──────────────────────────────────────────────────────────────────────────────
export function useDrivingSession(): DrivingSession & { resetSession: () => void } {
  const [sessionStart, setSessionStart] = useState<Date>(() => getOrInitSessionStart());
  const [session, setSession] = useState<DrivingSession>(() => computeSession(sessionStart));

  // Recalcul toutes les 60s
  useEffect(() => {
    setSession(computeSession(sessionStart));
    const id = setInterval(() => {
      setSession(computeSession(sessionStart));
    }, INTERVAL_MS);
    return () => clearInterval(id);
  }, [sessionStart]);

  const resetSession = useCallback(() => {
    const now = new Date();
    try {
      localStorage.setItem(LS_KEY, now.toISOString());
    } catch {
      // ignoré
    }
    setSessionStart(now);
    setSession(computeSession(now));
  }, []);

  return { ...session, resetSession };
}
