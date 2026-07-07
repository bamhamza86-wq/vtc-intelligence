/**
 * RecoWhereToGo — Bandeau "Où aller maintenant"
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche la meilleure zone en temps réel avec :
 *   • Nom de la zone
 *   • Distance GPS à vol d'oiseau depuis la position du chauffeur
 *   • ETA temps réel (routing backend)
 *   • Gain net estimé (brut − coûts à vide) + badge de confiance
 *   • Countdown vers le prochain pic (si détecté)
 *
 * Intègre le DriverStateToggle : toggle à gauche, reco au centre, countdown à
 * droite. Le comportement d'affichage varie selon l'état chauffeur :
 *   • available  → reco normale
 *   • on_ride    → reco grisée, préfixe "Prochaine zone après dépose"
 *   • pause      → zone/gain masqués, message de reprise conseillée
 *
 * Clic → recentre la carte sur la zone recommandée (callback).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Navigation, Zap, Clock, TrendingUp } from "lucide-react";
import { useSmartQueryRefresh } from "@/hooks/useSmartQueryRefresh";
import { apiRequest } from "@/lib/queryClient";
import { haversineKm, estimateRideGain, estimateNetGain, computeConfidence } from "@/lib/geoDistance";
import { useNextPeakHour } from "@/hooks/useNextPeakHour";
import { useDriverState } from "@/hooks/useDriverState";
import { useGpsPosition, GPS_FALLBACK } from "@/hooks/useGpsPosition";
import { DriverStateToggle } from "@/components/DriverStateToggle";
import { RouteSourceBadge } from "@/components/RouteSourceBadge";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecoWhereToGoProps {
  /** Position GPS courante du chauffeur. */
  position: { lat: number; lng: number };
  /** Liste triée des meilleures zones (endpoint /api/top-zones). */
  topZones: any[];
  /** Zone objet complet (avec lat/lng) pour la 1ère du top. */
  onFocusZone?: (zoneId: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtCountdown(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m.toString().padStart(2, "0")}`;
}

/** Formate une heure cible (0-23) en HH:MM arrondi à l'heure pleine. */
function fmtHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

// ─── Badge confiance ──────────────────────────────────────────────────────────

interface ConfidenceBadgeProps {
  level: "high" | "medium" | "low";
}

// ─── Vague 3, Levier 2 : barre de confiance à 3 segments (même palette que le badge) ───
const CONFIDENCE_FILL: Record<ConfidenceBadgeProps["level"], string> = {
  high: "bg-emerald-500",
  medium: "bg-amber-500",
  low: "bg-red-500",
};
const CONFIDENCE_SEGMENTS: Record<ConfidenceBadgeProps["level"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function ConfidenceBar({ level }: ConfidenceBadgeProps) {
  const filled = CONFIDENCE_SEGMENTS[level];
  const fillColor = CONFIDENCE_FILL[level];
  return (
    <span
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={`Confiance : ${filled}/3`}
      data-testid="reco-confidence-bar"
    >
      {[1, 2, 3].map((seg) => (
        <span
          key={seg}
          className={`inline-block h-[2px] w-[5px] rounded-full ${seg <= filled ? `${fillColor} opacity-90` : "bg-muted-foreground/30"}`}
        />
      ))}
    </span>
  );
}

function ConfidenceBadge({ level }: ConfidenceBadgeProps) {
  const config = {
    high:   { emoji: "🟢", label: "sûr",   tooltip: "Signal fiable : données récentes, forte convergence" },
    medium: { emoji: "🟡", label: "moyen", tooltip: "Signal modéré : données partiellement fraîches" },
    low:    { emoji: "🔴", label: "faible", tooltip: "Signal faible : données périmées ou peu convergentes" },
  }[level];

  return (
    <span
      data-testid="reco-confidence-badge"
      title={config.tooltip}
      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground cursor-help ml-1"
    >
      {config.emoji}
      <span className="hidden sm:inline">{config.label}</span>
      <ConfidenceBar level={level} />
    </span>
  );
}

// ─── Profil chauffeur (pour les coûts carburant/usure) ────────────────────────

interface DriverProfile {
  fuel_consumption_per100km?: number;
  fuel_price_per_liter?: number;
  wear_cost_per_km?: number;
}

// ─── Composant principal ──────────────────────────────────────────────────────

export function RecoWhereToGo({ position, topZones, onFocusZone }: RecoWhereToGoProps) {
  const nextPeak                = useNextPeakHour();
  const { state: driverState }  = useDriverState();

  // ─── Levier 8 : Distance GPS pondérée ──────────────────────────────
  // Origine chauffeur = position GPS temps réel (hook global). En fallback GPS
  // (isFallback), on force explicitement Bd Ney { 48.8976, 2.3299 }. La prop
  // `position` reste supportée en secours si le hook n'a rien (rétro-compat).
  const { position: gpsPosition, isFallback } = useGpsPosition();
  const origin = isFallback
    ? GPS_FALLBACK
    : (gpsPosition ?? position);

  // Profil chauffeur — migration vers useSmartQueryRefresh (pulse 30s + auto-pause)
  const { data: driverProfile } = useSmartQueryRefresh<DriverProfile>(
    ["/api/driver-profile"],
    () => apiRequest("GET", "/api/driver-profile").then((r) => r.json()),
    { staleTime: 5 * 60_000 },
  );

  // Levier 8 — Tri par score effectif = score × exp(-distance_km / 10).
  // Pénalise les zones lointaines : une zone un peu moins rentable mais proche
  // peut passer devant. On ne mute pas le tableau d'origine (copie via slice).
  const rankedZones = (topZones ?? [])
    .filter((z) => z && z.zone)
    .slice()
    .sort((a, b) => {
      const sa = a.profitability_index ?? a.profitabilityIndex ?? 0;
      const sb = b.profitability_index ?? b.profitabilityIndex ?? 0;
      const da = haversineKm(origin.lat, origin.lng, a.zone.lat, a.zone.lng);
      const db = haversineKm(origin.lat, origin.lng, b.zone.lat, b.zone.lng);
      const effA = sa * Math.exp(-da / 10);
      const effB = sb * Math.exp(-db / 10);
      return effB - effA;
    });

  const top = rankedZones[0] ?? topZones?.[0];
  if (!top || !top.zone) return null;

  const zone     = top.zone;
  const profIdx  = top.profitability_index ?? top.profitabilityIndex ?? 0;
  const surge    = top.surge_multiplier    ?? top.surgeMultiplier    ?? 1;
  const avgDist  = top.avg_distance_km     ?? top.avgDistanceKm      ?? 8;
  const longRide = top.long_ride_probability ?? top.longRideProbability ?? 0;
  const etaMin   = top.eta_to_zone         ?? top.etaToZone           ?? null;
  // ─── Source du calcul ETA/distance (tomtom|osrm|google|calibrated) ──────────
  const reco     = top as { distance_source?: string };
  const distSrc  = reco.distance_source     ?? top.distanceSource      ?? "calibrated";
  const phqBoost = top.phq_boost           ?? top.phqBoost            ?? 1.0;
  // Âge du signal (en secondes) — fourni par le backend ou fallback 60s
  const dataAgeSec = top.data_age_seconds  ?? top.dataAgeSeconds      ?? 60;
  // Convergence signal (0-1) et variance historique
  const sigConv  = top.signal_convergence  ?? top.signalConvergence   ?? 0.6;
  const histVar  = top.historical_variance ?? top.historicalVariance  ?? 10;

  // Distance GPS à vol d'oiseau depuis l'origine chauffeur (Levier 8).
  const distKm = haversineKm(origin.lat, origin.lng, zone.lat, zone.lng);
  // "X min de toi" : hypothèse 30 km/h moyenne urbaine (distance_km / 30 * 60).
  const minutesFromYou = Math.round((distKm / 30) * 60);

  // Gain net avec coûts carburant/usure depuis le profil chauffeur
  const netGainResult = estimateNetGain({
    avgDistanceKm:          avgDist,
    surge,
    longRideProbability:    longRide,
    distanceToZoneKm:       distKm,
    fuelConsumptionPer100km: driverProfile?.fuel_consumption_per100km,
    fuelPricePerLiter:       driverProfile?.fuel_price_per_liter,
    wearCostPerKm:           driverProfile?.wear_cost_per_km,
  });

  // Gain brut (rétrocompatibilité — utilisé si net = 0 par anomalie)
  const gainEstimated = estimateRideGain({ avgDistanceKm: avgDist, surge, longRideProbability: longRide });

  // Niveau de confiance
  const confidence = computeConfidence({
    dataAgeSeconds:     dataAgeSec,
    signalConvergence:  sigConv,
    historicalVariance: histVar,
  });

  // Code couleur du score de profitabilité
  const scoreColor =
    profIdx >= 75 ? "#22c55e" : profIdx >= 60 ? "#fbbf24" : "#f97316";
  const scoreLabel =
    profIdx >= 75 ? "Ultra rentable" : profIdx >= 60 ? "Rentable" : "Neutre";

  // ─── Fond du bandeau selon état chauffeur et confiance ────────────────────
  const isOnRide  = driverState === "on_ride";
  const isPause   = driverState === "pause";
  const isLowConf = confidence === "low";

  const bandeauBg = isPause
    ? "bg-zinc-800/40 border-b border-zinc-600/30"
    : isOnRide
    ? "bg-gradient-to-r from-blue-500/10 via-blue-500/5 to-transparent border-b border-blue-500/30"
    : isLowConf
    ? "bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border-b border-amber-500/30"
    : "bg-gradient-to-r from-emerald-500/15 via-emerald-500/10 to-transparent border-b border-emerald-500/40";

  // ─── Vue PAUSE ────────────────────────────────────────────────────────────
  const resumeHour = nextPeak.hour != null ? fmtHour(nextPeak.hour) : null;

  return (
    // ─── Mobile : flex-col stack | sm+ : flex-row inline ─────────────────────
    <div className={`px-3 py-2 ${bandeauBg}`} data-testid="reco-where-to-go">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">

        {/* ── Toggle état chauffeur (gauche) ── */}
        <div className="shrink-0">
          <DriverStateToggle />
        </div>

        {/* ── Contenu central ── */}
        <div className="flex-1 min-w-0">
          {isPause ? (
            /* ─── État PAUSE : message de reprise ─── */
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-0.5">
              <span className="text-zinc-400 font-medium">En pause</span>
              {resumeHour && (
                <span className="text-xs">
                  · Reprise conseillée à{" "}
                  <strong className="text-zinc-200 tabular-nums">{resumeHour}</strong>
                </span>
              )}
            </div>
          ) : (
            /* ─── État DISPONIBLE ou EN COURSE ─── */
            <button
              type="button"
              onClick={() => onFocusZone?.(zone.id)}
              className={`w-full flex items-center gap-3 text-left rounded-md px-1.5 py-1 transition-colors ${
                isOnRide
                  ? "hover:bg-blue-500/10 opacity-70"
                  : "hover:bg-emerald-500/10"
              }`}
              title="Cliquer pour centrer la carte sur cette zone"
            >
              <div className="shrink-0 flex flex-col items-center">
                <Navigation
                  size={20}
                  className={isOnRide ? "text-blue-400" : "text-emerald-400"}
                />
                <span
                  className={`text-[9px] mt-0.5 font-semibold uppercase tracking-wide ${
                    isOnRide ? "text-blue-300/80" : "text-emerald-300/80"
                  }`}
                >
                  {isOnRide ? "Après" : "Aller"}
                </span>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {isOnRide && (
                    <span className="text-[10px] text-blue-300/80 italic">
                      Prochaine zone après dépose ·{" "}
                    </span>
                  )}
                  <span
                    className={`text-sm font-bold truncate ${
                      isOnRide ? "text-blue-100" : "text-emerald-100"
                    }`}
                  >
                    {zone.name}
                  </span>
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                    style={{
                      background: `${scoreColor}22`,
                      color:      scoreColor,
                      border:     `1px solid ${scoreColor}66`,
                    }}
                  >
                    {scoreLabel} · {Math.round(profIdx)}/100
                  </span>
                  {phqBoost > 1.1 && (
                    <span className="text-[10px] text-amber-300 font-semibold">
                      📅 events ×{phqBoost.toFixed(2)}
                    </span>
                  )}
                </div>

                <div
                  className={`flex items-center gap-3 mt-0.5 text-[11px] flex-wrap ${
                    isOnRide ? "text-blue-200/70" : "text-emerald-200/85"
                  }`}
                >
                  <span className="flex items-center gap-1">
                    📍{" "}
                    <strong
                      className={`tabular-nums ${isOnRide ? "text-blue-100" : "text-emerald-100"}`}
                    >
                      {distKm.toFixed(1)} km
                    </strong>
                  </span>

                  {/* Levier 8 — "X min de toi" (30 km/h moyenne urbaine) */}
                  <span
                    className="flex items-center gap-1"
                    data-testid="reco-minutes-from-you"
                  >
                    <Clock size={11} />
                    <strong
                      className={`tabular-nums ${isOnRide ? "text-blue-100" : "text-emerald-100"}`}
                    >
                      {minutesFromYou} min
                    </strong>
                    <span className="opacity-70">de toi</span>
                  </span>

                  {etaMin != null && (
                    <span className="flex items-center gap-1">
                      <Clock size={11} /> ETA{" "}
                      <strong
                        className={`tabular-nums ${isOnRide ? "text-blue-100" : "text-emerald-100"}`}
                      >
                        {Math.round(etaMin)} min
                      </strong>
                      {/* Source du calcul ETA/distance */}
                      <RouteSourceBadge source={distSrc} size="xs" />
                    </span>
                  )}

                  {/* ── Gain net + badge confiance ── */}
                  <span
                    className="flex items-center gap-1"
                    data-testid="reco-net-gain"
                  >
                    <Zap size={11} className="text-amber-400" />
                    Gain net
                    <strong
                      className={`tabular-nums ${isOnRide ? "text-blue-100" : "text-emerald-100"}`}
                    >
                      ~{netGainResult.net > 0 ? netGainResult.net : gainEstimated} €
                    </strong>
                    {surge > 1.1 && (
                      <span className="text-amber-400 font-semibold">
                        ×{surge.toFixed(2)}
                      </span>
                    )}
                    <ConfidenceBadge level={confidence} />
                  </span>

                  {/* Badge "signal faible" discret si confidence = low */}
                  {isLowConf && !isOnRide && (
                    <span className="text-[10px] text-amber-500/70 italic">
                      signal faible
                    </span>
                  )}
                </div>
              </div>
            </button>
          )}
        </div>

        {/* ── Countdown prochain pic (droite sur sm+, inline row sur mobile) ── */}
        {!isPause && nextPeak.hour != null && !nextPeak.isNow && (
          <div
            className={`shrink-0 flex flex-col items-start sm:items-end rounded-md px-2 py-1 border ${
              nextPeak.imminent
                ? "border-red-500/60 bg-red-500/10"
                : "border-amber-500/40 bg-amber-500/10"
            }`}
            title={`Pic ${nextPeak.score}/100 dans ${fmtCountdown(nextPeak.minutesUntil)}${
              nextPeak.zoneName ? ` sur ${nextPeak.zoneName}` : ""
            }`}
          >
            <span
              className="text-[9px] uppercase tracking-wide font-semibold flex items-center gap-0.5"
              style={{ color: nextPeak.imminent ? "#f87171" : "#fbbf24" }}
            >
              <TrendingUp size={9} /> Prochain pic
            </span>
            <span
              className="text-sm font-bold tabular-nums"
              style={{ color: nextPeak.imminent ? "#f87171" : "#fbbf24" }}
            >
              {fmtCountdown(nextPeak.minutesUntil)}
            </span>
            <span className="text-[9px] text-muted-foreground">
              {nextPeak.score}/100
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default RecoWhereToGo;
