/**
 * geoDistance — utilitaires géographiques légers
 * ─────────────────────────────────────────────────────────────────────────────
 * Distance haversine (à vol d'oiseau) entre deux points GPS.
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
