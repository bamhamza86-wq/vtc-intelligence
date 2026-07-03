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
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { X, Navigation, TrendingUp, ArrowLeft } from "lucide-react";
import { apiRequest, REALTIME_INTERVAL } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { useNextPeakHour } from "@/hooks/useNextPeakHour";
import { useWakeLock } from "@/hooks/useWakeLock";
import { haversineKm, estimateRideGain } from "@/lib/geoDistance";
import { FatigueBanner } from "@/components/FatigueBanner";
import { DailyGoalBar } from "@/components/DailyGoalBar";
import { FuelAutonomyBadge } from "@/components/FuelAutonomyBadge";
import { useSwipe } from "@/hooks/useSwipe";
import { haptic } from "@/lib/haptics";

function fmtCountdown(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m.toString().padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Levier 6 — Mode conduite XXL
// ─────────────────────────────────────────────────────────────────────────────
// Clé localStorage signalant que le mode conduite est actif. Posée à l'entrée
// (mount) et retirée à la sortie (unmount) — permet aux autres écrans de savoir
// si le chauffeur est en conduite plein écran.
const DRIVING_MODE_KEY = "vtc.driving_mode_active";

export default function DrivePage() {
  // ── Wake Lock — empêche l'écran de s'éteindre pendant la conduite ──────────
  useWakeLock();

  // ── Navigation (wouter) ──────────────────────────────────────────────────────
  const [, navigate] = useLocation();

  // ── Levier 6 — État persisté "mode conduite actif" ─────────────────────────
  // Posé à l'entrée, retiré à la sortie (unmount). try/catch : certains iframes
  // publiés n'exposent pas localStorage.
  useEffect(() => {
    try {
      window.localStorage.setItem(DRIVING_MODE_KEY, "1");
    } catch { /* localStorage indisponible — ignore */ }
    return () => {
      try {
        window.localStorage.removeItem(DRIVING_MODE_KEY);
      } catch { /* localStorage indisponible — ignore */ }
    };
  }, []);

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

  // ── Index de la zone recommandée affichée (navigation swipe ← →) ─────────
  const [zoneIndex, setZoneIndex] = useState(0);

  // ── Ref sur le conteneur root — cible des listeners tactiles ─────────────
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Swipe gestures — threshold 60px (plus tolérant qu'à l'arrêt) ─────────
  useSwipe(containerRef, {
    threshold: 60,

    /** ← Zone suivante dans la liste ; sinon Carte */
    onSwipeLeft: () => {
      haptic("tap");
      if (topZones.length > 1) {
        setZoneIndex((i) => (i + 1) % topZones.length);
      } else {
        navigate("/");
      }
    },

    /** → Zone précédente dans la liste ; sinon Économie */
    onSwipeRight: () => {
      haptic("tap");
      if (topZones.length > 1) {
        setZoneIndex((i) => (i - 1 + topZones.length) % topZones.length);
      } else {
        navigate("/economics");
      }
    },

    /** ↑ Alertes */
    onSwipeUp: () => {
      haptic("tap");
      navigate("/alerts");
    },

    /** ↓ Quitter le mode conduite → retour Carte */
    onSwipeDown: () => {
      haptic("tap");
      navigate("/");
    },
  });

  // Zone active selon l'index swipé
  const activeZone = topZones[zoneIndex] ?? top;

  // ────────────────────────────────────────────────────────────────────
  // Levier 6 — Calcul des 3 infos HERO XXL (Zone / Distance / €/h attendu)
  // ────────────────────────────────────────────────────────────────────
  //   • Zone     : nom de la zone active
  //   • Distance : "X.X km · Y min" (distance GPS haversine + ETA backend/fallback 30 km/h)
  //   • €/h      : revenu horaire attendu = gain brut estimé / durée course + trajet à vide
  const heroZoneName = activeZone?.zone?.name ?? (isLoading ? "Chargement…" : "—");

  const heroDistanceKm = activeZone?.zone
    ? haversineKm(position.lat, position.lng, activeZone.zone.lat, activeZone.zone.lng)
    : null;
  // ETA : priorité au backend, sinon estimation 30 km/h moyenne urbaine.
  const heroEtaMin = activeZone
    ? Math.round(
        (activeZone.eta_to_zone ?? activeZone.etaToZone) != null
          ? (activeZone.eta_to_zone ?? activeZone.etaToZone)
          : (heroDistanceKm ?? 0) / 30 * 60,
      )
    : null;
  const heroDistanceLabel =
    heroDistanceKm != null ? `${heroDistanceKm.toFixed(1)} km · ${heroEtaMin} min` : "—";

  // €/h attendu : gain brut d'une course / (temps course estimé + trajet à vide vers zone).
  // Hypothèses : 30 km/h urbain → temps = km / 30 * 60. Plancher 15 min pour éviter
  // les ratios aberrants sur les micro-courses.
  let heroEurPerHour: number | null = null;
  if (activeZone) {
    const avgDist = activeZone.avg_distance_km ?? activeZone.avgDistanceKm ?? 8;
    const surge   = activeZone.surge_multiplier ?? activeZone.surgeMultiplier ?? 1;
    const longRide = activeZone.long_ride_probability ?? activeZone.longRideProbability ?? 0;
    const rideGain = estimateRideGain({ avgDistanceKm: avgDist, surge, longRideProbability: longRide });
    const rideMinutes = Math.max(15, (avgDist / 30) * 60 + (heroEtaMin ?? 0));
    heroEurPerHour = Math.round((rideGain / rideMinutes) * 60);
  }

  return (
    // ─── DrivePage — plein écran avec safe-area (notch / Dynamic Island) ────────
    <div
      ref={containerRef}
      className="fixed inset-0 z-[100] bg-black text-white flex flex-col overflow-hidden select-none pt-safe pb-safe"
      data-testid="drive-mode"
      style={{ fontFamily: "Inter, system-ui, sans-serif" }}
    >
      {/* Header minimal — retour (←) + libellé + horloge + sortie */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          {/* Levier 6 — Bouton retour visible top-left */}
          <Link
            href="/"
            className="flex items-center justify-center rounded-full text-white hover:bg-white/10 active:bg-white/20 p-1.5 -ml-1.5 transition-colors"
            data-testid="button-back-drive"
            aria-label="Retour"
          >
            <ArrowLeft size={22} />
          </Link>
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

      {/* ── Bandeau fatigue (au-dessus des blocs XXL) ─────────────────────── */}
      <div className="px-4 pt-2">
        <FatigueBanner />
      </div>

      {/* Levier 6 — HERO XXL : 3 infos essentielles (Zone / Distance / €/h)
           Lisibles en un coup d'œil au volant. Le reste (blocs historiques)
           demeure accessible en zone secondaire scrollable ci-dessous. */}
      <div
        className="flex flex-col items-center justify-center text-center px-4 py-6 gap-3 shrink-0"
        data-testid="drive-hero"
      >
        {/* Zone active */}
        <div
          className="text-[56px] leading-none font-bold text-white truncate max-w-full"
          data-testid="drive-hero-zone"
        >
          {heroZoneName}
        </div>
        {/* Distance + ETA */}
        <div
          className="text-[36px] font-semibold text-gray-300 leading-none tabular-nums"
          data-testid="drive-hero-distance"
        >
          {heroDistanceLabel}
        </div>
        {/* €/h attendu */}
        <div
          className="text-[36px] font-bold text-green-400 leading-none tabular-nums"
          data-testid="drive-hero-eur-per-hour"
        >
          {heroEurPerHour != null ? `${heroEurPerHour} €/h` : "—"}
        </div>
      </div>

      {/* Zone secondaire scrollable — blocs XXL détaillés (existants) conservés */}
      {/* Corps — 4 grandes zones info — mobile : auto rows pour tenir sur 375px */}
      <div className="flex-1 grid grid-rows-[auto_1fr_1fr_1fr_1fr] sm:grid-rows-4 gap-3 sm:gap-4 p-3 sm:p-4 md:p-6 min-h-0 overflow-y-auto">
        {/* Bloc 1 — Où aller (zone active selon swipe ← →) */}
        <div className="rounded-3xl bg-emerald-500/10 border-2 border-emerald-500/40 flex items-center gap-4 md:gap-8 px-6 md:px-10 py-4 min-h-0">
          <Navigation size={64} className="text-emerald-400 shrink-0" strokeWidth={2.5} />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-emerald-300/80 font-bold mb-1">
              Aller maintenant
              {/* Indicateur de position si plusieurs zones disponibles */}
              {topZones.length > 1 && (
                <span className="ml-2 opacity-60">
                  {zoneIndex + 1}/{topZones.length}
                </span>
              )}
            </div>
            {activeZone?.zone ? (
              <>
                <div className="text-2xl sm:text-3xl md:text-5xl font-black text-emerald-100 leading-tight truncate">
                  {activeZone.zone.name}
                </div>
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 mt-2 text-emerald-200/90">
                  <span className="text-2xl md:text-4xl font-bold tabular-nums">
                    {haversineKm(position.lat, position.lng, activeZone.zone.lat, activeZone.zone.lng).toFixed(1)}
                    <span className="text-lg font-medium text-emerald-300/70 ml-1">km</span>
                  </span>
                  {(activeZone.eta_to_zone ?? activeZone.etaToZone) != null && (
                    <span className="text-xl md:text-2xl tabular-nums">
                      ETA {Math.round(activeZone.eta_to_zone ?? activeZone.etaToZone)}
                      <span className="text-sm text-emerald-300/70 ml-1">min</span>
                    </span>
                  )}
                  <span className="text-lg md:text-xl">
                    Score{" "}
                    <strong className="tabular-nums text-white">
                      {Math.round(activeZone.profitability_index ?? activeZone.profitabilityIndex ?? 0)}/100
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

        {/* Bloc 2 — Gain estimé (suit la zone active) */}
        <div className="rounded-3xl bg-amber-500/10 border-2 border-amber-500/40 flex items-center gap-4 md:gap-8 px-6 md:px-10 py-4 min-h-0">
          <div className="shrink-0 text-5xl md:text-6xl">💶</div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-amber-300/80 font-bold mb-1">
              Gain estimé
            </div>
            {activeZone ? (
              <>
                <div className="text-4xl sm:text-5xl md:text-7xl font-black text-amber-100 leading-none tabular-nums">
                  ~
                  {estimateRideGain({
                    avgDistanceKm: activeZone.avg_distance_km ?? activeZone.avgDistanceKm ?? 8,
                    surge: activeZone.surge_multiplier ?? activeZone.surgeMultiplier ?? 1,
                    longRideProbability: activeZone.long_ride_probability ?? activeZone.longRideProbability ?? 0,
                  })}
                  <span className="text-3xl md:text-4xl text-amber-300/80 ml-2">€</span>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 mt-2 text-amber-200/85 text-lg md:text-xl">
                  <span>
                    Distance moy.{" "}
                    <strong className="tabular-nums text-white">
                      {(activeZone.avg_distance_km ?? activeZone.avgDistanceKm ?? 0).toFixed(1)} km
                    </strong>
                  </span>
                  {(activeZone.surge_multiplier ?? activeZone.surgeMultiplier ?? 1) > 1.1 && (
                    <span className="font-bold text-amber-300">
                      ⚡ Surge ×{(activeZone.surge_multiplier ?? activeZone.surgeMultiplier).toFixed(2)}
                    </span>
                  )}
                  <span>
                    Longue{" "}
                    <strong className="tabular-nums text-white">
                      {Math.round((activeZone.long_ride_probability ?? activeZone.longRideProbability ?? 0) * 100)}%
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
                  className={`text-4xl sm:text-6xl md:text-8xl font-black leading-none tabular-nums ${
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
        {/* Bloc 4 — Objectif journalier */}
        <DailyGoalBar variant="xxl" />
      </div>

      {/* ── Hint swipe — visible uniquement sur mobile (sm:hidden) ──────────
           Rappel discret des gestes disponibles en mode conduite          */}
      <div className="sm:hidden text-center pb-1">
        <span className="text-[10px] text-muted-foreground opacity-40">
          ← → zones · ↓ retour · ↑ alertes
        </span>
      </div>

      {/* Bandeau bas — position GPS + horloge secondaire */}
      <div className="border-t border-white/10 px-6 py-2 flex items-center justify-between text-[11px] text-white/50">
        <span>
          📍 GPS {position.lat.toFixed(4)}, {position.lng.toFixed(4)}
        </span>
        <span>vtc-one · mode conduite</span>
        <FuelAutonomyBadge />
      </div>
    </div>
  );
}
