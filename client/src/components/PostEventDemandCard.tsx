/**
 * PostEventDemandCard — Prévision de la demande post-événement (panneau MapPage)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Pic prévu 12 min après fin Stade de France — cap sur Saint-Denis Basilique"
 * Basé sur GET /api/events/post-demand?event_id=.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Zap } from "lucide-react";
import { usePostEventDemand } from "@/hooks/useIdfEvents";

// Libellés courts de repositionnement par zone (fallback si l'API ne renvoie
// pas de nom lisible — best_zones ne contient que des zone_id bruts).
const ZONE_LABEL: Record<string, string> = {
  z_stade_france: "Saint-Denis Basilique",
  z_montreuil: "Montreuil centre",
  z_epinay_gennevilliers: "Épinay / Gennevilliers",
  z_saint_denis_gare: "Gare Saint-Denis",
};

export default function PostEventDemandCard({ eventId }: { eventId: string | null }) {
  const { demand, isLoading } = usePostEventDemand(eventId);

  if (!eventId || isLoading || !demand) return null;

  const bestZone = demand.best_zones[0];
  const zoneLabel = bestZone ? (ZONE_LABEL[bestZone.zone_id] ?? bestZone.zone_id) : null;

  return (
    <div
      className="rounded-2xl border border-white/10 bg-slate-900/70 p-4"
      data-testid="post-event-demand-card"
    >
      <div className="flex items-center gap-2 mb-2">
        <Zap size={18} className="text-yellow-300" />
        <h3 className="text-sm font-bold text-white uppercase tracking-wide">
          Prévision post-événement
        </h3>
      </div>
      <p className="text-white/90 text-sm leading-relaxed">
        Pic prévu <span className="font-bold text-yellow-300">{demand.peak_min_after_end} min</span> après
        fin {demand.event_name}
        {zoneLabel && (
          <> — cap sur <span className="font-bold">{zoneLabel}</span></>
        )}
      </p>
      <p className="text-white/50 text-xs mt-1.5">{demand.expected_burst}</p>
    </div>
  );
}
