// ──────────────────────────────────────────────────────────────────────────────
// FatigueBanner — Bandeau de fatigue conducteur
// ──────────────────────────────────────────────────────────────────────────────
// Affiche un bandeau coloré selon le niveau de fatigue calculé par
// useDrivingSession. Rien n'est affiché en état "fresh".
// ──────────────────────────────────────────────────────────────────────────────
import { AlertTriangle } from "lucide-react";
import { useDrivingSession } from "@/hooks/useDrivingSession";

// ──────────────────────────────────────────────────────────────────────────────
// Composant principal
// ──────────────────────────────────────────────────────────────────────────────
export function FatigueBanner() {
  const { fatigueLevel, resetSession } = useDrivingSession();

  // Rien à afficher si le conducteur est reposé
  if (fatigueLevel === "fresh") return null;

  // ──────────────────────────────────────────────────────────────────────
  // Configuration visuelle par niveau de fatigue
  // ──────────────────────────────────────────────────────────────────────
  const config = {
    warm: {
      container:
        "bg-yellow-100 border border-yellow-400 text-yellow-800",
      message: "4h de conduite — pense à une pause courte",
    },
    tired: {
      container:
        "bg-orange-200 border border-orange-500 text-orange-900",
      message: "6h de conduite — pause légale recommandée maintenant",
    },
    exhausted: {
      container:
        "bg-red-200 border border-red-600 text-red-900 animate-pulse",
      message: "8h+ — ARRÊT recommandé, danger fatigue",
    },
  } as const;

  const { container, message } = config[fatigueLevel as keyof typeof config];

  return (
    // ─── Mobile : flex-row compact, padding réduit, tient sur 1 ligne ──────────
    <div
      className={`flex items-center gap-2 rounded-xl px-3 py-2 sm:px-4 sm:py-3 ${container}`}
      data-testid="fatigue-banner"
    >
      {/* Icône d'alerte */}
      <AlertTriangle size={16} className="shrink-0 sm:hidden" aria-hidden />
      <AlertTriangle size={20} className="shrink-0 hidden sm:block" aria-hidden />

      {/* Message — tronqué sur mobile */}
      <span className="flex-1 text-xs sm:text-sm font-medium truncate">{message}</span>

      {/* Bouton de réinitialisation de session */}
      <button
        onClick={resetSession}
        className="shrink-0 rounded-lg border border-current/40 bg-white/30 px-2.5 py-1 text-xs font-semibold hover:bg-white/50 active:bg-white/60 transition-colors whitespace-nowrap"
        type="button"
        data-testid="fatigue-banner-reset"
      >
        <span className="hidden sm:inline">J’ai fait une pause</span>
        <span className="sm:hidden">Pause ✓</span>
      </button>
    </div>
  );
}
