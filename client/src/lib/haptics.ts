/**
 * haptics — Retour haptique via Vibration API (+ vocabulaire enrichi Lot B)
 * ─────────────────────────────────────────────────────────────────────────────
 * Fournit une abstraction simple pour déclencher des vibrations selon
 * le type d'action, conçue pour les chauffeurs (mains occupées).
 *
 * API existante (conservée) :
 *   haptic("tap")     — vibration courte 10ms        (retour UI basique)
 *   haptic("success") — 30ms pause 50ms 30ms         (confirmation positive)
 *   haptic("warning") — 100ms pause 50ms 100ms       (alerte douce)
 *   haptic("error")   — 200ms pause 100ms 200ms…     (erreur critique)
 *
 * Vocabulaire différencié Lot B (nouvelles fonctions) :
 *   opportunity() — 2 pulses courts 40ms séparés de 60ms (opportunité détectée)
 *   alert()       — 1 pulse long 200ms
 *   confirm()     — tap unique 25ms
 *   fatigue()     — pulse crescendo [50, 60, 80, 60, 100, 60, 130]
 *   arrival()     — pattern rythmé [100, 50, 100]
 *
 * Fallback iOS : si `navigator.vibrate` est absent OU renvoie `false`, un son
 * court est joué via `AudioContext` (800Hz opportunity / 400Hz alert /
 * 1200Hz confirm), volume maîtrisé à 0.15 pour ne pas surprendre le chauffeur.
 *
 * Flag global : `hapticsEnabled` (lu depuis localStorage `vtc.haptics`,
 * défaut true). Quand désactivé, ni vibration ni fallback sonore ne sont
 * déclenchés par les fonctions du vocabulaire enrichi.
 *
 * Note de compatibilité : l'API `haptic()` historique (tap/success/warning/
 * error) reste strictement inchangée dans son comportement — elle ne consulte
 * pas le flag `vtc.haptics` pour ne rien casser chez les appelants existants.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Définition des patterns de vibration (API existante) ─────────────────────
const HAPTIC_PATTERNS: Record<HapticPattern, VibratePattern> = {
  tap:     10,
  success: [30, 50, 30],
  warning: [100, 50, 100],
  error:   [200, 100, 200, 100, 200],
};

// ── Types ─────────────────────────────────────────────────────────────────────
export type HapticPattern = "tap" | "success" | "warning" | "error";

// ── Fonction principale (API existante, inchangée) ────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════════════
// ── Vocabulaire haptique enrichi (Lot B) ──────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

// ── Flag global d'activation ──────────────────────────────────────────────────
const HAPTICS_FLAG_KEY = "vtc.haptics";

/**
 * Retourne true si le retour haptique enrichi est activé.
 * Défaut : true (activé) si aucune valeur n'est stockée.
 */
export function hapticsEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  const raw = localStorage.getItem(HAPTICS_FLAG_KEY);
  if (raw === null) return true;
  return raw === "1" || raw === "true";
}

/**
 * Active ou désactive le retour haptique enrichi (persisté en localStorage).
 */
export function setHapticsEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(HAPTICS_FLAG_KEY, enabled ? "1" : "0");
}

// ── Patterns enrichis ──────────────────────────────────────────────────────────
const ENRICHED_PATTERNS = {
  opportunity: [40, 60, 40] as number[],                  // 2 pulses 40ms séparés de 60ms
  alert:       200 as number,                             // 1 pulse long
  confirm:     25 as number,                              // tap unique
  fatigue:     [50, 60, 80, 60, 100, 60, 130] as number[], // crescendo
  arrival:     [100, 50, 100] as number[],                // pattern rythmé
} as const;

type EnrichedPatternName = keyof typeof ENRICHED_PATTERNS;

// ── Fallback audio (AudioContext) ─────────────────────────────────────────────
// Volume maîtrisé à 0.15 pour ne jamais surprendre le chauffeur en conduite.
const FALLBACK_VOLUME = 0.15;

