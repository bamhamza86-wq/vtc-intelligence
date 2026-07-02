/**
 * useDriverState — État courant du chauffeur (Disponible / En course / Pause)
 * ─────────────────────────────────────────────────────────────────────────────
 * Persiste l'état dans localStorage sous la clé `vtc.driver_state`.
 * Expose également le temps écoulé depuis le dernier changement d'état.
 *
 * Clé de persitence : vtc.driver_state
 * Clé du timestamp  : vtc.driver_state_since
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState, useEffect, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DriverState = "available" | "on_ride" | "pause";

export interface UseDriverStateResult {
  /** État courant du chauffeur. */
  state: DriverState;
  /** Modifie l'état et met à jour le timestamp. */
  setState: (next: DriverState) => void;
  /** Minutes écoulées depuis le dernier changement d'état. */
  sinceMinutes: number;
}

// ─── Constantes localStorage ──────────────────────────────────────────────────

const LS_STATE_KEY  = "vtc.driver_state";
const LS_SINCE_KEY  = "vtc.driver_state_since";
const DEFAULT_STATE: DriverState = "available";
const TICK_INTERVAL = 30_000;   // mise à jour sinceMinutes toutes les 30s

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readState(): DriverState {
  try {
    const raw = localStorage.getItem(LS_STATE_KEY);
    if (raw === "available" || raw === "on_ride" || raw === "pause") return raw;
  } catch {
    // localStorage indisponible (mode privé, iframe sandboxée, etc.)
  }
  return DEFAULT_STATE;
}

function readSince(): number {
  try {
    const raw = localStorage.getItem(LS_SINCE_KEY);
    const ts  = raw ? parseInt(raw, 10) : NaN;
    return isNaN(ts) ? Date.now() : ts;
  } catch {
    return Date.now();
  }
}

function persistState(state: DriverState): void {
  try {
    localStorage.setItem(LS_STATE_KEY, state);
    localStorage.setItem(LS_SINCE_KEY, String(Date.now()));
  } catch {
    // Silencieux si storage indisponible
  }
}

function computeSinceMinutes(since: number): number {
  return Math.floor((Date.now() - since) / 60_000);
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDriverState(): UseDriverStateResult {
  const [state, setStateRaw]       = useState<DriverState>(readState);
  const [since, setSince]          = useState<number>(readSince);
  const [sinceMinutes, setSinceMin] = useState(() => computeSinceMinutes(readSince()));

  // Tick d'horloge : rafraîchit sinceMinutes sans refetch
  useEffect(() => {
    const id = setInterval(() => {
      setSinceMin(computeSinceMinutes(since));
    }, TICK_INTERVAL);
    return () => clearInterval(id);
  }, [since]);

  const setState = useCallback((next: DriverState) => {
    persistState(next);
    const now = Date.now();
    setStateRaw(next);
    setSince(now);
    setSinceMin(0);
  }, []);

  return { state, setState, sinceMinutes };
}

export default useDriverState;
