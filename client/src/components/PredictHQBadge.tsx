/**
 * PredictHQBadge — Indicateur de boost événementiel PredictHQ sur une zone
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche un badge compact reflétant l'intensité du boost de demande lié à un
 * événement détecté par PredictHQ (concert, match, salon, etc.).
 *
 * Échelle de couleur :
 *   - boost <= 1.0          → rien (null) — pas d'événement actif
 *   - 1.0 < boost <= 1.3    → badge gris   "🎯 +N%"
 *   - 1.3 < boost <= 1.7    → badge yellow "🎯 ×1.5 Event"
 *   - boost > 1.7           → badge emerald animé "🎯 ×1.8 SURGE EVENT"
 *
 * Props :
 *   boost       : number  — multiplicateur (ex: 1.8)
 *   eventTitle  : string? — titre de l'événement (tooltip au survol)
 *   compact     : boolean? — version inline plus petite
 *   className   : string? — classes additionnelles
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Badge } from "@/components/ui/badge";

interface Props {
  boost?: number | null;
  eventTitle?: string | null;
  compact?: boolean;
  className?: string;
}

export function PredictHQBadge({ boost, eventTitle, compact = false, className = "" }: Props) {
  const b = typeof boost === "number" && isFinite(boost) ? boost : 1.0;

  // Pas d'événement actif → ne rien afficher
  if (b <= 1.0) return null;

  const sizeCls = compact ? "text-[10px] px-1.5 py-0 gap-0.5" : "text-xs px-2 py-0.5 gap-1";
  const title = eventTitle || "Événement PredictHQ en cours";

  // Palier 1 : léger (gris)
  if (b <= 1.3) {
    const pct = Math.round((b - 1) * 100);
    return (
      <Badge
        title={title}
        className={`inline-flex items-center ${sizeCls} bg-gray-500/20 text-gray-300 border-gray-500/30 border whitespace-nowrap ${className}`}
      >
        🎯 +{pct}%
      </Badge>
    );
  }

  // Palier 2 : modéré (yellow)
  if (b <= 1.7) {
    return (
      <Badge
        title={title}
        className={`inline-flex items-center ${sizeCls} bg-yellow-500/20 text-yellow-300 border-yellow-500/40 border whitespace-nowrap ${className}`}
      >
        🎯 ×{b.toFixed(1)} {compact ? "" : "Event"}
      </Badge>
    );
  }

  // Palier 3 : fort (emerald animé)
  return (
    <Badge
      title={title}
      className={`inline-flex items-center ${sizeCls} bg-emerald-500/25 text-emerald-300 border-emerald-400/50 border whitespace-nowrap animate-pulse font-semibold ${className}`}
    >
      🎯 ×{b.toFixed(1)} {compact ? "EVENT" : "SURGE EVENT"}
    </Badge>
  );
}

export default PredictHQBadge;
