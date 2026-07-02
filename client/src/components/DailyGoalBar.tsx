// ──────────────────────────────────────────────────────────────────────────────
// DailyGoalBar — Barre de progression vers l'objectif journalier
// ──────────────────────────────────────────────────────────────────────────────
// Prop `variant` :
//   "compact" → barre fine + texte "180€ / 240€" (usage dans EconomicsDashboard)
//   "xxl"     → grands chiffres style blocs DrivePage
// ──────────────────────────────────────────────────────────────────────────────
import { Target } from "lucide-react";
import { useDailyGoal } from "@/hooks/useDailyGoal";

// ──────────────────────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────────────────────
interface DailyGoalBarProps {
  variant: "compact" | "xxl";
}

// ──────────────────────────────────────────────────────────────────────────────
// Composant principal
// ──────────────────────────────────────────────────────────────────────────────
export function DailyGoalBar({ variant }: DailyGoalBarProps) {
  const { goalEuros, currentEuros, progressPct, hoursLeftAtCurrentRate, onTrack } = useDailyGoal();

  // ── Couleur barre : vert si on track, orange sinon ──────────────────────
  const barColor = onTrack ? "bg-green-500" : "bg-orange-500";
  const textColor = onTrack ? "text-green-400" : "text-orange-400";
  const borderColor = onTrack ? "border-green-500/40" : "border-orange-500/40";
  const bgColor = onTrack ? "bg-green-500/10" : "bg-orange-500/10";

  // ── Format helpers ───────────────────────────────────────────────────────
  const fmtEur = (v: number) => `${Math.round(v)}€`;

  // ── Variante compact ────────────────────────────────────────────────────
  if (variant === "compact") {
    return (
      // ─── Mobile : ligne unique lisible, tailles réduites ─────────────────
      <div
        className="flex items-center gap-2 py-2"
        data-testid="daily-goal-bar"
      >
        <Target size={13} className={`shrink-0 ${textColor}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] sm:text-xs text-muted-foreground font-medium">Objectif jour</span>
            <span className={`text-[11px] sm:text-xs font-bold tabular-nums ${textColor}`}>
              {fmtEur(currentEuros)} / {fmtEur(goalEuros)}
            </span>
          </div>
          {/* Barre de progression fine */}
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
        {hoursLeftAtCurrentRate > 0 && hoursLeftAtCurrentRate < 99 && (
          <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
            ~{hoursLeftAtCurrentRate.toFixed(1)}h
          </span>
        )}
      </div>
    );
  }

  // ── Variante XXL (DrivePage) ────────────────────────────────────────────
  return (
    // ─── Variante XXL — icon et texte adaptatifs mobile ──────────────────────
    <div
      className={`rounded-3xl border-2 ${borderColor} ${bgColor} flex items-center gap-3 sm:gap-4 md:gap-8 px-4 sm:px-6 md:px-10 py-3 sm:py-4 min-h-0`}
      data-testid="daily-goal-bar"
    >
      <Target
        size={40}
        className={`${textColor} shrink-0 sm:hidden`}
        strokeWidth={2.5}
      />
      <Target
        size={64}
        className={`${textColor} shrink-0 hidden sm:block`}
        strokeWidth={2.5}
      />
      <div className="flex-1 min-w-0">
        {/* Label */}
        <div className={`text-[11px] uppercase tracking-widest font-bold mb-1 ${textColor} opacity-80`}>
          Objectif journalier
        </div>

        {/* Chiffres XXL */}
        <div className={`text-3xl sm:text-5xl md:text-7xl font-black leading-none tabular-nums ${textColor.replace("400", "100")}`}>
          {fmtEur(currentEuros)}
          <span className={`text-2xl md:text-3xl ml-3 ${textColor} opacity-70`}>
            / {fmtEur(goalEuros)}
          </span>
        </div>

        {/* Barre de progression + sous-infos */}
        <div className="mt-3 space-y-1.5">
          <div className="h-3 rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className={`flex flex-wrap items-baseline gap-x-6 text-lg md:text-xl ${textColor} opacity-80`}>
            <span>
              {Math.round(progressPct)}% atteint
            </span>
            {hoursLeftAtCurrentRate > 0 && hoursLeftAtCurrentRate < 99 && (
              <span className="tabular-nums">
                ~{hoursLeftAtCurrentRate.toFixed(1)}h restant au rythme actuel
              </span>
            )}
            <span className={`font-semibold ${onTrack ? "text-green-300" : "text-orange-300"}`}>
              {onTrack ? "✓ En bonne voie" : "⚠ Rythme insuffisant"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
