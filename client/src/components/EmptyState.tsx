/**
 * EmptyState — États vides premium avec illustration SVG inline
 * ─────────────────────────────────────────────────────────────────────────────
 * Composant générique réutilisable pour remplacer les états vides basiques
 * (icône + texte gris) par une illustration SVG dédiée, cohérente avec le
 * thème (utilise currentColor + tokens Tailwind, compatible dark/light).
 *
 * Variantes disponibles : "map" (carte sans données), "achievements"
 * (aucun succès), "ml" (premier lancement IA), "alerts" (aucune alerte),
 * "community" (aucun signalement).
 *
 * Usage :
 *   <EmptyState variant="achievements" title="Aucun succès pour l'instant"
 *     description="..." />
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ReactNode } from "react";

type Variant = "map" | "achievements" | "ml" | "alerts" | "community";

interface EmptyStateProps {
  variant: Variant;
  title: string;
  description?: string;
  action?: ReactNode;
}

function MapIllustration() {
  return (
    <svg viewBox="0 0 160 120" className="w-32 h-24 mx-auto" aria-hidden="true">
      <rect x="10" y="10" width="140" height="100" rx="10" fill="currentColor" className="text-muted/30" />
      <path d="M25 90 Q45 40 70 70 T125 30" stroke="currentColor" className="text-primary/40" strokeWidth="2.5" fill="none" strokeDasharray="4 5" strokeLinecap="round" />
      <circle cx="45" cy="55" r="5" fill="currentColor" className="text-primary/50" />
      <circle cx="95" cy="80" r="4" fill="currentColor" className="text-primary/30" />
      <circle cx="120" cy="35" r="6" fill="currentColor" className="text-primary/60" />
      <path d="M120 22 L123 30 L120 28 L117 30 Z" fill="currentColor" className="text-primary/60" />
    </svg>
  );
}

function AchievementsIllustration() {
  return (
    <svg viewBox="0 0 160 120" className="w-32 h-24 mx-auto" aria-hidden="true">
      <circle cx="80" cy="50" r="32" fill="currentColor" className="text-amber-400/15" />
      <path
        d="M80 26 L88 45 L109 45 L92 58 L98 79 L80 66 L62 79 L68 58 L51 45 L72 45 Z"
        fill="currentColor"
        className="text-amber-400/50"
      />
      <rect x="50" y="94" width="60" height="6" rx="3" fill="currentColor" className="text-muted/40" />
      <rect x="62" y="104" width="36" height="4" rx="2" fill="currentColor" className="text-muted/25" />
    </svg>
  );
}

function MLIllustration() {
  return (
    <svg viewBox="0 0 160 120" className="w-32 h-24 mx-auto" aria-hidden="true">
      <circle cx="80" cy="55" r="30" fill="currentColor" className="text-cyan-400/15" />
      <circle cx="80" cy="55" r="6" fill="currentColor" className="text-cyan-400/70" />
      <circle cx="55" cy="40" r="4" fill="currentColor" className="text-cyan-400/50" />
      <circle cx="105" cy="42" r="4" fill="currentColor" className="text-cyan-400/50" />
      <circle cx="60" cy="75" r="4" fill="currentColor" className="text-cyan-400/50" />
      <circle cx="102" cy="74" r="4" fill="currentColor" className="text-cyan-400/50" />
      <line x1="80" y1="55" x2="55" y2="40" stroke="currentColor" className="text-cyan-400/40" strokeWidth="1.5" />
      <line x1="80" y1="55" x2="105" y2="42" stroke="currentColor" className="text-cyan-400/40" strokeWidth="1.5" />
      <line x1="80" y1="55" x2="60" y2="75" stroke="currentColor" className="text-cyan-400/40" strokeWidth="1.5" />
      <line x1="80" y1="55" x2="102" y2="74" stroke="currentColor" className="text-cyan-400/40" strokeWidth="1.5" />
    </svg>
  );
}

function AlertsIllustration() {
  return (
    <svg viewBox="0 0 160 120" className="w-32 h-24 mx-auto" aria-hidden="true">
      <path
        d="M80 22c-16 0-24 12-24 26v18l-8 12h64l-8-12V48c0-14-8-26-24-26z"
        fill="currentColor"
        className="text-muted/30"
      />
      <circle cx="80" cy="92" r="7" fill="currentColor" className="text-muted/30" />
      <circle cx="112" cy="34" r="10" fill="currentColor" className="text-emerald-400/40" />
      <path d="M108 34 l3 3 l6 -7" stroke="currentColor" className="text-emerald-500" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CommunityIllustration() {
  return (
    <svg viewBox="0 0 160 120" className="w-32 h-24 mx-auto" aria-hidden="true">
      <circle cx="55" cy="55" r="18" fill="currentColor" className="text-blue-400/25" />
      <circle cx="105" cy="55" r="18" fill="currentColor" className="text-purple-400/25" />
      <circle cx="80" cy="80" r="18" fill="currentColor" className="text-emerald-400/25" />
      <circle cx="55" cy="55" r="4" fill="currentColor" className="text-blue-400/60" />
      <circle cx="105" cy="55" r="4" fill="currentColor" className="text-purple-400/60" />
      <circle cx="80" cy="80" r="4" fill="currentColor" className="text-emerald-400/60" />
    </svg>
  );
}

const ILLUSTRATIONS: Record<Variant, React.ComponentType> = {
  map: MapIllustration,
  achievements: AchievementsIllustration,
  ml: MLIllustration,
  alerts: AlertsIllustration,
  community: CommunityIllustration,
};

export function EmptyState({ variant, title, description, action }: EmptyStateProps) {
  const Illustration = ILLUSTRATIONS[variant];
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10 gap-3" data-testid={`empty-state-${variant}`}>
      <Illustration />
      <p className="font-semibold text-sm">{title}</p>
      {description && <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export default EmptyState;
