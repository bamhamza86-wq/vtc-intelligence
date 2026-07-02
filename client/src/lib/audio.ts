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
 * Utilisation :
 *   import { playSound, setSoundEnabled, isSoundEnabled } from "@/lib/audio";
 *   playSound("alert");   // ne fait rien si sons désactivés
 * ─────────────────────────────────────────────────────────────────────────────
 */

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

// ── Génération d'un beep ───────────────────────────────────────────────────────
/**
 * Joue un bip sonore selon le type donné.
 * Ne fait rien si les sons sont désactivés ou si Web Audio API est indisponible.
 *
 * @param type — "alert" (800Hz 200ms) ou "success" (1200Hz 100ms)
 */
export function playSound(type: "alert" | "success"): void {
  // Vérifier l'activation
  if (!isSoundEnabled()) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  // Résoudre le contexte suspendu (règle autoplay browser)
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  // Paramètres selon le type
  const SOUND_CONFIG: Record<"alert" | "success", { freq: number; duration: number }> = {
    alert:   { freq: 800,  duration: 0.2  }, // 200ms
    success: { freq: 1200, duration: 0.1  }, // 100ms
  };

  const { freq, duration } = SOUND_CONFIG[type];

  try {
    const oscillator = ctx.createOscillator();
    const gainNode   = ctx.createGain();

    // Configuration de l'oscillateur
    oscillator.type      = "sine";
    oscillator.frequency.setValueAtTime(freq, ctx.currentTime);

    // Enveloppe de gain — montée rapide, extinction douce
    gainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.3,    ctx.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

    // Connexion au graphe audio
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Démarrage et arrêt automatique
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration + 0.05);

    // Nettoyer après la fin du son
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      gainNode.disconnect();
    });
  } catch {
    // Ignorer silencieusement si le contexte audio est dans un état inattendu
  }
}
