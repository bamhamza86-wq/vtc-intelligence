import Database from "better-sqlite3";
import { Zone, ProfitabilityScore, Event, Ride, Alert, DriverProfile, InsertAlert, InsertRide, InsertDriverProfile } from "@shared/schema";

const sqlite = new Database("data.db");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS zones (id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, type TEXT NOT NULL, city TEXT NOT NULL DEFAULT 'Seine-Saint-Denis');
  CREATE TABLE IF NOT EXISTS profitability_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, zone_id TEXT NOT NULL, hour INTEGER NOT NULL, day_type TEXT NOT NULL, demand_score REAL NOT NULL, supply_score REAL NOT NULL, ratio_ds REAL NOT NULL, avg_distance_km REAL NOT NULL, avg_duration_min REAL NOT NULL, avg_fare REAL NOT NULL, profitability_index REAL NOT NULL, long_ride_probability REAL NOT NULL, surge_multiplier REAL NOT NULL DEFAULT 1.0);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, zone_id TEXT NOT NULL, event_type TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, expected_attendance INTEGER, demand_boost REAL NOT NULL DEFAULT 1.0, is_active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS rides (id INTEGER PRIMARY KEY AUTOINCREMENT, pickup_zone_id TEXT NOT NULL, dropoff_zone_id TEXT NOT NULL, distance_km REAL NOT NULL, duration_min REAL NOT NULL, fare REAL NOT NULL, commission REAL NOT NULL, fuel_cost REAL NOT NULL, net_profit REAL NOT NULL, hourly_rate REAL NOT NULL, is_profitable INTEGER NOT NULL, is_long_ride INTEGER NOT NULL, timestamp TEXT NOT NULL, weather TEXT);
  CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, zone_id TEXT, priority TEXT NOT NULL, estimated_revenue REAL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS driver_profile (id INTEGER PRIMARY KEY AUTOINCREMENT, fuel_consumption_per100km REAL NOT NULL DEFAULT 7.5, fuel_price_per_liter REAL NOT NULL DEFAULT 1.92, platform_commission_pct REAL NOT NULL DEFAULT 25.0, hourly_target_income REAL NOT NULL DEFAULT 35.0, wear_cost_per_km REAL NOT NULL DEFAULT 0.08, min_profitable_km_per_min REAL NOT NULL DEFAULT 1.0, vehicle_type TEXT NOT NULL DEFAULT 'berline', prefer_long_rides INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS seed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS score_history (id INTEGER PRIMARY KEY AUTOINCREMENT, zone_id TEXT NOT NULL, hour INTEGER NOT NULL, day_type TEXT NOT NULL, profitability_index REAL NOT NULL, surge_multiplier REAL NOT NULL, demand_score REAL NOT NULL, supply_score REAL NOT NULL, seed_date TEXT NOT NULL);
`);

// ─── Zones Seine-Saint-Denis (93) + Aéroports ────────────────────────────────

const zones93 = [
  { id: "z_cdg",          name: "CDG — Roissy-en-France",     lat: 49.0097,  lng: 2.5479,  type: "airport" },
  { id: "z_orly",         name: "Orly — Terminal Sud/Ouest",  lat: 48.7262,  lng: 2.3652,  type: "airport" },
  { id: "z_saint_denis_gare", name: "Gare Saint-Denis",       lat: 48.9362,  lng: 2.3573,  type: "transport" },
  { id: "z_bobigny_gare", name: "Bobigny Pablo Picasso",       lat: 48.9059,  lng: 2.4470,  type: "transport" },
  { id: "z_aubervilliers",name: "Aubervilliers — Pantin",      lat: 48.9144,  lng: 2.3895,  type: "transport" },
  { id: "z_epinay_gennevilliers", name: "Épinay / Gennevilliers", lat: 48.9527, lng: 2.3090, type: "transport" },
  { id: "z_plaine_commune", name: "Plaine Commune — Affaires", lat: 48.9209,  lng: 2.3716,  type: "business" },
  { id: "z_le_bourget",   name: "Le Bourget — Parc Expo",     lat: 48.9437,  lng: 2.4254,  type: "business" },
  { id: "z_villepinte",   name: "Villepinte — Paris Nord",    lat: 48.9744,  lng: 2.5330,  type: "business" },
  { id: "z_tremblay",     name: "Tremblay-en-France",         lat: 48.9579,  lng: 2.5572,  type: "business" },
  { id: "z_stade_france", name: "Stade de France",            lat: 48.9245,  lng: 2.3596,  type: "entertainment" },
  { id: "z_93_centre",    name: "Saint-Denis — Centre",       lat: 48.9356,  lng: 2.3535,  type: "entertainment" },
  { id: "z_montreuil",    name: "Montreuil",                  lat: 48.8637,  lng: 2.4482,  type: "residential" },
  { id: "z_aulnay",       name: "Aulnay-sous-Bois",           lat: 48.9383,  lng: 2.4951,  type: "residential" },
];

// ─── Patterns horaires par zone ───────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Patterns de zone — recalibrés 09/06/2026
// Corrélation étendue réel/historique mardi 6h-18h
// Sources : ADP, RATP, DRIEA, observations terrain
// ─────────────────────────────────────────────────────────────────────────────
const patterns: Record<string, {
  peakHours: number[];
  baseAvgDist: number;
  baseLongRide: number;
  demandCap?: number;
  // Boosts horaires spécifiques 11h-18h (corrélation Parc Expo / events)
  demandBoost11_14?: number;   // boost demande 11h-14h
  demandBoost14_18?: number;   // boost demande 14h-18h (Parc Expo, business)
  // Boost corrélation 6h-10h (rush AM + aéroports matinaux) — mesuré 10/06/2026
  demandBoost6_10?: number;
}> = {
  // ── Aéroports ─────────────────────────────────────────────────────────────
  // CDG : trafic intercontinental 11h-14h (arrivées long-courriers)
  //       16h-18h pic départs — demande forte
  z_cdg: {
    peakHours: [4,5,6,7,8,9,10,11,12,13,16,17,18,19,20,21,22,23],
    baseAvgDist: 42, baseLongRide: 0.94, demandCap: 98,
    demandBoost11_14: 6,    // arrivées intercontinentales 11h-13h
    demandBoost14_18: 8,    // pic départs PM + navettes
    demandBoost6_10: 8,     // départs matinaux intercontinentaux + arrivées early ✅
  },
  // Orly : DOM-TOM 11h-14h, départs 16h-18h
  z_orly: {
    peakHours: [5,6,7,8,9,10,11,12,16,17,18,19,20,21],
    baseAvgDist: 27, baseLongRide: 0.84, demandCap: 94,
    demandBoost11_14: 4,
    demandBoost14_18: 7,
    demandBoost6_10: 5,     // DOM-TOM matinaux, présence 7h-10h forte ✅
  },
  // ── Hubs transport / banlieue proche ─────────────────────────────────────
  // St-Denis : trafic commute + tourisme Basilique / Stade France 13h-17h
  z_saint_denis_gare: {
    peakHours: [6,7,8,9,12,13,17,18,19,20],
    baseAvgDist: 16, baseLongRide: 0.40,
    demandBoost11_14: 3,
    demandBoost14_18: 5,
    demandBoost6_10: 6,     // rush commute fort 7h-9h ✅
  },
  z_bobigny_gare: {
    peakHours: [7,8,9,12,13,17,18,19],
    baseAvgDist: 13, baseLongRide: 0.32,
    demandBoost11_14: 2,
    demandBoost14_18: 3,
    demandBoost6_10: 6,     // rush commute fort 7h-9h ✅
  },
  z_aubervilliers: {
    peakHours: [7,8,9,11,12,17,18,19,22,23],
    baseAvgDist: 15, baseLongRide: 0.37,
    demandBoost11_14: 3,
    demandBoost14_18: 4,
    demandBoost6_10: 6,     // rush commute fort 7h-9h ✅
  },
  z_epinay_gennevilliers: {
    peakHours: [6,7,8,9,17,18,19],
    baseAvgDist: 19, baseLongRide: 0.44,
    demandBoost11_14: 1,
    demandBoost14_18: 2,
    demandBoost6_10: 3,     // commute modéré banlieue nord-ouest
  },
  // Plaine Commune : zone business active 11h-17h (sièges sociaux)
  z_plaine_commune: {
    peakHours: [7,8,9,10,11,12,13,14,15,16,17,18,19],
    baseAvgDist: 18, baseLongRide: 0.48,
    demandBoost11_14: 8,    // déjeuners d'affaires, réunions
    demandBoost14_18: 10,   // retour fin journée travail flexible
    demandBoost6_10: 4,     // arrivées employés sièges sociaux 7h-9h
  },
  // ── Hubs business / exposition ────────────────────────────────────────────
  // Le Bourget : parc expo adjacente, trafic business 10h-17h
  z_le_bourget: {
    peakHours: [7,8,9,10,11,12,13,14,15,16,17,18,19,20],
    baseAvgDist: 24, baseLongRide: 0.58,
    demandBoost11_14: 10,   // Parc Expo / Bourget Aéroport affaires
    demandBoost14_18: 12,   // pic retour exposants + navettes
    demandBoost6_10: 2,     // peu actif 6h-9h (pas de vols 6h-9h) ✅
  },
  // Villepinte : Parc des Expos Paris Nord Villepinte — très actif 11h-18h
  z_villepinte: {
    peakHours: [7,8,9,10,11,12,13,14,15,16,17,18,19,20],
    baseAvgDist: 32, baseLongRide: 0.68,
    demandBoost11_14: 12,   // salons professionnels 11h-14h
    demandBoost14_18: 15,   // sortie salons + navettes hôtel
    demandBoost6_10: 3,     // ouverture exposants / montage tôt
  },
  // Tremblay : entre CDG et Villepinte, hub logistique + résidentiel
  z_tremblay: {
    peakHours: [6,7,8,9,12,13,17,18,19],
    baseAvgDist: 35, baseLongRide: 0.78,
    demandBoost11_14: 5,
    demandBoost14_18: 6,
    demandBoost6_10: 4,     // travailleurs CDG / logistique tôt
  },
  // ── Zones culturelles / événementielles ───────────────────────────────────
  // Stade de France : événements 18h+, calme 11h-17h sauf matchs
  z_stade_france: {
    peakHours: [16,17,18,19,20,21,22,23],
    baseAvgDist: 14, baseLongRide: 0.32,
    demandBoost11_14: 2,    // visites stade / offices tourisme
    demandBoost14_18: 5,    // pré-event + entraînements
    demandBoost6_10: 2,     // commute résidentiel secteur
  },
  // ── Zones résidentielles / mixtes ─────────────────────────────────────────
  z_93_centre: {
    peakHours: [9,10,11,12,13,14,17,18,20,21,22],
    baseAvgDist: 14, baseLongRide: 0.30,
    demandBoost11_14: 5,    // lunch + commerces actifs
    demandBoost14_18: 6,
    demandBoost6_10: 3,     // commute centre-ville 7h-9h
  },
  z_montreuil: {
    peakHours: [7,8,9,12,13,17,18,19],
    baseAvgDist: 12, baseLongRide: 0.26,
    demandBoost11_14: 4,
    demandBoost14_18: 5,
    demandBoost6_10: 3,     // commute résidentiel est parisien
  },
  z_aulnay: {
    peakHours: [6,7,8,9,12,17,18,22,23],
    baseAvgDist: 22, baseLongRide: 0.52,
    demandBoost11_14: 3,
    demandBoost14_18: 5,    // proximité CDG / sorties salariés
    demandBoost6_10: 3,     // commute résidentiel nord-est
  },
};

// ─── Coefficients par jour de semaine ─────────────────────────────────────────
// Recalibrés 09/06/2026 — corrélation 6h-18h
// 11h-18h mardi : supply +5% par rapport à matin (chauffeurs mid-day shift)
// supply_morning ajouté 10/06/2026 — corrélation 6h-10h mercredi
const DAY_COEFFICIENTS: Record<number, {
  demand: number; supply: number; surge: number;
  supply_midday: number;  // supply 11h-18h (mid-day shift différent)
  supply_morning: number; // supply 6h-10h (rush AM, peu de chauffeurs)
  label: string;
}> = {
  0: { demand: 0.74, supply: 0.58, surge: 1.14, supply_midday: 0.62, supply_morning: 0.55, label: "Dimanche"  },
  1: { demand: 0.93, supply: 0.88, surge: 1.08, supply_midday: 0.90, supply_morning: 0.72, label: "Lundi"     },
  2: { demand: 1.03, supply: 0.78, surge: 1.18, supply_midday: 0.82, supply_morning: 0.65, label: "Mardi"     },
  3: { demand: 1.04, supply: 0.90, surge: 1.15, supply_midday: 0.93, supply_morning: 0.78, label: "Mercredi"  },
  4: { demand: 1.07, supply: 0.93, surge: 1.18, supply_midday: 0.96, supply_morning: 0.80, label: "Jeudi"     },
  5: { demand: 1.10, supply: 0.85, surge: 1.28, supply_midday: 0.88, supply_morning: 0.75, label: "Vendredi"  },
  6: { demand: 0.82, supply: 0.62, surge: 1.22, supply_midday: 0.65, supply_morning: 0.52, label: "Samedi"    },
};

function getTodayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function getYesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function computeScore(
  zone: typeof zones93[0],
  h: number,
  dt: string,
  dayOfWeek: number,
  seedVariance: number
) {
  const pat = patterns[zone.id] || { peakHours: [8,12,18], baseAvgDist: 15, baseLongRide: 0.30 };
  const isPeak = pat.peakHours.includes(h);
  const isNight = h >= 0 && h < 5;
  const isMidDay = h >= 11 && h <= 18;           // plage corrélée 11h-18h
  const isWeekendNight = dt === "weekend" && (h >= 22 || h <= 3);
  const dayCo = DAY_COEFFICIENTS[dayOfWeek] || DAY_COEFFICIENTS[2];

  // ── Demande — corrélation étendue 6h-18h ──────────────────────────────────
  let demandBase = isPeak ? 82 : (isNight ? 36 : 50);

  if (zone.type === "airport") {
    demandBase = isPeak ? 94 : (isNight ? 62 : 66);
    if ((pat as any).demandCap) demandBase = Math.min(demandBase, (pat as any).demandCap);
  }

  // Boosts horaires 11h-18h calibrés (corrélation Parc Expo / business)
  if (isMidDay && h >= 11 && h < 14) {
    demandBase += (pat as any).demandBoost11_14 ?? 0;
  }
  if (isMidDay && h >= 14 && h <= 18) {
    demandBase += (pat as any).demandBoost14_18 ?? 0;
  }

  // Boost corrélation 6h-10h (rush AM + aéroports matinaux) — mesuré 10/06/2026
  if (h >= 6 && h < 10) {
    demandBase += (pat as any).demandBoost6_10 ?? 0;
  }

  // Ajustements ponctuels validés
  if (zone.id === "z_cdg"  && h >= 6  && h <= 8)  demandBase = Math.min(demandBase + 4, 98);
  if (zone.id === "z_orly" && h === 8)             demandBase = Math.min(demandBase + 3, 94);
  if (zone.id === "z_stade_france" && !isPeak)     demandBase = 20;
  if (isWeekendNight) demandBase += 24;

  demandBase *= dayCo.demand;
  const v = Math.sin(seedVariance * 7.3 + h * 0.5) * 0.07;
  const demand = Math.min(100, Math.max(5, demandBase * (1 + v)));

  // ── Offre — mid-day shift différencié 11h-18h ─────────────────────────────
  // 11h-18h : davantage de chauffeurs actifs (shift journée) → supply plus haute
  // 6h-10h  : peu de chauffeurs (heure creuse chauffeurs) → supply_morning basse
  const isMorning = h >= 6 && h < 10;
  const supplyCoeff = isMorning ? dayCo.supply_morning
    : isMidDay ? dayCo.supply_midday
    : dayCo.supply;
  let supplyBase = isPeak ? 58 : (isNight ? 16 : 48);
  if (zone.type === "airport") supplyBase = isPeak ? 48 : 34;
  if (zone.id === "z_stade_france" && !isPeak) supplyBase = 64;
  // Zones business 11h-14h : supply plus haute (chauffeurs en attente lunch)
  if (isMidDay && h >= 11 && h < 14 &&
      ["z_plaine_commune","z_le_bourget","z_villepinte"].includes(zone.id)) {
    supplyBase = Math.min(supplyBase + 8, 72);
  }
  supplyBase *= supplyCoeff;
  const vs = Math.cos(seedVariance * 5.1 + h * 0.7) * 0.09;
  const supply = Math.max(5, Math.min(100, supplyBase * (1 + vs)));

  const ratio = demand / Math.max(supply, 1);

  // ── Distance & tarifs — calibrés distances Google Maps réelles ────────────
  // Distances réelles par zone (road_km Google Maps, pas haversine)
  // Distances réelles (road_km Google Maps) — recalibrées 10/06/2026 (Bd Ney → destination)
  const REAL_DIST_KM: Record<string, number> = {
    z_cdg: 23.8, z_orly: 28.6, z_le_bourget: 12.1, z_villepinte: 21.6,
    z_tremblay: 22.9, z_aulnay: 19.5, z_saint_denis_gare: 6.5,
    z_plaine_commune: 5.8, z_bobigny_gare: 13.4, z_aubervilliers: 6.6,
    z_epinay_gennevilliers: 9.6, z_93_centre: 6.8,
    z_montreuil: 14.0, z_stade_france: 5.2,
  };
  // Vitesse de base (rush PM 17-19h, Google Maps) — recalibrées 10/06/2026
  const SPEED_RUSH_PM: Record<string, number> = {
    z_cdg: 32.45, z_orly: 26.00, z_le_bourget: 18.15, z_villepinte: 30.86,
    z_tremblay: 29.87, z_aulnay: 27.21, z_saint_denis_gare: 13.00,
    z_plaine_commune: 16.57, z_bobigny_gare: 22.33, z_aubervilliers: 12.77,
    z_epinay_gennevilliers: 13.71, z_93_centre: 12.75,
    z_montreuil: 20.49, z_stade_france: 12.48,
  };
  // getRatioH — recalibré 10/06/2026 (corrélation 6h-10h mesurée à 10h37)
  const getRatioH = (hh: number): number => {
    if (hh < 6)  return 2.40;  // nuit
    if (hh < 7)  return 1.45;  // pré-rush 6h ✅ corrélation 6h-10h
    if (hh < 9)  return 0.88;  // rush AM
    if (hh < 12) return 1.69;  // post-rush 9-12h ✅ MESURÉ 10h37
    if (hh < 14) return 1.58;  // mi-journée
    if (hh < 16) return 1.42;  // après-midi
    if (hh < 17) return 1.12;  // pré-rush PM
    if (hh < 19) return 1.00;  // rush PM ✅ BASE
    if (hh < 22) return 1.52;  // soir
    return 2.40;
  };
  const baseSpeed = SPEED_RUSH_PM[zone.id] ?? 20.0;
  const effSpeed = baseSpeed * getRatioH(h);
  const realDist = REAL_DIST_KM[zone.id] ?? pat.baseAvgDist;

  // avgDist = distance moyenne d'une COURSE depuis cette zone (pas le trajet aller)
  // calibré : CDG→Paris ~42km, Orly→Paris ~30km, zones 93 ~12-18km
  const distMultiplier = isPeak ? 1.12 : (isMidDay ? 1.05 : 0.92);
  const avgDist = pat.baseAvgDist * distMultiplier + Math.sin(seedVariance + h) * 1.5;
  const avgDur = (avgDist / effSpeed) * 60; // minutes
  const avgFare = avgDist * 1.30 + 2.80;

  // ── Surge — calibré 11h-18h ────────────────────────────────────────────────
  // Rush PM 17h+ : surge déclenché plus tôt (observé terrain)
  // Mi-journée : surge modéré mais réel sur zones business
  const surgeThreshold1 = isMidDay ? 1.9 : 2.2;  // seuils abaissés 11h-18h
  const surgeThreshold2 = isMidDay ? 1.4 : 1.7;
  const surgeThreshold3 = isMidDay ? 1.1 : 1.3;
  const surgeMult = ratio > surgeThreshold1 ? 1.90 * dayCo.surge
    : ratio > surgeThreshold2 ? 1.48 * dayCo.surge
    : ratio > surgeThreshold3 ? 1.20 * dayCo.surge
    : 1.0;
  const surge = Math.min(3.8, surgeMult);

  const longRide = Math.min(0.98, pat.baseLongRide * (zone.type === "airport" ? 1.12 : 1.0));
  const commission = avgFare * 0.25;
  const fuel = (avgDist / 100) * 7.5 * 1.92;
  const wear = avgDist * 0.08;
  const net = avgFare - commission - fuel - wear;
  const hRate = (net / Math.max(avgDur / 60, 0.1)); // €/heure sans surge

  // ── Rentabilité nette RÉELLE avec surge (€/h) ─────────────────────────────
  // Revenu brut avec surge → net après commission + coûts → €/h réel chauffeur
  const grossWithSurge = avgFare * surge;
  const costKm = 0.224; // carburant 0.144 + usure 0.08
  const netFare = grossWithSurge * (1 - 0.25) - avgDist * costKm;
  const repoMin = Math.max(4, avgDist * 0.6); // repositionnement calibré
  const cycleMins = avgDur + repoMin;
  const coursesPerHour = 60 / Math.max(cycleMins, 8);
  const netHourly = netFare * coursesPerHour; // €/h réel avec surge

  // ── Index de rentabilité V2 — 10/06/2026 ─────────────────────────────────
  // Corrections majeures :
  // 1. Saturation CDG/Orly (ratio×18 overflow) → sigmoid sur netHourly
  // 2. Ratio D/O log-normalisé → max 20pts, plus de saturation à ratio>3
  // 3. Long ride × distance normalisée → bonus réel sur courses longues
  // 4. Surge log-scale → 10pts max, variation conservée
  // 5. Event boost intégré → 5pts max pour zones avec event actif
  // Target : 35€/h chauffeur = score 50, 60€/h = score 80, 80€/h = score 90

  // Sigmoid centrée sur 45€/h, pente 0.08 — calibrée 10/06/2026
  // Score 50 @ 45€/h, score 66 @ 55€/h, score 82 @ 70€/h — max 95, jamais saturant
  // CDG(64-70€/h) → 76-80, Orly(38-63€/h) → 48-72, zones€modestes(13-38€/h) → 12-48
  const sigRent = 1 / (1 + Math.exp(-0.08 * (netHourly - 45)));

  // Ratio D/O log-normalisé [0-1] — cap à ratio=6 (au lieu de saturer à ratio>2)
  const ratioNorm = Math.min(Math.log1p(ratio) / Math.log1p(6), 1.0);

  // Long ride × distance normalisée [0-1]
  const distNorm = Math.min(avgDist / 55, 1.0); // 55km = distance max CDG longue
  const longScore = longRide * (0.55 + 0.45 * distNorm);

  // Surge log-scale [0-1] — cap à surge=4
  const surgeNorm = surge > 1 ? Math.min(Math.log(surge) / Math.log(4), 1.0) : 0;

  // Event boost zones actives (Paris Air Show, Villepinte, Stade France soirée)
  const EVENT_BOOST_BY_ZONE: Record<string, number> = {
    z_stade_france: 0.8,   // match soir → peu d'impact journée
    z_le_bourget: 0.6,     // Paris Air Show actif
    z_villepinte: 0.7,     // Salon Villepinte actif
    z_93_centre: 0.3,      // Soirée Saint-Denis
  };
  const eventNorm = EVENT_BOOST_BY_ZONE[zone.id] ?? 0;

  // Score composite [0-95] — cap 95 pour garder granularité visible
  const profIdx = Math.min(95, Math.max(5, Math.round((
    0.50 * sigRent * 100 +
    0.20 * ratioNorm * 100 +
    0.15 * longScore * 100 +
    0.10 * surgeNorm * 100 +
    0.05 * eventNorm * 100
  ) * 10) / 10));

  return {
    demand: Math.round(demand * 10) / 10,
    supply: Math.round(supply * 10) / 10,
    ratio: Math.round(ratio * 100) / 100,
    avgDist: Math.round(avgDist * 10) / 10,
    avgDur: Math.round(avgDur * 10) / 10,
    avgFare: Math.round(avgFare * 100) / 100,
    profIdx: Math.round(profIdx * 10) / 10,
    longRide: Math.round(longRide * 1000) / 1000,
    surge: Math.round(surge * 100) / 100,
  };
}

function reseedScores(today: string, dayOfWeek: number) {
  const insS = sqlite.prepare(
    `INSERT INTO profitability_scores (zone_id,hour,day_type,demand_score,supply_score,ratio_ds,avg_distance_km,avg_duration_min,avg_fare,profitability_index,long_ride_probability,surge_multiplier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  const insH = sqlite.prepare(
    `INSERT OR IGNORE INTO score_history (zone_id,hour,day_type,profitability_index,surge_multiplier,demand_score,supply_score,seed_date) VALUES (?,?,?,?,?,?,?,?)`
  );

  for (let zi = 0; zi < zones93.length; zi++) {
    const zone = zones93[zi];
    const seedVar = zi * 1.37; // variance déterministe par zone
    for (const dt of ["weekday", "weekend"]) {
      for (let h = 0; h < 24; h++) {
        const s = computeScore(zone, h, dt, dayOfWeek, seedVar);
        insS.run(zone.id, h, dt, s.demand, s.supply, s.ratio, s.avgDist, s.avgDur, s.avgFare, s.profIdx, s.longRide, s.surge);
        insH.run(zone.id, h, dt, s.profIdx, s.surge, s.demand, s.supply, today);
      }
    }
  }
}

// ─── Seed initial + reseed quotidien ─────────────────────────────────────────

function seedData() {
  const now = new Date();
  const today = getTodayStr();
  const dayOfWeek = now.getDay(); // 0=dim … 6=sam

  // Vérifier si les zones existent (migration depuis ancien dataset)
  const zoneCnt = (sqlite.prepare("SELECT COUNT(*) as c FROM zones").get() as any).c;
  if (zoneCnt > 0) {
    const firstZone = sqlite.prepare("SELECT id FROM zones LIMIT 1").get() as any;
    if (firstZone && firstZone.id !== "z_cdg") {
      // Ancien dataset (Lyon) — purge totale
      sqlite.exec("DELETE FROM zones; DELETE FROM profitability_scores; DELETE FROM events; DELETE FROM alerts; DELETE FROM driver_profile; DELETE FROM seed_meta; DELETE FROM score_history;");
    }
  }

  // Réinsérer les zones si vides
  const zoneCount = (sqlite.prepare("SELECT COUNT(*) as c FROM zones").get() as any).c;
  if (zoneCount === 0) {
    const insZ = sqlite.prepare("INSERT OR IGNORE INTO zones (id,name,lat,lng,type,city) VALUES (?,?,?,?,?,'Seine-Saint-Denis')");
    for (const z of zones93) insZ.run(z.id, z.name, z.lat, z.lng, z.type);
  }

  // Vérifier si on a déjà seedé aujourd'hui
  const lastSeed = sqlite.prepare("SELECT value FROM seed_meta WHERE key='last_seed_date'").get() as any;
  const scoreCnt = (sqlite.prepare("SELECT COUNT(*) as c FROM profitability_scores").get() as any).c;

  const needsReseed = !lastSeed || lastSeed.value !== today || scoreCnt === 0;

  if (needsReseed) {
    console.log(`[storage] Reseed quotidien — ${today} (${DAY_COEFFICIENTS[dayOfWeek]?.label || "?"}, j=${dayOfWeek})`);

    // Archiver les scores actuels en historique avant de les effacer
    if (scoreCnt > 0 && lastSeed && lastSeed.value !== today) {
      const yesterday = getYesterdayStr();
      // Copier dans score_history si pas déjà archivé pour hier
      const histCnt = (sqlite.prepare("SELECT COUNT(*) as c FROM score_history WHERE seed_date=?").get(yesterday) as any).c;
      if (histCnt === 0) {
        sqlite.exec(`INSERT OR IGNORE INTO score_history (zone_id,hour,day_type,profitability_index,surge_multiplier,demand_score,supply_score,seed_date)
          SELECT zone_id,hour,day_type,profitability_index,surge_multiplier,demand_score,supply_score,'${yesterday}' FROM profitability_scores`);
        console.log(`[storage] Archivage historique J-1 (${yesterday}) : ${scoreCnt} scores sauvegardés`);
      }
    }

    // Effacer les anciens scores et recalculer
    sqlite.exec("DELETE FROM profitability_scores");
    reseedScores(today, dayOfWeek);

    const newCnt = (sqlite.prepare("SELECT COUNT(*) as c FROM profitability_scores").get() as any).c;
    console.log(`[storage] ${newCnt} scores calculés pour ${today}`);

    // Mettre à jour la meta
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_seed_date',?)").run(today);
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_seed_day',?)").run(String(dayOfWeek));
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_seed_ts',?)").run(now.toISOString());

    // Rafraîchir les événements avec la date du jour
    seedEvents(today, now);
  } else {
    console.log(`[storage] Données à jour pour ${today} (${DAY_COEFFICIENTS[dayOfWeek]?.label})`);
  }

  // Driver profile
  const dpCnt = (sqlite.prepare("SELECT COUNT(*) as c FROM driver_profile").get() as any).c;
  if (dpCnt === 0) {
    sqlite.prepare("INSERT OR IGNORE INTO driver_profile (fuel_consumption_per100km,fuel_price_per_liter,platform_commission_pct,hourly_target_income,wear_cost_per_km,min_profitable_km_per_min,vehicle_type,prefer_long_rides) VALUES (7.5,1.92,25.0,35.0,0.08,1.0,'berline',1)").run();
  }
}

// ─── Seed des événements quotidiens ──────────────────────────────────────────

function seedEvents(today: string, now: Date) {
  sqlite.exec("DELETE FROM events");
  sqlite.exec("DELETE FROM alerts WHERE is_read=0");

  const insE = sqlite.prepare("INSERT INTO events (name,zone_id,event_type,start_time,end_time,expected_attendance,demand_boost,is_active) VALUES (?,?,?,?,?,?,?,1)");

  // Événements fixes de la semaine (mise à jour avec date du jour)
  insE.run("Match Équipe de France — Stade de France", "z_stade_france", "match",
    `${today}T20:45:00`, `${today}T23:30:00`, 80000, 4.2);
  insE.run("Paris Air Show — Le Bourget", "z_le_bourget", "conference",
    `${today}T09:00:00`, `${today}T19:00:00`, 12000, 2.4);
  insE.run("Salon Paris Nord Villepinte", "z_villepinte", "conference",
    `${today}T09:00:00`, `${today}T18:00:00`, 8000, 2.0);
  insE.run("Flux CDG — Arrivées intercontinentales 24h", "z_cdg", "transport",
    `${today}T00:00:00`, `${today}T23:59:00`, 0, 1.0); // boost dynamique via flightService
  insE.run("Flux Orly — Vols domestiques & Maghreb", "z_orly", "transport",
    `${today}T06:00:00`, `${today}T23:00:00`, 0, 1.0);
  insE.run("Soirée Saint-Denis Centre", "z_93_centre", "event",
    `${today}T20:00:00`, `${today}T02:00:00`, 3500, 1.5);

  // Alertes générées dynamiquement depuis les scores de rentabilité temps réel
  generateDynamicAlerts();
}

// ─── Génération dynamique des alertes ─────────────────────────────────────────
// Remplace les alertes hardcodées : génère depuis les scores de rentabilité
// (profitability_scores) et les événements actifs à l'heure courante.
// Toutes les zones ciblées sont en Seine-Saint-Denis (93) ou aéroports franciliens.
function generateDynamicAlerts(): void {
  const now = new Date();
  const h = now.getHours();
  const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";

  // 1. Lire les scores ACTUELS depuis profitability_scores (heure courante)
  const currentScores = sqlite.prepare(`
    SELECT ps.*, z.name as zone_name, z.type as zone_type
    FROM profitability_scores ps
    LEFT JOIN zones z ON ps.zone_id = z.id
    WHERE ps.hour = ? AND ps.day_type = ?
    ORDER BY ps.profitability_index DESC
  `).all(h, dayType) as any[];

  // 2. Lire les événements actifs maintenant
  const activeEvents = sqlite.prepare(`
    SELECT * FROM events
    WHERE is_active = 1
    AND datetime('now') BETWEEN datetime(start_time) AND datetime(end_time)
  `).all() as any[];

  // 3. Supprimer uniquement les alertes auto-générées non lues (garder les lues = historique)
  sqlite.prepare("DELETE FROM alerts WHERE is_read = 0 AND created_at > ?")
    .run(new Date(now.getTime() - 3 * 60 * 1000).toISOString()); // garder > 3min

  const insA = sqlite.prepare(
    "INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0)"
  );

  const alertsGenerated: string[] = [];

  // ── RÈGLE 1 : Surge critique — ratio D/O > 3.0 ET zone 93 ────────────────
  // Prioriser les zones avec forte densité trafic (demande >> offre)
  for (const score of currentScores) {
    if (alertsGenerated.length >= 8) break; // max 8 alertes actives
    if (score.ratio_ds < 3.0) continue;

    // Calculer TTL selon urgence : ratio > 4 → 2h, ratio 3-4 → 4h
    const ttlH = score.ratio_ds > 4.0 ? 2 : 4;
    const expires = new Date(now.getTime() + ttlH * 3600000).toISOString();

    // Niveau de priorité basé sur densité trafic
    const priority = score.ratio_ds > 4.5 ? "critical"
      : score.ratio_ds > 3.5 ? "high" : "medium";

    // Revenus estimés : avg_fare × (ratio_ds / 2) = estimation courses possibles
    const estRevenue = Math.round(score.avg_fare * Math.min(score.ratio_ds / 2, 3));

    const congestionLabel = score.ratio_ds > 4.5 ? "Dense critique"
      : score.ratio_ds > 3.5 ? "Forte densité" : "Densité élevée";

    insA.run(
      "demand_spike",
      `${score.zone_name} — ${congestionLabel} D/O ${score.ratio_ds.toFixed(1)}×`,
      `Demande ${score.demand_score.toFixed(0)}pts / Offre ${score.supply_score.toFixed(0)}pts. ` +
      `Course moyenne ${score.avg_distance_km.toFixed(0)} km · ${score.avg_duration_min.toFixed(0)} min. ` +
      `Tarif estimé ${score.avg_fare.toFixed(0)}€. Surge ×${score.surge_multiplier.toFixed(1)}.`,
      score.zone_id, priority, estRevenue, expires, now.toISOString()
    );
    alertsGenerated.push(score.zone_id);
  }

  // ── RÈGLE 2 : Événements actifs avec boost significatif ───────────────────
  for (const ev of activeEvents) {
    if (alertsGenerated.length >= 8) break;
    if (alertsGenerated.includes(ev.zone_id)) continue; // déjà une alerte sur cette zone
    if (ev.demand_boost < 1.5) continue; // ignorer les micro-boosts

    // Trouver le score de la zone de l'événement
    const zoneScore = currentScores.find((s: any) => s.zone_id === ev.zone_id);
    if (!zoneScore) continue;

    const minutesLeft = Math.round(
      (new Date(ev.end_time).getTime() - now.getTime()) / 60000
    );
    if (minutesLeft <= 0) continue;

    const ttlMs = Math.min(minutesLeft * 60000, 4 * 3600000);
    const expires = new Date(now.getTime() + ttlMs).toISOString();

    const priority = ev.demand_boost >= 3.0 ? "critical"
      : ev.demand_boost >= 2.0 ? "high" : "medium";

    const attendanceStr = ev.expected_attendance > 0
      ? `${(ev.expected_attendance / 1000).toFixed(0)} 000 personnes. ` : "";

    insA.run(
      "event_ending",
      `${zoneScore.zone_name} — ${ev.name.substring(0, 40)}`,
      `${attendanceStr}Boost ×${ev.demand_boost.toFixed(1)}. ` +
      `Fin dans ${minutesLeft < 60 ? minutesLeft + " min" : Math.round(minutesLeft / 60) + "h"}. ` +
      `D/O courant ${zoneScore.ratio_ds.toFixed(1)}×.`,
      ev.zone_id, priority,
      Math.round(zoneScore.avg_fare * ev.demand_boost),
      expires, now.toISOString()
    );
    alertsGenerated.push(ev.zone_id);
  }

  // ── RÈGLE 3 : Opportunité long trajet (aéroports) ──────────────────────────
  // CDG/Orly : toujours pertinents si profitability_index > 70
  const airports = currentScores.filter((s: any) =>
    s.zone_type === "airport" &&
    s.profitability_index > 70 &&
    !alertsGenerated.includes(s.zone_id)
  );
  for (const ap of airports.slice(0, 2)) {
    if (alertsGenerated.length >= 8) break;
    const expires = new Date(now.getTime() + 3 * 3600000).toISOString();
    const priority = ap.profitability_index > 85 ? "high" : "medium";
    insA.run(
      "long_ride_opportunity",
      `${ap.zone_name} — Opportunité ${ap.long_ride_probability > 0.7 ? "long trajet" : "trajet moyen"}`,
      `Indice rentabilité ${ap.profitability_index.toFixed(0)}/100. ` +
      `Course moy. ${ap.avg_distance_km.toFixed(0)} km · ${ap.avg_fare.toFixed(0)}€. ` +
      `Long trajet ${(ap.long_ride_probability * 100).toFixed(0)}% probable.`,
      ap.zone_id, priority,
      Math.round(ap.avg_fare),
      expires, now.toISOString()
    );
    alertsGenerated.push(ap.zone_id);
  }

  // ── RÈGLE 4 : Alerte sous-performance — zones 93 avec ratio < 0.8 ─────────
  // Avertir le chauffeur des zones à éviter (offre > demande = mauvais)
  const lowZones = currentScores.filter((s: any) =>
    s.ratio_ds < 0.8 && s.demand_score < 30
  ).slice(0, 2);
  if (lowZones.length > 0) {
    const names = lowZones.map((z: any) => z.zone_name).join(", ");
    const expires = new Date(now.getTime() + 1 * 3600000).toISOString();
    insA.run(
      "low_demand",
      `Zones à éviter — Offre > Demande`,
      `${names} : saturation chauffeurs. D/O < 0.8. Préférer CDG, Stade ou zones rush.`,
      lowZones[0].zone_id, "low", null, expires, now.toISOString()
    );
  }

  console.log(`[storage] generateDynamicAlerts: ${alertsGenerated.length} alertes générées (h=${h}, dayType=${dayType})`);
}

seedData();

// ─── Refresh automatique toutes les 3 minutes ────────────────────────────────
// Recalcule les scores avec les coefficients du jour courant
// Garantit que toutes les données sont à jour en production
const REFRESH_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

setInterval(() => {
  try {
    const now = new Date();
    const today = getTodayStr();
    const dayOfWeek = now.getDay();
    // Recalcul complet des 672 scores (14 zones × 24h × 2 day_types)
    sqlite.exec("DELETE FROM profitability_scores");
    reseedScores(today, dayOfWeek);
    // Régénérer les alertes dynamiques après recalcul des scores
    generateDynamicAlerts();
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_refresh_ts',?)").run(now.toISOString());
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_seed_date',?)").run(today);
    console.log(`[storage] Auto-refresh 3min: scores recalculés à ${now.toLocaleTimeString('fr-FR')}`);
  } catch (err) {
    console.error("[storage] Erreur auto-refresh:", err);
  }
}, REFRESH_INTERVAL_MS);

// ─── API Storage ──────────────────────────────────────────────────────────────

export interface IStorage {
  getAllZones(): any[];
  getProfitabilityByHour(hour: number, dayType: string): any[];
  getTopZones(hour: number, dayType: string, limit?: number): any[];
  getActiveEvents(): any[];
  getActiveAlerts(): any[];
  clearExpiredAlerts(): void;
  generateDynamicAlerts(): void;
  markAlertRead(id: number): void;
  createAlert(alert: any): any;
  createRide(ride: any): any;
  getRideStats(): any;
  getRecentRides(limit?: number): any[];
  getDriverProfile(): any;
  updateDriverProfile(profile: any): any;
  getSeedMeta(): any;
  getScoreHistory(date?: string): any[];
  getDailyDiff(): any;
  forceReseed(): any;
  getLastRefreshTs(): string;
}

export const storage: IStorage = {
  getAllZones: () => sqlite.prepare("SELECT * FROM zones ORDER BY type, name").all(),

  getProfitabilityByHour: (hour, dayType) =>
    sqlite.prepare("SELECT ps.*, z.name as zone_name, z.type as zone_type FROM profitability_scores ps LEFT JOIN zones z ON ps.zone_id=z.id WHERE ps.hour=? AND ps.day_type=? ORDER BY ps.profitability_index DESC").all(hour, dayType),

  getTopZones: (hour, dayType, limit = 5) => {
    const rows = sqlite.prepare(`
      SELECT ps.*, z.id as zone_id_z, z.name, z.type, z.lat, z.lng
      FROM profitability_scores ps
      LEFT JOIN zones z ON ps.zone_id = z.id
      WHERE ps.hour=? AND ps.day_type=?
      ORDER BY ps.profitability_index DESC
      LIMIT ?
    `).all(hour, dayType, limit);
    return rows.map((r: any) => ({
      ...r,
      zone_id: r.zone_id || r.zone_id_z,
      zone: { id: r.zone_id || r.zone_id_z, name: r.name, type: r.type, lat: r.lat, lng: r.lng },
    }));
  },

  getActiveEvents: () => sqlite.prepare("SELECT * FROM events WHERE is_active=1 ORDER BY start_time ASC").all(),

  getActiveAlerts: () => sqlite.prepare(
    `SELECT a.*,
      COALESCE(ps.ratio_ds, 0) as traffic_density,
      COALESCE(ps.demand_score, 0) as current_demand,
      COALESCE(ps.surge_multiplier, 1.0) as current_surge
    FROM alerts a
    LEFT JOIN profitability_scores ps
      ON a.zone_id = ps.zone_id
      AND ps.hour = CAST(strftime('%H', 'now', 'localtime') AS INTEGER)
      AND ps.day_type = CASE WHEN strftime('%w', 'now') IN ('0','6') THEN 'weekend' ELSE 'weekday' END
    WHERE a.expires_at > ?
    ORDER BY
      a.is_read ASC,
      CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      COALESCE(ps.ratio_ds, 0) DESC,
      a.created_at DESC`
  ).all(new Date().toISOString()),

  generateDynamicAlerts: () => generateDynamicAlerts(),

  markAlertRead: (id: number) => sqlite.prepare("UPDATE alerts SET is_read=1 WHERE id=?").run(id),
  clearExpiredAlerts: () => sqlite.prepare("DELETE FROM alerts WHERE expires_at<?").run(new Date().toISOString()),

  createAlert: (alert) =>
    sqlite.prepare("INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0) RETURNING *")
      .get(alert.type, alert.title, alert.message, alert.zoneId || null, alert.priority, alert.estimatedRevenue || null, alert.expiresAt, alert.createdAt),

  createRide: (ride) =>
    sqlite.prepare("INSERT INTO rides (pickup_zone_id,dropoff_zone_id,distance_km,duration_min,fare,commission,fuel_cost,net_profit,hourly_rate,is_profitable,is_long_ride,timestamp,weather) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *")
      .get(ride.pickupZoneId, ride.dropoffZoneId, ride.distanceKm, ride.durationMin, ride.fare, ride.commission, ride.fuelCost, ride.netProfit, ride.hourlyRate, ride.isProfitable ? 1 : 0, ride.isLongRide ? 1 : 0, ride.timestamp, ride.weather || null),

  getRideStats: () => {
    const stats = sqlite.prepare("SELECT COUNT(*) as total, SUM(net_profit) as totalNet, AVG(hourly_rate) as avgRate, AVG(distance_km) as avgDist, SUM(CASE WHEN is_profitable=1 THEN 1 ELSE 0 END) as profitable, SUM(CASE WHEN is_long_ride=1 THEN 1 ELSE 0 END) as longRides FROM rides").get() as any;
    return { total: stats.total || 0, totalNetProfit: Math.round((stats.totalNet || 0) * 100) / 100, avgHourlyRate: Math.round((stats.avgRate || 0) * 100) / 100, avgDistance: Math.round((stats.avgDist || 0) * 10) / 10, profitableCount: stats.profitable || 0, longRideCount: stats.longRides || 0 };
  },

  getRecentRides: (limit = 10) => sqlite.prepare("SELECT * FROM rides ORDER BY timestamp DESC LIMIT ?").all(limit),

  getDriverProfile: () => sqlite.prepare("SELECT * FROM driver_profile LIMIT 1").get(),

  updateDriverProfile: (profile) => {
    const existing = sqlite.prepare("SELECT id FROM driver_profile LIMIT 1").get() as any;
    if (existing) {
      sqlite.prepare("UPDATE driver_profile SET fuel_consumption_per100km=?,fuel_price_per_liter=?,platform_commission_pct=?,hourly_target_income=?,wear_cost_per_km=?,vehicle_type=?,prefer_long_rides=? WHERE id=?")
        .run(profile.fuelConsumptionPer100km ?? 7.5, profile.fuelPricePerLiter ?? 1.92, profile.platformCommissionPct ?? 25, profile.hourlyTargetIncome ?? 35, profile.wearCostPerKm ?? 0.08, profile.vehicleType ?? "berline", profile.preferLongRides ? 1 : 0, existing.id);
    } else {
      sqlite.prepare("INSERT INTO driver_profile (fuel_consumption_per100km,fuel_price_per_liter,platform_commission_pct,hourly_target_income,wear_cost_per_km,vehicle_type,prefer_long_rides) VALUES (?,?,?,?,?,?,?)")
        .run(profile.fuelConsumptionPer100km ?? 7.5, profile.fuelPricePerLiter ?? 1.92, profile.platformCommissionPct ?? 25, profile.hourlyTargetIncome ?? 35, profile.wearCostPerKm ?? 0.08, profile.vehicleType ?? "berline", profile.preferLongRides ? 1 : 0);
    }
    return sqlite.prepare("SELECT * FROM driver_profile LIMIT 1").get();
  },

  getSeedMeta: () => {
    const rows = sqlite.prepare("SELECT key, value FROM seed_meta").all() as any[];
    const meta: Record<string, string> = {};
    rows.forEach((r: any) => { meta[r.key] = r.value; });
    return meta;
  },

  getScoreHistory: (date?: string) => {
    if (date) return sqlite.prepare("SELECT * FROM score_history WHERE seed_date=? ORDER BY zone_id, hour").all(date);
    return sqlite.prepare("SELECT DISTINCT seed_date FROM score_history ORDER BY seed_date DESC LIMIT 7").all();
  },

  forceReseed: () => {
    const now = new Date();
    const today = getTodayStr();
    const dayOfWeek = now.getDay();
    sqlite.exec("DELETE FROM profitability_scores");
    reseedScores(today, dayOfWeek);
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_seed_date',?)").run(today);
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_seed_day',?)").run(String(dayOfWeek));
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_seed_ts',?)").run(now.toISOString());
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_refresh_ts',?)").run(now.toISOString());
    const cnt = (sqlite.prepare("SELECT COUNT(*) as c FROM profitability_scores").get() as any).c;
    console.log(`[storage] forceReseed: ${cnt} scores recalculés à ${now.toISOString()}`);
    return { reseeded: true, count: cnt, timestamp: now.toISOString() };
  },

  getLastRefreshTs: () => {
    const row = sqlite.prepare("SELECT value FROM seed_meta WHERE key='last_refresh_ts'").get() as any;
    return row?.value || null;
  },

  // Diff J vs J-1 pour l'analyse inversée
  getDailyDiff: () => {
    const today = getTodayStr();
    const yesterday = getYesterdayStr();
    const todayScores = sqlite.prepare("SELECT zone_id, hour, day_type, profitability_index, surge_multiplier, demand_score, supply_score FROM profitability_scores ORDER BY zone_id, hour").all() as any[];
    const yesterdayScores = sqlite.prepare("SELECT zone_id, hour, day_type, profitability_index, surge_multiplier, demand_score, supply_score FROM score_history WHERE seed_date=? ORDER BY zone_id, hour").all(yesterday) as any[];

    if (yesterdayScores.length === 0) return { today, yesterday, diff: [], hasHistory: false };

    const yMap: Record<string, any> = {};
    yesterdayScores.forEach((s: any) => { yMap[`${s.zone_id}|${s.hour}|${s.day_type}`] = s; });

    const diff = todayScores.map((t: any) => {
      const y = yMap[`${t.zone_id}|${t.hour}|${t.day_type}`];
      if (!y) return null;
      return {
        zone_id: t.zone_id,
        hour: t.hour,
        day_type: t.day_type,
        today_index: t.profitability_index,
        yesterday_index: y.profitability_index,
        delta_index: Math.round((t.profitability_index - y.profitability_index) * 10) / 10,
        today_surge: t.surge_multiplier,
        yesterday_surge: y.surge_multiplier,
        delta_surge: Math.round((t.surge_multiplier - y.surge_multiplier) * 100) / 100,
        today_demand: t.demand_score,
        yesterday_demand: y.demand_score,
        delta_demand: Math.round((t.demand_score - y.demand_score) * 10) / 10,
      };
    }).filter(Boolean);

    return { today, yesterday, diff, hasHistory: true, todayLabel: DAY_COEFFICIENTS[new Date().getDay()]?.label, yesterdayLabel: DAY_COEFFICIENTS[(new Date().getDay() + 6) % 7]?.label };
  },
};
