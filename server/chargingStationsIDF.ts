/**
 * chargingStationsIDF.ts — Dataset de secours (fallback) : bornes de recharge
 * électrique en Île-de-France (rapport.md §6.4 "Bornes de recharge électrique
 * en temps réel").
 * ─────────────────────────────────────────────────────────────────────────────
 * Contrainte : ZÉRO nouvelle dépendance npm. On tente un appel HTTP direct vers
 * OpenChargeMap (API publique, pas de SDK) via fetch natif Node ≥18. Si l'appel
 * échoue (pas de clé API, réseau coupé, quota atteint...), on retombe sur ce
 * jeu de données statique couvrant Paris intra-muros + banlieue immédiate
 * (aéroports, gares, grands axes) — suffisant pour un usage démonstratif /
 * dégradé sans dépendance externe.
 *
 * Coordonnées approximatives, prix estimés indicatifs (ordre de grandeur 2026).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface ChargingStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  network: string;
  powerKw: number;
  connectorType: string;
  available: boolean; // statique ici (pas de télémétrie temps réel en fallback)
  estimatedPriceEurPerKwh: number;
  address: string;
}

// Jeu de données statique IDF — Paris + proche banlieue (Roissy, Orly, La Défense,
// Bercy, Stade de France) aligné sur les zones cibles du produit (CONTEXTE_PROJET.md).
export const CHARGING_STATIONS_IDF: ChargingStation[] = [
  { id: "idf-001", name: "Ionity Porte de la Chapelle", lat: 48.8977, lng: 2.3606, network: "Ionity", powerKw: 300, connectorType: "CCS", available: true, estimatedPriceEurPerKwh: 0.69, address: "Porte de la Chapelle, 75018 Paris" },
  { id: "idf-002", name: "Tesla Supercharger Bercy", lat: 48.8389, lng: 2.3822, network: "Tesla", powerKw: 250, connectorType: "CCS", available: true, estimatedPriceEurPerKwh: 0.45, address: "Quai de Bercy, 75012 Paris" },
  { id: "idf-003", name: "Belib' Bastille", lat: 48.8532, lng: 2.3692, network: "Belib'", powerKw: 22, connectorType: "Type 2", available: true, estimatedPriceEurPerKwh: 0.39, address: "Place de la Bastille, 75011 Paris" },
  { id: "idf-004", name: "Belib' Gare de Lyon", lat: 48.8443, lng: 2.3743, network: "Belib'", powerKw: 50, connectorType: "CCS/CHAdeMO", available: true, estimatedPriceEurPerKwh: 0.42, address: "Gare de Lyon, 75012 Paris" },
  { id: "idf-005", name: "Fastned La Défense", lat: 48.8918, lng: 2.2388, network: "Fastned", powerKw: 175, connectorType: "CCS", available: true, estimatedPriceEurPerKwh: 0.59, address: "Esplanade de La Défense, 92400 Courbevoie" },
  { id: "idf-006", name: "TotalEnergies Roissy CDG T2", lat: 49.0047, lng: 2.5701, network: "TotalEnergies", powerKw: 150, connectorType: "CCS", available: true, estimatedPriceEurPerKwh: 0.55, address: "Aéroport Roissy CDG Terminal 2, 95700 Roissy-en-France" },
  { id: "idf-007", name: "Izivia Roissy CDG T1", lat: 49.0097, lng: 2.5479, network: "Izivia", powerKw: 50, connectorType: "CCS/CHAdeMO", available: true, estimatedPriceEurPerKwh: 0.48, address: "Aéroport Roissy CDG Terminal 1, 95700 Roissy-en-France" },
  { id: "idf-008", name: "Bump Orly Ouest", lat: 48.7262, lng: 2.3652, network: "Bump", powerKw: 100, connectorType: "CCS", available: true, estimatedPriceEurPerKwh: 0.52, address: "Aéroport Orly, Orly Ouest, 94390 Orly" },
  { id: "idf-009", name: "Belib' Stade de France", lat: 48.9245, lng: 2.3601, network: "Belib'", powerKw: 22, connectorType: "Type 2", available: true, estimatedPriceEurPerKwh: 0.39, address: "Rue Jules Rimet, 93200 Saint-Denis" },
  { id: "idf-010", name: "Freshmile Saint-Denis Pleyel", lat: 48.9226, lng: 2.3538, network: "Freshmile", powerKw: 50, connectorType: "CCS/CHAdeMO", available: true, estimatedPriceEurPerKwh: 0.44, address: "Rue Francisque Poulbot, 93200 Saint-Denis" },
  { id: "idf-011", name: "Belib' Châtelet", lat: 48.8583, lng: 2.3470, network: "Belib'", powerKw: 22, connectorType: "Type 2", available: true, estimatedPriceEurPerKwh: 0.39, address: "Rue de Rivoli, 75001 Paris" },
  { id: "idf-012", name: "Belib' République", lat: 48.8674, lng: 2.3634, network: "Belib'", powerKw: 22, connectorType: "Type 2", available: false, estimatedPriceEurPerKwh: 0.39, address: "Place de la République, 75011 Paris" },
  { id: "idf-013", name: "Ionity Porte d'Orléans", lat: 48.8235, lng: 2.3266, network: "Ionity", powerKw: 300, connectorType: "CCS", available: true, estimatedPriceEurPerKwh: 0.69, address: "Porte d'Orléans, 75014 Paris" },
  { id: "idf-014", name: "TotalEnergies Porte de Bercy", lat: 48.8340, lng: 2.3874, network: "TotalEnergies", powerKw: 150, connectorType: "CCS", available: true, estimatedPriceEurPerKwh: 0.55, address: "Porte de Bercy, 75012 Paris" },
  { id: "idf-015", name: "Belib' Gare du Nord", lat: 48.8809, lng: 2.3553, network: "Belib'", powerKw: 50, connectorType: "CCS/CHAdeMO", available: true, estimatedPriceEurPerKwh: 0.42, address: "Gare du Nord, 75010 Paris" },
  { id: "idf-016", name: "Fastned Aubervilliers", lat: 48.9092, lng: 2.3820, network: "Fastned", powerKw: 175, connectorType: "CCS", available: true, estimatedPriceEurPerKwh: 0.59, address: "Avenue Victor Hugo, 93300 Aubervilliers" },
  { id: "idf-017", name: "Belib' Porte de Vincennes", lat: 48.8459, lng: 2.4141, network: "Belib'", powerKw: 22, connectorType: "Type 2", available: true, estimatedPriceEurPerKwh: 0.39, address: "Porte de Vincennes, 75020 Paris" },
  { id: "idf-018", name: "Izivia Créteil", lat: 48.7904, lng: 2.4556, network: "Izivia", powerKw: 50, connectorType: "CCS/CHAdeMO", available: true, estimatedPriceEurPerKwh: 0.48, address: "Avenue du Général de Gaulle, 94000 Créteil" },
  { id: "idf-019", name: "Belib' Montparnasse", lat: 48.8422, lng: 2.3211, network: "Belib'", powerKw: 50, connectorType: "CCS/CHAdeMO", available: true, estimatedPriceEurPerKwh: 0.42, address: "Gare Montparnasse, 75015 Paris" },
  { id: "idf-020", name: "Tesla Supercharger Saint-Maurice", lat: 48.8172, lng: 2.4275, network: "Tesla", powerKw: 250, connectorType: "CCS", available: true, estimatedPriceEurPerKwh: 0.45, address: "Quai de la Marne, 94410 Saint-Maurice" },
];

/** Distance haversine en km — utilitaire local (évite dépendance externe). */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Retourne les bornes IDF dans un rayon donné (km), triées par distance croissante. */
export function getNearbyStationsFallback(lat: number, lng: number, radiusKm: number): (ChargingStation & { distanceKm: number })[] {
  return CHARGING_STATIONS_IDF
    .map((s) => ({ ...s, distanceKm: Math.round(haversineKm(lat, lng, s.lat, s.lng) * 100) / 100 }))
    .filter((s) => s.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}
