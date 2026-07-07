/**
 * DropoffPointHint — Suggestion de dépose optimale par salle
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiché quand un event_ending est proche : "Dépose optimale : côté nord
 * Bercy — 3 min à pied entrée principale". Basé sur GET /api/events/dropoff-point.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { MapPin } from "lucide-react";
import { useDropoffPoint } from "@/hooks/useIdfEvents";

const SIDE_LABEL: Record<string, string> = {
  nord: "nord",
  sud: "sud",
  est: "est",
  ouest: "ouest",
};

export default function DropoffPointHint({ venueKey, salle }: { venueKey: string; salle?: string }) {
  const { point, isLoading } = useDropoffPoint(venueKey, salle);

  if (isLoading || !point) return null;

  const walkMin = Math.max(1, Math.round(point.walking_distance_m / 80)); // ~80m/min à pied

  return (
    <div
      className="flex items-start gap-2 rounded-xl bg-black/25 p-3"
      data-testid="dropoff-point-hint"
    >
      <MapPin size={18} className="text-amber-300 shrink-0 mt-0.5" />
      <div className="text-sm text-white/90 leading-relaxed">
        <span className="font-semibold">Dépose optimale : </span>
        côté {SIDE_LABEL[point.side] ?? point.side} {point.salle_name.split(" — ")[0]} — {walkMin} min à pied entrée principale
      </div>
    </div>
  );
}
