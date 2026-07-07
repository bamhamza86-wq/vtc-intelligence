/**
 * useVoiceCommand — Commandes vocales push-to-talk (Vague 2 - Feature 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilise `webkitSpeechRecognition` (Chrome/Android) si disponible. Aucune
 * dépendance npm — repose entièrement sur les API navigateur natives.
 * Si non supporté, `isSupported` vaut false (le bouton micro doit être masqué
 * par l'appelant).
 *
 * Usage (push-to-talk) :
 *   const { isSupported, isListening, start, stop } = useVoiceCommand();
 *   <button onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} />
 *
 * Commandes reconnues (fr-FR) :
 *   "où aller" / "où"         → navigation vers /focus
 *   "je fais pause" / "pause" → toast "Pause enregistrée" + LS vtc.pause.since
 *   "combien" / "bilan"       → navigation vers /tax (bilan fiscal / gains)
 *   "rentrer"                 → navigation vers /return-journey
 *
 * Écoute limitée à 5s max (arrêt auto si l'utilisateur ne relâche pas le
 * bouton). Confirmation vocale via speak(..., {priority:"high"}).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { speak } from "@/lib/voice";
import { confirm as hapticConfirm, alert as hapticAlert } from "@/lib/haptics";

const LS_PAUSE_SINCE = "vtc.pause.since";
const MAX_LISTEN_MS = 5000;

type SpeechRecognitionCtor = new () => any;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.webkitSpeechRecognition || w.SpeechRecognition || null;
}

export interface UseVoiceCommandResult {
  isSupported: boolean;
  isListening: boolean;
  lastTranscript: string | null;
  /** Démarre l'écoute (à brancher sur onPointerDown / onTouchStart). */
  start: () => void;
  /** Arrête l'écoute (à brancher sur onPointerUp / onPointerLeave). */
  stop: () => void;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // retire les accents pour un matching robuste
    .trim();
}

/**
 * Hook exposant le contrôle push-to-talk et l'exécution des commandes.
 * @param onOpenBilan callback optionnel appelé pour "combien"/"bilan" avant le
 *   fallback de navigation vers /tax (permet d'ouvrir EndOfShiftModal si dispo).
 */
export function useVoiceCommand(onOpenBilan?: () => void): UseVoiceCommandResult {
  const [, navigate] = useLocation();
  const [isListening, setIsListening] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedManuallyRef = useRef(false);

  const Ctor = getSpeechRecognitionCtor();
  const isSupported = !!Ctor;

  const executeCommand = useCallback(
    (rawText: string) => {
      const text = normalize(rawText);
      setLastTranscript(rawText);

      if (text.includes("ou aller") || text === "ou" || text.includes(" ou ") || text.startsWith("ou")) {
        hapticConfirm();
        speak("Direction focus", { priority: "high" });
        navigate("/focus");
        return;
      }
      if (text.includes("je fais pause") || text.includes("pause")) {
        hapticConfirm();
        try {
          localStorage.setItem(LS_PAUSE_SINCE, String(Date.now()));
        } catch {
          // ignore
        }
        speak("Pause enregistrée", { priority: "high" });
        return;
      }
      if (text.includes("combien") || text.includes("bilan")) {
        hapticConfirm();
        speak("Voici ton bilan", { priority: "high" });
        if (onOpenBilan) {
          onOpenBilan();
        } else {
          navigate("/tax");
        }
        return;
      }
      if (text.includes("rentrer")) {
        hapticConfirm();
        speak("Calcul du retour", { priority: "high" });
        navigate("/return-journey");
        return;
      }

      // Commande non reconnue
      hapticAlert();
      speak("Commande non reconnue", { priority: "high" });
    },
    [navigate, onOpenBilan]
  );

  const stop = useCallback(() => {
    stoppedManuallyRef.current = true;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
  }, []);

  const start = useCallback(() => {
    if (!Ctor) return;
    if (isListening) return;

    stoppedManuallyRef.current = false;

    const recognition = new Ctor();
    recognition.lang = "fr-FR";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      try {
        const result = event.results?.[0]?.[0]?.transcript ?? "";
        if (result) executeCommand(result);
      } catch {
        // ignore
      }
    };

    recognition.onerror = () => {
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
      setIsListening(true);
      timeoutRef.current = setTimeout(() => {
        stop();
      }, MAX_LISTEN_MS);
    } catch {
      setIsListening(false);
    }
  }, [Ctor, isListening, executeCommand, stop]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
    };
  }, []);

  return { isSupported, isListening, lastTranscript, start, stop };
}
