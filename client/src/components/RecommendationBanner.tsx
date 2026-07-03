/**
 * RecommendationBanner — Bandeau « Où aller maintenant » (Levier 2 + 4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Sticky en haut de MapPage. Affiche la meilleure zone (score effectif × distance)
 * calculée côté serveur via /api/best-zone-now, plus un compte à rebours live vers
 * le prochain pic de rentabilité via /api/next-peak.
 *
 * Sources de données :
 *   - /api/best-zone-now?lat=..&lng=..  → refetch 3s (position GPS temps réel)
 *   - /api/next-peak                    → refetch 30s (moyennes horaires stables)
 *
 * Fond dynamique selon score_effectif :
 *   > 70   → vert    (zone chaude)
 *   40–70  → orange  (zone tiède)
 *   < 40   → gris    (zone froide)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";

// ─── Forme de la réponse /api/best-zone-now ──────────────────────────────────
interface BestZone {
  zone_id: string;
  name: string;
  lat: number;
  lng: number;
  score: number;
  score_effectif: number;
  distance_km: number;
  predicted: number;
  upper_bound: number;
  _ts: number;
  error?: string;
}

// ─── Forme de la réponse /api/next-peak ──────────────────────────────────────
interface NextPeak {
  next_peak_hour: number | null;
  minutes_until: number;
  expected_score: number;
  _ts: number;
}

export function RecommendationBanner() {
  const { position } = useGpsPosition();

  // ─── Levier 2 : meilleure zone maintenant (refetch 3s, GPS temps réel) ─────
  const { data: best } = useQuery<BestZone>({
    queryKey: ["/api/best-zone-now", position.lat, position.lng],
    queryFn: () =>
      apiRequest("GET", `/api/best-zone-now?lat=${position.lat}&lng=${position.lng}`).then(r => r.json()),
    refetchInterval: 3000,
  });

  // ─── Levier 4 : prochain pic de rentabilité (refetch 30s) ──────────────────
  const { data: peak } = useQuery<NextPeak>({
    queryKey: ["/api/next-peak"],
    queryFn: () => apiRequest("GET", "/api/next-peak").then(r => r.json()),
    refetchInterval: 30000,
  });

  // ─── Timer live : décrément JS local du compte à rebours (1s) ──────────────
  const [minutesLeft, setMinutesLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!peak || peak.next_peak_hour === null || peak.minutes_until < 0) {
      setMinutesLeft(null);
      return;
    }
    // Base = minutes serveur ; on décrémente localement en tenant compte du temps écoulé.
    const baseMinutes = peak.minutes_until;
    const baseTs = peak._ts;
    const tick = () => {
      const elapsedMin = (Date.now() - baseTs) / 60000;
      setMinutesLeft(Math.max(0, Math.round(baseMinutes - elapsedMin)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [peak]);

  // Pas de données exploitables → on n'affiche rien.
  if (!best || best.error || best.score_effectif === undefined) return null;

  // ─── Palette dynamique selon score effectif ────────────────────────────────
  const scoreEff = best.score_effectif;
  let tone = "bg-gray-100 border-gray-400 text-gray-700";
  if (scoreEff > 70) tone = "bg-green-100 border-green-500 text-green-900";
  else if (scoreEff >= 40) tone = "bg-orange-100 border-orange-500 text-orange-900";

  // ─── Deeplink Google Maps « Y aller » ──────────────────────────────────────
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${best.lat},${best.lng}&travelmode=driving`;

  return (
    <div
      data-testid="recommendation-banner"
      className={`sticky top-0 z-[1200] flex flex-col gap-1 border-b-2 px-4 py-3 shadow-md sm:flex-row sm:items-center sm:justify-between ${tone}`}
    >
      {/* ── Bloc texte : zone + score + distance + countdown ── */}
      <div className="flex flex-col">
        <span className="text-lg font-extrabold leading-tight sm:text-xl" data-testid="recommendation-zone-name">
          {best.name}
        </span>
        <span className="text-sm font-medium opacity-90" data-testid="recommendation-score-line">
          Score {best.score_effectif} · {best.distance_km} km
        </span>
        {minutesLeft !== null && (
          <span className="text-xs font-semibold opacity-80" data-testid="recommendation-peak-timer">
            ⏱️ Prochain pic dans {minutesLeft} min
          </span>
        )}
      </div>

      {/* ── Bouton Y aller (deeplink navigation) ── */}
      <a
        href={mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="recommendation-go-button"
        className="mt-1 inline-flex items-center justify-center rounded-lg bg-black/80 px-4 py-2 text-sm font-bold text-white shadow hover:bg-black sm:mt-0"
      >
        🗺️ Y aller
      </a>
    </div>
  );
}
