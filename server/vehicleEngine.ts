/**
 * vehicleEngine.ts — COUCHE VÉHICULE (Entretien, EV, Carburant, Éco-conduite)
 * ═══════════════════════════════════════════════════════════════════════════
 * Inspiré du rapport.md §4 (Optimisation carburant/énergie) et §6 (Coûts cachés) :
 *   §4.1 Score d'éco-conduite avec impact chiffré sur consommation
 *   §4.2 Comparateur de stations-service les moins chères
 *   §4.3 Stratégie de recharge EV en 3 paliers
 *   §4.4 Timer "temps de charge = pause légale" synchronisé
 *   §4.5 Calculateur ROI transition thermique → électrique personnalisé
 *   §6.1 Calendrier d'entretien prédictif basé sur kilométrage réel
 *   §6.3 Simulateur LOA/LLD vs achat avec alerte dépassement kilométrage
 *   §6.6 Calculateur de coût de non-utilisation
 *
 * IMPORTANT — additif uniquement :
 *   - Les leviers 6 (rappels entretien), 7 (LOA/LLD tracker) et 8 (comparateur
 *     financement) réutilisent l'existant (`fiscalProactif.ts` : maintenance_schedule,
 *     loa_contract, compareVehicleFinance) plutôt que de dupliquer des tables —
 *     les endpoints `/api/vehicle/*` demandés délèguent à ces fonctions déjà
 *     testées en production. Voir routes.ts pour le mapping.
 *   - `fuel_stations_idf` et `maintenance_reminders` (levier 6 : version simplifiée
 *     "vidange/pneus/freins/révision/CT/filtre" demandée par l'énoncé) et
 *     `fuel_log` sont de NOUVELLES tables propres à cette couche.
 *
 * ZÉRO nouvelle dépendance npm — better-sqlite3 déjà présent (pattern fatigueCoach.ts).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";
import { CHARGING_STATIONS_IDF, getNearbyStationsFallback, type ChargingStation } from "./chargingStationsIDF";
import * as fatigueCoach from "./fatigueCoach";

const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const DEFAULT_USER = "root";

function nowIso(): string {
  return new Date().toISOString();
}
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHÉMA
// ═══════════════════════════════════════════════════════════════════════════
db.exec(`
  -- Levier 2 : stations carburant IDF (30+ pré-remplies)
  CREATE TABLE IF NOT EXISTS fuel_stations_idf (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    city TEXT NOT NULL,
    fuel_type TEXT NOT NULL,       -- E10 | Gazole | GNV
    price_eur REAL NOT NULL,       -- €/L ou €/kg (GNV)
    unit TEXT NOT NULL DEFAULT 'L',
    updated_at TEXT NOT NULL
  );

  -- Levier 6 : rappels d'entretien (schéma simplifié demandé par l'énoncé)
  CREATE TABLE IF NOT EXISTS maintenance_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,            -- vidange | pneus | freins | revision | CT | filtre
    km_next INTEGER NOT NULL,
    date_next TEXT,
    cost_estimate REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'a_venir', -- a_venir | proche | urgent | fait
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Levier 9 : journal de consommation (pleins carburant ou recharges EV)
  CREATE TABLE IF NOT EXISTS fuel_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    date TEXT NOT NULL,
    km_debut INTEGER NOT NULL,
    km_fin INTEGER NOT NULL,
    litres REAL,                   -- rempli si thermique
    kwh REAL,                      -- rempli si EV
    prix REAL NOT NULL,            -- coût total du plein/recharge en €
    station TEXT,
    created_at TEXT NOT NULL
  );

  -- Levier 1 : saisie éco-conduite (freinage/accélération/vitesse), manuelle ou capteurs
  CREATE TABLE IF NOT EXISTS eco_driving_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    date TEXT NOT NULL,
    harsh_braking_count INTEGER NOT NULL DEFAULT 0,
    harsh_accel_count INTEGER NOT NULL DEFAULT 0,
    avg_speed_kmh REAL NOT NULL DEFAULT 0,
    km_parcourus REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manuel', -- manuel | capteurs
    created_at TEXT NOT NULL
  );

  -- Levier 11 : profil véhicule courant (pour comparateurs EV vs thermique, rentabilité)
  CREATE TABLE IF NOT EXISTS vehicle_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    energie TEXT NOT NULL DEFAULT 'thermique', -- thermique | hybride | electrique
    modele TEXT NOT NULL DEFAULT 'Berline compacte',
    conso_l_100km REAL NOT NULL DEFAULT 6.5,   -- si thermique/hybride
    conso_kwh_100km REAL NOT NULL DEFAULT 16,  -- si EV
    capacite_reservoir_l REAL NOT NULL DEFAULT 50,
    capacite_batterie_kwh REAL NOT NULL DEFAULT 52,
    autonomie_km REAL NOT NULL DEFAULT 350,
    km_par_jour_moyen REAL NOT NULL DEFAULT 220,
    updated_at TEXT NOT NULL
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// SEED — 30+ stations carburant IDF (prix indicatifs juillet 2026)
// ─────────────────────────────────────────────────────────────────────────────
interface SeedStation {
  id: string; name: string; brand: string; lat: number; lng: number; city: string;
  fuel_type: string; price_eur: number; unit?: string;
}

const SEED_STATIONS: SeedStation[] = [
  { id: "fs-001", name: "TotalEnergies Access Paris 15e", brand: "TotalEnergies", lat: 48.8422, lng: 2.2966, city: "Paris 15e", fuel_type: "E10", price_eur: 1.72 },
  { id: "fs-002", name: "TotalEnergies Access Paris 15e (GNV)", brand: "TotalEnergies", lat: 48.8422, lng: 2.2966, city: "Paris 15e", fuel_type: "GNV", price_eur: 1.15, unit: "kg" },
  { id: "fs-003", name: "Intermarché Nanterre", brand: "Intermarché", lat: 48.8924, lng: 2.2065, city: "Nanterre", fuel_type: "E10", price_eur: 1.68 },
  { id: "fs-004", name: "Leclerc Villejuif", brand: "Leclerc", lat: 48.7906, lng: 2.3630, city: "Villejuif", fuel_type: "E10", price_eur: 1.65 },
  { id: "fs-005", name: "Auchan Vélizy 2", brand: "Auchan", lat: 48.7827, lng: 2.1919, city: "Vélizy-Villacoublay", fuel_type: "E10", price_eur: 1.66 },
  { id: "fs-006", name: "Carrefour Rosny 2", brand: "Carrefour", lat: 48.8735, lng: 2.4838, city: "Rosny-sous-Bois", fuel_type: "E10", price_eur: 1.67 },
  { id: "fs-007", name: "BP Gennevilliers", brand: "BP", lat: 48.9330, lng: 2.2941, city: "Gennevilliers", fuel_type: "E10", price_eur: 1.74 },
  { id: "fs-008", name: "Shell Boulogne-Billancourt", brand: "Shell", lat: 48.8352, lng: 2.2400, city: "Boulogne-Billancourt", fuel_type: "E10", price_eur: 1.73 },
  { id: "fs-009", name: "Esso Ivry-sur-Seine", brand: "Esso", lat: 48.8137, lng: 2.3894, city: "Ivry-sur-Seine", fuel_type: "E10", price_eur: 1.71 },
  { id: "fs-010", name: "Avia La Défense", brand: "Avia", lat: 48.8908, lng: 2.2359, city: "Puteaux", fuel_type: "E10", price_eur: 1.75 },
  { id: "fs-011", name: "Intermarché Aubervilliers", brand: "Intermarché", lat: 48.9145, lng: 2.3830, city: "Aubervilliers", fuel_type: "Gazole", price_eur: 1.64 },
  { id: "fs-012", name: "Leclerc Bondy", brand: "Leclerc", lat: 48.9034, lng: 2.4834, city: "Bondy", fuel_type: "Gazole", price_eur: 1.63 },
  { id: "fs-013", name: "Carrefour Montreuil", brand: "Carrefour", lat: 48.8574, lng: 2.4432, city: "Montreuil", fuel_type: "E10", price_eur: 1.69 },
  { id: "fs-014", name: "TotalEnergies Créteil Soleil", brand: "TotalEnergies", lat: 48.7847, lng: 2.4573, city: "Créteil", fuel_type: "E10", price_eur: 1.73 },
  { id: "fs-015", name: "BP Saint-Denis", brand: "BP", lat: 48.9362, lng: 2.3574, city: "Saint-Denis", fuel_type: "E10", price_eur: 1.74 },
  { id: "fs-016", name: "Shell Porte d'Orléans", brand: "Shell", lat: 48.8231, lng: 2.3269, city: "Paris 14e", fuel_type: "E10", price_eur: 1.76 },
  { id: "fs-017", name: "Esso Vitry-sur-Seine", brand: "Esso", lat: 48.7876, lng: 2.3931, city: "Vitry-sur-Seine", fuel_type: "Gazole", price_eur: 1.65 },
  { id: "fs-018", name: "Avia Colombes", brand: "Avia", lat: 48.9226, lng: 2.2544, city: "Colombes", fuel_type: "E10", price_eur: 1.71 },
  { id: "fs-019", name: "Auchan Vélizy (GNV)", brand: "Auchan", lat: 48.7827, lng: 2.1919, city: "Vélizy-Villacoublay", fuel_type: "GNV", price_eur: 1.12, unit: "kg" },
  { id: "fs-020", name: "Intermarché Argenteuil", brand: "Intermarché", lat: 48.9482, lng: 2.2469, city: "Argenteuil", fuel_type: "E10", price_eur: 1.67 },
  { id: "fs-021", name: "Leclerc Noisy-le-Grand", brand: "Leclerc", lat: 48.8474, lng: 2.5514, city: "Noisy-le-Grand", fuel_type: "E10", price_eur: 1.66 },
  { id: "fs-022", name: "Carrefour Vélizy", brand: "Carrefour", lat: 48.7818, lng: 2.1889, city: "Vélizy-Villacoublay", fuel_type: "Gazole", price_eur: 1.62 },
  { id: "fs-023", name: "TotalEnergies Orly", brand: "TotalEnergies", lat: 48.7262, lng: 2.3652, city: "Orly", fuel_type: "E10", price_eur: 1.77 },
  { id: "fs-024", name: "BP Roissy CDG", brand: "BP", lat: 49.0047, lng: 2.5701, city: "Roissy-en-France", fuel_type: "E10", price_eur: 1.79 },
  { id: "fs-025", name: "Shell Massy", brand: "Shell", lat: 48.7304, lng: 2.2831, city: "Massy", fuel_type: "E10", price_eur: 1.73 },
  { id: "fs-026", name: "Esso Bobigny", brand: "Esso", lat: 48.9074, lng: 2.4390, city: "Bobigny", fuel_type: "E10", price_eur: 1.72 },
  { id: "fs-027", name: "Avia Cergy", brand: "Avia", lat: 49.0362, lng: 2.0764, city: "Cergy", fuel_type: "E10", price_eur: 1.70 },
  { id: "fs-028", name: "Intermarché Melun", brand: "Intermarché", lat: 48.5396, lng: 2.6598, city: "Melun", fuel_type: "Gazole", price_eur: 1.61 },
  { id: "fs-029", name: "Leclerc Évry", brand: "Leclerc", lat: 48.6280, lng: 2.4419, city: "Évry-Courcouronnes", fuel_type: "E10", price_eur: 1.64 },
  { id: "fs-030", name: "Carrefour Saint-Quentin-en-Yvelines", brand: "Carrefour", lat: 48.7838, lng: 1.9743, city: "Montigny-le-Bretonneux", fuel_type: "E10", price_eur: 1.66 },
  { id: "fs-031", name: "TotalEnergies Versailles", brand: "TotalEnergies", lat: 48.8014, lng: 2.1301, city: "Versailles", fuel_type: "Gazole", price_eur: 1.66 },
  { id: "fs-032", name: "BP Antony", brand: "BP", lat: 48.7539, lng: 2.2977, city: "Antony", fuel_type: "E10", price_eur: 1.74 },
  { id: "fs-033", name: "Shell Clichy", brand: "Shell", lat: 48.9046, lng: 2.3060, city: "Clichy", fuel_type: "E10", price_eur: 1.75 },
  { id: "fs-034", name: "Total Access Pantin (GNV)", brand: "TotalEnergies", lat: 48.8964, lng: 2.4014, city: "Pantin", fuel_type: "GNV", price_eur: 1.18, unit: "kg" },
];

function seedFuelStations(): void {
  const cnt = (db.prepare(`SELECT COUNT(*) as c FROM fuel_stations_idf`).get() as any).c;
  if (cnt > 0) return;
  const ins = db.prepare(`
    INSERT INTO fuel_stations_idf (id, name, brand, lat, lng, city, fuel_type, price_eur, unit, updated_at)
    VALUES (@id, @name, @brand, @lat, @lng, @city, @fuel_type, @price_eur, @unit, @updated_at)
  `);
  const tx = db.transaction((rows: SeedStation[]) => {
    for (const s of rows) {
      ins.run({ ...s, unit: s.unit ?? "L", updated_at: nowIso() });
    }
  });
  tx(SEED_STATIONS);
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED — rappels entretien (levier 6)
// ─────────────────────────────────────────────────────────────────────────────
function seedMaintenanceReminders(): void {
  const cnt = (db.prepare(`SELECT COUNT(*) as c FROM maintenance_reminders`).get() as any).c;
  if (cnt > 0) return;
  const today = new Date();
  const plus1y = new Date(today); plus1y.setFullYear(plus1y.getFullYear() + 1);
  const plus4y = new Date(today); plus4y.setFullYear(plus4y.getFullYear() + 4);
  const rows = [
    { type: "vidange", km_next: 15000, date_next: null as string | null, cost_estimate: 90 },
    { type: "pneus", km_next: 30000, date_next: null, cost_estimate: 400 },
    { type: "freins", km_next: 40000, date_next: null, cost_estimate: 300 },
    { type: "revision", km_next: 20000, date_next: plus1y.toISOString().slice(0, 10), cost_estimate: 180 },
    { type: "CT", km_next: 999999, date_next: plus4y.toISOString().slice(0, 10), cost_estimate: 78 },
    { type: "filtre", km_next: 20000, date_next: null, cost_estimate: 55 },
  ];
  const ins = db.prepare(`
    INSERT INTO maintenance_reminders (type, km_next, date_next, cost_estimate, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'a_venir', ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      ins.run(r.type, r.km_next, r.date_next, r.cost_estimate, nowIso(), nowIso());
    }
  });
  tx();
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED — profil véhicule par défaut
// ─────────────────────────────────────────────────────────────────────────────
function ensureVehicleProfile(): any {
  let row = db.prepare(`SELECT * FROM vehicle_profile ORDER BY id DESC LIMIT 1`).get();
  if (!row) {
    db.prepare(`
      INSERT INTO vehicle_profile (energie, modele, conso_l_100km, conso_kwh_100km, capacite_reservoir_l, capacite_batterie_kwh, autonomie_km, km_par_jour_moyen, updated_at)
      VALUES ('thermique', 'Berline compacte (Toyota Corolla Hybride)', 5.2, 16, 45, 52, 350, 220, ?)
    `).run(nowIso());
    row = db.prepare(`SELECT * FROM vehicle_profile ORDER BY id DESC LIMIT 1`).get();
  }
  return row;
}

export function initVehicleEngine(): void {
  seedFuelStations();
  seedMaintenanceReminders();
  ensureVehicleProfile();
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVIER 1 — Score éco-conduite
// ═══════════════════════════════════════════════════════════════════════════
export interface EcoScoreInput {
  harsh_braking_count?: number;
  harsh_accel_count?: number;
  avg_speed_kmh?: number;
  km_parcourus?: number;
  source?: "manuel" | "capteurs";
}

export interface EcoScoreResult {
  score: number; // /100
  breakdown: { label_fr: string; points: number; max_points: number }[];
  tips_fr: string[];
  conso_impact_pct: number; // surconsommation estimée en % vs conduite idéale
  date: string;
}

export function logEcoDriving(userId: string, input: EcoScoreInput): { id: number } {
  const info = db.prepare(`
    INSERT INTO eco_driving_log (user_id, date, harsh_braking_count, harsh_accel_count, avg_speed_kmh, km_parcourus, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    new Date().toISOString().slice(0, 10),
    input.harsh_braking_count ?? 0,
    input.harsh_accel_count ?? 0,
    input.avg_speed_kmh ?? 0,
    input.km_parcourus ?? 0,
    input.source ?? "manuel",
    nowIso()
  );
  return { id: Number(info.lastInsertRowid) };
}

export function computeEcoScore(userId: string): EcoScoreResult {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT * FROM eco_driving_log WHERE user_id = ? AND date = ? ORDER BY id DESC
  `).all(userId, today) as any[];

  // Agrégat du jour (somme freinages/accéls, moyenne pondérée vitesse par km)
  const totalBraking = rows.reduce((a, r) => a + (r.harsh_braking_count ?? 0), 0);
  const totalAccel = rows.reduce((a, r) => a + (r.harsh_accel_count ?? 0), 0);
  const totalKm = rows.reduce((a, r) => a + (r.km_parcourus ?? 0), 0);
  const avgSpeed = totalKm > 0
    ? rows.reduce((a, r) => a + (r.avg_speed_kmh ?? 0) * (r.km_parcourus ?? 0), 0) / totalKm
    : (rows[0]?.avg_speed_kmh ?? 32); // 32 km/h = vitesse moyenne urbaine IDF typique

  // Barème /100 : 40 pts freinage, 40 pts accélération, 20 pts vitesse moyenne
  const kmRef = Math.max(totalKm, 1);
  const brakingPer100km = (totalBraking / kmRef) * 100;
  const accelPer100km = (totalAccel / kmRef) * 100;

  const brakingScore = Math.max(0, 40 - brakingPer100km * 2);
  const accelScore = Math.max(0, 40 - accelPer100km * 2);
  // Vitesse idéale urbaine IDF ~30-40 km/h ; pénalité si trop lent (embouteillage subi, hors score)
  // ou trop rapide (survitesse = surconsommation + risque)
  let speedScore = 20;
  if (avgSpeed > 50) speedScore = Math.max(0, 20 - (avgSpeed - 50) * 1.2);
  else if (avgSpeed < 15 && totalKm > 0) speedScore = 15; // trafic dense, pas pénalisant fortement

  const score = Math.round(Math.max(0, Math.min(100, brakingScore + accelScore + speedScore)));

  const breakdown = [
    { label_fr: "Freinage en douceur", points: Math.round(brakingScore), max_points: 40 },
    { label_fr: "Accélération progressive", points: Math.round(accelScore), max_points: 40 },
    { label_fr: "Vitesse moyenne maîtrisée", points: Math.round(speedScore), max_points: 20 },
  ];

  const tips: string[] = [];
  if (brakingScore < 30) tips.push("Anticipe les feux et le trafic pour freiner plus progressivement — chaque freinage brusque coûte du carburant et de l'usure de plaquettes.");
  if (accelScore < 30) tips.push("Accélère en douceur après un arrêt : les à-coups augmentent la consommation de 10 à 20% en ville.");
  if (avgSpeed > 50) tips.push("Ta vitesse moyenne est élevée pour de la conduite urbaine — lever le pied de quelques km/h réduit nettement la conso au-delà de 90 km/h sur voie rapide.");
  if (score >= 80) tips.push("Excellente conduite ! Continue ainsi, tu économises du carburant et prolonges la durée de vie de ton véhicule.");
  if (tips.length === 0) tips.push("Conduite correcte. Pense à vérifier la pression des pneus chaque mois : -0,3 bar = +2% de consommation.");

  // Impact conso estimé : chaque point sous 100 ≈ 0.3% de surconsommation (calibrage heuristique)
  const conso_impact_pct = r2((100 - score) * 0.3);

  return { score, breakdown, tips_fr: tips, conso_impact_pct, date: today };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVIER 2 — Stations carburant les moins chères
// ═══════════════════════════════════════════════════════════════════════════
export interface CheapFuelResult {
  stations: (SeedStation & { unit: string; distanceKm: number; economie_vs_plus_cher_eur_par_plein: number })[];
  fuel_type: string;
  station_moins_chere: string | null;
  prix_moyen_zone: number;
}

export function getCheapFuelStations(lat: number, lng: number, fuelType = "E10", radiusKm = 15): CheapFuelResult {
  const rows = db.prepare(`SELECT * FROM fuel_stations_idf WHERE fuel_type = ?`).all(fuelType) as any[];
  const withDist = rows
    .map((s) => ({ ...s, distanceKm: r2(haversineKm(lat, lng, s.lat, s.lng)) }))
    .filter((s) => s.distanceKm <= radiusKm)
    .sort((a, b) => a.price_eur - b.price_eur || a.distanceKm - b.distanceKm);

  const prices = withDist.map((s) => s.price_eur);
  const maxPrice = prices.length ? Math.max(...prices) : 0;
  const avgPrice = prices.length ? r2(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;

  // Réservoir moyen 50L pour le calcul d'économie
  const TANK_L = 50;
  const stations = withDist.slice(0, 20).map((s) => ({
    ...s,
    economie_vs_plus_cher_eur_par_plein: r2((maxPrice - s.price_eur) * TANK_L),
  }));

  return {
    stations,
    fuel_type: fuelType,
    station_moins_chere: stations[0]?.name ?? null,
    prix_moyen_zone: avgPrice,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVIER 3 — Bornes de recharge stratégiques (réutilise chargingStationsIDF.ts)
// ═══════════════════════════════════════════════════════════════════════════
export interface ChargingStrategyTier {
  palier: "rapide_court" | "moyen_dejeuner" | "lent_pause_nuit";
  label_fr: string;
  duree_min: number;
  pct_batterie_gagne: number;
  stations: (ChargingStation & { distanceKm: number })[];
  conseil_fr: string;
}

export function getChargingStrategy(lat: number, lng: number): { paliers: ChargingStrategyTier[] } {
  const nearby = getNearbyStationsFallback(lat, lng, 25);
  const fast = nearby.filter((s) => s.powerKw >= 100).slice(0, 3);
  const medium = nearby.filter((s) => s.powerKw >= 40 && s.powerKw < 100).slice(0, 3);
  const slow = nearby.filter((s) => s.powerKw < 40).slice(0, 3);

  const paliers: ChargingStrategyTier[] = [
    {
      palier: "rapide_court",
      label_fr: "Recharge rapide courte (entre 2 courses)",
      duree_min: 15,
      pct_batterie_gagne: 40,
      stations: fast.length ? fast : nearby.slice(0, 3),
      conseil_fr: "Idéal pendant une pause café de 15 min entre deux courses — borne ≥100 kW pour maximiser les kWh reçus dans un temps court.",
    },
    {
      palier: "moyen_dejeuner",
      label_fr: "Recharge moyenne pause déjeuner",
      duree_min: 45,
      pct_batterie_gagne: 65,
      stations: medium.length ? medium : nearby.slice(0, 3),
      conseil_fr: "À combiner avec ta pause déjeuner légale (45 min) — borne 40-100 kW, bon compromis prix/vitesse.",
    },
    {
      palier: "lent_pause_nuit",
      label_fr: "Recharge lente pause longue / nuit",
      duree_min: 240,
      pct_batterie_gagne: 100,
      stations: slow.length ? slow : nearby.slice(0, 3),
      conseil_fr: "Recharge complète pendant une pause longue ou à domicile — tarif le plus bas au kWh, à privilégier hors urgence.",
    },
  ];

  return { paliers };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVIER 4 — Temps de charge = pause légale
// ═══════════════════════════════════════════════════════════════════════════
export interface ChargeAsBreakResult {
  fatigue_risk: number;
  next_break_recommended_min: number;
  charge_options: { palier: string; duree_min: number; match_fatigue: boolean; verdict_fr: string }[];
  recommandation_fr: string;
}

export function getChargeAsBreak(userId: string, lat: number, lng: number): ChargeAsBreakResult {
  const risk = fatigueCoach.computeMicrosleepRisk(userId);
  const strategy = getChargingStrategy(lat, lng);

  const charge_options = strategy.paliers.map((p) => {
    const match = p.duree_min >= risk.next_break_recommended_min * 0.7 && p.duree_min <= risk.next_break_recommended_min * 2.5;
    return {
      palier: p.palier,
      duree_min: p.duree_min,
      match_fatigue: risk.next_break_recommended_min > 0 ? match : p.palier === "rapide_court",
      verdict_fr: match
        ? `Bonne coïncidence : ${p.duree_min} min de charge ≈ ta pause recommandée (${risk.next_break_recommended_min} min).`
        : `Écart entre ${p.duree_min} min de charge et la pause recommandée (${risk.next_break_recommended_min} min).`,
    };
  });

  const best = charge_options.find((c) => c.match_fatigue) ?? charge_options[0];
  const recommandation_fr = risk.next_break_recommended_min === 0
    ? "Fatigue élevée détectée : arrête-toi maintenant, profite d'une borne rapide à proximité pour transformer la pause obligatoire en recharge utile."
    : `Ta pause recommandée est de ${risk.next_break_recommended_min} min — le palier "${best?.palier}" correspond le mieux : recharge et repos combinés.`;

  return {
    fatigue_risk: risk.risk,
    next_break_recommended_min: risk.next_break_recommended_min,
    charge_options,
    recommandation_fr,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVIER 5 — Coût réel EV vs thermique (jour par jour)
// ═══════════════════════════════════════════════════════════════════════════
const PRIX_KWH_RAPIDE = 0.25;
const PRIX_KWH_LENT = 0.15;
const PRIX_KWH_DOMICILE = 0.18;
const ENTRETIEN_REDUCTION_EV = 0.4; // -40% entretien EV vs thermique

export interface EvVsThermalDay {
  jour: number;
  km: number;
  cout_ev_eur: number;
  cout_thermique_eur: number;
  economie_jour_eur: number;
  cumul_economie_eur: number;
}

export interface EvVsThermalResult {
  jours: EvVsThermalDay[];
  cout_ev_mensuel_eur: number;
  cout_thermique_mensuel_eur: number;
  economie_mensuelle_eur: number;
  economie_annuelle_estimee_eur: number;
  hypotheses_fr: string[];
}

export function computeEvVsThermal(input: {
  km_par_jour?: number;
  jours?: number;
  conso_kwh_100km?: number;
  conso_l_100km?: number;
  prix_carburant_eur_l?: number;
  pct_recharge_rapide?: number; // part des recharges faites en rapide (0-1)
  pct_recharge_lente?: number;  // part faite en lent (0-1) — le reste = domicile
}): EvVsThermalResult {
  const profile = ensureVehicleProfile();
  const kmJour = input.km_par_jour ?? profile.km_par_jour_moyen ?? 220;
  const jours = input.jours ?? 30;
  const consoKwh = input.conso_kwh_100km ?? profile.conso_kwh_100km ?? 16;
  const consoL = input.conso_l_100km ?? profile.conso_l_100km ?? 6.5;
  const prixCarburant = input.prix_carburant_eur_l ?? 1.72;

  const pctRapide = input.pct_recharge_rapide ?? 0.2;
  const pctLent = input.pct_recharge_lente ?? 0.3;
  const pctDomicile = Math.max(0, 1 - pctRapide - pctLent);

  const prixKwhMoyen = r2(PRIX_KWH_RAPIDE * pctRapide + PRIX_KWH_LENT * pctLent + PRIX_KWH_DOMICILE * pctDomicile);

  // Entretien journalier estimé (base ~4€/jour thermique pour usage VTC intensif, -40% EV)
  const ENTRETIEN_JOUR_THERMIQUE = 4.0;
  const entretienJourEv = r2(ENTRETIEN_JOUR_THERMIQUE * (1 - ENTRETIEN_REDUCTION_EV));

  const jourList: EvVsThermalDay[] = [];
  let cumul = 0;
  for (let j = 1; j <= jours; j++) {
    const coutEnergieEv = r2((kmJour / 100) * consoKwh * prixKwhMoyen);
    const coutEv = r2(coutEnergieEv + entretienJourEv);
    const coutCarburant = r2((kmJour / 100) * consoL * prixCarburant);
    const coutThermique = r2(coutCarburant + ENTRETIEN_JOUR_THERMIQUE);
    const economie = r2(coutThermique - coutEv);
    cumul = r2(cumul + economie);
    jourList.push({ jour: j, km: kmJour, cout_ev_eur: coutEv, cout_thermique_eur: coutThermique, economie_jour_eur: economie, cumul_economie_eur: cumul });
  }

  const cout_ev_mensuel_eur = r2(jourList.reduce((a, d) => a + d.cout_ev_eur, 0));
  const cout_thermique_mensuel_eur = r2(jourList.reduce((a, d) => a + d.cout_thermique_eur, 0));
  const economie_mensuelle_eur = r2(cout_thermique_mensuel_eur - cout_ev_mensuel_eur);

  return {
    jours: jourList,
    cout_ev_mensuel_eur,
    cout_thermique_mensuel_eur,
    economie_mensuelle_eur,
    economie_annuelle_estimee_eur: r2(economie_mensuelle_eur * 12),
    hypotheses_fr: [
      `Prix kWh mélangé : ${prixKwhMoyen}€/kWh (rapide ${PRIX_KWH_RAPIDE}€ ×${Math.round(pctRapide * 100)}%, lent ${PRIX_KWH_LENT}€ ×${Math.round(pctLent * 100)}%, domicile ${PRIX_KWH_DOMICILE}€ ×${Math.round(pctDomicile * 100)}%)`,
      `Carburant thermique : ${prixCarburant}€/L, conso ${consoL} L/100km`,
      `Entretien : -${Math.round(ENTRETIEN_REDUCTION_EV * 100)}% en EV vs thermique (base ${ENTRETIEN_JOUR_THERMIQUE}€/jour)`,
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVIER 6 — Rappels d'entretien (table maintenance_reminders dédiée)
// ═══════════════════════════════════════════════════════════════════════════
export function getMaintenanceReminders(): any[] {
  return db.prepare(`SELECT * FROM maintenance_reminders ORDER BY
    CASE status WHEN 'urgent' THEN 0 WHEN 'proche' THEN 1 WHEN 'a_venir' THEN 2 ELSE 3 END,
    km_next ASC
  `).all();
}

export function updateMaintenanceProgress(currentKm: number): any[] {
  const rows = db.prepare(`SELECT * FROM maintenance_reminders`).all() as any[];
  const upd = db.prepare(`UPDATE maintenance_reminders SET status = ?, updated_at = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const remaining = r.km_next - currentKm;
      let status = "a_venir";
      if (remaining <= 0) status = "urgent";
      else if (remaining < r.km_next * 0.1) status = "urgent";
      else if (remaining < r.km_next * 0.25) status = "proche";
      upd.run(status, nowIso(), r.id);
    }
  });
  tx();
  return getMaintenanceReminders();
}

export function markReminderDone(id: number, nextKmInterval: number): any {
  const r = db.prepare(`SELECT * FROM maintenance_reminders WHERE id = ?`).get(id) as any;
  if (!r) return null;
  db.prepare(`UPDATE maintenance_reminders SET km_next = km_next + ?, status = 'a_venir', updated_at = ? WHERE id = ?`)
    .run(nextKmInterval, nowIso(), id);
  return db.prepare(`SELECT * FROM maintenance_reminders WHERE id = ?`).get(id);
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVIER 9 — Suivi consommation (fuel_log)
// ═══════════════════════════════════════════════════════════════════════════
export interface FuelLogInput {
  date?: string;
  km_debut: number;
  km_fin: number;
  litres?: number;
  kwh?: number;
  prix: number;
  station?: string;
}

export function addFuelLog(userId: string, input: FuelLogInput): any {
  const info = db.prepare(`
    INSERT INTO fuel_log (user_id, date, km_debut, km_fin, litres, kwh, prix, station, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    input.date ?? new Date().toISOString().slice(0, 10),
    input.km_debut,
    input.km_fin,
    input.litres ?? null,
    input.kwh ?? null,
    input.prix,
    input.station ?? null,
    nowIso()
  );
  return db.prepare(`SELECT * FROM fuel_log WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export interface FuelLogStats {
  logs: any[];
  conso_moyenne_l_100km: number | null;
  conso_moyenne_kwh_100km: number | null;
  cout_moyen_par_plein_eur: number;
  cout_total_periode_eur: number;
}

export function getFuelLogStats(userId: string, limit = 30): FuelLogStats {
  const rows = db.prepare(`
    SELECT * FROM fuel_log WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?
  `).all(userId, limit) as any[];

  const thermiqueRows = rows.filter((r) => r.litres != null && r.litres > 0);
  const evRows = rows.filter((r) => r.kwh != null && r.kwh > 0);

  const consoL = thermiqueRows.map((r) => {
    const km = r.km_fin - r.km_debut;
    return km > 0 ? (r.litres / km) * 100 : null;
  }).filter((v): v is number => v != null);

  const consoKwh = evRows.map((r) => {
    const km = r.km_fin - r.km_debut;
    return km > 0 ? (r.kwh / km) * 100 : null;
  }).filter((v): v is number => v != null);

  const conso_moyenne_l_100km = consoL.length ? r2(consoL.reduce((a, b) => a + b, 0) / consoL.length) : null;
  const conso_moyenne_kwh_100km = consoKwh.length ? r2(consoKwh.reduce((a, b) => a + b, 0) / consoKwh.length) : null;

  const cout_total_periode_eur = r2(rows.reduce((a, r) => a + (r.prix ?? 0), 0));
  const cout_moyen_par_plein_eur = rows.length ? r2(cout_total_periode_eur / rows.length) : 0;

  return {
    logs: rows.map((r) => ({ ...r, l_100km: r.litres && (r.km_fin - r.km_debut) > 0 ? r2((r.litres / (r.km_fin - r.km_debut)) * 100) : null })),
    conso_moyenne_l_100km,
    conso_moyenne_kwh_100km,
    cout_moyen_par_plein_eur,
    cout_total_periode_eur,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVIER 10 — Alerte carburant décision (plein maintenant vs attendre)
// ═══════════════════════════════════════════════════════════════════════════
export interface RefuelDecisionResult {
  decision: "maintenant" | "attendre";
  message_fr: string;
  station_proche: { name: string; distanceKm: number; price_eur: number } | null;
  station_alternative: { name: string; price_eur: number; ecart_pct: number } | null;
  economie_estimee_eur: number;
}

export function getRefuelDecision(lat: number, lng: number, fuelType = "E10", reservoirActuelPct = 25): RefuelDecisionResult {
  const nearby = getCheapFuelStations(lat, lng, fuelType, 8).stations;
  const wide = getCheapFuelStations(lat, lng, fuelType, 25).stations;

  const closest = nearby[0] ?? null;
  const cheaper = wide.find((s) => closest && s.price_eur < closest.price_eur - 0.02) ?? null;

  const TANK_L = 50;
  const remainingL = TANK_L * (reservoirActuelPct / 100);
  const urgentReserve = remainingL < TANK_L * 0.15; // <15% = urgence

  if (urgentReserve || !cheaper) {
    return {
      decision: "maintenant",
      message_fr: closest
        ? `Réservoir bas (${reservoirActuelPct}%) — fais le plein maintenant à "${closest.name}" (${closest.price_eur}€/L, à ${closest.distanceKm} km).`
        : "Réservoir bas — aucune station identifiée à proximité, fais le plein dès que possible.",
      station_proche: closest ? { name: closest.name, distanceKm: closest.distanceKm, price_eur: closest.price_eur } : null,
      station_alternative: null,
      economie_estimee_eur: 0,
    };
  }

  const ecartPct = closest ? r2(((closest.price_eur - cheaper.price_eur) / closest.price_eur) * 100) : 0;
  const economie = closest ? r2((closest.price_eur - cheaper.price_eur) * TANK_L) : 0;

  if (ecartPct >= 3) {
    return {
      decision: "attendre",
      message_fr: `Attends si possible : "${cheaper.name}" est ${ecartPct}% moins cher (${cheaper.price_eur}€/L vs ${closest?.price_eur}€/L ici) — économie ~${economie}€ sur un plein complet.`,
      station_proche: closest ? { name: closest.name, distanceKm: closest.distanceKm, price_eur: closest.price_eur } : null,
      station_alternative: { name: cheaper.name, price_eur: cheaper.price_eur, ecart_pct: ecartPct },
      economie_estimee_eur: economie,
    };
  }

  return {
    decision: "maintenant",
    message_fr: closest
      ? `Fais le plein maintenant à "${closest.name}" (${closest.price_eur}€/L) — pas d'écart significatif avec les stations alentour.`
      : "Fais le plein à la prochaine station disponible.",
    station_proche: closest ? { name: closest.name, distanceKm: closest.distanceKm, price_eur: closest.price_eur } : null,
    station_alternative: null,
    economie_estimee_eur: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVIER 11 — Détecteur véhicule non rentable
// ═══════════════════════════════════════════════════════════════════════════
export interface ProfitabilityCheckResult {
  vehicule_actuel: string;
  volume_courses_jour_estime: number;
  km_jour_moyen: number;
  cout_km_actuel_eur: number;
  verdict: "adapte" | "sous_dimensionne" | "surdimensionne";
  recommandation_fr: string;
  gain_potentiel_mensuel_eur: number;
}

export function checkVehicleProfitability(input: { courses_par_jour?: number; km_par_jour?: number }): ProfitabilityCheckResult {
  const profile = ensureVehicleProfile();
  const coursesJour = input.courses_par_jour ?? 18;
  const kmJour = input.km_par_jour ?? profile.km_par_jour_moyen ?? 220;

  const isEv = profile.energie === "electrique";
  const coutKmEnergie = isEv
    ? (profile.conso_kwh_100km / 100) * PRIX_KWH_DOMICILE
    : (profile.conso_l_100km / 100) * 1.72;
  const coutKmEntretien = isEv ? 0.08 * (1 - ENTRETIEN_REDUCTION_EV) : 0.08;
  const cout_km_actuel_eur = r2(coutKmEnergie + coutKmEntretien);

  let verdict: ProfitabilityCheckResult["verdict"] = "adapte";
  let recommandation_fr = `Ton véhicule actuel (${profile.modele}) est bien dimensionné pour ${coursesJour} courses/jour et ${kmJour} km/jour.`;
  let gain = 0;

  // Volume élevé + thermique peu efficient → suggérer hybride/EV
  if (kmJour > 250 && !isEv && profile.conso_l_100km > 6) {
    verdict = "sous_dimensionne";
    const evSim = computeEvVsThermal({ km_par_jour: kmJour, jours: 30 });
    gain = evSim.economie_mensuelle_eur;
    recommandation_fr = `Volume élevé (${kmJour} km/jour) avec un véhicule thermique consommant ${profile.conso_l_100km} L/100km : passer à un hybride/EV économiserait environ ${gain}€/mois. Ton véhicule actuel n'est pas optimal pour ce volume.`;
  } else if (kmJour < 120 && isEv && profile.autonomie_km > 300) {
    verdict = "surdimensionne";
    recommandation_fr = `Ton véhicule électrique grande autonomie (${profile.autonomie_km} km) est sous-utilisé avec seulement ${kmJour} km/jour — un modèle plus compact et moins coûteux à l'achat/entretien pourrait suffire, sans réel gain de recharge à faire.`;
  } else if (coursesJour > 25 && profile.modele.toLowerCase().includes("citadine")) {
    verdict = "sous_dimensionne";
    recommandation_fr = `Volume de courses élevé (${coursesJour}/jour) pour une citadine — un véhicule plus robuste (berline) réduirait l'usure prématurée et améliorerait le confort client, donc les pourboires/notes.`;
  }

  return {
    vehicule_actuel: profile.modele,
    volume_courses_jour_estime: coursesJour,
    km_jour_moyen: kmJour,
    cout_km_actuel_eur,
    verdict,
    recommandation_fr,
    gain_potentiel_mensuel_eur: gain,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Profil véhicule — getters/setters pour la page frontend
// ═══════════════════════════════════════════════════════════════════════════
export function getVehicleProfile(): any {
  return ensureVehicleProfile();
}

export function updateVehicleProfile(input: Partial<{
  energie: string; modele: string; conso_l_100km: number; conso_kwh_100km: number;
  capacite_reservoir_l: number; capacite_batterie_kwh: number; autonomie_km: number; km_par_jour_moyen: number;
}>): any {
  const existing = ensureVehicleProfile();
  db.prepare(`
    UPDATE vehicle_profile SET
      energie = ?, modele = ?, conso_l_100km = ?, conso_kwh_100km = ?,
      capacite_reservoir_l = ?, capacite_batterie_kwh = ?, autonomie_km = ?, km_par_jour_moyen = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.energie ?? existing.energie,
    input.modele ?? existing.modele,
    input.conso_l_100km ?? existing.conso_l_100km,
    input.conso_kwh_100km ?? existing.conso_kwh_100km,
    input.capacite_reservoir_l ?? existing.capacite_reservoir_l,
    input.capacite_batterie_kwh ?? existing.capacite_batterie_kwh,
    input.autonomie_km ?? existing.autonomie_km,
    input.km_par_jour_moyen ?? existing.km_par_jour_moyen,
    nowIso(),
    existing.id
  );
  return ensureVehicleProfile();
}

export { DEFAULT_USER };
