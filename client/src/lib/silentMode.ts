/**
 * silentMode — Mode "silence total" (feat/safety)
 * ─────────────────────────────────────────────────────────────────────────────
 * Flag persisté en localStorage : `vtc.silent_mode_until` (timestamp ISO ou "").
 * Quand actif, tous les toasts NON-CRITIQUES sont désactivés :
 *   - SOS, fatigue rouge, course non-rentable rouge restent toujours affichés.
 *
 * API :
 *   isSilentModeActive()          → bool
 *   getSilentModeUntil()          → Date | null
 *   setSilentModeFor(minutes)     → active pour N minutes
 *   clearSilentMode()             → désactive immédiatement
 *   shouldSuppressToast(kind)     → true si le toast doit être filtré
 * ─────────────────────────────────────────────────────────────────────────────
 */

const LS_KEY = "vtc.silent_mode_until";

/** Catégories de toast toujours autorisées même en mode silence total. */
export type CriticalToastKind = "sos" | "fatigue_red" | "unprofitable_red";
export type ToastKind = CriticalToastKind | "info" | "success" | "warning" | "generic";

const ALWAYS_ALLOWED: ReadonlySet<string> = new Set<CriticalToastKind>([
  "sos",
  "fatigue_red",
  "unprofitable_red",
]);

export function getSilentModeUntil(): Date | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

export function isSilentModeActive(): boolean {
  const until = getSilentModeUntil();
  if (!until) return false;
  return until.getTime() > Date.now();
}

export function setSilentModeFor(minutes: number): void {
  try {
    const until = new Date(Date.now() + minutes * 60_000);
    localStorage.setItem(LS_KEY, until.toISOString());
    window.dispatchEvent(new StorageEvent("storage", { key: LS_KEY }));
  } catch {
    // localStorage indisponible — ignoré silencieusement
  }
}

export function clearSilentMode(): void {
  try {
    localStorage.removeItem(LS_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: LS_KEY }));
  } catch {
    // ignoré
  }
}

/** true si le toast de type `kind` doit être filtré (masqué) en ce moment. */
export function shouldSuppressToast(kind: ToastKind = "generic"): boolean {
  if (!isSilentModeActive()) return false;
  return !ALWAYS_ALLOWED.has(kind);
}
