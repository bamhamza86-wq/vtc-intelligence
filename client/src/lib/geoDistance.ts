/**
 * geoDistance — utilitaires géographiques légers
 * ─────────────────────────────────────────────────────────────────────────────
 * Distance haversine (à vol d'oiseau) entre deux points GPS.
 * Estimations financières nettes (gain brut − coûts à vide).
 * Utilisée pour la recommandation "Où aller maintenant" et le mode conduite.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Distance à vol d'oiseau entre deux points GPS, en km.
 * Retourne une valeur arrondie à 0.1 km.
 */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_KM * c * 10) / 10;
}

/**
 * Estimation grossière d'une course VTC en euros.
 * Modèle simplifié : tarif de base + prix/km × distance moyenne × surge.
 * Volontairement conservateur pour éviter les faux espoirs.
 */
export function estimateRideGain(params: {
  avgDistanceKm: number;
  surge: number;
  longRideProbability?: number;
}): number {
  const { avgDistanceKm, surge, longRideProbability = 0 } = params;
  const BASE_FARE = 5;            // prise en charge moyenne Uber/Bolt Paris
  const PRICE_PER_KM = 1.4;       // ~1.40 €/km net (post-commission)
  // Bonus longue course (>15km) : demi-course supplémentaire pondérée
  const longRideBonus = longRideProbability > 0.4 ? longRideProbability * 8 : 0;
  const baseGain = BASE_FARE + PRICE_PER_KM * Math.max(avgDistanceKm, 3);
  const gain = (baseGain + longRideBonus) * Math.max(1, surge);
  return Math.round(gain);
}

/**
 * Estimation du gain net d'une course après déduction des coûts à vide.
 * ─────────────────────────────────────────────────────────────────────────────
 * gross     = tarif_base + prix_km × avgDistanceKm × surge + bonus_longue_course
 * costEmpty = (distanceToZoneKm + avgDistanceKm × returnEmptyProbability)
 *             × (consommation_l_km × prix_litre + usure_par_km)
 * net       = max(0, gross − costEmpty)  — affiché jamais négatif
 */
export function estimateNetGain(params: {
  avgDistanceKm: number;
  surge: number;
  longRideProbability?: number;
  distanceToZoneKm: number;
  fuelConsumptionPer100km?: number;
  fuelPricePerLiter?: number;
  wearCostPerKm?: number;
  returnEmptyProbability?: number;
}): { gross: number; costEmpty: number; net: number } {
  const {
    avgDistanceKm,
    surge,
    longRideProbability   = 0,
    distanceToZoneKm,
    fuelConsumptionPer100km  = 7.5,
    fuelPricePerLiter        = 1.92,
    wearCostPerKm            = 0.08,
    returnEmptyProbability   = 0.35,
  } = params;

  const BASE_FARE    = 5;     // prise en charge Uber/Bolt Paris
  const PRICE_PER_KM = 1.4;  // ~1.40 €/km net (post-commission)

  // Bonus longue course (probabilité > 40 %)
  const longRideBonus = longRideProbability > 0.4 ? longRideProbability * 8 : 0;
  const baseGain      = BASE_FARE + PRICE_PER_KM * Math.max(avgDistanceKm, 3);
  const gross         = (baseGain + longRideBonus) * Math.max(1, surge);

  // Coût kilométrique total : carburant + usure
  const fuelLPerKm  = fuelConsumptionPer100km / 100;
  const kmCost      = fuelLPerKm * fuelPricePerLiter + wearCostPerKm;

  // Km à vide = trajet vers la zone + retour vide estimé
  const emptyKm  = distanceToZoneKm + avgDistanceKm * returnEmptyProbability;
  const costEmpty = emptyKm * kmCost;

  const net = Math.max(0, gross - costEmpty);
  return {
    gross:     Math.round(gross * 100) / 100,
    costEmpty: Math.round(costEmpty * 100) / 100,
    net:       Math.round(net * 100) / 100,
  };
}

/**
 * Niveau de confiance dans une recommandation.
 * ─────────────────────────────────────────────────────────────────────────────
 *   high   : données fraîches (< 3 min) + signaux convergents + faible variance
 *   medium : cas intermédiaires
 *   low    : données périmées (> 10 min) OU faible convergence (< 0.4)
 */
export function computeConfidence(params: {
  dataAgeSeconds: number;
  signalConvergence: number;
  historicalVariance: number;
}): "high" | "medium" | "low" {
  const { dataAgeSeconds, signalConvergence, historicalVariance } = params;

  // Critère low prioritaire
  if (dataAgeSeconds > 600 || signalConvergence < 0.4) return "low";
  // Critère high
  if (dataAgeSeconds < 180 && signalConvergence >= 0.7 && historicalVariance < 15) return "high";
  // Tout le reste
  return "medium";
}
