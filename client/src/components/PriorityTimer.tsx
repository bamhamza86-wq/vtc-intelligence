/**
 * PriorityTimer — Barre de progression "Priorité 10 min" post-dépose aéroport
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche le compte à rebours en grande police + barre de progression.
 * Déclenche un retour haptique unique à 1 minute restante (bord de fin de
 * priorité, moment clé pour anticiper le repositionnement).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef } from "react";
import { ShieldCheck } from "lucide-react";
import { useAirportPriority } from "@/hooks/useAirportQueue";
import { haptic } from "@/lib/haptics";

const TOTAL_SECONDS = 10 * 60;

function fmtMMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function PriorityTimer() {
  const { priority } = useAirportPriority();
  const hapticFiredRef = useRef(false);

  useEffect(() => {
    if (!priority.active) {
      hapticFiredRef.current = false;
      return;
    }
    if (priority.seconds_remaining <= 60 && !hapticFiredRef.current) {
      hapticFiredRef.current = true;
      haptic("warning");
    }
  }, [priority.active, priority.seconds_remaining]);

  if (!priority.active) return null;

  const progressPct = Math.max(0, Math.min(100, (priority.seconds_remaining / TOTAL_SECONDS) * 100));
  const isEnding = priority.seconds_remaining <= 60;

  return (
    <div
      className="rounded-2xl border-2 shadow-lg p-4"
      style={{
        background: isEnding
          ? "linear-gradient(135deg, rgba(251,146,60,0.22) 0%, rgba(239,68,68,0.18) 100%)"
          : "linear-gradient(135deg, rgba(34,197,94,0.18) 0%, rgba(16,185,129,0.15) 100%)",
        borderColor: isEnding ? "rgba(251,146,60,0.5)" : "rgba(34,197,94,0.4)",
      }}
      role="timer"
      aria-live="polite"
      data-testid="priority-timer"
    >
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-2 rounded-lg ${isEnding ? "bg-orange-500/20 text-orange-200" : "bg-emerald-500/20 text-emerald-200"}`}>
          <ShieldCheck size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-widest font-bold text-white/70">
            Priorité 10 min — {priority.airport}
          </div>
        </div>
      </div>

      <div className="text-4xl font-black tabular-nums text-white text-center my-2" data-testid="priority-countdown">
        {fmtMMSS(priority.seconds_remaining)}
      </div>

      <div className="h-3 rounded-full bg-black/25 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${isEnding ? "bg-orange-400" : "bg-emerald-400"}`}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {isEnding && (
        <div className="mt-2 text-center text-sm font-semibold text-orange-200">
          Fin de priorité imminente — préparez votre repositionnement
        </div>
      )}
    </div>
  );
}
