/**
 * RecoWhereToGo — Bandeau "Où aller maintenant"
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche la meilleure zone en temps réel avec :
 *   • Nom de la zone
 *   • Distance GPS à vol d'oiseau depuis la position du chauffeur
 *   • ETA temps réel (routing backend)
 *   • Gain estimé de la prochaine course
 *   • Countdown vers le prochain pic (si détecté)
 *
 * Clic → recentre la carte sur la zone recommandée (callback).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Navigation, Zap, Clock, TrendingUp } from "lucide-react";
import { haversineKm, estimateRideGain } from "@/lib/geoDistance";
import { useNextPeakHour } from "@/hooks/useNextPeakHour";

export interface RecoWhereToGoProps {
  /** Position GPS courante du chauffeur. */
  position: { lat: number; lng: number };
  /** Liste triée des meilleures zones (endpoint /api/top-zones). */
  topZones: any[];
  /** Zone objet complet (avec lat/lng) pour la 1ère du top. */
  onFocusZone?: (zoneId: string) => void;
}

function fmtCountdown(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m.toString().padStart(2, "0")}`;
}

export function RecoWhereToGo({ position, topZones, onFocusZone }: RecoWhereToGoProps) {
  const nextPeak = useNextPeakHour();
  const top = topZones?.[0];
  if (!top || !top.zone) return null;

  const zone = top.zone;
  const profIdx = top.profitability_index ?? top.profitabilityIndex ?? 0;
  const surge = top.surge_multiplier ?? top.surgeMultiplier ?? 1;
  const avgDist = top.avg_distance_km ?? top.avgDistanceKm ?? 8;
  const longRide = top.long_ride_probability ?? top.longRideProbability ?? 0;
  const etaMin = top.eta_to_zone ?? top.etaToZone ?? null;
  const phqBoost = top.phq_boost ?? top.phqBoost ?? 1.0;

  const distKm = haversineKm(position.lat, position.lng, zone.lat, zone.lng);
  const gainEstimated = estimateRideGain({ avgDistanceKm: avgDist, surge, longRideProbability: longRide });

  // Code couleur du score : vert >=75, jaune >=60, orange sinon
  const scoreColor =
    profIdx >= 75 ? "#22c55e" : profIdx >= 60 ? "#fbbf24" : "#f97316";
  const scoreLabel =
    profIdx >= 75 ? "Ultra rentable" : profIdx >= 60 ? "Rentable" : "Neutre";

  return (
    <div
      className="bg-gradient-to-r from-emerald-500/15 via-emerald-500/10 to-transparent border-b border-emerald-500/40 px-3 py-2"
      data-testid="reco-where-to-go"
    >
      <button
        type="button"
        onClick={() => onFocusZone?.(zone.id)}
        className="w-full flex items-center gap-3 text-left hover:bg-emerald-500/10 rounded-md px-1.5 py-1 transition-colors"
        title="Cliquer pour centrer la carte sur cette zone"
      >
        <div className="shrink-0 flex flex-col items-center">
          <Navigation size={20} className="text-emerald-400" />
          <span className="text-[9px] text-emerald-300/80 mt-0.5 font-semibold uppercase tracking-wide">
            Aller
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-emerald-100 truncate">
              {zone.name}
            </span>
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
              style={{ background: `${scoreColor}22`, color: scoreColor, border: `1px solid ${scoreColor}66` }}
            >
              {scoreLabel} · {Math.round(profIdx)}/100
            </span>
            {phqBoost > 1.1 && (
              <span className="text-[10px] text-amber-300 font-semibold">
                📅 events ×{phqBoost.toFixed(2)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-emerald-200/85 flex-wrap">
            <span className="flex items-center gap-1">
              📍 <strong className="tabular-nums text-emerald-100">{distKm.toFixed(1)} km</strong>
            </span>
            {etaMin != null && (
              <span className="flex items-center gap-1">
                <Clock size={11} /> ETA <strong className="tabular-nums text-emerald-100">{Math.round(etaMin)} min</strong>
              </span>
            )}
            <span className="flex items-center gap-1">
              <Zap size={11} className="text-amber-400" /> Gain
              <strong className="tabular-nums text-emerald-100">~{gainEstimated} €</strong>
              {surge > 1.1 && (
                <span className="text-amber-400 font-semibold">×{surge.toFixed(2)}</span>
              )}
            </span>
          </div>
        </div>

        {/* Countdown prochain pic */}
        {nextPeak.hour != null && !nextPeak.isNow && (
          <div
            className={`shrink-0 flex flex-col items-end rounded-md px-2 py-1 border ${
              nextPeak.imminent
                ? "border-red-500/60 bg-red-500/10"
                : "border-amber-500/40 bg-amber-500/10"
            }`}
            title={`Pic ${nextPeak.score}/100 dans ${fmtCountdown(nextPeak.minutesUntil)}${nextPeak.zoneName ? ` sur ${nextPeak.zoneName}` : ""}`}
          >
            <span className="text-[9px] uppercase tracking-wide font-semibold flex items-center gap-0.5"
              style={{ color: nextPeak.imminent ? "#f87171" : "#fbbf24" }}
            >
              <TrendingUp size={9} /> Prochain pic
            </span>
            <span className="text-sm font-bold tabular-nums"
              style={{ color: nextPeak.imminent ? "#f87171" : "#fbbf24" }}
            >
              {fmtCountdown(nextPeak.minutesUntil)}
            </span>
            <span className="text-[9px] text-muted-foreground">
              {nextPeak.score}/100
            </span>
          </div>
        )}
      </button>
    </div>
  );
}

export default RecoWhereToGo;
