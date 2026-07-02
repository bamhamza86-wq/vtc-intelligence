/**
 * useRareEventAlert — Détection des événements rares haute valeur
 * ─────────────────────────────────────────────────────────────────────────────
 * Interroge /api/events, filtre selon trois critères de rareté :
 *   - Vol avec prévision retard ≥ 30 min  (flight_forecast + delay_minutes)
 *   - Événement PredictHQ rang ≥ 80       (phq_rank)
 *   - Boost météo ≥ 0.3                   (weather_boost)
 *
 * Le dismiss local est persisté dans localStorage avec TTL de 15 min.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback } from "react";
import { useSmartQueryRefresh } from "./useSmartQueryRefresh";
import { apiRequest } from "@/lib/queryClient";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RareEventType = "flight" | "phq" | "weather";

export interface RareEvent {
  id: string;
  title: string;
  type: RareEventType;
  estimated_gain_eur: number;
  travel_min: number;
  zone_id?: string;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const DISMISS_TTL_MS = 15 * 60 * 1000; // 15 minutes
const LS_PREFIX = "vtc.rare_dismissed.";

// ─── Helpers localStorage ─────────────────────────────────────────────────────

function isDismissed(id: string): boolean {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${id}`);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { expires_at: number };
    if (Date.now() > parsed.expires_at) {
      localStorage.removeItem(`${LS_PREFIX}${id}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function markDismissed(id: string): void {
  try {
    localStorage.setItem(
      `${LS_PREFIX}${id}`,
      JSON.stringify({ expires_at: Date.now() + DISMISS_TTL_MS })
    );
  } catch {
    /* localStorage indisponible — ignore */
  }
}

// ─── Score de rareté ─────────────────────────────────────────────────────────

interface EventCandidate {
  id: string | number;
  name?: string;
  zone_id?: string;
  event_type?: string;
  // champs vols
  flight_forecast?: boolean;
  delay_minutes?: number;
  // champs PredictHQ
  phq_rank?: number;
  rank?: number;
  // champs météo
  weather_boost?: number;
  // champs estimation financière
  demand_boost?: number;
  estimated_revenue?: number;
}

interface ScoredEvent {
  event: EventCandidate;
  score: number;
  type: RareEventType;
}

function scoreEvent(e: EventCandidate): ScoredEvent | null {
  let score = 0;
  let type: RareEventType | null = null;

  // Critère vol avec retard ≥ 30 min
  const isFlightForecast =
    e.event_type === "flight_forecast" || Boolean(e.flight_forecast);
  const delayMin = e.delay_minutes ?? 0;
  if (isFlightForecast && delayMin >= 30) {
    score += 1 + delayMin / 60;
    type = "flight";
  }

  // Critère PredictHQ rang ≥ 80
  const phqRank = e.phq_rank ?? e.rank ?? 0;
  if (phqRank >= 80) {
    score += (phqRank - 80) / 20 + 1; // +1 à rank=80, +2 à rank=100
    if (!type) type = "phq";
  }

  // Critère boost météo ≥ 0.3
  const weatherBoost = e.weather_boost ?? 0;
  if (weatherBoost >= 0.3) {
    score += weatherBoost;
    if (!type) type = "weather";
  }

  if (!type || score <= 0) return null;
  return { event: e, score, type };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseRareEventAlertResult {
  rareEvent: RareEvent | null;
  dismissRareEvent: () => void;
}

export function useRareEventAlert(): UseRareEventAlertResult {
  // Migration vers useSmartQueryRefresh : pulse 30s tab active + auto-pause en arrière-plan
  const { data: events = [] } = useSmartQueryRefresh<EventCandidate[]>(
    ["/api/events"],
    () => apiRequest("GET", "/api/events").then((r) => r.json()),
  );

  // Filtrer, scorer, trier, exclure les events déjà dismissés
  const candidates: ScoredEvent[] = (events as EventCandidate[])
    .map(scoreEvent)
    .filter((s): s is ScoredEvent => s !== null)
    .filter((s) => !isDismissed(String(s.event.id)))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0] ?? null;

  let rareEvent: RareEvent | null = null;
  if (best) {
    const e = best.event;
    // Estimation du gain : basée sur demand_boost * valeur de base 30€
    const boost = e.demand_boost ?? 1.5;
    const estimatedGain = Math.round(30 * (boost - 1) * 10) / 10;
    rareEvent = {
      id: String(e.id),
      title: e.name ?? "Événement rare détecté",
      type: best.type,
      estimated_gain_eur: Math.max(estimatedGain, 5),
      travel_min: 15, // estimation par défaut si non fourni
      zone_id: e.zone_id,
    };
  }

  const dismissRareEvent = useCallback(() => {
    if (best) {
      markDismissed(String(best.event.id));
    }
  }, [best]);

  return { rareEvent, dismissRareEvent };
}
