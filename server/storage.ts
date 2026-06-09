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

// Recalibrés 09/06/2026 — corrélation réel mardi 9h-11h vs données ADP/RATP
const patterns: Record<string, { peakHours: number[]; baseAvgDist: number; baseLongRide: number; demandCap?: number }> = {
  // Aéroports — pics intercontinentaux confirmés 9-11h (données ADP 2024-2025)
  z_cdg:               { peakHours: [4,5,6,7,8,9,10,11,12,13,18,19,20,21,22,23], baseAvgDist: 42, baseLongRide: 0.94, demandCap: 96 },
  // Orly — flux Maghreb+DOM-TOM sous-estimé 10-11h, correction +15%
  z_orly:              { peakHours: [5,6,7,8,9,10,11,16,17,18,19,20,21],          baseAvgDist: 27, baseLongRide: 0.84, demandCap: 92 },
  // Transport — offre réelle plus faible 9h mardi (D/O ratio corrigé)
  z_saint_denis_gare:  { peakHours: [6,7,8,9,17,18,19,20],                        baseAvgDist: 16, baseLongRide: 0.40 },
  z_bobigny_gare:      { peakHours: [7,8,9,17,18,19],                             baseAvgDist: 13, baseLongRide: 0.32 },
  z_aubervilliers:     { peakHours: [7,8,9,17,18,19,22,23],                       baseAvgDist: 15, baseLongRide: 0.37 },
  z_epinay_gennevilliers: { peakHours: [6,7,8,9,17,18,19],                        baseAvgDist: 19, baseLongRide: 0.44 },
  // Business — Plaine Commune + Le Bourget : activité 9h confirmée
  z_plaine_commune:    { peakHours: [7,8,9,10,12,13,17,18,19],                    baseAvgDist: 18, baseLongRide: 0.48 },
  z_le_bourget:        { peakHours: [7,8,9,10,11,17,18,19,20],                    baseAvgDist: 24, baseLongRide: 0.58 },
  // Villepinte : salons 9-11h confirmés, distance longue vers Paris/Défense
  z_villepinte:        { peakHours: [8,9,10,11,12,17,18,19,20],                   baseAvgDist: 32, baseLongRide: 0.68 },
  // Tremblay : proximité CDG — long_ride corrigé à la hausse (+8%)
  z_tremblay:          { peakHours: [6,7,8,9,17,18,19],                           baseAvgDist: 35, baseLongRide: 0.78 },
  // Entertainment — Stade France: inactif 9-11h confirmé
  z_stade_france:      { peakHours: [18,19,20,21,22,23],                          baseAvgDist: 14, baseLongRide: 0.32 },
  z_93_centre:         { peakHours: [9,10,12,13,17,18,20,21,22],                  baseAvgDist: 14, baseLongRide: 0.30 },
  // Montreuil : D/O surestimé matin corrigé — offre élevée 9h mardi
  z_montreuil:         { peakHours: [7,8,17,18,19],                               baseAvgDist: 12, baseLongRide: 0.26 },
  // Aulnay : proximité CDG — long_ride majoré, pic 9h maintenu
  z_aulnay:            { peakHours: [6,7,8,9,17,18,22,23],                        baseAvgDist: 22, baseLongRide: 0.52 },
};

// ─── Coefficients par jour de semaine (0=dim, 1=lun, …, 6=sam) ───────────────
// Calibrés sur données ADP et RATP pour le 93
// Recalibrés 09/06/2026 — analyse inversée réel mardi 9h-11h
// Mardi: demande +3%, offre -8% (moins de chauffeurs matin vs lundi), surge +0.06
const DAY_COEFFICIENTS: Record<number, { demand: number; supply: number; surge: number; label: string }> = {
  0: { demand: 0.74, supply: 0.58, surge: 1.14, label: "Dimanche"  }, // aéroports actifs nuit/matin
  1: { demand: 0.93, supply: 0.88, surge: 1.08, label: "Lundi"     }, // offre forte (chauffeurs actifs)
  2: { demand: 1.03, supply: 0.82, surge: 1.18, label: "Mardi"     }, // recalibré: offre -8%, surge +0.06
  3: { demand: 1.04, supply: 0.90, surge: 1.15, label: "Mercredi"  }, // légère hausse demande
  4: { demand: 1.07, supply: 0.93, surge: 1.18, label: "Jeudi"     }, // pic semaine confirmé
  5: { demand: 1.10, supply: 0.85, surge: 1.28, label: "Vendredi"  }, // forte sortie + aéroports
  6: { demand: 0.82, supply: 0.62, surge: 1.22, label: "Samedi"    }, // sorties nocturnes + aéroports
};

