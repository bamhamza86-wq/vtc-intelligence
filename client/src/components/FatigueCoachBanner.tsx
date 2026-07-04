/**
 * FatigueCoachBanner — Rappel visuel pause fatigue (Lot D)
 * ─────────────────────────────────────────────────────────────────────────────
 * Banner ambré affiché sur /drive quand le coach détecte :
 *   - 4h+ de conduite continue
 *   - Zone somnolence circadienne (13-15h ou 2-6h)
 * Propose lien Google Maps vers aires de repos (via GPS courant).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useFatigueCoach } from "@/hooks/useFatigueCoach";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { Coffee, X, MapPin } from "lucide-react";

const REASON_LABELS: Record<string, string> = {
  hours: "Vous conduisez depuis longtemps",
  circadian_afternoon: "Creux de l'après-midi",
  circadian_night: "Vigilance nuit réduite",
};

export default function FatigueCoachBanner() {
  const { shouldShow, dismiss, reason, hoursDriven } = useFatigueCoach();
  const { position } = useGpsPosition();

  if (!shouldShow || !reason) return null;

  const label = REASON_LABELS[reason] || "Pause recommandée";

  // Lien Google Maps vers "aire de repos" autour du GPS courant
  const mapsUrl = position
    ? `https://www.google.com/maps/search/aire+de+repos/@${position.lat},${position.lng},14z`
    : "https://www.google.com/maps/search/aire+de+repos";

  return (
    <div
      className="fixed left-3 right-3 z-40 rounded-xl border shadow-lg"
      style={{
        bottom: "calc(4rem + env(safe-area-inset-bottom, 0px) + 0.75rem)",
        background: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)",
        borderColor: "#f59e0b",
        color: "#78350f",
      }}
      role="alert"
      aria-live="polite"
      data-testid="fatigue-coach-banner"
    >
      <div className="flex items-start gap-3 p-3">
        <div className="p-2 rounded-lg bg-white/60 flex-shrink-0">
          <Coffee size={22} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm leading-snug">
            ☕ Pause recommandée
          </div>
          <div className="text-xs opacity-90 mt-0.5">
            {label}
            {reason === "hours" && ` (${hoursDriven.toFixed(1)}h)`}
          </div>
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium mt-2 underline decoration-amber-700/50 hover:decoration-amber-700"
            data-testid="link-rest-area"
          >
            <MapPin size={12} />
            <span>Trouver une aire de repos</span>
          </a>
        </div>
        <button
          onClick={dismiss}
          className="p-2 rounded-lg hover:bg-white/40 transition-colors flex-shrink-0"
          aria-label="Ignorer le rappel"
          data-testid="button-dismiss-fatigue"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
