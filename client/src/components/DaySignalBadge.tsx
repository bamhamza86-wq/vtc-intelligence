/**
 * DaySignalBadge — Pastille signal émotionnel journée (VERT / ORANGE / ROUGE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Composant compact (30-40px de haut) affichant :
 *   • Cercle coloré animé (vert pulsant, orange fixe, rouge pulsant)
 *   • Label court
 *   • Tooltip complet au survol (score + raison)
 *
 * Utilisé dans le header du Layout, à droite des boutons thème/déconnexion.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useDaySignal } from "@/hooks/useDaySignal";

// ─── Constantes de style par état ────────────────────────────────────────────

const STATE_CONFIG = {
  green: {
    bg:        "bg-emerald-500",
    ring:      "ring-emerald-500/40",
    text:      "text-emerald-400",
    border:    "border-emerald-500/40",
    badgeBg:   "bg-emerald-500/15",
    animate:   "animate-pulse",
  },
  orange: {
    bg:        "bg-amber-500",
    ring:      "ring-amber-500/40",
    text:      "text-amber-400",
    border:    "border-amber-500/40",
    badgeBg:   "bg-amber-500/15",
    animate:   "",   // fixe
  },
  red: {
    bg:        "bg-red-500",
    ring:      "ring-red-500/40",
    text:      "text-red-400",
    border:    "border-red-500/40",
    badgeBg:   "bg-red-500/15",
    animate:   "animate-pulse",
  },
} as const;

// ─── Composant ────────────────────────────────────────────────────────────────

interface DaySignalBadgeProps {
  /** compact=true → pastille seule sans label ni score (usage mobile header) */
  compact?: boolean;
}

export function DaySignalBadge({ compact = false }: DaySignalBadgeProps) {
  const signal = useDaySignal();
  const cfg    = STATE_CONFIG[signal.state];

  const tooltipText = signal.isLoading
    ? "Calcul du signal en cours…"
    : `Score journée : ${signal.score}/100\n${signal.reason}`;

  // ─── Mode compact : pastille seule (mobile header) ────────────────────────
  if (compact) {
    return (
      <div
        data-testid="day-signal-badge"
        title={tooltipText}
        className="flex items-center justify-center w-8 h-8 cursor-default select-none"
      >
        <span className="relative flex shrink-0 items-center justify-center w-4 h-4">
          {cfg.animate && (
            <span
              className={`absolute inset-0 rounded-full ${cfg.bg} opacity-40 ${cfg.animate}`}
              aria-hidden="true"
            />
          )}
          <span className={`relative block w-3 h-3 rounded-full ${cfg.bg} ring-1 ${cfg.ring}`} />
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="day-signal-badge"
      title={tooltipText}
      className={`
        flex items-center gap-1.5 h-8
        px-2 py-1 rounded-md
        border ${cfg.border} ${cfg.badgeBg}
        cursor-default select-none
        transition-colors
      `}
    >
      {/* ─── Cercle coloré animé ─── */}
      <span className="relative flex shrink-0 items-center justify-center w-3 h-3">
        {/* Halo pulsant (green / red uniquement) */}
        {cfg.animate && (
          <span
            className={`absolute inset-0 rounded-full ${cfg.bg} opacity-40 ${cfg.animate}`}
            aria-hidden="true"
          />
        )}
        <span className={`relative block w-2.5 h-2.5 rounded-full ${cfg.bg} ring-1 ${cfg.ring}`} />
      </span>

      {/* ─── Label court ─── */}
      <span className={`text-[11px] font-semibold leading-none ${cfg.text} whitespace-nowrap`}>
        {signal.label}
      </span>

      {/* ─── Score miniature ─── */}
      <span className="text-[10px] text-muted-foreground tabular-nums leading-none">
        {signal.isLoading ? "…" : `${signal.score}`}
      </span>
    </div>
  );
}

export default DaySignalBadge;