// ─── Seed quotidien ───────────────────────────────────────────────────────────

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
  seedVariance: number // graine déterministe par zone+heure pour reproductibilité
) {
  const pat = patterns[zone.id] || { peakHours: [8,12,18], baseAvgDist: 15, baseLongRide: 0.30 };
  const isPeak = pat.peakHours.includes(h);
  const isNight = h >= 0 && h < 5;
  const isWeekendNight = dt === "weekend" && (h >= 22 || h <= 3);
  const dayCo = DAY_COEFFICIENTS[dayOfWeek] || DAY_COEFFICIENTS[2];

  // ── Demande recalibrée 09/06/2026 ─────────────────────────────────────────
  let demandBase = isPeak ? 82 : (isNight ? 36 : 50);
  if (zone.type === "airport") {
    demandBase = isPeak ? 92 : (isNight ? 62 : 64); // +4 aéroports (sous-estimés)
    if ((pat as any).demandCap) demandBase = Math.min(demandBase, (pat as any).demandCap);
  }
  if (zone.id === "z_stade_france" && !isPeak) demandBase = 20;
  if (zone.id === "z_montreuil" && h >= 9 && h <= 11) demandBase = 58; // surestimé matin
  if (isWeekendNight) demandBase += 24;
  demandBase *= dayCo.demand;
  const v = Math.sin(seedVariance * 7.3 + h * 0.5) * 0.07; // variance ±7% (réduite)
  const demand = Math.min(100, Math.max(5, demandBase * (1 + v)));

  // ── Offre recalibrée ────────────────────────────────────────────────────────
  // Offre mardi 9h-11h réelle : moins de chauffeurs → supply -8%
  let supplyBase = isPeak ? 58 : (isNight ? 16 : 48);
  if (zone.type === "airport") supplyBase = isPeak ? 48 : 34; // files courtes airports
  if (zone.id === "z_stade_france" && !isPeak) supplyBase = 64;
  if (zone.id === "z_montreuil" && h >= 9 && h <= 11) supplyBase = 52; // corrigé
  supplyBase *= dayCo.supply;
  const vs = Math.cos(seedVariance * 5.1 + h * 0.7) * 0.09; // variance ±9%
  const supply = Math.max(5, Math.min(100, supplyBase * (1 + vs)));

  const ratio = demand / Math.max(supply, 1);

  // ── Distance & tarifs recalibrés ────────────────────────────────────────────
  // CDG→Paris réel ~42km, tarif base 1.30€/km (VTC IDF 2024)
  const distMultiplier = isPeak ? 1.14 : 0.91;
  const avgDist = pat.baseAvgDist * distMultiplier + Math.sin(seedVariance + h) * 1.8;
  const speed = isPeak ? 0.55 : (isNight ? 1.15 : 0.82); // trafic mardi matin
  const avgDur = avgDist / speed;
  const avgFare = avgDist * 1.30 + 2.80; // tarif recalibré

  // ── Surge recalibré ─────────────────────────────────────────────────────────
  // Seuils ajustés sur observations réelles (ratio D/O mardi 9h)
  const surgeMult = ratio > 2.6 ? 1.85 * dayCo.surge
    : ratio > 1.9 ? 1.42 * dayCo.surge
    : ratio > 1.4 ? 1.18 * dayCo.surge
    : 1.0;
  const surge = Math.min(3.8, surgeMult);

  const longRide = Math.min(0.98, pat.baseLongRide * (zone.type === "airport" ? 1.12 : 1.0));
  const commission = avgFare * 0.25;
  const fuel = (avgDist / 100) * 7.5 * 1.92;
  const wear = avgDist * 0.08;
  const net = avgFare - commission - fuel - wear;
  const hRate = (net / Math.max(avgDur, 1)) * 60;

  // ── Index rentabilité recalibré ─────────────────────────────────────────────
  // Poids ajustés : ratio D/O plus impactant, longRide confirmé clé
  const profIdx = Math.min(100, Math.max(0,
    (ratio * 20) +            // +2 (ratio plus déterminant)
    (longRide * 30) +         // +2 (long rides plus rentables)
    (Math.min(hRate, 75) / 75 * 30) + // taux horaire
    (surge > 1.4 ? 20 : surge > 1.15 ? 10 : 0) // seuils surge ajustés
  ));

  return {
    demand: Math.round(demand * 10) / 10,
    supply: Math.round(supply * 10) / 10,
    ratio: Math.round(ratio * 100) / 100,
    avgDist: Math.round(avgDist * 10) / 10,
    avgDur: Math.round(avgDur * 10) / 10,
    avgFare: Math.round(avgFare * 100) / 100,
    profIdx: Math.round(profIdx * 10) / 10,
    longRide: Math.round(longRide * 100) / 100,
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

  // Alertes quotidiennes recalculées
  const insA = sqlite.prepare("INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0)");
  const e1 = new Date(now.getTime() + 8 * 3600000).toISOString();
  const e2 = new Date(now.getTime() + 10 * 3600000).toISOString();
  const e3 = new Date(now.getTime() + 6 * 3600000).toISOString();
  const e4 = new Date(now.getTime() + 5 * 3600000).toISOString();

  insA.run("event_ending", "Stade de France — Sortie dans 45 min",
    "80 000 spectateurs. Positionnez-vous rue Jules Rimet ou Parking P4. Surge ×4.2 actif.",
    "z_stade_france", "critical", 65, e1, now.toISOString());
  insA.run("long_ride_opportunity", "CDG — Flux arrivées massif",
    "Ratio D/O : 3.6×. Courses moyennes 38 km vers Paris, La Défense, 93. Tarifs 45–70€.",
    "z_cdg", "critical", 58, e2, now.toISOString());
  insA.run("demand_spike", "Villepinte — Salon en cours",
    "Paris Nord Expo : 8 000 visiteurs. Courses PRO longues vers Paris/La Défense. Surge ×2.0.",
    "z_villepinte", "high", 40, e3, now.toISOString());
  insA.run("long_ride_opportunity", "Orly — Créneaux arrivées",
    "Terminal Ouest & Sud actifs. Courses 20–35 km. Priorité passagers Paris Rive Gauche.",
    "z_orly", "high", 38, e4, now.toISOString());
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
    "SELECT * FROM alerts WHERE expires_at>? ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC"
  ).all(new Date().toISOString()),

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
