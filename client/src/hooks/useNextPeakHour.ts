/**
 * useNextPeakHour — Détecte le prochain créneau plus rentable
 * ─────────────────────────────────────────────────────────────────────────────
 * Interroge /api/profitability?hour=H pour les 6 prochaines heures et trouve
 * la première heure dont le score max dépasse le score courant d'au moins
 * PEAK_MARGIN_PTS points. Retourne l'heure cible, le score attendu, et le
 * countdown en minutes.
 *
 * Rafraîchi toutes les 5 min (les scores heure-par-heure changent peu) et
 * un tick d'horloge 30s met à jour l'affichage du countdown.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

const PEAK_MARGIN_PTS = 8;      // seuil pour considérer une heure comme "pic"
const LOOKAHEAD_HOURS = 6;      // fenêtre d'analyse

interface HourlyMax {
  hour: number;
  maxScore: number;
  bestZoneId?: string;
  bestZoneName?: string;
}

export interface NextPeak {
  /** Heure cible (0-23). null si aucun pic détecté. */
  hour: number | null;
  /** Score de profitabilité attendu (0-100). */
  score: number;
  /** Nom de la zone au pic. */
  zoneName?: string;
  /** Minutes restantes avant le pic. */
  minutesUntil: number;
  /** true si le pic est dans <1h — code couleur imminent. */
  imminent: boolean;
  /** true si le pic est "maintenant ou déjà passé" — pas d'affichage. */
  isNow: boolean;
  /** Score de l'heure courante (référence). */
  currentScore: number;
  /** État du chargement. */
  isLoading: boolean;
}

async function fetchHourMax(hour: number, dayType: string): Promise<HourlyMax> {
  const res = await apiRequest(
    "GET",
    `/api/top-zones?hour=${hour}&dayType=${dayType}&limit=1`,
  );
  const data = (await res.json()) as any[];
  const top = data[0];
  return {
    hour,
    maxScore: top?.profitability_index ?? top?.profitabilityIndex ?? 0,
    bestZoneId: top?.zone_id,
    bestZoneName: top?.zone?.name,
  };
}

export function useNextPeakHour(): NextPeak {
  const now = new Date();
  const currentHour = now.getHours();
  const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";

  // Génère la liste des heures à interroger (courant + 6 suivantes)
  const hours = Array.from({ length: LOOKAHEAD_HOURS + 1 }, (_, i) => (currentHour + i) % 24);

  const { data: hourly = [], isLoading } = useQuery<HourlyMax[]>({
    queryKey: ["/api/profitability-hourly-forecast", currentHour, dayType],
    queryFn: async () => Promise.all(hours.map((h) => fetchHourMax(h, dayType))),
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
  });

  // Tick d'horloge (30s) pour rafraîchir le countdown sans refetch backend
  const [clockTick, setClockTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClockTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const nowTs = new Date(clockTick);
  const currentScore = hourly[0]?.maxScore ?? 0;

  // Cherche le premier pic (score > courant + marge) dans la fenêtre
  let peakEntry: HourlyMax | undefined;
  for (let i = 1; i < hourly.length; i++) {
    if (hourly[i] && hourly[i].maxScore >= currentScore + PEAK_MARGIN_PTS) {
      peakEntry = hourly[i];
      break;
    }
  }

  // Fallback : si aucun pic > courant, prendre le max de la fenêtre s'il est >= 60
  if (!peakEntry) {
    const best = [...hourly.slice(1)].sort((a, b) => b.maxScore - a.maxScore)[0];
    if (best && best.maxScore >= 60 && best.maxScore >= currentScore + 3) {
      peakEntry = best;
    }
  }

  if (!peakEntry) {
    return {
      hour: null,
      score: 0,
      minutesUntil: 0,
      imminent: false,
      isNow: false,
      currentScore,
      isLoading,
    };
  }

  // Calcul minutes jusqu'au pic (heure pleine)
  const target = new Date(nowTs);
  const hourDelta = peakEntry.hour < currentHour
    ? peakEntry.hour + 24 - currentHour
    : peakEntry.hour - currentHour;
  target.setHours(nowTs.getHours() + hourDelta, 0, 0, 0);
  const minutesUntil = Math.max(0, Math.round((target.getTime() - nowTs.getTime()) / 60_000));

  return {
    hour: peakEntry.hour,
    score: Math.round(peakEntry.maxScore),
    zoneName: peakEntry.bestZoneName,
    minutesUntil,
    imminent: minutesUntil <= 60,
    isNow: minutesUntil <= 5,
    currentScore,
    isLoading,
  };
}

export default useNextPeakHour;
