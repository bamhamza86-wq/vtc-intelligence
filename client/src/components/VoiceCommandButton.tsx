/**
 * VoiceCommandButton — Commandes vocales natives (rapport.md §10.3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bouton micro flottant sur DrivePage (mode mains libres, sécurité en conduite).
 * Utilise Web Speech API native (`webkitSpeechRecognition`) — ZÉRO dépendance
 * npm, lang='fr-FR'.
 *
 * Commandes reconnues :
 *   "focus"    → navigate /focus
 *   "accepter" → trigger focus accept (callback onAccept)
 *   "refuser"  → trigger focus refuse (callback onRefuse)
 *   "pause"    → toggle silence (mode silence total, 30 min)
 *   "carte"    → navigate /
 *   "gains"    → navigate /economics
 *
 * Tap target ≥60px (contrainte mission — bouton voice plus grand que le
 * standard 44px pour usage en conduite avec gants / vibrations routières).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Mic, MicOff } from "lucide-react";
import { haptic } from "@/lib/haptics";
import { setSilentModeFor, clearSilentMode, isSilentModeActive } from "@/lib/silentMode";

interface VoiceCommandButtonProps {
  onAccept?: () => void;
  onRefuse?: () => void;
}

type RecognitionState = "idle" | "listening" | "unsupported";

// Type minimal pour éviter une dépendance à @types/dom-speech-recognition (absent du projet).
interface MinimalSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognitionCtor(): (new () => MinimalSpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.webkitSpeechRecognition || w.SpeechRecognition || null;
}

export function VoiceCommandButton({ onAccept, onRefuse }: VoiceCommandButtonProps) {
  const [, navigate] = useLocation();
  const [state, setState] = useState<RecognitionState>("idle");
  const [lastHeard, setLastHeard] = useState<string>("");
  const recognitionRef = useRef<MinimalSpeechRecognition | null>(null);

  useEffect(() => {
    if (!getSpeechRecognitionCtor()) {
      setState("unsupported");
    }
  }, []);

  const handleCommand = useCallback(
    (transcript: string) => {
      const t = transcript.toLowerCase().trim();
      setLastHeard(t);

      if (t.includes("focus")) {
        haptic("tap");
        navigate("/focus");
      } else if (t.includes("accepter") || t.includes("accepte")) {
        haptic("tap");
        onAccept?.();
      } else if (t.includes("refuser") || t.includes("refuse")) {
        haptic("tap");
        onRefuse?.();
      } else if (t.includes("pause")) {
        haptic("tap");
        if (isSilentModeActive()) {
          clearSilentMode();
        } else {
          setSilentModeFor(30);
        }
      } else if (t.includes("carte")) {
        haptic("tap");
        navigate("/");
      } else if (t.includes("gains")) {
        haptic("tap");
        navigate("/economics");
      }
    },
    [navigate, onAccept, onRefuse]
  );

  const startListening = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setState("unsupported");
      return;
    }
    const recognition = new Ctor();
    recognition.lang = "fr-FR";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (event: any) => {
      const transcript = event?.results?.[0]?.[0]?.transcript ?? "";
      if (transcript) handleCommand(transcript);
    };
    recognition.onerror = () => {
      setState("idle");
    };
    recognition.onend = () => {
      setState("idle");
    };

    recognitionRef.current = recognition;
    setState("listening");
    haptic("tap");
    try {
      recognition.start();
    } catch {
      setState("idle");
    }
  }, [handleCommand]);

  function stopListening() {
    recognitionRef.current?.stop();
    setState("idle");
  }

  if (state === "unsupported") {
    return null; // Dégradation silencieuse — pas de dep, pas de bouton mort affiché
  }

  const listening = state === "listening";

  return (
    <>
      <button
        type="button"
        onClick={listening ? stopListening : startListening}
        aria-label={listening ? "Arrêter l'écoute vocale" : "Activer les commandes vocales"}
        aria-pressed={listening}
        data-testid="button-voice-command"
        className={`fixed z-50 flex items-center justify-center rounded-full shadow-lg active:scale-95 transition-transform select-none border-2 ${
          listening
            ? "bg-red-600/90 border-red-300/60 text-white animate-pulse"
            : "bg-sky-600/25 border-sky-400/50 text-sky-200"
        }`}
        style={{
          left: "0.75rem",
          bottom: "calc(6.5rem + env(safe-area-inset-bottom, 0px))",
          width: 60,
          height: 60,
        }}
      >
        {listening ? <MicOff size={26} /> : <Mic size={26} />}
      </button>

      {listening && (
        <div
          className="fixed z-50 left-3 rounded-xl bg-black/80 backdrop-blur px-3 py-2 text-xs text-white/90 max-w-[220px]"
          style={{ bottom: "calc(11rem + env(safe-area-inset-bottom, 0px))" }}
          data-testid="voice-command-hint"
        >
          🎙️ Écoute… dites « focus », « accepter », « refuser », « pause », « carte » ou « gains »
        </div>
      )}
      {!listening && lastHeard && (
        <div
          className="fixed z-50 left-3 rounded-xl bg-black/70 backdrop-blur px-3 py-1.5 text-[11px] text-white/70 max-w-[200px]"
          style={{ bottom: "calc(11rem + env(safe-area-inset-bottom, 0px))" }}
        >
          Compris : « {lastHeard} »
        </div>
      )}
    </>
  );
}

export default VoiceCommandButton;
