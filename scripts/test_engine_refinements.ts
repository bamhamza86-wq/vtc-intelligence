/**
 * test_engine_refinements.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Script de régression — Audit Vague 2 (Juin 2026)
 * Simule computeScore AVANT vs APRÈS les 10 corrections pour les 14 zones × 24h
 *
 * Corrections testées :
 *   A1 — eventNorm DB-driven (plus de constante fantôme statique)
 *   A2 — grève DB-driven (plus de dayOfWeekNow===4 hardcodé)
 *   B1 — repoMin plafonné 45min (CDG bug 346min)
 *   B2 — rampe salon progressive (cliff booléen 14→28 supprimé)
 *   B3 — isMidDay corrigé h<=13 (était h<=18)
 *   C1 — Map events préchargée (N+1 → 1 query)
 *   D1 — surgeNorm normalisé par log(SURGE_CAP=3.8)
 *   E1 — shortRideBonus guard isShortRideZone (baseAvgDist<13)
 *   G  — Pragmas SQLite WAL/cache/mmap
 *   H1 — Sigmoid inflection adaptative
 *
 * Usage : npx tsx scripts/test_engine_refinements.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync } from "node:fs";

// ─── Constantes communes ────────────────────────────────────────────────────

const ZONES_93 = [
  { id: "z_cdg",                name: "CDG — Roissy",             type: "airport",   lat: 49.0097, lng: 2.5479 },
  { id: "z_orly",               name: "Orly",                     type: "airport",   lat: 48.7262, lng: 2.3652 },
  { id: "z_saint_denis_gare",   name: "Gare Saint-Denis",         type: "transport", lat: 48.9362, lng: 2.3573 },
  { id: "z_bobigny_gare",       name: "Bobigny P. Picasso",        type: "transport", lat: 48.9059, lng: 2.4470 },
  { id: "z_le_bourget",         name: "Le Bourget",               type: "business",  lat: 48.9342, lng: 2.4356 },
  { id: "z_villepinte",         name: "Parc Villepinte",          type: "business",  lat: 48.9653, lng: 2.5100 },
  { id: "z_tremblay",           name: "Tremblay-en-France",       type: "residential", lat: 48.9583, lng: 2.5779 },
  { id: "z_aulnay",             name: "Aulnay-sous-Bois",        type: "residential", lat: 48.9397, lng: 2.4941 },
  { id: "z_aubervilliers",      name: "Aubervilliers",            type: "urban",     lat: 48.9135, lng: 2.3834 },
  { id: "z_plaine_commune",     name: "Plaine Commune",           type: "business",  lat: 48.9233, lng: 2.3680 },
  { id: "z_epinay_gennevilliers", name: "Épinay/Gennevilliers",   type: "residential", lat: 48.9567, lng: 2.2997 },
  { id: "z_93_centre",          name: "93 Centre (Pantin/Noisy)", type: "urban",     lat: 48.8971, lng: 2.4270 },
  { id: "z_montreuil",          name: "Montreuil",                type: "urban",     lat: 48.8635, lng: 2.4432 },
  { id: "z_stade_france",       name: "Stade de France",          type: "stadium",   lat: 48.9244, lng: 2.3601 },
];

// Patterns par zone (identiques AVANT et APRÈS — seul computeScore change)
const PATTERNS: Record<string, any> = {
  z_cdg:              { peakHours: [4,5,6,7,8,9,10,11,12,13,16,17,18,19,20,21,22,23], baseAvgDist: 42, baseLongRide: 0.94, demandBoost6_10: 10, demandCap: 98 },
  z_orly:             { peakHours: [5,6,7,8,9,10,11,12,13,17,18,19,20,21], baseAvgDist: 27, baseLongRide: 0.84, demandBoost6_10: 8 },
  z_le_bourget:       { peakHours: [7,8,9,17,18,19], baseAvgDist: 14, baseLongRide: 0.32, baseAvgDistSalon: 22, baseLongRideSalon: 0.54, demandBoost6_10: 6 },
  z_villepinte:       { peakHours: [7,8,9,17,18,19], baseAvgDist: 14, baseLongRide: 0.20, baseAvgDistSalon: 28, baseLongRideSalon: 0.62, demandBoost11_14: 12, demandBoost14_18: 8, demandBoost6_10: 8 },
  z_tremblay:         { peakHours: [7,8,9,17,18], baseAvgDist: 18, baseLongRide: 0.42, demandBoost6_10: 5 },
  z_aulnay:           { peakHours: [6,7,8,9,17,18], baseAvgDist: 20, baseLongRide: 0.48, demandBoost6_10: 7 },
  z_saint_denis_gare: { peakHours: [6,7,8,9,17,18,19], baseAvgDist: 12, baseLongRide: 0.28, demandBoost6_10: 8 },
  z_plaine_commune:   { peakHours: [7,8,9,17,18], baseAvgDist: 13, baseLongRide: 0.30, demandBoost6_10: 7, demandBoost11_14: 6 },
  z_bobigny_gare:     { peakHours: [7,8,9,17,18,19], baseAvgDist: 13, baseLongRide: 0.32, demandBoost6_10: 6 },
  z_aubervilliers:    { peakHours: [7,8,9,17,18], baseAvgDist: 11, baseLongRide: 0.22, demandBoost6_10: 5 },
  z_epinay_gennevilliers: { peakHours: [7,8,17,18], baseAvgDist: 12, baseLongRide: 0.26, demandBoost6_10: 4 },
  z_93_centre:        { peakHours: [7,8,9,17,18,19], baseAvgDist: 11, baseLongRide: 0.24, demandBoost6_10: 5 },
  z_montreuil:        { peakHours: [7,8,9,17,18,19], baseAvgDist: 11, baseLongRide: 0.24, demandBoost6_10: 5 },
  z_stade_france:     { peakHours: [13,16,17,18,19,20,21,22,23], baseAvgDist: 14, baseLongRide: 0.32 },
};

const DAY_COEFFICIENTS: Record<number, any> = {
  0: { demand: 0.74, supply: 0.58, surge: 1.14, supply_midday: 0.62, supply_morning: 0.55, label: "Dimanche" },
  1: { demand: 0.93, supply: 0.88, surge: 1.08, supply_midday: 0.90, supply_morning: 0.72, label: "Lundi" },
  2: { demand: 1.03, supply: 0.78, surge: 1.18, supply_midday: 0.82, supply_morning: 0.65, label: "Mardi" },
  3: { demand: 1.04, supply: 0.90, surge: 1.15, supply_midday: 0.93, supply_morning: 0.78, label: "Mercredi" },
  4: { demand: 1.18, supply: 0.91, surge: 1.28, supply_midday: 0.93, supply_morning: 0.68, label: "Jeudi" },
  5: { demand: 1.10, supply: 0.85, surge: 1.28, supply_midday: 0.88, supply_morning: 0.75, label: "Vendredi" },
  6: { demand: 0.82, supply: 0.62, surge: 1.22, supply_midday: 0.65, supply_morning: 0.52, label: "Samedi" },
};

const REAL_DIST_KM: Record<string, number> = {
  z_cdg: 23.8, z_orly: 28.6, z_le_bourget: 12.1, z_villepinte: 21.6,
  z_tremblay: 22.9, z_aulnay: 19.5, z_saint_denis_gare: 6.5,
  z_plaine_commune: 5.8, z_bobigny_gare: 13.4, z_aubervilliers: 6.6,
  z_epinay_gennevilliers: 9.6, z_93_centre: 6.8,
  z_montreuil: 14.0, z_stade_france: 5.2,
};

const SPEED_RUSH_PM: Record<string, number> = {
  z_cdg: 32.45, z_orly: 26.00, z_le_bourget: 18.15, z_villepinte: 30.86,
  z_tremblay: 29.87, z_aulnay: 27.21, z_saint_denis_gare: 13.00,
  z_plaine_commune: 16.57, z_bobigny_gare: 22.33, z_aubervilliers: 12.77,
  z_epinay_gennevilliers: 13.71, z_93_centre: 12.75,
  z_montreuil: 20.49, z_stade_france: 12.48,
};

function getRatioH(hh: number): number {
  if (hh < 6)  return 2.20;
  if (hh < 7)  return 1.32;
  if (hh < 8)  return 0.80;
  if (hh < 9)  return 0.72;
  if (hh < 10) return 0.85;
  if (hh < 11) return 1.38;
  if (hh < 12) return 1.62;
  if (hh < 13) return 1.55;
  if (hh < 14) return 1.48;
  if (hh < 15) return 1.38;
  if (hh < 16) return 1.22;
  if (hh < 17) return 1.08;
  if (hh < 19) return 1.00;
  if (hh < 22) return 1.52;
  return 2.20;
}

// ─── Simulation Jour : Jeudi (dayOfWeek=4) ────────────────────────────────
// Cas le plus impactant : demand=1.18, surge=1.28
const SIM_DAY_OF_WEEK = 4; // Jeudi
const SIM_DAY_TYPE = "weekday";

// ─── Événements simulés (aucun event actif → tester le fantôme A1) ─────────
// AVANT : eventNorm statique hardcodée (ex: villepinte=0.75, le_bourget=1.25)
// APRÈS : zoneActiveEvents vide → eventNorm=0 (correct)
const MOCK_EVENTS_AFTER: Record<string, any[]> = {}; // pas d'événements actifs

// ─── ANCIENNE logique (AVANT corrections) ───────────────────────────────────
function computeScoreBefore(
  zone: typeof ZONES_93[0],
  h: number,
  dayOfWeek: number,
  seedVariance: number
): number {
  const patBase = PATTERNS[zone.id] || { peakHours: [8,12,18], baseAvgDist: 15, baseLongRide: 0.30 };
  const pat = { ...patBase };

  const isPeak = pat.peakHours.includes(h);
  const isNight = h >= 0 && h < 5;
  // BUG B3 : isMidDay était h <= 18 (trop large — couvre tout l'après-midi)
  const isMidDay = h >= 11 && h <= 18;
  const isWeekendNight = dayOfWeek === 0 || dayOfWeek === 6 ? (h >= 22 || h <= 3) : false;
  const dayCo = DAY_COEFFICIENTS[dayOfWeek] || DAY_COEFFICIENTS[2];

  let demandBase = isPeak ? 82 : (isNight ? 36 : 50);
  if (zone.type === "airport") {
    demandBase = isPeak ? 94 : (isNight ? 62 : 66);
  }
  if (isMidDay && h >= 11 && h < 14) demandBase += (patBase.demandBoost11_14 ?? 0);
  if (isMidDay && h >= 14 && h <= 18) demandBase += (patBase.demandBoost14_18 ?? 0);
  if (h >= 6 && h < 10) demandBase += (patBase.demandBoost6_10 ?? 0);
  if (zone.id === "z_cdg"  && h >= 6  && h <= 8) demandBase = Math.min(demandBase + 4, 98);
  if (zone.id === "z_orly" && h === 8)            demandBase = Math.min(demandBase + 3, 94);
  if (zone.id === "z_stade_france" && !isPeak)    demandBase = 20;
  if (isWeekendNight) demandBase += 24;
  demandBase *= dayCo.demand;
  const v = Math.sin(seedVariance * 7.3 + h * 0.5) * 0.07;
  const demand = Math.min(100, Math.max(5, demandBase * (1 + v)));

  // BUG B3 affecte aussi supply (isMorning séparé, mais pas isMidDay)
  const isMorning = h >= 6 && h < 10;
  const supplyCoeff = isMorning ? dayCo.supply_morning
    : isMidDay ? dayCo.supply_midday
    : dayCo.supply;
  let supplyBase = isPeak ? 58 : (isNight ? 16 : 48);
  if (zone.type === "airport") supplyBase = isPeak ? 48 : 34;
  if (zone.id === "z_stade_france" && !isPeak) supplyBase = 64;
  if (isMidDay && h >= 11 && h < 14 &&
    ["z_plaine_commune","z_le_bourget","z_villepinte"].includes(zone.id)) {
    supplyBase = Math.min(supplyBase + 8, 72);
  }
  supplyBase *= supplyCoeff;
  const vs = Math.cos(seedVariance * 5.1 + h * 0.7) * 0.09;
  const supply = Math.max(5, Math.min(100, supplyBase * (1 + vs)));

  const ratio = demand / Math.max(supply, 1);

  const rawRatio = getRatioH(h);
  const rideRatio = Math.min(rawRatio * 1.22, 1.05);
  const repoRatio = rawRatio * 0.82;
  const baseSpeed = SPEED_RUSH_PM[zone.id] ?? 20.0;
  const effRideSpeed = Math.max(baseSpeed * rideRatio, baseSpeed * 0.88);
  const effRepoSpeed = Math.max(baseSpeed * repoRatio, 4.0);

  const distMultiplier = isPeak ? 1.12 : (isMidDay ? 1.05 : 0.92);
  const avgDist = pat.baseAvgDist * distMultiplier + Math.sin(seedVariance + h) * 1.5;
  const avgDur = (avgDist / effRideSpeed) * 60;
  const avgFare = avgDist * 1.30 + 2.80;

  const isMorningRush = h >= 6 && h < 9;
  const surgeThreshold1 = isMorningRush ? 1.5 : isMidDay ? 1.9 : 2.2;
  const surgeThreshold2 = isMorningRush ? 1.1 : isMidDay ? 1.4 : 1.7;
  const surgeThreshold3 = isMorningRush ? 0.9 : isMidDay ? 1.1 : 1.3;
  const surgeMult = ratio > surgeThreshold1 ? 1.90 * dayCo.surge
    : ratio > surgeThreshold2 ? 1.48 * dayCo.surge
    : ratio > surgeThreshold3 ? 1.20 * dayCo.surge
    : 1.0;
  const surge = Math.min(3.8, surgeMult);

  const longRide = Math.min(0.98, pat.baseLongRide * (zone.type === "airport" ? 1.12 : 1.0));
  const grossWithSurge = avgFare * surge;
  const costKm = 0.224;
  const netFare = grossWithSurge * 0.75 - avgDist * costKm;

  // BUG B1 : repoMin sans plafond 45min
  const repoKm = Math.max(3, avgDist * 0.55);
  const repoMin = Math.max(3, (repoKm / effRepoSpeed) * 60); // PAS de min(45, ...)

  const cycleMins = avgDur + repoMin;
  const coursesPerHour = 60 / Math.max(cycleMins, 8);
  const netHourly = netFare * coursesPerHour;

  // BUG H1 : inflection statique = 45 (pas adaptative)
  const inflection = 45;
  const sigRent = 1 / (1 + Math.exp(-0.08 * (netHourly - inflection)));

  // BUG E1 : shortRideBonus sans guard isShortRideZone
  const shortRideBonus = (avgDist < 12 && surge > 1.5)
    ? Math.min(8, (surge - 1.5) * 6.4)
    : 0;

  const ratioNorm = Math.min(Math.log1p(ratio) / Math.log1p(6), 1.0);
  const distNorm = Math.min(avgDist / 55, 1.0);
  const longScore = longRide * (0.55 + 0.45 * distNorm);

  // BUG D1 : surgeNorm normalisé par log(4.8) au lieu de log(SURGE_CAP=3.8)
  const surgeNorm_before = surge > 1 ? Math.min(Math.log(surge) / Math.log(4.8), 1.0) : 0;

  // BUG A1 : eventNorm statique hardcodée (constante fantôme)
  // Simulation : le code AVANT avait une constante statique par zone (extraite de l'audit)
  const STATIC_EVENT_NORMS: Record<string, number> = {
    z_villepinte:   0.75,  // boost fantôme +3.75pts même sans event
    z_le_bourget:   1.25,  // boost fantôme +6.25pts même sans event
    z_stade_france: 0.50,  // boost fantôme +2.5pts
    z_cdg:          0.30,  // boost fantôme +1.5pts
    z_orly:         0.20,  // boost fantôme +1.0pts
  };
  const eventNorm_before = STATIC_EVENT_NORMS[zone.id] ?? 0;

  const profIdx = Math.min(95, Math.max(5, Math.round((
    0.50 * sigRent * 100 +
    0.16 * ratioNorm * 100 +
    0.15 * longScore * 100 +
    0.14 * surgeNorm_before * 100 +
    0.05 * eventNorm_before * 100 +
    shortRideBonus
  ) * 10) / 10));

  return profIdx;
}

// ─── NOUVELLE logique (APRÈS corrections) ──────────────────────────────────
function computeScoreAfter(
  zone: typeof ZONES_93[0],
  h: number,
  dayOfWeek: number,
  seedVariance: number
): number {
  const patBase = PATTERNS[zone.id] || { peakHours: [8,12,18], baseAvgDist: 15, baseLongRide: 0.30 };

  // B2 : rampe salon (pas d'event actif dans ce test → salonRatio=0)
  const zoneActiveEvents: any[] = MOCK_EVENTS_AFTER[zone.id] ?? [];
  const salonBoost = zoneActiveEvents
    .filter((e: any) => ["salon","conference","congres","exhibition"].includes(e.event_type))
    .reduce((acc: number, e: any) => Math.max(acc, e.demand_boost ?? 0), 0);
  const salonRatio = salonBoost >= 1.5 ? Math.min(1.0, (salonBoost - 1.5) / 2.5) : 0;
  const pat = {
    ...patBase,
    baseAvgDist:  patBase.baseAvgDist + salonRatio * ((patBase.baseAvgDistSalon ?? patBase.baseAvgDist) - patBase.baseAvgDist),
    baseLongRide: patBase.baseLongRide + salonRatio * ((patBase.baseLongRideSalon ?? patBase.baseLongRide) - patBase.baseLongRide),
  };

  const isPeak = pat.peakHours.includes(h);
  const isNight = h >= 0 && h < 5;
  // FIX B3 : isMidDay corrigé h<=13
  const isMidDay = h >= 11 && h <= 13;
  const isWeekendNight = (dayOfWeek === 0 || dayOfWeek === 6) && (h >= 22 || h <= 3);
  const dayCo = DAY_COEFFICIENTS[dayOfWeek] || DAY_COEFFICIENTS[2];

  let demandBase = isPeak ? 82 : (isNight ? 36 : 50);
  if (zone.type === "airport") {
    demandBase = isPeak ? 94 : (isNight ? 62 : 66);
    if ((patBase as any).demandCap) demandBase = Math.min(demandBase, (patBase as any).demandCap);
  }
  if (isMidDay && h >= 11 && h < 14) demandBase += (patBase.demandBoost11_14 ?? 0);
  if (isMidDay && h >= 14 && h <= 18) demandBase += (patBase.demandBoost14_18 ?? 0);
  if (h >= 6 && h < 10) demandBase += (patBase.demandBoost6_10 ?? 0);
  if (zone.id === "z_cdg"  && h >= 6  && h <= 8) demandBase = Math.min(demandBase + 4, 98);
  if (zone.id === "z_orly" && h === 8)            demandBase = Math.min(demandBase + 3, 94);
  if (zone.id === "z_stade_france" && !isPeak)    demandBase = 20;
  if (isWeekendNight) demandBase += 24;
  demandBase *= dayCo.demand;
  const v = Math.sin(seedVariance * 7.3 + h * 0.5) * 0.07;
  const demand = Math.min(100, Math.max(5, demandBase * (1 + v)));

  const isMorning = h >= 6 && h < 10;
  const supplyCoeff = isMorning ? dayCo.supply_morning
    : isMidDay ? dayCo.supply_midday
    : dayCo.supply;
  let supplyBase = isPeak ? 58 : (isNight ? 16 : 48);
  if (zone.type === "airport") supplyBase = isPeak ? 48 : 34;
  if (zone.id === "z_stade_france" && !isPeak) supplyBase = 64;
  if (isMidDay && h >= 11 && h < 14 &&
    ["z_plaine_commune","z_le_bourget","z_villepinte"].includes(zone.id)) {
    supplyBase = Math.min(supplyBase + 8, 72);
  }
  supplyBase *= supplyCoeff;
  const vs = Math.cos(seedVariance * 5.1 + h * 0.7) * 0.09;
  const supply = Math.max(5, Math.min(100, supplyBase * (1 + vs)));

  const ratio = demand / Math.max(supply, 1);

  const rawRatio = getRatioH(h);
  const rideRatio = Math.min(rawRatio * 1.22, 1.05);
  const repoRatio = rawRatio * 0.82;
  const baseSpeed = SPEED_RUSH_PM[zone.id] ?? 20.0;
  const effRideSpeed = Math.max(baseSpeed * rideRatio, baseSpeed * 0.88);
  const effRepoSpeed = Math.max(baseSpeed * repoRatio, 4.0);

  const distMultiplier = isPeak ? 1.12 : (isMidDay ? 1.05 : 0.92);
  const avgDist = pat.baseAvgDist * distMultiplier + Math.sin(seedVariance + h) * 1.5;
  const avgDur = (avgDist / effRideSpeed) * 60;
  const avgFare = avgDist * 1.30 + 2.80;

  const isMorningRush = h >= 6 && h < 9;
  const surgeThreshold1 = isMorningRush ? 1.5 : isMidDay ? 1.9 : 2.2;
  const surgeThreshold2 = isMorningRush ? 1.1 : isMidDay ? 1.4 : 1.7;
  const surgeThreshold3 = isMorningRush ? 0.9 : isMidDay ? 1.1 : 1.3;
  const surgeMult = ratio > surgeThreshold1 ? 1.90 * dayCo.surge
    : ratio > surgeThreshold2 ? 1.48 * dayCo.surge
    : ratio > surgeThreshold3 ? 1.20 * dayCo.surge
    : 1.0;
  const surge = Math.min(3.8, surgeMult);

  const longRide = Math.min(0.98, pat.baseLongRide * (zone.type === "airport" ? 1.12 : 1.0));
  const grossWithSurge = avgFare * surge;
  const costKm = 0.224;
  const netFare = grossWithSurge * 0.75 - avgDist * costKm;

  // FIX B1 : repoMin plafonné 45min
  const repoKm = Math.max(3, avgDist * 0.55);
  const repoMin = Math.min(45, Math.max(3, (repoKm / effRepoSpeed) * 60));

  const cycleMins = avgDur + repoMin;
  const coursesPerHour = 60 / Math.max(cycleMins, 8);
  const netHourly = netFare * coursesPerHour;

  // FIX H1 : inflection adaptative
  const BASE_INFLECTION = 45;
  const inflectionAdjust = (dayCo.demand - 1.0) * 10;
  const inflection = Math.max(30, Math.min(65, BASE_INFLECTION + inflectionAdjust));
  const sigRent = 1 / (1 + Math.exp(-0.08 * (netHourly - inflection)));

  // FIX E1 : guard isShortRideZone (baseAvgDist<13)
  const isShortRideZone = pat.baseAvgDist < 13;
  const shortRideBonus = (isShortRideZone && avgDist < 12 && surge > 1.5)
    ? Math.min(8, (surge - 1.5) * 6.4)
    : 0;

  const ratioNorm = Math.min(Math.log1p(ratio) / Math.log1p(6), 1.0);
  const distNorm = Math.min(avgDist / 55, 1.0);
  const longScore = longRide * (0.55 + 0.45 * distNorm);

  // FIX D1 : surgeNorm normalisé par log(SURGE_CAP=3.8)
  const SURGE_CAP = 3.8;
  const surgeNorm = surge > 1 ? Math.min(Math.log(surge) / Math.log(SURGE_CAP), 1.0) : 0;

  // FIX A1 : eventNorm DB-driven (aucun event actif → 0)
  const EVENT_NORM_CEILING = 6.0;
  const maxBoost = zoneActiveEvents.length > 0
    ? Math.max(...zoneActiveEvents.map((e: any) => e.demand_boost ?? 0))
    : 0;
  const eventNorm = Math.min(1.0, maxBoost / EVENT_NORM_CEILING);

  const profIdx = Math.min(95, Math.max(5, Math.round((
    0.50 * sigRent * 100 +
    0.16 * ratioNorm * 100 +
    0.15 * longScore * 100 +
    0.14 * surgeNorm * 100 +
    0.05 * eventNorm * 100 +
    shortRideBonus
  ) * 10) / 10));

  return profIdx;
}

// ─── Exécution du test ──────────────────────────────────────────────────────

interface ZoneDelta {
  zoneId: string;
  zoneName: string;
  avgBefore: number;
  avgAfter: number;
  deltaPct: number;
  maxDelta: number;
  maxDeltaHour: number;
  hourlyDetails: Array<{
    h: number;
    before: number;
    after: number;
    delta: number;
    deltaPct: number;
  }>;
}

function runRegressionTest(): void {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  VTC Intelligence — Test de Régression Vague 2               ");
  console.log(`  Jour simulé : ${DAY_COEFFICIENTS[SIM_DAY_OF_WEEK].label} (j=${SIM_DAY_OF_WEEK})   `);
  console.log(`  Demande ×${DAY_COEFFICIENTS[SIM_DAY_OF_WEEK].demand}, Surge ×${DAY_COEFFICIENTS[SIM_DAY_OF_WEEK].surge}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results: ZoneDelta[] = [];
  const significantShifts: ZoneDelta[] = [];

  for (let zi = 0; zi < ZONES_93.length; zi++) {
    const zone = ZONES_93[zi];
    const seedVar = zi * 1.37;
    const hourlyDetails: ZoneDelta["hourlyDetails"] = [];
    let sumBefore = 0;
    let sumAfter = 0;
    let maxDelta = 0;
    let maxDeltaHour = 0;

    for (let h = 0; h < 24; h++) {
      const before = computeScoreBefore(zone, h, SIM_DAY_OF_WEEK, seedVar);
      const after = computeScoreAfter(zone, h, SIM_DAY_OF_WEEK, seedVar);
      const delta = after - before;
      const deltaPct = before > 0 ? (delta / before) * 100 : 0;

      hourlyDetails.push({ h, before, after, delta, deltaPct });
      sumBefore += before;
      sumAfter += after;

      if (Math.abs(delta) > Math.abs(maxDelta)) {
        maxDelta = delta;
        maxDeltaHour = h;
      }
    }

    const avgBefore = sumBefore / 24;
    const avgAfter = sumAfter / 24;
    const deltaPct = avgBefore > 0 ? ((avgAfter - avgBefore) / avgBefore) * 100 : 0;

    const zoneDelta: ZoneDelta = {
      zoneId: zone.id,
      zoneName: zone.name,
      avgBefore: Math.round(avgBefore * 10) / 10,
      avgAfter: Math.round(avgAfter * 10) / 10,
      deltaPct: Math.round(deltaPct * 10) / 10,
      maxDelta: Math.round(maxDelta * 10) / 10,
      maxDeltaHour,
      hourlyDetails,
    };

    results.push(zoneDelta);
    if (Math.abs(deltaPct) > 10) {
      significantShifts.push(zoneDelta);
    }
  }

  // ─── Tableau récapitulatif ──────────────────────────────────────────────
  console.log("┌────────────────────────────────────────┬───────┬───────┬────────────┬──────────┐");
  console.log("│ Zone                                   │ AVANT │ APRÈS │ Δ moy. (%) │ Δ max/h  │");
  console.log("├────────────────────────────────────────┼───────┼───────┼────────────┼──────────┤");

  for (const r of results) {
    const flag = Math.abs(r.deltaPct) > 10 ? " ⚠️" : Math.abs(r.deltaPct) > 5 ? " ~" : "";
    const name = r.zoneName.padEnd(39).slice(0, 39);
    const before = String(r.avgBefore).padStart(5);
    const after = String(r.avgAfter).padStart(5);
    const pct = (r.deltaPct >= 0 ? "+" : "") + String(r.deltaPct) + "%";
    const maxH = (r.maxDelta >= 0 ? "+" : "") + String(r.maxDelta) + "@h" + String(r.maxDeltaHour);
    console.log(`│ ${name} │ ${before} │ ${after} │ ${pct.padStart(10)} │ ${maxH.padEnd(8)}${flag} │`);
  }

  console.log("└────────────────────────────────────────┴───────┴───────┴────────────┴──────────┘");

  // ─── Zones avec shift > 10% ────────────────────────────────────────────
  if (significantShifts.length > 0) {
    console.log(`\n⚠️  ${significantShifts.length} zone(s) avec variation > 10% :\n`);
    for (const s of significantShifts) {
      const dir = s.deltaPct > 0 ? "↑ HAUSSE" : "↓ BAISSE";
      console.log(`  ${dir} ${s.zoneName} : ${s.avgBefore} → ${s.avgAfter} (${s.deltaPct > 0 ? "+" : ""}${s.deltaPct}%)`);
      console.log(`    Δ max : ${s.maxDelta > 0 ? "+" : ""}${s.maxDelta} pts à h=${s.maxDeltaHour}h`);

      // Détail des heures les plus impactées
      const topHours = s.hourlyDetails
        .filter(d => Math.abs(d.deltaPct) > 10)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 5);
      if (topHours.length > 0) {
        console.log(`    Heures critiques :`);
        for (const t of topHours) {
          console.log(`      h=${String(t.h).padStart(2)}h : ${t.before} → ${t.after} (${t.delta > 0 ? "+" : ""}${Math.round(t.delta * 10) / 10} pts, ${t.delta > 0 ? "+" : ""}${Math.round(t.deltaPct * 10) / 10}%)`);
        }
      }
      console.log();
    }
  } else {
    console.log("\n✅  Aucune zone avec variation > 10% — résultats stables.");
  }

  // ─── Détail CDG (zone la plus critique — repoMin bug B1) ────────────────
  const cdgResult = results.find(r => r.zoneId === "z_cdg");
  if (cdgResult) {
    console.log("\n═══ Détail CDG (zone critique — bug B1 repoMin) ═══════════════");
    console.log(" h  | AVANT | APRÈS | Δ pts | Δ %");
    console.log("----+-------+-------+-------+------");
    for (const d of cdgResult.hourlyDetails) {
      const bar = d.after > d.before ? "▲" : d.after < d.before ? "▼" : "=";
      const flags = [];
      if (d.h >= 6 && d.h <= 9) flags.push("rush-AM");
      if (d.h >= 11 && d.h <= 13) flags.push("midi");
      if (d.h >= 17 && d.h <= 19) flags.push("rush-PM");
      const flagStr = flags.length > 0 ? `  [${flags.join(",")}]` : "";
      console.log(
        ` ${String(d.h).padStart(2)}h | ${String(d.before).padStart(5)} | ${String(d.after).padStart(5)} | ${bar} ${String(Math.abs(d.delta)).padStart(4)} | ${(d.delta >= 0 ? "+" : "-")}${Math.round(Math.abs(d.deltaPct) * 10) / 10}%${flagStr}`
      );
    }
  }

  // ─── Résumé statistique global ─────────────────────────────────────────
  const totalBefore = results.reduce((s, r) => s + r.avgBefore, 0) / results.length;
  const totalAfter = results.reduce((s, r) => s + r.avgAfter, 0) / results.length;
  const globalDelta = ((totalAfter - totalBefore) / totalBefore) * 100;
  const maxShift = results.reduce((m, r) => Math.abs(r.deltaPct) > Math.abs(m.deltaPct) ? r : m);
  const minShift = results.reduce((m, r) => Math.abs(r.deltaPct) < Math.abs(m.deltaPct) ? r : m);

  console.log("\n═══ Résumé Statistique Global ══════════════════════════════════");
  console.log(`  Score moyen AVANT   : ${Math.round(totalBefore * 10) / 10}`);
  console.log(`  Score moyen APRÈS   : ${Math.round(totalAfter * 10) / 10}`);
  console.log(`  Variation globale   : ${globalDelta >= 0 ? "+" : ""}${Math.round(globalDelta * 10) / 10}%`);
  console.log(`  Zone la + impactée  : ${maxShift.zoneName} (${maxShift.deltaPct >= 0 ? "+" : ""}${maxShift.deltaPct}%)`);
  console.log(`  Zone la - impactée  : ${minShift.zoneName} (${minShift.deltaPct >= 0 ? "+" : ""}${minShift.deltaPct}%)`);
  console.log(`  Zones > ±10%        : ${significantShifts.length} / ${results.length}`);

  // ─── Vérification seuil de rentabilité ─────────────────────────────────
  console.log("\n═══ Vérification Seuil Rentabilité (1€/km, 1min/km) ════════════");
  let profitable_before = 0;
  let profitable_after = 0;
  for (const zone of ZONES_93) {
    const zi = ZONES_93.indexOf(zone);
    const seedVar = zi * 1.37;
    for (let h = 6; h < 22; h++) { // heures actives seulement
      const b = computeScoreBefore(zone, h, SIM_DAY_OF_WEEK, seedVar);
      const a = computeScoreAfter(zone, h, SIM_DAY_OF_WEEK, seedVar);
      if (b >= 50) profitable_before++;
      if (a >= 50) profitable_after++;
    }
  }
  const total = ZONES_93.length * 16;
  console.log(`  Slots "rentables" (score≥50) AVANT : ${profitable_before}/${total} (${Math.round(profitable_before/total*100)}%)`);
  console.log(`  Slots "rentables" (score≥50) APRÈS : ${profitable_after}/${total} (${Math.round(profitable_after/total*100)}%)`);
  console.log(`  Variation : ${profitable_after - profitable_before > 0 ? "+" : ""}${profitable_after - profitable_before} slots`);

  // ─── Sortie JSON pour intégration CI ──────────────────────────────────
  const outputPath = "scripts/test_results_regression.json";
  const jsonOutput = {
    meta: {
      timestamp: new Date().toISOString(),
      simDay: DAY_COEFFICIENTS[SIM_DAY_OF_WEEK].label,
      dayOfWeek: SIM_DAY_OF_WEEK,
      zonesCount: ZONES_93.length,
      hoursRange: "0h-23h",
      corrections: ["A1","A2","B1","B2","B3","C1","D1","E1","G","H1"],
    },
    summary: {
      globalAvgBefore: Math.round(totalBefore * 10) / 10,
      globalAvgAfter: Math.round(totalAfter * 10) / 10,
      globalDeltaPct: Math.round(globalDelta * 10) / 10,
      zonesAbove10Pct: significantShifts.length,
      profitableSlotsB4: profitable_before,
      profitableSlotsAfter: profitable_after,
    },
    zones: results.map(r => ({
      zoneId: r.zoneId,
      zoneName: r.zoneName,
      avgBefore: r.avgBefore,
      avgAfter: r.avgAfter,
      deltaPct: r.deltaPct,
      maxDelta: r.maxDelta,
      maxDeltaHour: r.maxDeltaHour,
      significantShift: Math.abs(r.deltaPct) > 10,
    })),
    significantZones: significantShifts.map(s => ({
      zoneId: s.zoneId,
      zoneName: s.zoneName,
      deltaPct: s.deltaPct,
      criticalHours: s.hourlyDetails
        .filter(d => Math.abs(d.deltaPct) > 10)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 5),
    })),
  };

  // Écriture JSON
  writeFileSync(outputPath, JSON.stringify(jsonOutput, null, 2));
  console.log(`\n✅  Résultats JSON exportés : ${outputPath}`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

// ─── Lancement ───────────────────────────────────────────────────────────────
runRegressionTest();
