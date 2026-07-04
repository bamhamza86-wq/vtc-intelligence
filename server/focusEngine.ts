/**
 * focusEngine.ts — Moteur de recommandation « Focus » (Lot C)
 * ─────────────────────────────────────────────────────────────────────────────
 * Synthétise en UNE seule recommandation actionnable les signaux déjà calculés
 * ailleurs dans l'app (scores de zones, événements PredictHQ, vols, trains,
 * communauté, fatigue, autonomie carburant) — conformément à bench_vtc.md §2 :
 * « la vraie valeur ajoutée est de combiner ces strates en une seule
 * recommandation simple plutôt que de multiplier les cartes à interpréter ».
 *
 * Principe : ce moteur NE RECALCULE PAS de scoring — il réutilise massivement
 * storage.ts (getProfitabilityByHour, getActiveEvents, getBestZoneNow,
 * getCommunityImpact) et les services externes (flightService, sncfService)
 * déjà branchés côté serveur. Aucun nouveau modèle de scoring n'est inventé ici.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { storage } from "./storage";
import { getFlightData, getFlightBoostForZone } from "./flightService";
import { getSncfSignalsSync } from "./sncfService";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FocusVerb = "aller" | "rester" | "pause" | "rentrer";

export interface FocusAlternative {
  verb: string;
  zoneName: string;
  reasonShort: string;
}

export interface FocusRecommendation {
  id: string;
  verb: FocusVerb;
  zoneName: string;
  zoneId: string | null;
  distanceKm: number | null;
  etaMin: number | null;
  reasonShort: string;
  expectedGainEuros: number | null;
  confidence: number; // 0..1
  validUntil: number; // epoch ms
  alternatives: FocusAlternative[];
}

export interface FocusInputContext {
  lat: number;
  lng: number;
  /** Heures de conduite continue déclarées côté client (localStorage) — optionnel. */
  sessionHoursDriven?: number;
  /** Autonomie carburant restante en pourcentage (0-100) — optionnel. */
  fuelAutonomyPct?: number;
}

// ─── Constantes de seuils métier ───────────────────────────────────────────────

const PAUSE_AFTER_HOURS = 4; // session continue > 4h → suggestion pause (brief Lot C)
const LOW_FUEL_PCT = 15; // autonomie < 15% → rentrer
const TOP_N_FOR_REST = 3; // zone actuelle "top-3" → rester si événement actif
const EVENT_WINDOW_MIN = 60; // événement PredictHQ actif dans les 60 min
const TRANSPORT_WINDOW_MIN = 30; // vol/train dans les 30 min

const VALID_FOR_MS = 3 * 60 * 1000; // recommandation valable 3 min (cohérent avec cache 30s + marge)

// ─── Helpers ────────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

function currentHourAndDayType(): { hour: number; dayType: string } {
  const now = new Date();
  const hour = (now.getUTCHours() + 2) % 24; // heure locale Paris (cohérent avec storage.ts)
  const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";
  return { hour, dayType };
}

/** Estimation ETA grossière à partir de la distance à vol d'oiseau (30 km/h moyen urbain IDF). */
function estimateEtaMin(distanceKm: number): number {
  const AVG_SPEED_KMH = 30;
  return Math.max(1, Math.round((distanceKm / AVG_SPEED_KMH) * 60));
}

/** Estimation basse du gain, conservatrice (cf. geoDistance.ts côté client — logique répliquée simplifiée). */
function estimateGainLowEuros(score: number, longRideProbability: number): number {
  const BASE_FARE = 5;
  const PRICE_PER_KM = 1.4;
  const avgDistanceKm = 5; // hypothèse basse
  const longRideBonus = longRideProbability > 0.4 ? longRideProbability * 6 : 0; // bonus atténué (estimation "basse")
  const surgeFactor = Math.max(1, score / 60); // score élevé → petite prime, conservateur
  const gross = (BASE_FARE + PRICE_PER_KM * avgDistanceKm + longRideBonus) * Math.min(surgeFactor, 1.3);
  return Math.round(gross);
}

