/**
 * DriveTimer — Barre de progression du temps de conduite continue (feat/safety)
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche en haut de DrivePage / FocusPage une barre horizontale représentant
 * la progression vers le seuil légal indicatif (4h30 de conduite continue).
 * Devient rouge à partir de 4h. Cliquer sur les chiffres bascule pause/reprise.
 *
 * S'appuie sur GET /api/safety/session/current (poll léger 30s) — ne
 * recalcule rien côté client au-delà du fallback local useDrivingSession.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Pause, Play } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { haptic } from "@/lib/haptics";

const RED_THRESHOLD_MIN = 240; // 4h → rouge
const AMBER_THRESHOLD_MIN = 120; // 2h → ambre

interface SafetySessionCurrent {
  active: boolean;
  paused: boolean;
  drive_minutes_continuous: number;
  next_mandatory_break_in_min: number | null;
  total_today: number;
  session_id: number | null;
}

function fmtHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m} min`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

export function DriveTimer({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();

  const { data } = useQuery<SafetySessionCurrent>({
    queryKey: ["/api/safety/session/current"],
    queryFn: () => apiRequest("GET", "/api/safety/session/current").then((r) => r.json()),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const startMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safety/session/start").then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/safety/session/current"] }),
  });

  const pauseMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safety/session/pause").then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/safety/session/current"] }),
  });

  const resumeMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safety/session/resume").then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/safety/session/current"] }),
  });

  // Auto-démarre une session au premier montage si aucune n'est active.
  const hasAutoStarted = data !== undefined;
  if (hasAutoStarted && !data.active && !startMutation.isPending) {
    startMutation.mutate();
  }

  const continuousMin = data?.drive_minutes_continuous ?? 0;
  const paused = data?.paused ?? false;
  const pct = Math.min(100, (continuousMin / RED_THRESHOLD_MIN) * 100);

  const barColor =
    continuousMin >= RED_THRESHOLD_MIN
      ? "bg-red-500"
      : continuousMin >= AMBER_THRESHOLD_MIN
      ? "bg-amber-400"
      : "bg-emerald-400";

  const textColor =
    continuousMin >= RED_THRESHOLD_MIN
      ? "text-red-300"
      : continuousMin >= AMBER_THRESHOLD_MIN
      ? "text-amber-300"
      : "text-emerald-300";

  function togglePause() {
    haptic("tap");
    if (paused) {
      resumeMutation.mutate();
    } else {
      pauseMutation.mutate();
    }
  }

  return (
    <div
      className={`w-full ${compact ? "px-2 py-1" : "px-3 py-2"} bg-black/40 border-b border-white/10`}
      data-testid="drive-timer"
    >
      <div className="flex items-center gap-2">
        <Clock size={compact ? 14 : 18} className={`shrink-0 ${textColor}`} aria-hidden />
        <span className={`text-[11px] uppercase tracking-widest font-bold shrink-0 ${textColor}`}>
          Temps de conduite
        </span>
        <span className={`ml-auto text-sm font-black tabular-nums ${textColor}`} data-testid="drive-timer-value">
          {fmtHM(continuousMin)}
        </span>
        <button
          type="button"
          onClick={togglePause}
          className="flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 active:bg-white/25 transition-colors shrink-0"
          style={{ minWidth: 36, minHeight: 36 }}
          aria-label={paused ? "Reprendre la conduite" : "Mettre en pause"}
          data-testid="drive-timer-toggle-pause"
        >
          {paused ? <Play size={16} className="text-white" /> : <Pause size={16} className="text-white" />}
        </button>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-white/10 overflow-hidden" role="progressbar"
        aria-valuenow={Math.round(continuousMin)} aria-valuemin={0} aria-valuemax={RED_THRESHOLD_MIN}
        aria-label="Progression du temps de conduite continue">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor} ${paused ? "opacity-40" : ""}`}
          style={{ width: `${pct}%` }}
          data-testid="drive-timer-bar"
        />
      </div>
      {paused && (
        <div className="mt-1 text-[10px] text-white/50 font-medium">⏸ En pause</div>
      )}
    </div>
  );
}

export default DriveTimer;
