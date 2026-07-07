/**
 * QuickActionBar — Command Bar mono-main (Vague 1 - Levier 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Barre flottante 2×2 boutons XL au bas de l'écran, en zone du pouce.
 * Accessible par un swipe-up depuis le bord droit ou un tap sur le FAB.
 * Actions : Voix ON/OFF · Ma position (recentrer) · Alerte communauté · Pause.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { Mic, MicOff, MapPin, AlertTriangle, Coffee, X, Zap, Radio } from "lucide-react";
import { haptic, alert as hapticAlert, fatigue as hapticFatigue, tapLeft as hapticTapLeft, tapRight as hapticTapRight } from "@/lib/haptics";
import { setVoiceMode, isVoiceEnabled, speak } from "@/lib/voice";
import { useVoiceCommand } from "@/hooks/useVoiceCommand";

// ── Levier 8 (Vague 3) — reach hint FAB ────────────────────────────────────
// Affiché une seule fois par session pour aider à repérer le FAB sans le
// chercher visuellement. Flag persisté en sessionStorage (jamais répété
// pendant un même quart de travail).
const FAB_HINT_KEY = "vtc.fabHintShown";

export default function QuickActionBar() {
  const [location, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [voiceOn, setVoiceOn] = useState(isVoiceEnabled());
  const { isSupported: voiceCmdSupported, isListening, start: startListening, stop: stopListening } = useVoiceCommand();
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);

  // ── Levier 8 (Vague 3) — reach hint FAB : pulse unique par session ─────────
  const [showFabHint, setShowFabHint] = useState(() => {
    try {
      return typeof sessionStorage !== "undefined" && !sessionStorage.getItem(FAB_HINT_KEY);
    } catch {
      return false;
    }
  });

  // Ne pas afficher sur /login ou en mode conduite (déjà en pleine attention)
  if (location === "/login" || location === "/drive") return null;

  function clearFabHint() {
    setShowFabHint(false);
    try {
      sessionStorage.setItem(FAB_HINT_KEY, "1");
    } catch {
      // Stockage indisponible (mode privé strict) — on ignore silencieusement.
    }
  }

  function toggleVoice() {
    const next = !voiceOn;
    setVoiceOn(next);
    setVoiceMode(next ? "on" : "off");
    hapticTapLeft(); // Levier 5 : colonne gauche
    if (next) speak("Voix activée", { priority: "low" });
  }

  // ── Micro commandes vocales (push-to-talk) ─────────────────────────────────
  // Appui long (>350ms) = démarre l'écoute push-to-talk (relâcher = arrêt).
  // Tap court = bascule la voix ON/OFF (comportement historique conservé).
  function micPointerDown() {
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      haptic("tap");
      startListening();
    }, 350);
  }
  function micPointerUp() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (longPressTriggeredRef.current) {
      stopListening();
      longPressTriggeredRef.current = false;
    } else {
      toggleVoice();
    }
  }
  function micPointerLeave() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (longPressTriggeredRef.current) {
      stopListening();
      longPressTriggeredRef.current = false;
    }
  }
  function myPosition() {
    hapticTapRight(); // Levier 5 : colonne droite
    navigate("/");
    setOpen(false);
  }
  function reportAlert() {
    hapticAlert();
    navigate("/alerts");
    setOpen(false);
  }
  function takeBreak() {
    hapticFatigue();
    speak("Pause enregistrée. Bonne récupération.", { priority: "low" });
    setOpen(false);
  }

  const actions = [
    {
      key: "voice",
      label: voiceOn ? "Voix ON" : "Voix OFF",
      icon: voiceOn ? Mic : MicOff,
      color: voiceOn ? "bg-emerald-600" : "bg-slate-600",
      onClick: toggleVoice,
      // Bouton voix : tap court garde le comportement historique (toggle),
      // un appui long déclenche le push-to-talk (géré via pointer handlers
      // spécifiques ci-dessous, pas via onClick).
      pointerHandlers: true,
    },
    {
      key: "position",
      label: "Ma position",
      icon: MapPin,
      color: "bg-sky-600",
      onClick: myPosition,
    },
    {
      key: "alert",
      label: "Alerte",
      icon: AlertTriangle,
      color: "bg-rose-600",
      onClick: reportAlert,
    },
    {
      key: "pause",
      label: "Pause",
      icon: Coffee,
      color: "bg-amber-600",
      onClick: takeBreak,
    },
    ...(voiceCmdSupported
      ? [
          {
            key: "voicecmd",
            label: isListening ? "Écoute…" : "Commande",
            icon: Radio,
            color: isListening ? "bg-rose-600 animate-pulse-ring" : "bg-indigo-600",
            onClick: () => {},
            pointerHandlers: true,
            isVoiceCmd: true,
          },
        ]
      : []),
  ];

  return (
    <>
      {/* FAB déclencheur */}
      <button
        onClick={() => {
          haptic("tap");
          setOpen((o) => !o);
        }}
        onAnimationEnd={() => {
          if (showFabHint) clearFabHint();
        }}
        aria-label="Actions rapides"
        aria-expanded={open}
        className={`fixed right-3 z-40 rounded-full shadow-2xl active:scale-95 transition-all ${open ? "bg-rose-600" : "bg-primary"} text-white ${showFabHint ? "animate-edge-pulse" : ""}`}
        style={{
          bottom: "calc(5rem + env(safe-area-inset-bottom, 0px))",
          width: 56,
          height: 56,
        }}
        data-testid="quick-actions-fab"
      >
        {open ? <X size={26} className="mx-auto" /> : <Zap size={26} className="mx-auto" />}
      </button>

      {/* Overlay + grid 2x2 */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            className="fixed right-3 z-40 grid grid-cols-2 gap-2 animate-slide-up"
            style={{ bottom: "calc(10rem + env(safe-area-inset-bottom, 0px))", width: 220 }}
            role="menu"
            aria-label="Actions rapides"
          >
            {actions.map((a: any) => (
              <button
                key={a.key}
                {...(a.pointerHandlers
                  ? {
                      onPointerDown: micPointerDown,
                      onPointerUp: micPointerUp,
                      onPointerLeave: micPointerLeave,
                    }
                  : { onClick: a.onClick })}
                className={`${a.color} text-white rounded-2xl shadow-xl flex flex-col items-center justify-center gap-1 active:scale-95 transition-transform`}
                style={{ minHeight: 88, minWidth: 88 }}
                role="menuitem"
                data-testid={`quick-action-${a.key}`}
              >
                <a.icon size={26} />
                <span className="text-xs font-semibold">{a.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