// ─── Moteur principal ──────────────────────────────────────────────────────────

/**
 * Calcule la recommandation Focus unique à partir du contexte chauffeur.
 *
 * Algorithme (dans l'ordre de priorité) :
 *   1. Fatigue    : si sessionHoursDriven > 4h continues → verb "pause" (aire/zone calme la plus proche).
 *   2. Autonomie  : si fuelAutonomyPct < 15% → verb "rentrer" (ou station-service/zone base).
 *   3. Rester     : si la zone actuelle du chauffeur est dans le top-3 de rentabilité ET
 *                   qu'un événement (PredictHQ/vol/train) est actif dans la fenêtre pertinente
 *                   → verb "rester".
 *   4. Aller      : sinon, on prend le meilleur score de rentabilité pondéré par :
 *                     - distance (pénalité type getBestZoneNow : score × exp(-dist/10))
 *                     - boost vols (si zone aéroport, vols dans les 30 min)
 *                     - boost trains SNCF (si zone gare, signal actif)
 *                     - boost PredictHQ (événement actif dans les 60 min)
 *                   → verb "aller" vers la zone au meilleur score pondéré.
 *
 * Les 2 meilleures alternatives (hors zone retenue) sont retournées en secours.
 */
export function computeFocusRecommendation(ctx: FocusInputContext): FocusRecommendation {
  const { hour, dayType } = currentHourAndDayType();
  const now = Date.now();

  // ─── 1. Fatigue — priorité maximale ────────────────────────────────────────
  if (ctx.sessionHoursDriven !== undefined && ctx.sessionHoursDriven > PAUSE_AFTER_HOURS) {
    return buildPauseRecommendation(ctx, now);
  }

  // ─── 2. Autonomie carburant critique ───────────────────────────────────────
  if (ctx.fuelAutonomyPct !== undefined && ctx.fuelAutonomyPct < LOW_FUEL_PCT) {
    return buildRentrerRecommendation(ctx, now);
  }

  // ─── Données brutes réutilisées de storage.ts ──────────────────────────────
  const scores = (storage.getProfitabilityByHour(hour, dayType) as any[]) || [];
  const activeEvents = (storage.getActiveEvents() as any[]) || [];
  const zones = (storage.getAllZones() as any[]) || [];
  const zoneById = new Map(zones.map((z) => [z.id, z]));

  // ─── Score effectif = profitability_index pondéré par distance + boosts ────
  const scored = scores.map((s) => {
    const zone = zoneById.get(s.zone_id);
    const lat = zone?.lat ?? s.lat;
    const lng = zone?.lng ?? s.lng;
    const distanceKm = lat != null && lng != null ? haversineKm(ctx.lat, ctx.lng, lat, lng) : 999;

    let boost = 1.0;
    let reasonParts: string[] = [];

    // Boost événement PredictHQ actif dans les 60 min sur cette zone
    const zoneEvent = activeEvents.find((e) => e.zone_id === s.zone_id && (e.demand_boost ?? 1) > 1.1);
    if (zoneEvent) {
      const startsInMin = zoneEvent.start_time
        ? (new Date(zoneEvent.start_time).getTime() - now) / 60000
        : 0;
      if (Math.abs(startsInMin) <= EVENT_WINDOW_MIN || zoneEvent.is_active) {
        boost *= zoneEvent.demand_boost ?? 1;
        reasonParts.push(`Événement ${zoneEvent.name} actif`);
      }
    }

    // Boost trains SNCF si zone gare
    const sncfBoost = getZoneTrainBoostSafe(s.zone_id, hour);
    if (sncfBoost > 0) {
      boost *= 1 + sncfBoost;
      if (reasonParts.length === 0) reasonParts.push(`Trafic gare soutenu`);
    }

    const score = s.profitability_index ?? 0;
    const scoreEffectif = score * boost * Math.exp(-distanceKm / 10);

    return {
      zoneId: s.zone_id as string,
      zoneName: (s.zone_name ?? zone?.name ?? s.zone_id) as string,
      score,
      scoreEffectif,
      distanceKm,
      longRideProbability: s.long_ride_probability ?? 0,
      reasonParts,
      isAirport: zone?.type === "airport",
    };
  });

  scored.sort((a, b) => b.scoreEffectif - a.scoreEffectif);

  // ─── Boost vols pour zones aéroport (async côté service — on utilise le cache déjà chaud) ─
  // getFlightData() est async ; le moteur reste synchrone pour la portion scoring,
  // mais l'appelant (route Express) peut enrichir la raison via applyFlightContext().

  const top3Ids = new Set(scored.slice(0, TOP_N_FOR_REST).map((s) => s.zoneId));

  // ─── 3. Rester : zone actuelle top-3 ET événement actif ────────────────────
  const currentZone = findClosestZone(ctx.lat, ctx.lng, zones);
  if (currentZone && top3Ids.has(currentZone.id)) {
    const currentScored = scored.find((s) => s.zoneId === currentZone.id);
    if (currentScored && currentScored.reasonParts.length > 0) {
      return buildResterRecommendation(currentScored, scored, now);
    }
  }

  // ─── 4. Aller vers la meilleure zone ────────────────────────────────────────
  return buildAllerRecommendation(scored, now);
}

