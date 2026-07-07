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
import FatigueCoachBanner from "@/components/FatigueCoachBanner";
import { DailyGoalBar } from "@/components/DailyGoalBar";
import { FuelAutonomyBadge } from "@/components/FuelAutonomyBadge";
import { RouteSourceBadge } from "@/components/RouteSourceBadge";
import { useSwipe } from "@/hooks/useSwipe";
import { haptic, haptics } from "@/lib/haptics";
import { ZoneEmptyingToast } from "@/components/ZoneEmptyingToast";
import { DriveTimer } from "@/components/DriveTimer";
import { EmergencyButton } from "@/components/EmergencyButton";
import { useSwipeAcceptRefuse } from "@/hooks/useSwipeAcceptRefuse";
import { Check, XCircle } from "lucide-react";

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

  // ── Geste accepter/refuser sur la carte de recommandation (pointer events) ──
  // Swipe droite = j'accepte cette zone (confirmation + haptique positif).
  // Swipe gauche = je refuse → passe à l'alternative suivante (haptique alerte).
  const [lastAction, setLastAction] = useState<"accept" | "refuse" | null>(null);
  const { dragX, dragging, handlers: recoDragHandlers } = useSwipeAcceptRefuse({
    threshold: 80,
    onAccept: () => {
      haptics.opportunity();
      setLastAction("accept");
      window.setTimeout(() => setLastAction(null), 1200);
    },
    onRefuse: () => {
      haptics.alert();
      setLastAction("refuse");
      if (topZones.length > 1) {
        setZoneIndex((i) => (i + 1) % topZones.length);
      }
      window.setTimeout(() => setLastAction(null), 1200);
    },
  });

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
      {/* Header minimal — retour (←) + libellé + horloge + sortie (tap-targets ≥ 44px) */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 gap-2">
        <Link
          href="/"
          className="flex items-center justify-center rounded-full text-white hover:bg-white/10 active:bg-white/20 transition-colors shrink-0"
          style={{ minWidth: 44, minHeight: 44 }}
          data-testid="button-back-drive"
          aria-label="Retour"
        >
          <ArrowLeft size={24} />
        </Link>
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-[10px] uppercase tracking-widest text-emerald-400 font-bold truncate">
            Mode conduite
          </span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
        </div>
        <div className="text-xl font-mono tabular-nums font-bold text-white/90 shrink-0">
          {now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
        </div>
        <Link
          href="/"
          className="flex items-center gap-1.5 rounded-full border border-white/20 hover:bg-white/10 active:bg-white/20 px-3 text-sm font-medium transition-colors shrink-0"
          style={{ minHeight: 44 }}
          data-testid="button-exit-drive"
          aria-label="Sortir du mode conduite"
        >
          <X size={16} /> <span>Sortir</span>
        </Link>
      </div>

      {/* ── Levier sécurité — Timer conduite continue (seuil légal indicatif) ── */}
      <DriveTimer />

      {/* ── Bandeau fatigue (au-dessus des blocs XXL) ─────────────────────── */}
      <div className="px-4 pt-2">
        <FatigueBanner />
      </div>

      {/* --- Couche Aeroports/Evenements/Greves (Iteration 3) : timer priorite + fin evenement + queue aeroport --- */}
      <div className="px-4 pt-2 space-y-2">
        <PriorityTimer />
        <EventEndingBanner />
        <AirportQueueCard />
      </div>

      {/* ─── Corps scrollable — flex-col (fini la grille rigide) ────────────────
           Chaque bloc prend sa hauteur naturelle. Le HERO XXL redondant est
           supprimé : la zone active est déjà en tête du bloc 1. Sur 375px on
           lit tout en scrollant, sans overlap. */}
      <div className="flex-1 flex flex-col gap-3 p-3 sm:p-4 md:p-6 min-h-0 overflow-y-auto">

        {/* Bloc 1 — Où aller (zone active selon swipe ← →) — draggable accepter/refuser */}
        <div
          {...recoDragHandlers}
          className="relative rounded-2xl bg-emerald-500/10 border-2 border-emerald-500/40 flex items-start gap-3 md:gap-6 px-4 md:px-10 py-4 touch-pan-y"
          style={{
            transform: `translateX(${dragX}px) rotate(${dragX / 30}deg)`,
            transition: dragging ? "none" : "transform 0.25s ease-out",
            cursor: dragging ? "grabbing" : "grab",
          }}
          data-testid="reco-swipe-card"
        >
          {dragX > 20 && (
            <div
              className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-emerald-500 text-black px-3 py-1 font-black text-xs z-10"
              style={{ opacity: Math.min(1, dragX / 80) }}
            >
              <Check size={14} /> J'ACCEPTE
            </div>
          )}
          {dragX < -20 && (
            <div
              className="absolute top-2 left-2 flex items-center gap-1 rounded-full bg-rose-500 text-white px-3 py-1 font-black text-xs z-10"
              style={{ opacity: Math.min(1, -dragX / 80) }}
            >
              <XCircle size={14} /> JE REFUSE
            </div>
          )}
          <Navigation size={44} className="text-emerald-400 shrink-0 mt-1 md:size-16" strokeWidth={2.5} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-emerald-300/80 font-bold mb-1">
              <span>Aller maintenant</span>
              {topZones.length > 1 && (
                <span className="opacity-60">{zoneIndex + 1}/{topZones.length}</span>
              )}
              <span className="ml-auto">
                <RouteSourceBadge source={activeZone?.distance_source ?? "calibrated"} size="xs" />
              </span>
            </div>
            {activeZone?.zone ? (
              <>
                <div className="text-2xl sm:text-3xl md:text-5xl font-black text-emerald-100 leading-tight break-words">
                  {activeZone.zone.name}
                </div>
                <div className="mt-2 space-y-0.5 text-emerald-200/90">
                  <div className="flex items-baseline gap-3 text-lg md:text-2xl tabular-nums">
                    <span className="font-bold">
                      {haversineKm(position.lat, position.lng, activeZone.zone.lat, activeZone.zone.lng).toFixed(1)}
                      <span className="text-sm font-medium text-emerald-300/70 ml-1">km</span>
                    </span>
                    {(activeZone.eta_to_zone ?? activeZone.etaToZone) != null && (
                      <span>
                        ETA {Math.round(activeZone.eta_to_zone ?? activeZone.etaToZone)}
                        <span className="text-sm text-emerald-300/70 ml-1">min</span>
                      </span>
                    )}
                  </div>
                  <div className="text-sm md:text-base">
                    Score{" "}
                    <strong className="tabular-nums text-white">
                      {Math.round(activeZone.profitability_index ?? activeZone.profitabilityIndex ?? 0)}/100
                    </strong>
                    {heroEurPerHour != null && (
                      <span className="ml-3 text-green-300 font-semibold">
                        · ~{heroEurPerHour} €/h
                      </span>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-xl text-emerald-300/60">
                {isLoading ? "Chargement…" : "Aucune donnée"}
              </div>
            )}
          </div>
        </div>

        {/* Bloc 2 — Gain estimé (suit la zone active) */}
        <div className="rounded-2xl bg-amber-500/10 border-2 border-amber-500/40 flex items-start gap-3 md:gap-6 px-4 md:px-10 py-4">
          <div className="shrink-0 text-3xl md:text-6xl mt-1">💶</div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-amber-300/80 font-bold mb-1">
              Gain estimé
            </div>
            {activeZone ? (
              <>
                <div className="text-3xl sm:text-4xl md:text-6xl font-black text-amber-100 leading-none tabular-nums">
                  ~
                  {estimateRideGain({
                    avgDistanceKm: activeZone.avg_distance_km ?? activeZone.avgDistanceKm ?? 8,
                    surge: activeZone.surge_multiplier ?? activeZone.surgeMultiplier ?? 1,
                    longRideProbability: activeZone.long_ride_probability ?? activeZone.longRideProbability ?? 0,
                  })}
                  <span className="text-xl md:text-3xl text-amber-300/80 ml-1">€</span>
                </div>
                <div className="mt-2 text-sm md:text-base text-amber-200/85 space-y-0.5">
                  <div>
                    Dist. moy.{" "}
                    <strong className="tabular-nums text-white">
                      {(activeZone.avg_distance_km ?? activeZone.avgDistanceKm ?? 0).toFixed(1)} km
                    </strong>
                    <span className="ml-3">
                      Longue{" "}
                      <strong className="tabular-nums text-white">
                        {Math.round((activeZone.long_ride_probability ?? activeZone.longRideProbability ?? 0) * 100)}%
                      </strong>
                    </span>
                  </div>
                  {(activeZone.surge_multiplier ?? activeZone.surgeMultiplier ?? 1) > 1.1 && (
                    <div className="font-bold text-amber-300">
                      ⚡ Surge ×{(activeZone.surge_multiplier ?? activeZone.surgeMultiplier).toFixed(2)}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-xl text-amber-300/60">—</div>
            )}
          </div>
        </div>

        {/* Bloc 3 — Countdown prochain pic */}
        <div
          className={`rounded-2xl border-2 flex items-start gap-3 md:gap-6 px-4 md:px-10 py-4 ${
            nextPeak.imminent
              ? "bg-red-500/10 border-red-500/60"
              : nextPeak.hour != null
                ? "bg-sky-500/10 border-sky-500/40"
                : "bg-white/5 border-white/15"
          }`}
        >
          <TrendingUp
            size={44}
            className={`shrink-0 mt-1 md:size-16 ${nextPeak.imminent ? "text-red-400 animate-pulse" : nextPeak.hour != null ? "text-sky-400" : "text-white/40"}`}
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
                  className={`text-3xl sm:text-5xl md:text-7xl font-black leading-none tabular-nums ${
                    nextPeak.imminent ? "text-red-100" : "text-sky-100"
                  }`}
                >
                  {fmtCountdown(nextPeak.minutesUntil)}
                </div>
                <div
                  className={`mt-2 text-sm md:text-base space-y-0.5 ${
                    nextPeak.imminent ? "text-red-200/85" : "text-sky-200/85"
                  }`}
                >
                  <div>
                    Score <strong className="tabular-nums text-white">{nextPeak.score}/100</strong>
                    <span className="text-white/60 ml-2">
                      à {String(nextPeak.hour).padStart(2, "0")}:00
                    </span>
                  </div>
                  {nextPeak.zoneName && (
                    <div className="truncate">
                      → <strong className="text-white">{nextPeak.zoneName}</strong>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-lg md:text-3xl text-white/50 font-semibold">
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
          ← → zones · ↓ retour · ↑ alertes · glisser la reco pour accepter/refuser
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
      <FatigueCoachBanner />
      {/* ─── Couche Communautaire : toast "zone en train de se vider" ─── */}
      <ZoneEmptyingToast />
      {/* ─── Couche Sécurité : bouton SOS flottant (appui long 800ms) ─── */}
      <EmergencyButton />
    </div>
  );
}
