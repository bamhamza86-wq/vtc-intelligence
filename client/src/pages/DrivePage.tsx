/**
 * DrivePage — Mode conduite plein écran
 * ─────────────────────────────────────────────────────────────────────────────
 * Vue minimaliste conçue pour être consultable en un coup d'œil au volant :
 *   • Fond noir, texte XXL
 *   • 3 informations essentielles :
 *       1. Où aller maintenant (zone + distance + ETA)
 *       2. Gain estimé de la prochaine course + surge
 *       3. Countdown vers le prochain pic
 *   • Bouton "Sortir" en haut à droite pour revenir à la carte
 *
 * Rafraîchi toutes les 30s (top-zones + profitabilité).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { X, Navigation, TrendingUp } from "lucide-react";
import { apiRequest, REALTIME_INTERVAL } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { useNextPeakHour } from "@/hooks/useNextPeakHour";
import { haversineKm, estimateRideGain } from "@/lib/geoDistance";

function fmtCountdown(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m.toString().padStart(2, "0")}`;
}

export default function DrivePage() {
  const { position } = useGpsPosition();
  const now = new Date();
  const currentHour = now.getHours();
  const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";

  const { data: topZones = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/top-zones-drive", currentHour, dayType],
    queryFn: () =>
      apiRequest("GET", `/api/top-zones?hour=${currentHour}&dayType=${dayType}&limit=3`).then((r) => r.json()),
    refetchInterval: REALTIME_INTERVAL,
    staleTime: 20_000,
  });

  const nextPeak = useNextPeakHour();
  const top = topZones[0];

  return (
    <div
      className="fixed inset-0 z-[100] bg-black text-white flex flex-col overflow-hidden select-none"
      data-testid="drive-mode"
      style={{ fontFamily: "Inter, system-ui, sans-serif" }}
    >
      {/* Header minimal — logo + horloge + sortie */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-emerald-400 font-bold">
            Mode conduite
          </span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        </div>
        <div className="text-2xl font-mono tabular-nums font-bold text-white/90">
          {now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
        </div>
        <Link
          href="/"
          className="flex items-center gap-2 rounded-full border border-white/20 hover:bg-white/10 active:bg-white/20 px-4 py-2 text-sm font-medium transition-colors"
          data-testid="button-exit-drive"
        >
          <X size={16} /> Sortir
        </Link>
      </div>

      {/* Corps — 3 grandes zones info */}
      <div className="flex-1 grid grid-rows-3 gap-4 p-4 md:p-6 min-h-0">
        {/* Bloc 1 — Où aller */}
        <div className="rounded-3xl bg-emerald-500/10 border-2 border-emerald-500/40 flex items-center gap-4 md:gap-8 px-6 md:px-10 py-4 min-h-0">
          <Navigation size={64} className="text-emerald-400 shrink-0" strokeWidth={2.5} />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-emerald-300/80 font-bold mb-1">
              Aller maintenant
            </div>
            {top?.zone ? (
              <>
                <div className="text-3xl md:text-5xl font-black text-emerald-100 leading-tight truncate">
                  {top.zone.name}
                </div>
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 mt-2 text-emerald-200/90">
                  <span className="text-2xl md:text-4xl font-bold tabular-nums">
                    {haversineKm(position.lat, position.lng, top.zone.lat, top.zone.lng).toFixed(1)}
                    <span className="text-lg font-medium text-emerald-300/70 ml-1">km</span>
                  </span>
                  {(top.eta_to_zone ?? top.etaToZone) != null && (
                    <span className="text-xl md:text-2xl tabular-nums">
                      ETA {Math.round(top.eta_to_zone ?? top.etaToZone)}
                      <span className="text-sm text-emerald-300/70 ml-1">min</span>
                    </span>
                  )}
                  <span className="text-lg md:text-xl">
                    Score{" "}
                    <strong className="tabular-nums text-white">
                      {Math.round(top.profitability_index ?? top.profitabilityIndex ?? 0)}/100
                    </strong>
                  </span>
                </div>
              </>
            ) : (
              <div className="text-2xl text-emerald-300/60">
                {isLoading ? "Chargement…" : "Aucune donnée"}
              </div>
            )}
          </div>
        </div>

        {/* Bloc 2 — Gain estimé */}
        <div className="rounded-3xl bg-amber-500/10 border-2 border-amber-500/40 flex items-center gap-4 md:gap-8 px-6 md:px-10 py-4 min-h-0">
          <div className="shrink-0 text-5xl md:text-6xl">💶</div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-amber-300/80 font-bold mb-1">
              Gain estimé
            </div>
            {top ? (
              <>
                <div className="text-5xl md:text-7xl font-black text-amber-100 leading-none tabular-nums">
                  ~
                  {estimateRideGain({
                    avgDistanceKm: top.avg_distance_km ?? top.avgDistanceKm ?? 8,
                    surge: top.surge_multiplier ?? top.surgeMultiplier ?? 1,
                    longRideProbability: top.long_ride_probability ?? top.longRideProbability ?? 0,
                  })}
                  <span className="text-3xl md:text-4xl text-amber-300/80 ml-2">€</span>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 mt-2 text-amber-200/85 text-lg md:text-xl">
                  <span>
                    Distance moy.{" "}
                    <strong className="tabular-nums text-white">
                      {(top.avg_distance_km ?? top.avgDistanceKm ?? 0).toFixed(1)} km
                    </strong>
                  </span>
                  {(top.surge_multiplier ?? top.surgeMultiplier ?? 1) > 1.1 && (
                    <span className="font-bold text-amber-300">
                      ⚡ Surge ×{(top.surge_multiplier ?? top.surgeMultiplier).toFixed(2)}
                    </span>
                  )}
                  <span>
                    Longue{" "}
                    <strong className="tabular-nums text-white">
                      {Math.round((top.long_ride_probability ?? top.longRideProbability ?? 0) * 100)}%
                    </strong>
                  </span>
                </div>
              </>
            ) : (
              <div className="text-2xl text-amber-300/60">—</div>
            )}
          </div>
        </div>

        {/* Bloc 3 — Countdown prochain pic */}
        <div
          className={`rounded-3xl border-2 flex items-center gap-4 md:gap-8 px-6 md:px-10 py-4 min-h-0 ${
            nextPeak.imminent
              ? "bg-red-500/10 border-red-500/60"
              : nextPeak.hour != null
                ? "bg-sky-500/10 border-sky-500/40"
                : "bg-white/5 border-white/15"
          }`}
        >
          <TrendingUp
            size={64}
            className={`shrink-0 ${nextPeak.imminent ? "text-red-400 animate-pulse" : nextPeak.hour != null ? "text-sky-400" : "text-white/40"}`}
            strokeWidth={2.5}
          />
          <div className="flex-1 min-w-0">
            <div
              className={`text-[11px] uppercase tracking-widest font-bold mb-1 ${
                nextPeak.imminent ? "text-red-300/80" : nextPeak.hour != null ? "text-sky-300/80" : "text-white/50"
              }`}
            >
              Prochain pic rentable
            </div>
            {nextPeak.hour != null ? (
              <>
                <div
                  className={`text-6xl md:text-8xl font-black leading-none tabular-nums ${
                    nextPeak.imminent ? "text-red-100" : "text-sky-100"
                  }`}
                >
                  {fmtCountdown(nextPeak.minutesUntil)}
                </div>
                <div
                  className={`flex flex-wrap items-baseline gap-x-4 mt-2 text-lg md:text-xl ${
                    nextPeak.imminent ? "text-red-200/85" : "text-sky-200/85"
                  }`}
                >
                  <span>
                    Score attendu <strong className="tabular-nums text-white">{nextPeak.score}/100</strong>
                  </span>
                  {nextPeak.zoneName && (
                    <span className="truncate">
                      → <strong className="text-white">{nextPeak.zoneName}</strong>
                    </span>
                  )}
                  <span className="text-white/60">
                    à {String(nextPeak.hour).padStart(2, "0")}:00
                  </span>
                </div>
              </>
            ) : (
              <div className="text-3xl md:text-4xl text-white/50 font-semibold">
                Aucun pic prévu dans les 6h
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bandeau bas — position GPS + horloge secondaire */}
      <div className="border-t border-white/10 px-6 py-2 flex items-center justify-between text-[11px] text-white/50">
        <span>
          📍 GPS {position.lat.toFixed(4)}, {position.lng.toFixed(4)}
        </span>
        <span>vtc-one · mode conduite</span>
      </div>
    </div>
  );
}
