/**
 * useDaySignal — Signal émotionnel global de la journée (VERT / ORANGE / ROUGE)
 * ─────────────────────────────────────────────────────────────────────────────
 * Agrège les données des 3 prochaines heures (heure courante + 2 suivantes)
 * via /api/top-zones pour calculer un score journée 0-100.
 *
 * Score = moyenne pondérée des top-3 zones par heure :
 *   profitability_index × surge_multiplier × phq_boost
 * Normalisé sur 100 via plafonnement à MAX_RAW.
 *
 * Seuils :
 *   green  ≥ 65  → "Reste dehors"
 *   orange 40-64 → "Attends"
 *   red    < 40  → "Rentre ou pause"
 *
 * Rafraîchi toutes les 2 minutes.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useSmartQueryRefresh } from "./useSmartQueryRefresh";
import { apiRequest } from "@/lib/queryClient";

// ─── Constantes ───────────────────────────────────────────────────────────────

// REFRESH_INTERVAL supprimé — géré par useSmartQueryRefresh (30s tab active, 5min masquée)
const STALE_TIME       = 90_000;       // 90s
const TOP_ZONES_LIMIT  = 5;
/** Valeur brute max attendue avant normalisation → 100 */
const MAX_RAW = 130;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DaySignal {
  /** État émotionnel global de la journée. */
  state: "green" | "orange" | "red";
  /** Libellé court affiché dans la pastille. */
  label: string;
  /** Score agrégé 0-100. */
  score: number;
  /** Explication détaillée pour le tooltip. */
  reason: string;
  /** true pendant le chargement initial. */
  isLoading: boolean;
}

interface RawTopZone {
  profitability_index?: number;
  profitabilityIndex?: number;
  surge_multiplier?: number;
  surgeMultiplier?: number;
  phq_boost?: number;
  phqBoost?: number;
  zone?: { name?: string };
}

// ─── Fetch d'une heure ───────────────────────────────────────────────────────

async function fetchTopZonesForHour(hour: number): Promise<RawTopZone[]> {
  const res = await apiRequest("GET", `/api/top-zones?hour=${hour}&limit=${TOP_ZONES_LIMIT}`);
  return res.json() as Promise<RawTopZone[]>;
}

// ─── Calcul du score à partir des zones d'une heure ─────────────────────────

function scoreFromZones(zones: RawTopZone[]): number {
  const top3 = zones.slice(0, 3);
  if (top3.length === 0) return 0;
  const values = top3.map((z) => {
    const profIdx  = z.profitability_index ?? z.profitabilityIndex ?? 0;
    const surge    = z.surge_multiplier    ?? z.surgeMultiplier    ?? 1;
    const phqBoost = z.phq_boost           ?? z.phqBoost           ?? 1;
    return profIdx * surge * phqBoost;
  });
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  // Normalise : plafonne à MAX_RAW → 100
  return Math.min(100, Math.round((avg / MAX_RAW) * 100));
}

// ─── Construction du signal à partir des 3 scores horaires ──────────────────

function buildSignal(
  hours: number[],
  allZones: RawTopZone[][],
): Omit<DaySignal, "isLoading"> {
  const scores = allZones.map(scoreFromZones);
  // Moyenne pondérée : heure courante compte double
  const weights = [2, 1, 1];
  const totalWeight = weights.slice(0, scores.length).reduce((a, b) => a + b, 0);
  const weightedSum = scores.reduce((sum, s, i) => sum + s * (weights[i] ?? 1), 0);
  const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  // Détection des pics (zones avec score horaire brut > 75 sur les 2h suivantes)
  const futurePics = scores.slice(1).filter((s) => s >= 65).length;
  const surgeVals  = allZones
    .flat()
    .slice(0, 15)
    .map((z) => z.surge_multiplier ?? z.surgeMultiplier ?? 1)
    .filter((s) => s > 1.1);
  const avgSurge = surgeVals.length
    ? surgeVals.reduce((a, b) => a + b, 0) / surgeVals.length
    : 1;

  // ─── Seuils ────────────────────────────────────────────────────────────────
  let state: DaySignal["state"];
  let label: string;
  let reason: string;

  if (score >= 65) {
    state = "green";
    label = "Reste dehors";
    reason =
      futurePics > 0
        ? `${futurePics} pic${futurePics > 1 ? "s" : ""} ≥65 dans les 2h · surge moyen ${avgSurge.toFixed(1)}×`
        : `Score global ${score}/100 · surge moyen ${avgSurge.toFixed(1)}×`;
  } else if (score >= 40) {
    state = "orange";
    label = "Attends";
    reason =
      futurePics > 0
        ? `Activité modérée · ${futurePics} pic${futurePics > 1 ? "s" : ""} attendu${futurePics > 1 ? "s" : ""} dans les 2h`
        : `Score global ${score}/100 · activité modérée`;
  } else {
    state = "red";
    label = "Rentre ou pause";
    reason = `Score global ${score}/100 · faible activité sur les 3h à venir`;
  }

  return { state, label, score, reason };
}

// ─── Hook principal ───────────────────────────────────────────────────────────

export function useDaySignal(): DaySignal {
  const now = new Date();
  const currentHour = now.getHours();
  // Heures : courante + 2 suivantes
  const hours = [
    currentHour,
    (currentHour + 1) % 24,
    (currentHour + 2) % 24,
  ];

  // Migration vers useSmartQueryRefresh : pulse 30s tab active + auto-pause en arrière-plan
  const { data, isLoading } = useSmartQueryRefresh<RawTopZone[][]>(
    ["/api/day-signal", currentHour],
    () => Promise.all(hours.map(fetchTopZonesForHour)),
    { staleTime: STALE_TIME, retry: 1 },
  );

  if (isLoading || !data) {
    return {
      state: "orange",
      label: "Chargement…",
      score: 50,
      reason: "Calcul du signal en cours…",
      isLoading: true,
    };
  }

  return {
    ...buildSignal(hours, data),
    isLoading: false,
  };
}

export default useDaySignal;