function getZoneTrainBoostSafe(zoneId: string, hour: number): number {
  try {
    const sncf = getSncfSignalsSync(hour);
    const signal = sncf.active_signals.find((sig) => sig.zones_impacted.includes(zoneId));
    return signal?.demand_boost ?? 0;
  } catch {
    return 0;
  }
}

function findClosestZone(lat: number, lng: number, zones: any[]): any | null {
  if (!zones.length) return null;
  let best: any = null;
  let bestDist = Infinity;
  for (const z of zones) {
    const d = haversineKm(lat, lng, z.lat, z.lng);
    if (d < bestDist) {
      bestDist = d;
      best = z;
    }
  }
  // Ne considère "sur zone" que si à moins de 2km (sinon pas de zone "actuelle" fiable)
  return bestDist <= 2 ? best : null;
}

function buildPauseRecommendation(ctx: FocusInputContext, now: number): FocusRecommendation {
  return {
    id: `pause-${now}`,
    verb: "pause",
    zoneName: "Pause recommandée",
    zoneId: null,
    distanceKm: null,
    etaMin: null,
    reasonShort: `Plus de ${PAUSE_AFTER_HOURS}h de conduite continue — sécurité avant tout`,
    expectedGainEuros: null,
    confidence: 0.9,
    validUntil: now + VALID_FOR_MS,
    alternatives: [],
  };
}

function buildRentrerRecommendation(ctx: FocusInputContext, now: number): FocusRecommendation {
  return {
    id: `rentrer-${now}`,
    verb: "rentrer",
    zoneName: "Retour recommandé",
    zoneId: null,
    distanceKm: null,
    etaMin: null,
    reasonShort: "Autonomie carburant faible (< 15 %)",
    expectedGainEuros: null,
    confidence: 0.85,
    validUntil: now + VALID_FOR_MS,
    alternatives: [],
  };
}

function buildResterRecommendation(current: any, scored: any[], now: number): FocusRecommendation {
  const alternatives: FocusAlternative[] = scored
    .filter((s) => s.zoneId !== current.zoneId)
    .slice(0, 2)
    .map((s) => ({
      verb: "aller",
      zoneName: s.zoneName,
      reasonShort: s.reasonParts[0] ?? `Score ${Math.round(s.score)}`,
    }));

  return {
    id: `rester-${current.zoneId}-${now}`,
    verb: "rester",
    zoneName: current.zoneName,
    zoneId: current.zoneId,
    distanceKm: 0,
    etaMin: 0,
    reasonShort: current.reasonParts[0] ?? "Zone parmi les plus rentables actuellement",
    expectedGainEuros: estimateGainLowEuros(current.score, current.longRideProbability),
    confidence: Math.min(0.95, 0.6 + current.reasonParts.length * 0.15),
    validUntil: now + VALID_FOR_MS,
    alternatives,
  };
}