const FALLBACK_FREQUENCIES: Partial<Record<EnrichedPatternName, number>> = {
  opportunity: 800,
  alert: 400,
  confirm: 1200,
};

let _hapticsAudioContext: AudioContext | null = null;

function getHapticsAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (_hapticsAudioContext) return _hapticsAudioContext;
  try {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    _hapticsAudioContext = new Ctor();
    return _hapticsAudioContext;
  } catch {
    return null;
  }
}

/**
 * Joue un bip court via Web Audio API, volume fixe à 0.15.
 * Utilisé comme fallback quand la Vibration API est indisponible (iOS Safari)
 * ou échoue.
 */
function playFallbackTone(freq: number, durationSec = 0.12): void {
  const ctx = getHapticsAudioContext();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  try {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(freq, ctx.currentTime);

    // Enveloppe de gain douce, plafonnée à FALLBACK_VOLUME (0.15)
    gainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(FALLBACK_VOLUME, ctx.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationSec);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + durationSec + 0.05);

    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      gainNode.disconnect();
    });
  } catch {
    // Ignorer silencieusement (contexte audio bloqué par autoplay policy, etc.)
  }
}

/**
 * Rejoue un pattern de vibration en tant que séquence de bips audio pour les
 * patterns tableau (ex: fatigue crescendo, arrival rythmé) — approximation
 * du rythme haptique en son, toujours à volume maîtrisé.
 */
function playFallbackPatternTone(pattern: number[], baseFreq: number): void {
  const ctx = getHapticsAudioContext();
  if (!ctx) return;

  let cumulativeDelayMs = 0;
  pattern.forEach((ms, index) => {
    // Index pair = vibration ; index impair = silence (pause). On ne joue
    // un son que pour les segments "vibration".
    const isVibrationSegment = index % 2 === 0;
    if (isVibrationSegment) {
      const delay = cumulativeDelayMs;
      window.setTimeout(() => playFallbackTone(baseFreq, Math.max(ms, 40) / 1000), delay);
    }
    cumulativeDelayMs += ms;
  });
}

// ── Déclenchement unifié vibration + fallback ─────────────────────────────────
function triggerEnriched(name: EnrichedPatternName): void {
  if (!hapticsEnabled()) return;

  const pattern = ENRICHED_PATTERNS[name];
  let vibrated = false;

  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      vibrated = navigator.vibrate(pattern as VibratePattern) !== false;
    } catch {
      vibrated = false;
    }
  }

  if (!vibrated) {
    const freq = FALLBACK_FREQUENCIES[name] ?? 600;
    if (Array.isArray(pattern)) {
      playFallbackPatternTone(pattern, freq);
    } else {
      playFallbackTone(freq, Math.max(pattern, 60) / 1000);
    }
  }
}

// ── API enrichie exportée ─────────────────────────────────────────────────────

/** Opportunité détectée — 2 pulses courts 40ms séparés de 60ms. */
export function opportunity(): void {
  triggerEnriched("opportunity");
}

/** Alerte — 1 pulse long 200ms. */
export function alert(): void {
  triggerEnriched("alert");
}

/** Confirmation — tap unique 25ms. */
export function confirm(): void {
  triggerEnriched("confirm");
}

/** Fatigue — pulse crescendo [50, 60, 80, 60, 100, 60, 130]. */
export function fatigue(): void {
  triggerEnriched("fatigue");
}

/** Arrivée — pattern rythmé [100, 50, 100]. */
export function arrival(): void {
  triggerEnriched("arrival");
}

// ── Objet de commodité regroupant le vocabulaire enrichi ──────────────────────
// Permet `import { haptics } from "@/lib/haptics"; haptics.opportunity();`
// tout en gardant les exports nommés individuels ci-dessus.
export const haptics = {
  opportunity,
  alert,
  confirm,
  fatigue,
  arrival,
  enabled: hapticsEnabled,
  setEnabled: setHapticsEnabled,
};
