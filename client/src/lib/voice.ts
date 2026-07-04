/**
 * voice — Retour vocal français (Web Speech API — SpeechSynthesis)
 * ─────────────────────────────────────────────────────────────────────────────
 * Permet au chauffeur de recevoir des informations sans quitter la route des
 * yeux ("Roissy dans 14 minutes"). Sélectionne automatiquement une voix
 * française (fr-FR de préférence, sinon toute voix fr-*).
 *
 * API :
 *   speak(text, { priority, queue }) — énonce un texte
 *     priority: "low" | "high" | "critical" (défaut "low")
 *       - "low"      : ignoré si un message "high"/"critical" est en cours
 *       - "high"     : mis en file d'attente derrière les messages en cours
 *       - "critical" : interrompt immédiatement tout ce qui est en cours/en file
 *     queue: si false, n'empile pas dans la file (comportement par défaut :
 *            true — les messages sont mis en file sauf s'ils sont "low" et
 *            qu'un message prioritaire parle déjà).
 *
 *   isSupported() — retourne false si `speechSynthesis.getVoices()` est vide
 *     après une attente de 500ms (certains navigateurs chargent les voix de
 *     façon asynchrone).
 *
 * Flag localStorage `vtc.voice` (défaut "auto") — activation simplifiée :
 * la voix est active par défaut ("auto" ~ actif) sauf si explicitement mise
 * à "off" par le chauffeur via le toggle exposé dans MobileSettings.
 *
 * Compatibilité iOS Safari : la synthèse vocale fr-FR est disponible mais le
 * catalogue de voix est plus limité qu'Android/Chrome — le fallback fr-* gère
 * ce cas. Nécessite une interaction utilisateur préalable sur la page avant
 * le premier appel (politique autoplay), comme pour l'AudioContext.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export type VoicePriority = "low" | "high" | "critical";

export interface SpeakOptions {
  priority?: VoicePriority;
  /** Si false, le message n'est pas mis en file (perdu si un autre parle). */
  queue?: boolean;
}

interface QueueItem {
  text: string;
  priority: VoicePriority;
}

// ── Constantes ────────────────────────────────────────────────────────────────
const VOICE_FLAG_KEY = "vtc.voice";
const RATE = 1.05;
const PITCH = 1.0;
const VOLUME = 0.9;
const VOICES_WAIT_MS = 500;

// ── État interne de la file ────────────────────────────────────────────────────
let _queue: QueueItem[] = [];
let _speakingPriority: VoicePriority | null = null;
let _cachedFrenchVoice: SpeechSynthesisVoice | null = null;

// ── Flag d'activation ──────────────────────────────────────────────────────────
/**
 * Retourne le mode voix stocké ("auto" | "on" | "off"). Défaut : "auto".
 * Simplifié conformément au brief : "auto" est traité comme actif.
 */
export function getVoiceMode(): "auto" | "on" | "off" {
  if (typeof localStorage === "undefined") return "auto";
  const raw = localStorage.getItem(VOICE_FLAG_KEY);
  if (raw === "on" || raw === "off" || raw === "auto") return raw;
  return "auto";
}

export function setVoiceMode(mode: "auto" | "on" | "off"): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(VOICE_FLAG_KEY, mode);
}

/** true si la voix est activée (mode "auto" ou "on"). */
export function isVoiceEnabled(): boolean {
  return getVoiceMode() !== "off";
}

// ── Sélection de la voix française ────────────────────────────────────────────
function pickFrenchVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  // Préférence stricte fr-FR
  const exact = voices.find((v) => v.lang?.toLowerCase() === "fr-fr");
  if (exact) return exact;
  // Sinon toute voix fr-*
  const anyFrench = voices.find((v) => v.lang?.toLowerCase().startsWith("fr"));
  if (anyFrench) return anyFrench;
  return null;
}

function getFrenchVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  if (_cachedFrenchVoice) return _cachedFrenchVoice;
  const voices = window.speechSynthesis.getVoices();
  const found = pickFrenchVoice(voices);
  if (found) _cachedFrenchVoice = found;
  return found;
}

// ── Support ────────────────────────────────────────────────────────────────────
/**
 * Retourne true si la synthèse vocale est disponible avec au moins une voix
 * chargée. Certains navigateurs chargent les voix de façon asynchrone après
 * le premier appel — on attend jusqu'à 500ms via l'événement `voiceschanged`
 * avant de conclure à l'absence de support.
 */
export async function isSupported(): Promise<boolean> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;

  const synth = window.speechSynthesis;
  const immediate = synth.getVoices();
  if (immediate.length > 0) return true;

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const onVoicesChanged = () => {
      if (resolved) return;
      const voices = synth.getVoices();
      if (voices.length > 0) {
        resolved = true;
        synth.removeEventListener?.("voiceschanged", onVoicesChanged);
        resolve(true);
      }
    };

    synth.addEventListener?.("voiceschanged", onVoicesChanged);

    window.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      synth.removeEventListener?.("voiceschanged", onVoicesChanged);
      resolve(synth.getVoices().length > 0);
    }, VOICES_WAIT_MS);
  });
}

// ── Moteur de file d'attente ────────────────────────────────────────────────────
function priorityRank(p: VoicePriority): number {
  return p === "critical" ? 2 : p === "high" ? 1 : 0;
}

function processQueue(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  if (window.speechSynthesis.speaking) return;
  if (_queue.length === 0) {
    _speakingPriority = null;
    return;
  }

  const item = _queue.shift()!;
  _speakingPriority = item.priority;

  const utterance = new SpeechSynthesisUtterance(item.text);
  const voice = getFrenchVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = "fr-FR";
  }
  utterance.rate = RATE;
  utterance.pitch = PITCH;
  utterance.volume = VOLUME;

  utterance.onend = () => {
    _speakingPriority = null;
    processQueue();
  };
  utterance.onerror = () => {
    _speakingPriority = null;
    processQueue();
  };

  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    _speakingPriority = null;
    processQueue();
  }
}

// ── API principale ──────────────────────────────────────────────────────────────
/**
 * Énonce un texte en français via la synthèse vocale.
 *
 * Règles de priorité :
 *   - "low"      : ignoré si un message "high"/"critical" parle déjà.
 *   - "high"     : mis en file, joué après les messages en cours.
 *   - "critical" : interrompt immédiatement tout ce qui est en cours/en file.
 *
 * Ne fait rien si la voix est désactivée (`vtc.voice` = "off") ou si
 * `speechSynthesis` est indisponible.
 */
export function speak(text: string, opts: SpeakOptions = {}): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  if (!isVoiceEnabled()) return;
  if (!text || !text.trim()) return;

  const priority: VoicePriority = opts.priority ?? "low";
  const shouldQueue = opts.queue ?? true;

  // "low" est skipé si un message plus prioritaire est en cours de lecture.
  if (priority === "low" && _speakingPriority && priorityRank(_speakingPriority) > priorityRank("low")) {
    return;
  }

  if (priority === "critical") {
    // Interrompt tout : vide la file et annule la lecture en cours.
    _queue = [];
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
    _queue.push({ text, priority });
    processQueue();
    return;
  }

  if (!shouldQueue && window.speechSynthesis.speaking) {
    // Pas de mise en file demandée : le message est perdu si ça parle déjà.
    return;
  }

  _queue.push({ text, priority });
  // Tri stable par priorité décroissante (high avant low), sans réordonner
  // les éléments de même priorité entre eux.
  _queue.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));

  processQueue();
}

/** Arrête immédiatement toute lecture et vide la file d'attente. */
export function stop(): void {
  _queue = [];
  _speakingPriority = null;
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

export const voice = {
  speak,
  stop,
  isSupported,
  getVoiceMode,
  setVoiceMode,
  isVoiceEnabled,
};
