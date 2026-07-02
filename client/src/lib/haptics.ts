/**
 * haptics — Retour haptique via Vibration API
 * ─────────────────────────────────────────────────────────────────────────────
 * Fournit une abstraction simple pour déclencher des vibrations selon
 * le type d'action, conçue pour les chauffeurs (mains occupées).
 *
 * Patterns disponibles :
 *   "tap"     — vibration courte 10ms        (retour UI basique)
 *   "success" — 30ms pause 50ms 30ms         (confirmation positive)
 *   "warning" — 100ms pause 50ms 100ms       (alerte douce)
 *   "error"   — 200ms pause 100ms 200ms…     (erreur critique)
 *
 * Silent fallback si navigator.vibrate est absent (iOS Safari, desktop).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Définition des patterns de vibration ─────────────────────────────────────
const HAPTIC_PATTERNS: Record<HapticPattern, VibratePattern> = {
  tap:     10,
  success: [30, 50, 30],
  warning: [100, 50, 100],
  error:   [200, 100, 200, 100, 200],
};

// ── Types ─────────────────────────────────────────────────────────────────────
export type HapticPattern = "tap" | "success" | "warning" | "error";

// ── Fonction principale ───────────────────────────────────────────────────────
/**
 * Déclenche une vibration selon le pattern donné.
 * Ne fait rien si `navigator.vibrate` n'est pas disponible (iOS, desktop).
 *
 * @param pattern — Type de retour haptique souhaité
 */
export function haptic(pattern: HapticPattern): void {
  if (typeof navigator === "undefined") return;
  if (typeof navigator.vibrate !== "function") return; // Fallback silencieux

  const vibratePattern = HAPTIC_PATTERNS[pattern];
  try {
    navigator.vibrate(vibratePattern);
  } catch {
    // Certains navigateurs lèvent une exception si la vibration est bloquée
    // (ex: iframe sandboxé) — on ignore silencieusement.
  }
}
