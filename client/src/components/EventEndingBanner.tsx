/**
 * EventEndingBanner — Bannière chaude "Fin d'événement" en haut de page
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche en haut de FocusPage/MapPage lorsqu'une alerte type='event_ending'
 * est active (générée par le cron 3 min de server/airportEngine.ts).
 * Inclut le hint de dépose optimale (DropoffPointHint) si un venue est déduit
 * de la zone concernée.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Flame } from "lucide-react";
import DropoffPointHint from "./DropoffPointHint";

interface RawAlert {
  id: number;
  type: string;
  title: string;
  message: string;
  zone_id?: string | null;
  priority: string;
}

// Mapping zone_id → venue_key pour le hint de dépose optimale (couvre les
// venues connus de server/idfVenues.ts). Étendre si de nouvelles zones sont
// ajoutées au calendrier IDF.
const ZONE_TO_VENUE: Record<string, string> = {
  z_stade_france: "stade_de_france",
  z_montreuil: "bercy",
  z_epinay_gennevilliers: "la_defense_arena",
};

export default function EventEndingBanner() {
  const { data } = useQuery<RawAlert[]>({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then((r) => r.json()),
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: 1,
  });

  const alerts = Array.isArray(data) ? data : [];
  const eventEnding = alerts.find((a) => a.type === "event_ending");

  if (!eventEnding) return null;

  const venueKey = eventEnding.zone_id ? ZONE_TO_VENUE[eventEnding.zone_id] : null;

  return (
    <div
      className="rounded-2xl border-2 shadow-lg p-4 mb-3 animate-pulse-slow"
      style={{
        background: "linear-gradient(135deg, rgba(249,115,22,0.25) 0%, rgba(220,38,38,0.2) 100%)",
        borderColor: "rgba(249,115,22,0.5)",
      }}
      role="alert"
      data-testid="event-ending-banner"
    >
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-orange-500/30 text-orange-100 shrink-0">
          <Flame size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-widest font-bold text-orange-200">
            Fin d'événement
          </div>
          <div className="text-white font-semibold text-sm mt-0.5">{eventEnding.title}</div>
          <p className="text-orange-100/90 text-sm mt-1">{eventEnding.message}</p>
        </div>
      </div>

      {venueKey && (
        <div className="mt-3">
          <DropoffPointHint venueKey={venueKey} />
        </div>
      )}
    </div>
  );
}
