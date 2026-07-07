/**
 * audio — Sons d'alerte générés via Web Audio API
 * ─────────────────────────────────────────────────────────────────────────────
 * Génère des beeps synthétiques sans fichier audio externe.
 * Activé/désactivé via localStorage `vtc.sound_enabled` (défaut : false).
 *
 * Sons disponibles :
 *   "alert"   — 800 Hz pendant 200ms  (alerte / attention)
 *   "success" — 1200 Hz pendant 100ms (confirmation / succès)
 *
 * Sons additionnels (couche Wow-factor polish, tous synthétisés, zéro fichier) :
 *   "ping"          — nouveau signalement communautaire (note claire courte)
 *   "chime"         — achievement débloqué (arpège 3 notes montant, façon Duolingo)
 *   "fatigue_alert" — alerte fatigue (2 tons graves espacés, volontairement sobre)
 *
 * Utilisation :
 *   import { playSound, setSoundEnabled, isSoundEnabled } from "@/lib/audio";
 *   playSound("alert");   // ne fait rien si sons désactivés
 *   playSound("chime");   // achievement débloqué
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type SoundType = "alert" | "success" | "ping" | "chime" | "fatigue_alert";

// ── Clé localStorage ──────────────────────────────────────────────────────────
const SOUND_KEY = "vtc.sound_enabled";

// ── Contexte Audio partagé (lazy init) ───────────────────────────────────────
let _audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (_audioContext) return _audioContext;
  try {
    _audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    return _audioContext;
  } catch {
    return null;
  }
}

// ── Vérification de l'état des sons ──────────────────────────────────────────
/**
 * Retourne true si les sons sont activés (localStorage vtc.sound_enabled = "1").
 * Défaut : false.
 */
export function isSoundEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(SOUND_KEY) === "1";
}

/**
 * Active ou désactive les sons d'alerte.
 */
export function setSoundEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SOUND_KEY, enabled ? "1" : "0");
}

// ── Génération d'une note isolée ──────────────────────────────────────────────
function playTone(ctx: AudioContext, freq: number, startAt: number, duration: number, peakGain = 0.28, type: OscillatorType = "sine"): void {
  try {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(freq, startAt);

    // Enveloppe de gain — montée rapide, extinction douce
    gainNode.gain.setValueAtTime(0.0001, startAt);
    gainNode.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.05);

    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      gainNode.disconnect();
    });
  } catch {
    // Ignorer silencieusement si le contexte audio est dans un état inattendu
  }
}

// ── Séquences (notes successives, en secondes relatives) ────────────────────
interface NoteStep { freq: number; delay: number; duration: number; gain?: number; type?: OscillatorType }

const SOUND_SEQUENCES: Record<SoundType, NoteStep[]> = {
  alert:   [{ freq: 800,  delay: 0,    duration: 0.2 }],
  success: [{ freq: 1200, delay: 0,    duration: 0.1 }],
  // Ping communautaire — note unique claire et brève, timbre triangle (plus doux qu'un sine strident)
  ping:    [{ freq: 1050, delay: 0,    duration: 0.09, gain: 0.22, type: "triangle" }],
  // Chime achievement — arpège montant 3 notes façon "petite victoire" (rapport §15.4)
  chime: [
    { freq: 660,  delay: 0,    duration: 0.12, gain: 0.24 },
    { freq: 880,  delay: 0.09, duration: 0.12, gain: 0.24 },
    { freq: 1320, delay: 0.18, duration: 0.22, gain: 0.26 },
  ],
  // Alerte fatigue — 2 tons graves espacés, sobres et non-anxiogènes
  fatigue_alert: [
    { freq: 340, delay: 0,    duration: 0.22, gain: 0.24, type: "sine" },
    { freq: 300, delay: 0.28, duration: 0.28, gain: 0.24, type: "sine" },
  ],
};

// ── Lecture d'un son ───────────────────────────────────────────────────────────
/**
 * Joue un son synthétique selon le type donné.
 * Ne fait rien si les sons sont désactivés ou si Web Audio API est indisponible.
 */
export function playSound(type: SoundType): void {
  if (!isSoundEnabled()) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const sequence = SOUND_SEQUENCES[type];
  if (!sequence) return;

  const now = ctx.currentTime;
  for (const step of sequence) {
    playTone(ctx, step.freq, now + step.delay, step.duration, step.gain ?? 0.28, step.type ?? "sine");
  }
}
