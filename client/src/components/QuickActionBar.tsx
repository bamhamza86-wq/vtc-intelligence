/**
 * QuickActionBar — Command Bar mono-main (Vague 1 - Levier 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Barre flottante 2×2 boutons XL au bas de l'écran, en zone du pouce.
 * Accessible par un swipe-up depuis le bord droit ou un tap sur le FAB.
 * Actions : Voix ON/OFF · Ma position (recentrer) · Alerte communauté · Pause.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { Mic, MicOff, MapPin, AlertTriangle, Coffee, X, Zap } from "lucide-react";
import { haptic, alert as hapticAlert, fatigue as hapticFatigue } from "@/lib/haptics";
import { setVoiceMode, isVoiceEnabled, speak } from "@/lib/voice";

export default function QuickActionBar() {
  const [location, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [voiceOn, setVoiceOn] = useState(isVoiceEnabled());

  // Ne pas afficher sur /login ou en mode conduite (déjà en pleine attention)
  if (location === "/login" || location === "/drive") return null;

  function toggleVoice() {
    const next = !voiceOn;
    setVoiceOn(next);
    setVoiceMode(next ? "on" : "off");
    haptic("tap");
    if (next) speak("Voix activée", { priority: "low" });
  }
  function myPosition() {
    haptic("tap");
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
  ];

  return (
    <>
      {/* FAB déclencheur */}
      <button
        onClick={() => {
          haptic("tap");
          setOpen((o) => !o);
        }}
        aria-label="Actions rapides"
        aria-expanded={open}
        className={`fixed right-3 z-40 rounded-full shadow-2xl active:scale-95 transition-all ${open ? "bg-rose-600" : "bg-primary"} text-white`}
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
            {actions.map((a) => (
              <button
                key={a.key}
                onClick={a.onClick}
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