function buildAllerRecommendation(scored: any[], now: number): FocusRecommendation {
  if (!scored.length) {
    return {
      id: `aller-vide-${now}`,
      verb: "aller",
      zoneName: "Aucune donnée disponible",
      zoneId: null,
      distanceKm: null,
      etaMin: null,
      reasonShort: "Pas de score de rentabilité disponible pour le moment",
      expectedGainEuros: null,
      confidence: 0.1,
      validUntil: now + VALID_FOR_MS,
      alternatives: [],
    };
  }

  const best = scored[0];
  const alternatives: FocusAlternative[] = scored.slice(1, 3).map((s) => ({
    verb: "aller",
    zoneName: s.zoneName,
    reasonShort: s.reasonParts[0] ?? `Score ${Math.round(s.score)} · ${s.distanceKm} km`,
  }));

  const etaMin = estimateEtaMin(best.distanceKm);
  const reasonShort =
    best.reasonParts[0] ?? `Rentabilité forte (${Math.round(best.score)}/100) à ${best.distanceKm} km`;

  // Confiance : convergence des signaux (plus de raisons = plus de confiance) + fraîcheur (toujours "fraîche" ici, calcul synchrone)
  const confidence = Math.min(0.95, 0.45 + best.reasonParts.length * 0.2 + Math.min(best.score, 100) / 300);

  return {
    id: `aller-${best.zoneId}-${now}`,
    verb: "aller",
    zoneName: best.zoneName,
    zoneId: best.zoneId,
    distanceKm: best.distanceKm,
    etaMin,
    reasonShort,
    expectedGainEuros: estimateGainLowEuros(best.score, best.longRideProbability),
    confidence: Math.round(confidence * 100) / 100,
    validUntil: now + VALID_FOR_MS,
    alternatives,
  };
}

// ─── Enrichissement asynchrone optionnel (vols / trains dans les 30 min) ──────
// Appelé depuis la route Express (contexte async) pour préciser reasonShort
// quand la meilleure zone est un aéroport et qu'un vol arrive bientôt.
export async function enrichWithFlightContext(
  reco: FocusRecommendation,
): Promise<FocusRecommendation> {
  if (reco.verb !== "aller" && reco.verb !== "rester") return reco;
  if (!reco.zoneId || (reco.zoneId !== "z_cdg" && reco.zoneId !== "z_orly")) return reco;

  try {
    const flightData = await getFlightData();
    const stats = reco.zoneId === "z_cdg" ? flightData.cdg : flightData.orly;
    const nextFlight = flightData.flights
      .filter((f) => f.airport === (reco.zoneId === "z_cdg" ? "CDG" : "ORLY") && f.status === "arriving")
      .sort((a, b) => (a.arrival_time ?? 0) - (b.arrival_time ?? 0))[0];

    if (nextFlight && nextFlight.arrival_time) {
      const minUntil = Math.round((nextFlight.arrival_time * 1000 - Date.now()) / 60000);
      if (minUntil >= 0 && minUntil <= TRANSPORT_WINDOW_MIN) {
        return {
          ...reco,
          reasonShort: `Vol ${nextFlight.callsign || nextFlight.origin_country} dans ${minUntil} min`,
        };
      }
    }
    if (stats.peak_level === "surge" || stats.peak_level === "high") {
      return { ...reco, reasonShort: `Flux aéroport ${stats.peak_level === "surge" ? "en surge" : "élevé"}` };
    }
  } catch {
    // Défensif — le vol reste optionnel, on garde la reco de base
  }
  return reco;
}
