/**
 * EmergencyButton — Bouton SOS flottant discret (feat/safety)
 * ─────────────────────────────────────────────────────────────────────────────
 * Positionné bottom-right dans DrivePage. Nécessite un appui long (800ms)
 * pour éviter les déclenchements accidentels — un tap court ne fait rien.
 * Après l'appui long : modal de confirmation → si confirmé, POST
 * /api/safety/emergency (avec position GPS) puis affiche les numéros utiles
 * (17, 112, 115, 3919) sous forme de liens `tel:`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useRef, useState } from "react";
import { AlertOctagon, Phone, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { haptic } from "@/lib/haptics";
import { useGpsPosition } from "@/hooks/useGpsPosition";

const LONG_PRESS_MS = 800;

interface UsefulNumber {
  label: string;
  number: string;
}

const FALLBACK_NUMBERS: UsefulNumber[] = [
  { label: "Police secours", number: "17" },
  { label: "Numéro d'urgence européen", number: "112" },
  { label: "SAMU social (sans-abris / détresse)", number: "115" },
  { label: "Numéro national violences (écoute)", number: "3919" },
];

export function EmergencyButton() {
  const { position } = useGpsPosition();
  const [step, setStep] = useState<"idle" | "confirm" | "sent">("idle");
  const [numbers, setNumbers] = useState<UsefulNumber[]>(FALLBACK_NUMBERS);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(0); // 0-100, feedback visuel appui long

  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function clearTimers() {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    setProgress(0);
  }

  function onPointerDown() {
    if (step !== "idle") return;
    const startedAt = Date.now();
    progressIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setProgress(Math.min(100, (elapsed / LONG_PRESS_MS) * 100));
    }, 30);
    pressTimerRef.current = setTimeout(() => {
      haptic("warning");
      setStep("confirm");
      clearTimers();
    }, LONG_PRESS_MS);
  }

  function onPointerUp() {
    clearTimers();
  }

  async function confirmEmergency() {
    setSending(true);
    haptic("error");
    try {
      const res = await apiRequest("POST", "/api/safety/emergency", {
        lat: position.lat,
        lng: position.lng,
      }).then((r) => r.json());
      if (res?.useful_numbers) setNumbers(res.useful_numbers);
      // Retour haptique critique — pattern long pour confirmer l'envoi
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([200, 100, 200, 100, 200]);
      }
      setStep("sent");
    } catch {
      // Même en cas d'échec réseau, on affiche les numéros utiles (sécurité avant tout)
      setStep("sent");
    } finally {
      setSending(false);
    }
  }

  function close() {
    setStep("idle");
  }

  return (
    <>
      {/* Bouton flottant discret bottom-right */}
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        className="fixed z-50 flex items-center justify-center rounded-full bg-red-600/25 border-2 border-red-500/50 text-red-200 shadow-lg active:scale-95 transition-transform select-none"
        style={{
          right: "0.75rem",
          bottom: "calc(6.5rem + env(safe-area-inset-bottom, 0px))",
          width: 56,
          height: 56,
        }}
        aria-label="Urgence — appui long 800ms pour déclencher le SOS"
        data-testid="button-emergency"
      >
        <AlertOctagon size={24} />
        {progress > 0 && (
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 56 56" aria-hidden>
            <circle
              cx="28"
              cy="28"
              r="26"
              fill="none"
              stroke="rgb(248 113 113)"
              strokeWidth="3"
              strokeDasharray={`${(progress / 100) * 163.4} 163.4`}
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>

      {/* Modal de confirmation */}
      {step === "confirm" && (
        <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="bg-zinc-900 border-2 border-red-600 rounded-2xl p-5 max-w-sm w-full text-white">
            <div className="flex items-center gap-2 text-red-400 mb-3">
              <AlertOctagon size={28} />
              <h2 className="text-lg font-black">Confirmer l'urgence ?</h2>
            </div>
            <p className="text-sm text-white/80 mb-4">
              Votre position sera enregistrée et une alerte critique sera générée. Utilisez
              ce bouton uniquement en cas de réel danger.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={close}
                className="flex-1 rounded-xl bg-white/10 hover:bg-white/20 font-semibold py-3"
                style={{ minHeight: 48 }}
                data-testid="button-emergency-cancel"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={confirmEmergency}
                disabled={sending}
                className="flex-1 rounded-xl bg-red-600 hover:bg-red-500 font-bold py-3 disabled:opacity-60"
                style={{ minHeight: 48 }}
                data-testid="button-emergency-confirm"
              >
                {sending ? "Envoi..." : "Confirmer SOS"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Numéros utiles après confirmation */}
      {step === "sent" && (
        <div className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="bg-zinc-900 border-2 border-red-600 rounded-2xl p-5 max-w-sm w-full text-white">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-red-400">
                <AlertOctagon size={26} />
                <h2 className="text-lg font-black">Alerte envoyée</h2>
              </div>
              <button
                type="button"
                onClick={close}
                className="p-2 rounded-lg hover:bg-white/10"
                style={{ minWidth: 44, minHeight: 44 }}
                aria-label="Fermer"
                data-testid="button-emergency-close"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-white/70 mb-3">Numéros utiles — appuyez pour appeler :</p>
            <div className="space-y-2">
              {numbers.map((n) => (
                <a
                  key={n.number}
                  href={`tel:${n.number}`}
                  className="flex items-center justify-between rounded-xl bg-white/10 hover:bg-white/20 active:bg-white/25 px-4 py-3 transition-colors"
                  style={{ minHeight: 48 }}
                  data-testid={`link-emergency-call-${n.number}`}
                >
                  <span className="text-sm font-medium">{n.label}</span>
                  <span className="flex items-center gap-1.5 text-lg font-black tabular-nums">
                    <Phone size={16} />
                    {n.number}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default EmergencyButton;
