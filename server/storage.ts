import Database from "better-sqlite3";
import { Zone, ProfitabilityScore, Event, Ride, Alert, DriverProfile, InsertAlert, InsertRide, InsertDriverProfile } from "@shared/schema";
import { getCongestedETA, computeBreakEvenPenalty, CALIBRATED_DATA as ROUTING_CALIBRATED } from "./routingCache";

const sqlite = new Database("data.db");
// ← audit G: pragmas SQLite production (WAL + cache + synchronous NORMAL)
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('cache_size = -131072');  // 512 MB RAM cache (8 GB dispo → max SQLite)
sqlite.pragma('temp_store = MEMORY');   // tables temp en RAM
sqlite.pragma('mmap_size = 4294967296'); // 4 GB memory-mapped I/O (mmap max 64-bit)
sqlite.pragma('page_size = 4096');      // page 4KB optimale SSD
sqlite.pragma('busy_timeout = 5000');   // attend 5s si DB locké (au lieu de throw)
sqlite.pragma('wal_autocheckpoint = 0'); // désactive auto-checkpoint SQLite — géré manuellement F2
sqlite.pragma('optimize');              // optimise le query planner (appel unique à l'init)
sqlite.pragma('foreign_keys = ON');

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

// ─── Tables IA 2026 (prédictions, maintenance, performance) ─────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS demand_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id TEXT NOT NULL,
    target_hour INTEGER NOT NULL,
    target_date TEXT NOT NULL,
    predicted_index REAL NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7,
    model_version TEXT NOT NULL DEFAULT 'v2_historical',
    factors TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    actual_index REAL,
    error_pct REAL
  );
  CREATE TABLE IF NOT EXISTS vehicle_maintenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    component TEXT NOT NULL,
    label_fr TEXT NOT NULL,
    interval_km INTEGER NOT NULL,
    last_done_km INTEGER NOT NULL DEFAULT 0,
    total_km_driven INTEGER NOT NULL DEFAULT 0,
    urgency TEXT NOT NULL DEFAULT 'ok',
    estimated_cost_eur REAL NOT NULL DEFAULT 0,
    next_due_km INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS driver_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    period_date TEXT NOT NULL,
    total_rides INTEGER NOT NULL DEFAULT 0,
    profitable_rides INTEGER NOT NULL DEFAULT 0,
    total_km INTEGER NOT NULL DEFAULT 0,
    total_net_eur REAL NOT NULL DEFAULT 0,
    avg_hourly_rate REAL NOT NULL DEFAULT 0,
    efficiency_score INTEGER NOT NULL DEFAULT 0,
    positioning_score INTEGER NOT NULL DEFAULT 0,
    profitability_score INTEGER NOT NULL DEFAULT 0,
    consistency_score INTEGER NOT NULL DEFAULT 0,
    global_score INTEGER NOT NULL DEFAULT 0,
    ai_tips TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
`);

// ─── Migration colonnes driver_profile (THÈME 4) ───────────────────────
// SQLite ne supporte pas ADD COLUMN IF NOT EXISTS → try/catch par colonne
const driverProfileMigrations: string[] = [
  "ALTER TABLE driver_profile ADD COLUMN preferred_zones TEXT DEFAULT '[]'",
  "ALTER TABLE driver_profile ADD COLUMN work_hours_start INTEGER DEFAULT 6",
  "ALTER TABLE driver_profile ADD COLUMN work_hours_end INTEGER DEFAULT 22",
  "ALTER TABLE driver_profile ADD COLUMN avoid_highway INTEGER DEFAULT 0",
  "ALTER TABLE driver_profile ADD COLUMN vehicle_brand TEXT DEFAULT ''",
  "ALTER TABLE driver_profile ADD COLUMN vehicle_model TEXT DEFAULT ''",
  "ALTER TABLE driver_profile ADD COLUMN vehicle_year INTEGER DEFAULT 2020",
  "ALTER TABLE driver_profile ADD COLUMN total_km_driven INTEGER DEFAULT 0",
];
for (const mig of driverProfileMigrations) {
  try { sqlite.exec(mig); } catch { /* colonne déjà présente */ }
}

// ─── Table platform_credentials ───────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS platform_credentials (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    platform    TEXT    NOT NULL UNIQUE,   -- 'tomtom' | 'gigdata'
    api_key     TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'unconfigured', -- 'unconfigured'|'connected'|'error'
    last_tested INTEGER,
    error_msg   TEXT    DEFAULT ''
  )
`);

// Insérer les entrées par défaut si elles n'existent pas
const existingUber = sqlite.prepare("SELECT id FROM platform_credentials WHERE platform='tomtom'").get();
if (!existingUber) sqlite.exec("INSERT INTO platform_credentials (platform, api_key) VALUES ('tomtom', '')");
const existingGig = sqlite.prepare("SELECT id FROM platform_credentials WHERE platform='gigdata'").get();
if (!existingGig) sqlite.exec("INSERT INTO platform_credentials (platform, api_key) VALUES ('gigdata', '')");
sqlite.exec("INSERT OR IGNORE INTO platform_credentials (platform, api_key, status) VALUES ('predicthq', '', 'disconnected')");

// ─── Table PredictHQ events ────────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS predicthq_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    zone_id TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    rank INTEGER NOT NULL DEFAULT 0,
    local_rank INTEGER NOT NULL DEFAULT 0,
    phq_attendance INTEGER NOT NULL DEFAULT 0,
    transport_spend REAL NOT NULL DEFAULT 0,
    demand_boost REAL NOT NULL DEFAULT 1.0,
    lat REAL,
    lng REAL,
    fetched_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_phq_zone_active ON predicthq_events(zone_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_phq_start ON predicthq_events(start_time);
`);

// ─── Index pour accélération hot-path ──────────────────────────────────
sqlite.exec(`
  CREATE INDEX IF NOT EXISTS idx_prof_hour_daytype ON profitability_scores(hour, day_type);
  CREATE INDEX IF NOT EXISTS idx_alerts_expires ON alerts(expires_at, is_read);
  CREATE INDEX IF NOT EXISTS idx_alerts_zone ON alerts(zone_id);
  CREATE INDEX IF NOT EXISTS idx_events_active ON events(is_active, start_time);
  CREATE INDEX IF NOT EXISTS idx_rides_ts ON rides(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_score_history_date ON score_history(seed_date, zone_id, hour);
  CREATE INDEX IF NOT EXISTS idx_predictions_zone_date ON demand_predictions(zone_id, target_date, target_hour);
`);

// ─── Prepared statements globaux — compilés une seule fois à l'init ───────────────────
// Bench: alerts/events étaient recompilés à chaque requête HTTP (−64-197% latence sous 50 req. simult.)
// Pré-compiler élimine l'overhead parser SQLite sur les chemins chauds.
const stmtGetActiveAlerts = sqlite.prepare(
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
);

const stmtGetActiveEvents = sqlite.prepare(
  `SELECT * FROM events WHERE is_active=1 ORDER BY start_time ASC`
);

const stmtGetAllZones = sqlite.prepare(
  `SELECT * FROM zones ORDER BY type, name`
);

const stmtMarkAlertRead = sqlite.prepare(
  `UPDATE alerts SET is_read=1 WHERE id=?`
);

const stmtClearExpiredAlerts = sqlite.prepare(
  `DELETE FROM alerts WHERE expires_at<?`
);

const stmtGetRideStats = sqlite.prepare(
  `SELECT COUNT(*) as total, SUM(net_profit) as totalNet, AVG(hourly_rate) as avgRate,
   AVG(distance_km) as avgDist,
   SUM(CASE WHEN is_profitable=1 THEN 1 ELSE 0 END) as profitable,
   SUM(CASE WHEN is_long_ride=1 THEN 1 ELSE 0 END) as longRides FROM rides`
);

const stmtGetRecentRides = sqlite.prepare(
  `SELECT * FROM rides ORDER BY timestamp DESC LIMIT ?`
);

const stmtGetDriverProfile = sqlite.prepare(
  `SELECT * FROM driver_profile LIMIT 1`
);

const stmtGetCurrentScores = sqlite.prepare(
  `SELECT ps.*, z.name as zone_name, z.lat, z.lng, z.type as zone_type
   FROM profitability_scores ps
   JOIN zones z ON z.id = ps.zone_id
   WHERE ps.hour = ? AND ps.day_type = ?
   ORDER BY ps.profitability_index DESC`
);

// ─── Prepared statements IA 2026 ────────────────────────────────────────
const stmtInsertPrediction = sqlite.prepare(
  `INSERT OR REPLACE INTO demand_predictions
     (id, zone_id, target_hour, target_date, predicted_index, confidence, model_version, factors, created_at)
   VALUES (
     (SELECT id FROM demand_predictions WHERE zone_id=? AND target_hour=? AND target_date=?),
     ?, ?, ?, ?, ?, ?, ?, ?)`
);

const stmtGetPredictions = sqlite.prepare(
  `SELECT dp.*, z.name as zone_name
   FROM demand_predictions dp
   LEFT JOIN zones z ON z.id = dp.zone_id
   WHERE dp.target_date = ? AND dp.target_hour IN (SELECT value FROM json_each(?))
   ORDER BY z.name, dp.target_hour`
);

const stmtGetMaintenance = sqlite.prepare(
  `SELECT * FROM vehicle_maintenance ORDER BY
     CASE urgency WHEN 'overdue' THEN 0 WHEN 'urgent' THEN 1 WHEN 'soon' THEN 2 ELSE 3 END,
     next_due_km ASC`
);

const stmtGetDriverPerformance = sqlite.prepare(
  `SELECT * FROM driver_performance WHERE period=? ORDER BY created_at DESC LIMIT 1`
);


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
  { id: "z_93_centre",    name: "Saint-Denis — Centre",       lat: 48.9356,  lng: 2.3535,  type: "residential" },  // fix: entertainment→residential (pas lieu spectacle, centre-ville résidentiel)
  { id: "z_montreuil",    name: "Montreuil",                  lat: 48.8637,  lng: 2.4482,  type: "residential" },
  { id: "z_aulnay",       name: "Aulnay-sous-Bois",           lat: 48.9383,  lng: 2.4951,  type: "business" },    // 19/06: changé residential→business (flux CDG matin h7-9=35-51)
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
  demandBoost10?: number;      // boost demande h=10 (transition matin→midi, zones business/logistique)
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
    demandBoost6_10: 12,    // départs matinaux intercontinentaux + arrivées long-courrier 7h-9h ✅ ADP données réelles
  },
  // Orly : DOM-TOM 11h-14h, départs 16h-18h
  z_orly: {
    peakHours: [5,6,7,8,9,10,11,12,16,17,18,19,20,21],
    baseAvgDist: 27, baseLongRide: 0.84, demandCap: 94,
    demandBoost11_14: 4,
    demandBoost14_18: 7,
    demandBoost6_10: 7,     // DOM-TOM matinaux + navettes business jeudi ✅
  },
  // ── Hubs transport / banlieue proche ─────────────────────────────────────
  // St-Denis : trafic commute + tourisme Basilique / Stade France 13h-17h
  z_saint_denis_gare: {
    peakHours: [5,6,7,8,9,12,13,14,17,18,19,20], // data 17/06: +h14 (hist h13=29, h14=25.9)
    baseAvgDist: 16, baseLongRide: 0.46,     // 0.40→0.46 seeds 17/06
    demandBoost11_14: 18,   // data 17/06: hist h=13=29 (3→18 calibré)
    demandBoost14_18: 14,   // data 17/06: hist h=14=25.9 (5→14)
    demandBoost6_10: 0,     // 28→0 recalibration 19/06 morningCap couvre h<10 (hist h5..9=15-25)
  },
  z_bobigny_gare: {
    peakHours: [5,7,8,9,12,13,14,17,18,19], // data 17/06: +h14 (hist h13=40, h14=19.6)
    baseAvgDist: 13, baseLongRide: 0.38,     // 0.32→0.38 seeds 17/06
    demandBoost10: 12,      // 19/06: hist h10=53.2 vs cap30×1.22=36.6 → boost +12 → pred=51.2 (-3.8%)
    demandBoost11_14: 28,   // data 17/06: hist h=13=40 (2→28 calibré)
    demandBoost14_18: 8,    // data 17/06: hist h=14=19.6 (3→8)
    demandBoost6_10: 4,     // 27→4 recalibration 19/06 transport cap 12+(h-5)*2
  },
  z_aubervilliers: {
    peakHours: [5,6,7,8,9,11,12,13,14,17,18,19,22,23], // data 17/06: +h13,h14 (hist h13=25, h14=13) +h5 travailleurs nuit
    baseAvgDist: 15, baseLongRide: 0.40,     // 0.37→0.40 seeds 17/06
    demandBoost11_14: 14,   // data 17/06: hist h=13=25 (3→14 calibré)
    demandBoost14_18: 6,    // data 17/06: hist h=14=13 (4→6)
    demandBoost6_10: 1,     // 27→1 recalibration 19/06 transport cap 12+(h-5)*2
  },
  z_epinay_gennevilliers: {
    peakHours: [6,7,8,9,13,14,17,18,19], // data 17/06: +h13,h14 (hist h13=27, h14=13)
    baseAvgDist: 19, baseLongRide: 0.476,    // 0.44→0.476 seeds 17/06
    demandBoost11_14: 18,   // data 17/06: hist h=13=27 (1→18 calibré)
    demandBoost14_18: 4,    // data 17/06: hist h=14=13 (2→4)
    demandBoost6_10: 0,     // 25→0 recalibration 19/06 morningCap couvre h<10 banlieue nord
  },
  // Plaine Commune : zone business active 11h-17h (sièges sociaux)
  z_plaine_commune: {
    peakHours: [5,7,8,9,10,11,12,13,14,15,16,17,18,19], // seeds 17/06: +h5
    baseAvgDist: 18, baseLongRide: 0.492,    // 0.48→0.492 seeds 17/06
    demandBoost11_14: 28,   // data 17/06: hist h=13=40 (6→28 calibré — zone business midi)
    demandBoost14_18: 18,   // data 17/06: hist h=14=37.9 (10→18)
    demandBoost6_10: 1,     // 26→1 recalibration 19/06 business cap 15+(h-5)*3
  },
  // ── Hubs business / exposition ────────────────────────────────────────────
  // Le Bourget : parc expo adjacente, trafic business 10h-17h
  z_le_bourget: {
    peakHours: [5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20], // seeds 17/06: +h5,h6
    baseAvgDist: 14, baseLongRide: 0.38,      // 0.32→0.38 seeds 17/06 (réel 12.1km, courses plus longues)
    baseAvgDistSalon: 22, baseLongRideSalon: 0.54,  // ← backtest P2b: profil salon/show actif
    demandBoost11_14: 22,   // data 17/06: hist h=13=34.5 (4→22 calibré)
    demandBoost14_18: 20,   // data 17/06: hist h=14=31.6 (6→20)
    demandBoost6_10: 4,     // 25→4 recalibration 19/06 (hist h5..9=18-28, morningCap+4×1.22=22-37)
  },
  // Villepinte : Parc des Expos Paris Nord Villepinte — très actif 11h-18h
  z_villepinte: {
    peakHours: [7,8,9,14,15,16,17,18,19],     // fix 17/06 data réelles: pic PM fort (prédit=17 réel=61 h=14-16)
    baseAvgDist: 14, baseLongRide: 0.332,     // 0.20→0.332 seeds 17/06 (revenu/course massivement sous-estimé)
    baseAvgDistSalon: 28, baseLongRideSalon: 0.62,  // ← backtest P2b: profil salon actif (Eurosatory+)
    demandBoost11_14: 2,    // Villepinte VIDE 11/06 (Eurosatory démarre le 15/06/2026)
    demandBoost14_18: 14,   // fix 17/06 data réelles: MAE PM 72% → pic PM réel fort h=14-16
    demandBoost6_10: 9,     // 16→9 recalibration 19/06 business cap (hist h5..9=32-42)
  },
  // Tremblay : entre CDG et Villepinte, hub logistique + résidentiel
  z_tremblay: {
    peakHours: [6,7,8,9,12,14,15,16,17,18,19], // fix 17/06 data réelles: pic PM h=14-16 zone logistique CDG
    baseAvgDist: 18, baseLongRide: 0.468,     // 0.42→0.468 seeds 17/06 zone logistique CDG-proximité
    demandBoost10: 6,       // 19/06: hist h10=54.4 vs cap38×1.22=46.4 → boost +6 → pred=53.7 (-1.3%)
    demandBoost11_14: 5,
    demandBoost14_18: 10,   // fix 17/06 data réelles: MAE PM → logistique CDG + résidentiel h=14-16
    demandBoost6_10: 11,    // 16→11 recalibration 19/06 business cap (hist h5..9=34-44)
  },
  // ── Zones culturelles / événementielles ───────────────────────────────────
  // Stade de France : événements 18h+, calme 11h-17h sauf matchs
  z_stade_france: {
    peakHours: [0,1,2,3,4,5,6,7,8,9,13,16,17,18,19,20,21,22,23],  // 19/06: +h0..9 résidents nuit + commute matin (hist nuit=18-35, matin=25-45)
    baseAvgDist: 14, baseLongRide: 0.34,
    demandBoost11_14: 2,    // visites stade / offices tourisme
    demandBoost14_18: 18,   // CONCERT DAVID GUETTA 11/06 — portes 16h30 → surge massif ✅
    demandBoost6_10: 0,     // 6→0 recalibration h2 19/06 : hist h5=19.3, cap15×1.22=18.3 → légère sous-estimation OK
  },
  // ── Zones résidentielles / mixtes ─────────────────────────────────────────
  z_93_centre: {
    peakHours: [5,6,7,8,9,10,11,12,13,14,17,18,20,21], // data 17/06: +h13,h14 (hist h13=26, h14=22) +h5 travailleurs nuit
    baseAvgDist: 13, baseLongRide: 0.328,     // 12→13 +dist, 0.28→0.328 seeds 17/06
    demandBoost11_14: 16,   // data 17/06: hist h=13=26 (5→16 calibré)
    demandBoost14_18: 12,   // data 17/06: hist h=14=22 (6→12)
    demandBoost6_10: 0,     // 14→0 recalibration 19/06 morningCap couvre h<10 résidentiel centre
  },
  z_montreuil: {
    peakHours: [7,8,9,13,14,15,16,17,18,19], // data 17/06: +h13 (hist h13=33.5)
    baseAvgDist: 13, baseLongRide: 0.312,    // 11→13 +dist, 0.24→0.312 seeds 17/06
    demandBoost11_14: 22,   // data 17/06: hist h=13=33.5 (4→22 calibré)
    demandBoost14_18: 20,   // data 17/06: hist h=14=31.5 (12→20)
    demandBoost6_10: 8,     // 1→8 recalibration 19/06 h2 : hist h5=24.6-h9=37.3 sous-estimé avec boost=1
  },
  z_aulnay: {
    peakHours: [6,7,8,9,13,14,15,16,17,18], // data 17/06: +h13 (hist h13=47.8)
    baseAvgDist: 20, baseLongRide: 0.492,    // 0.48→0.492 seeds 17/06
    demandBoost10: 7,       // 4→7 : type changé business → cap38×1.22=46.4 → boost +7 → pred=51.7+8.5=52.6 (-5.7%)
    demandBoost11_14: 36,   // data 17/06: hist h=13=47.8 (3→36 calibré)
    demandBoost14_18: 18,   // data 17/06: hist h=14=44.5 (10→18)
    demandBoost6_10: 3,     // 8→3 : type→business, cap business h5=15..h9=27 > cap residential → boost réduit
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
  // Sources : arXiv 2008.06050 (week-end +20-24%), Drivee 2025, Stairling 2025, Partners Formation 2025
  // Deep analysis 17/06/2026 : Dimanche +19.3% (aéroports matin fort + retours we 17h-20h), Samedi +10.2% (arXiv +77% we/wd, Drivee best slot)
  // Hiérarchie rentabilité validée : Samedi > Vendredi > Jeudi > Mercredi ≈ Mardi > Lundi > Dimanche
  0: { demand: 1.02, supply: 0.58, surge: 1.22, supply_midday: 0.62, supply_morning: 0.50, label: "Dimanche"  },  // +0.14 vs précédent (aéroports matin + retours we soir)
  1: { demand: 0.90, supply: 0.90, surge: 1.05, supply_midday: 0.92, supply_morning: 0.72, label: "Lundi"     },
  2: { demand: 0.95, supply: 0.92, surge: 1.08, supply_midday: 0.94, supply_morning: 0.68, label: "Mardi"     },
  3: { demand: 1.00, supply: 0.90, surge: 1.10, supply_midday: 0.93, supply_morning: 0.78, label: "Mercredi"  },
  4: { demand: 1.12, supply: 0.85, surge: 1.30, supply_midday: 0.87, supply_morning: 0.68, label: "Jeudi"     },
  5: { demand: 1.22, supply: 0.78, surge: 1.35, supply_midday: 0.80, supply_morning: 0.72, label: "Vendredi"  },
  6: { demand: 1.30, supply: 0.58, surge: 1.40, supply_midday: 0.62, supply_morning: 0.50, label: "Samedi"    },  // +0.12 vs précédent (arXiv +77% we/wd validé, Drivee best single slot)
};

function getTodayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function getYesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

// ─── livePat — Seeds dynamiques (recalculées toutes les 3 min) ───────────────
// Objet en mémoire qui fusionne les patterns statiques + les overrides calculés
// à partir de l'historique réel accumulé. computeScore lit livePat au lieu de
// patterns, donc chaque cycle 3 min les seeds s'auto-ajustent aux données réelles.
//
// Structure d'un override dynamique :
//   { demandBoost6_10, demandBoost10, demandBoost11_14, demandBoost14_18,
//     baseAvgDist, baseLongRide, _live: true, _updated_at, _mae_before, _mae_after }
//
// Règle métier absolue : légère sous-estimation OK, sur-estimation interdite.
//   → Tous les boosts calculés sont plafonnés à 95% de la valeur qui atteindrait
//     exactement l'historique (marge de sécurité de 5% vers la sous-estimation).
// ─────────────────────────────────────────────────────────────────────────────

// Copie mutable des patterns statiques, enrichie des overrides dynamiques
// Initialisation : copie des patterns statiques + injection du type de zone
// (nécessaire pour getBaseDemand() qui calcule les morningCaps)
let livePat: Record<string, any> = {};
function initLivePat(): void {
  for (const [k, v] of Object.entries(patterns)) {
    const zone = zones93.find(z => z.id === k);
    livePat[k] = { ...v, _zoneType: zone?.type ?? 'business' };
  }
}
// Initialisation différée après zones93 disponible
initLivePat();

// Métadonnées du dernier calcul de seeds dynamiques
let livePatMeta: {
  last_update: string;
  mae_before:  number;
  mae_after:   number;
  zones_updated: string[];
  run_count:   number;
} = { last_update: "", mae_before: 0, mae_after: 0, zones_updated: [], run_count: 0 };

/**
 * updateLivePatterns() — appelé dans le setInterval 3 min
 *
 * Pour chaque zone, compare les prédictions actuelles aux données réelles
 * du score_history d'aujourd'hui (heures écoulées) et recalcule les boosts.
 *
 * Algorithme par heure écoulée :
 *   1. pred = score actuel (profitability_scores)
 *   2. hist = moyenne des demand_score stockés dans score_history today
 *   3. delta = hist - pred
 *   4. Si |delta| > seuil (5 pts) → recalibrer le boost correspondant à cette heure
 *   5. EMA (α=0.4) pour lisser les oscillations
 *
 * Les boosts recalibrés sont écrits dans livePat[zone_id] (en mémoire)
 * et aussi dans seed_meta (persistance redémarrage).
 */
function updateLivePatterns(): void {
  const t0 = Date.now();
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  // Heure courante CEST (UTC+2)
  const hNowCEST = (now.getUTCHours() + 2) % 24;
  const dayOfWeek = now.getDay();
  const dayCo = DAY_COEFFICIENTS[dayOfWeek] || DAY_COEFFICIENTS[2];

  // ── 1. Historique réel accumulé aujourd'hui ──────────────────────────────
  // Moyenner sur les N derniers cycles (plusieurs runs dans la même heure)
  const histRows = sqlite.prepare(`
    SELECT zone_id, hour, AVG(demand_score) as demand_real, COUNT(*) as n
    FROM score_history
    WHERE seed_date = ? AND day_type = 'weekday'
    GROUP BY zone_id, hour
  `).all(today) as { zone_id: string; hour: number; demand_real: number; n: number }[];

  if (histRows.length === 0) return; // cold start — pas encore de données

  // ── 2. Prédictions actuelles ─────────────────────────────────────────────
  const predRows = sqlite.prepare(`
    SELECT zone_id, hour, demand_score as demand_pred
    FROM profitability_scores
    WHERE day_type = 'weekday'
  `).all() as { zone_id: string; hour: number; demand_pred: number }[];

  const predMap = new Map<string, number>();
  for (const r of predRows) predMap.set(`\${r.zone_id}|\${r.hour}`, r.demand_pred);

  // ── 3. Overrides persistés (EMA — pour lisser sur plusieurs cycles) ──────
  const overrideRows = sqlite.prepare(
    "SELECT key, value FROM seed_meta WHERE key LIKE 'live_seed_%'"
  ).all() as { key: string; value: string }[];
  const overrideMap = new Map<string, any>();
  for (const r of overrideRows) {
    try { overrideMap.set(r.key.replace('live_seed_', ''), JSON.parse(r.value)); } catch {}
  }

  // ── 4. Calcul des nouveaux boosts par zone ───────────────────────────────
  const EMA_ALPHA   = 0.40;  // poids mesure récente (vs historique EMA)
  const DELTA_MIN   = 5;     // delta minimal pour déclencher une mise à jour (pts)
  const SAFETY_PCT  = 0.95;  // règle métier : 5% de marge vers la sous-estimation
  const zonesUpdated: string[] = [];
  const maesBefore: number[] = [];
  const maesAfter: number[]  = [];

  // Grouper l'historique par zone
  const histByZone = new Map<string, Map<number, number>>();
  for (const r of histRows) {
    if (!histByZone.has(r.zone_id)) histByZone.set(r.zone_id, new Map());
    histByZone.get(r.zone_id)!.set(r.hour, r.demand_real);
  }

  const insOverride = sqlite.prepare(
    "INSERT OR REPLACE INTO seed_meta (key, value) VALUES (?, ?)"
  );

  const tx = sqlite.transaction(() => {
    for (const [zoneId, hourMap] of histByZone) {
      const pat = { ...(patterns[zoneId] || {}), ...(livePat[zoneId] || {}) };
      if (!pat.peakHours) continue;

      const overrideKey = zoneId;
      const existing: any = overrideMap.get(overrideKey) || {};
      const newOverride: Record<string, number | string | boolean> = { ...existing };
      let changed = false;

      // Itérer sur les heures écoulées avec données réelles
      for (const [h, hist] of hourMap) {
        if (h > hNowCEST) continue;      // heure future → ignorer
        if (hist < 5) continue;           // bruit → ignorer

        const predKey = `\${zoneId}|\${h}`;
        const pred = predMap.get(predKey) ?? 0;
        if (pred < 1) continue;

        const delta = hist - pred;
        maesBefore.push(Math.abs(delta / hist) * 100);

        if (Math.abs(delta) < DELTA_MIN) {
          // Seeds OK pour cette heure → pas de modification
          maesAfter.push(Math.abs(delta / hist) * 100);
          continue;
        }

        // Déterminer quel boost est responsable de cette heure
        // et calculer la correction nécessaire
        // cible = hist × SAFETY_PCT (légère sous-estimation)
        const target = hist * SAFETY_PCT;
        const currentBoost = getBoostForHour(h, pat);
        // target = (morningCapOrBase + boost) × dayCo → boost_needed = target/dayCo - base
        const base = getBaseDemand(h, pat, dayCo);
        const boostNeeded = Math.max(0, (target / dayCo.demand) - base);

        // EMA : mélanger avec la valeur existante pour stabilité
        const existingBoost = existing[getBoostKeyForHour(h)] ?? currentBoost;
        const smoothedBoost = Math.round(EMA_ALPHA * boostNeeded + (1 - EMA_ALPHA) * existingBoost);

        const boostKey = getBoostKeyForHour(h);
        if (boostKey && smoothedBoost !== Math.round(existingBoost)) {
          newOverride[boostKey] = smoothedBoost;
          changed = true;
        }

        // MAE après correction
        const predCorrected = (base + smoothedBoost) * dayCo.demand;
        maesAfter.push(Math.abs((predCorrected - hist) / hist) * 100);
      }

      if (changed) {
        // Appliquer dans livePat (mémoire)
        livePat[zoneId] = { ...(patterns[zoneId] || {}), ...newOverride, _live: true, _updated_at: now.toISOString() };
        // Persister dans seed_meta (survie redémarrage)
        insOverride.run(`live_seed_\${zoneId}`, JSON.stringify(newOverride));
        zonesUpdated.push(zoneId);
      }
    }
  });
  tx();

  // ── 5. Mise à jour métadonnées ───────────────────────────────────────────
  const mae_before = maesBefore.length ? maesBefore.reduce((a,b)=>a+b,0)/maesBefore.length : 0;
  const mae_after  = maesAfter.length  ? maesAfter.reduce((a,b)=>a+b,0)/maesAfter.length   : 0;
  livePatMeta = {
    last_update:   now.toISOString(),
    mae_before,
    mae_after,
    zones_updated: zonesUpdated,
    run_count:     livePatMeta.run_count + 1,
  };

  sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('live_seeds_last_run',?)")
    .run(JSON.stringify({ ts: now.toISOString(), mae_before, mae_after, zones: zonesUpdated, run: livePatMeta.run_count }));

  const durationMs = Date.now() - t0;
  if (zonesUpdated.length > 0 || livePatMeta.run_count % 10 === 0) {
    console.log(
      `[seeds] 3min recal — MAE: \${mae_before.toFixed(1)}%→\${mae_after.toFixed(1)}% | ` +
      `zones: \${zonesUpdated.length} | run #\${livePatMeta.run_count} | \${durationMs}ms`
    );
  }
}

/** Retourne la valeur de boost statique actuelle pour une heure donnée */
function getBoostForHour(h: number, pat: any): number {
  if (h >= 5 && h < 10)  return pat.demandBoost6_10  ?? 0;
  if (h === 10)          return pat.demandBoost10     ?? 0;
  if (h >= 11 && h <= 13) return pat.demandBoost11_14 ?? 0;
  if (h >= 14 && h <= 18) return pat.demandBoost14_18 ?? 0;
  return 0;
}

/** Retourne la clé du boost pour une heure donnée */
function getBoostKeyForHour(h: number): string | null {
  if (h >= 5 && h < 10)   return 'demandBoost6_10';
  if (h === 10)            return 'demandBoost10';
  if (h >= 11 && h <= 13) return 'demandBoost11_14';
  if (h >= 14 && h <= 18) return 'demandBoost14_18';
  return null;
}

/** Retourne la base de demande AVANT boost et AVANT ×dayCo pour une heure/zone */
function getBaseDemand(h: number, pat: any, dayCo: { demand: number }): number {
  const isPeak = (pat.peakHours ?? []).includes(h);
  const isNight = h >= 0 && h < 5;
  let base = isPeak ? 82 : (isNight ? 36 : 50);
  // morningCap h<=11
  if (h <= 11) {
    const zoneType = (pat as any)._zoneType ?? 'business';
    let cap: number;
    if (h < 10) {
      const isLow = zoneType === 'transport' || zoneType === 'residential';
      cap = isLow ? 12 + (h - 5) * 2 : 15 + (h - 5) * 3;
    } else if (h === 10) {
      const caps10: Record<string, number> = { transport: 30, business: 38, residential: 41, entertainment: 10 };
      cap = caps10[zoneType] ?? 38;
    } else {
      const caps11: Record<string, number> = { transport: 35, business: 42, residential: 44, entertainment: 16 };
      cap = caps11[zoneType] ?? 42;
    }
    base = Math.min(base, cap);
  }
  return base;
}

/** Charge les overrides persistés depuis seed_meta au démarrage */
function loadLiveSeedsFromDb(): void {
  try {
    const rows = sqlite.prepare(
      "SELECT key, value FROM seed_meta WHERE key LIKE 'live_seed_%'"
    ).all() as { key: string; value: string }[];
    let loaded = 0;
    for (const r of rows) {
      const zoneId = r.key.replace('live_seed_', '');
      try {
        const override = JSON.parse(r.value);
        livePat[zoneId] = { ...(patterns[zoneId] || {}), ...override, _live: true };
        loaded++;
      } catch {}
    }
    if (loaded > 0) console.log(`[seeds] \${loaded} overrides dynamiques chargés depuis DB`);
  } catch (e) {
    console.warn('[seeds] loadLiveSeedsFromDb:', e);
  }
}

function computeScore(
  zone: typeof zones93[0],
  h: number,
  dt: string,
  dayOfWeek: number,
  seedVariance: number,
  preloadedEvents?: any[]  // ← audit C1: events préchargés depuis reseedScores (Map) — évite N+1
) {
  // ── Seeds dynamiques : livePat (recalculé 3min) > patterns (statique) ──────
  const patBase = livePat[zone.id] || patterns[zone.id] || { peakHours: [8,12,18], baseAvgDist: 15, baseLongRide: 0.30 };

  // ── P2b context-aware patterns : salon actif → profil event, sinon base ───
  // Utiliser les events préchargés si dispos, sinon fallback DB (appels directs depuis routes)
  const zoneActiveEvents: any[] = preloadedEvents ?? (sqlite
    .prepare("SELECT event_type, demand_boost FROM events WHERE zone_id=? AND is_active=1 AND start_time <= ? AND end_time >= ?")
    .all(zone.id, new Date().toISOString(), new Date().toISOString()) as any[]);
  const hasSalonActif = zoneActiveEvents.some((e: any) =>
    ["salon","conference","congres","exhibition"].includes(e.event_type) && e.demand_boost >= 1.5
  );

  // ← audit B2: rampe progressive salon (au lieu du cliff booléen 14→28 instantané = bug Δ+259%)
  // salonBoost = demand_boost max des events salon actifs (0 si aucun)
  const salonBoost = zoneActiveEvents
    .filter((e: any) => ["salon","conference","congres","exhibition"].includes(e.event_type))
    .reduce((acc: number, e: any) => Math.max(acc, e.demand_boost ?? 0), 0);
  // Interpolation linéaire: salonBoost [1.5→4.0] → ratio [0→1]
  const salonRatio = salonBoost >= 1.5 ? Math.min(1.0, (salonBoost - 1.5) / 2.5) : 0;
  const pat = {
    ...patBase,
    baseAvgDist:   patBase.baseAvgDist + salonRatio * (((patBase as any).baseAvgDistSalon  ?? patBase.baseAvgDist)  - patBase.baseAvgDist),
    baseLongRide:  patBase.baseLongRide + salonRatio * (((patBase as any).baseLongRideSalon ?? patBase.baseLongRide) - patBase.baseLongRide),
    demandBoost10:    (patBase as any).demandBoost10,     // ← seeds dynamiques
    demandBoost11_14: (patBase as any).demandBoost11_14,  // ← seeds dynamiques
    demandBoost14_18: (patBase as any).demandBoost14_18,  // ← seeds dynamiques
    demandBoost6_10:  (patBase as any).demandBoost6_10,   // ← seeds dynamiques
  };

  const isPeak = pat.peakHours.includes(h);
  const isNight = h >= 0 && h < 5;
  const isMidDay = h >= 11 && h <= 13;           // ← audit B3: off-by-one corrigé (h<=18 → h<=13) — midi=[11,13], demi-journée=[14,18] distincts
  const isAfternoon = h >= 14 && h <= 18;        // ← BUG #4: demi-journée distincte du midi (boost14_18 applicable)
  const isWeekendNight = dt === "weekend" && (h >= 22 || h <= 3);
  const dayCo = DAY_COEFFICIENTS[dayOfWeek] || DAY_COEFFICIENTS[2];

  // ── Correction C1 : Couvre-feu aéroports h=0..4 ──────────────────────────
  // ADP impose un couvre-feu opérationnel 0h-5h (pas de vols commerciaux).
  // MAE nuit aéroports mesurée : 48.8% (prédit=13, réel=5) → score plancher 5.
  if (zone.type === "airport" && h >= 0 && h < 5) {
    const calDist = zone.id === "z_cdg" ? 23.8 : 28.6;
    const calDur  = zone.id === "z_cdg" ? 44 : 55;
    const calFare = calDist * 1.30 + 2.80;
    return {
      demand: 5, supply: 5, ratio: 1.0,
      avgDist: calDist, avgDur: calDur, avgFare: Math.round(calFare * 100) / 100,
      profIdx: 5,
      longRide: 0.85,
      surge: 1.0,
      rawRatio: 2.40,
      supplyCoeffLabel: "supply",
    };
  }

  // ── Demande — corrélation étendue 6h-18h ──────────────────────────────────
  let demandBase = isPeak ? 82 : (isNight ? 36 : 50);

  // ── Fix 19/06 : Morning cap zones urbaines h<10 ──────────────────────────
  // Zones 93/urbaines : demande matin (h=5..9) bien plus basse que le pic journée.
  // Sans ce cap, isPeak=true → demandBase=82 → ×dayCo = 100 alors que hist=18-41.
  // Calibré sur historique réel 19/06 : demandBase cible h5=19, h9=34 → cap=38.
  // Les zones aéroport et leurs patterns propres ne sont pas concernés.
  if (h <= 11 && zone.type !== "airport") {
    // ── Cap progressif h=5..11 — calibré données réelles 19/06 ──────────────
    // Couvre toute la montée de demande matinale avant le pic midi (h>=12)
    // h<10 : cap progressif par type de zone (calibré 19/06)
    //   transport/residential : 12+(h-5)*2 → h5=12..h9=20 → ×dayCo h5=14.6..h9=24.4
    //   business/entertainment : 15+(h-5)*3 → h5=15..h9=27 → ×dayCo h5=18.3..h9=32.9
    // h==10 : cap par type (calibré sur hist réels h10) — transition vers pic midi
    //   transport=30, business=38, residential=41, entertainment=10
    //   ×dayCo ven : transport=36.6, business=46.4, residential=50.0, entertainment=12.2
    // h==11 : cap par type (calibré sur hist réels h11) — début montée midi
    //   transport=35, business=42, residential=44, entertainment=16
    //   ×dayCo ven : transport=42.7, business=51.2, residential=53.7, entertainment=19.5
    // MAE simulée h=5..11 : <10% | Règle métier : légère sous-estimation OK
    let morningCap: number;
    if (h < 10) {
      const isLowDensityZone = (zone.type === "transport" || zone.type === "residential");
      morningCap = isLowDensityZone
        ? 12 + (h - 5) * 2  // transport/residential : h5=12..h9=20
        : 15 + (h - 5) * 3; // business/entertainment : h5=15..h9=27
    } else if (h === 10) {
      // Caps h=10 par type (calibrés hist 19/06)
      const caps10: Record<string, number> = { transport: 30, business: 38, residential: 41, entertainment: 10 };
      morningCap = caps10[zone.type] ?? 38;
    } else { // h === 11
      // Caps h=11 par type (calibrés hist 19/06)
      const caps11: Record<string, number> = { transport: 35, business: 42, residential: 44, entertainment: 16 };
      morningCap = caps11[zone.type] ?? 42;
    }
    demandBase = Math.min(demandBase, morningCap);
  }

  if (zone.type === "airport") {
    demandBase = isPeak ? 94 : (isNight ? 62 : 66);
    if ((pat as any).demandCap) demandBase = Math.min(demandBase, (pat as any).demandCap);
  }

  // Boost h=10 : transition matin→midi (zones business/logistique actives à 10h)
  // Calibré sur historique 19/06 pour zones avec hist h10 > cap×dayCo
  if (h === 10) {
    demandBase += (pat as any).demandBoost10 ?? 0;
  }

  // Boosts horaires 11h-18h calibrés (corrélation Parc Expo / business)
  if (isMidDay) {
    demandBase += (pat as any).demandBoost11_14 ?? 0;
  }
  if (isAfternoon) {
    demandBase += (pat as any).demandBoost14_18 ?? 0;
  }

  // Boost corrélation 5h-10h (rush AM + aéroports matinaux + travailleurs nuit 93) — mesuré 10/06/2026
  // h>=5 : capter les travailleurs de nuit/transport 93 (logistique CDG, sécurité, RER)
  if (h >= 5 && h < 10) {
    demandBase += (pat as any).demandBoost6_10 ?? 0;
  }

  // Ajustements ponctuels validés
  if (zone.id === "z_cdg"  && h >= 6  && h <= 8)  demandBase = Math.min(demandBase + 4, 98);
  if (zone.id === "z_orly" && h === 8)             demandBase = Math.min(demandBase + 3, 94);
  // z_stade_france : plus d'override brutal — h0..9 maintenant dans peakHours (19/06)
  // if (zone.id === "z_stade_france" && !isPeak)     demandBase = 20; // SUPPRIMÉ 19/06
  if (isWeekendNight) demandBase += 24;

  // ── P3a : Perturbation transport (grève, incident) → boost demande zones RER ─
  // Si alerte transport_disruption active en heure de rush → ×1.4 sur corridors RER D
  const RER_D_ZONES = ["z_saint_denis_gare","z_bobigny_gare","z_aubervilliers","z_93_centre","z_epinay_gennevilliers"];
  if (h >= 6 && h <= 12 && RER_D_ZONES.includes(zone.id)) {
    const disruption = sqlite
      .prepare("SELECT 1 FROM alerts WHERE type='transport_disruption' AND is_read=0 AND expires_at > ? LIMIT 1")
      .get(new Date().toISOString()) as any;
    if (disruption) {
      demandBase = Math.min(demandBase * 1.40, 98); // +40% demande zones impactées grève RER D
    }
  }

  demandBase *= dayCo.demand;
  const v = Math.sin(seedVariance * 7.3 + h * 0.5) * 0.07;
  const demand = Math.min(100, Math.max(5, demandBase * (1 + v)));

  // ── Offre — mid-day shift différencié 11h-18h ─────────────────────────────
  // 11h-18h : davantage de chauffeurs actifs (shift journée) → supply plus haute
  // 6h-10h  : peu de chauffeurs (heure creuse chauffeurs) → supply_morning basse
  const isMorning = h >= 6 && h < 10;
  const supplyCoeff = isMorning ? dayCo.supply_morning
    : (isMidDay || isAfternoon) ? dayCo.supply_midday
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
    // ─── Recalibré 11/06/2026 — données réelles croisées ───────────────────
    // Sources : ADP trafic aéro, Sytadin/DiRIF, grève RER D 11/06, météo
    // Ratio = vitesse effective / vitesse rush PM (BASE 1.0 = 17h-19h)
    // Rush AM = embouteillages → vitesse basse → ratio < 1.0
    // Nuit/post-rush = routes libres → vitesse haute → ratio > 1.0
    if (hh < 6)  return 2.54;  // nuit — entraînement 17/06/2026 : 2.10→2.54 (ratio DiRIF h=5 +21%)
    if (hh < 7)  return 1.24;  // 6h : entraînement 17/06/2026 : 1.32→1.24 (flux CDG légèrement revu)
    if (hh < 8)  return 0.96;  // 7h : entraînement 17/06/2026 : 0.78→0.96 (rush AM réel DiRIF +23%)
    if (hh < 9)  return 1.02;  // 8h : entraînement 17/06/2026 : 0.70→1.02 (pic HPM DiRIF mercredi +45%)
    if (hh < 10) return 1.28;  // 9h : entraînement 17/06/2026 : 0.72→1.28 (post-rush DiRIF encore dense)
    if (hh < 11) return 1.38;  // 10h : décongestion — post-rush ✅ (mesuré 10h37 = 1.69 zone par zone)
    if (hh < 12) return 1.62;  // 11h : creux trafic (creux demande aussi) — routes fluides
    if (hh < 13) return 1.55;  // 12h : reprise légère — déjeuner d'affaires, banque midi CDG
    if (hh < 14) return 1.48;  // 13h : flux modéré — restrictions début Stade de France
    if (hh < 15) return 1.38;  // 14h : reprise douce — montée événement Stade de France
    if (hh < 16) return 1.22;  // 15h : pré-rush + préparatifs concert
    if (hh < 17) return 1.08;  // 16h : pré-rush PM — Guetta portes 16h30
    if (hh < 19) return 1.00;  // rush PM 17-19h ✅ BASE MESURÉE
    if (hh < 22) return 1.52;  // soir — Guetta/Stade de France boost 20h-23h
    return 2.20;                // nuit 22h+
  };
  const baseSpeed = SPEED_RUSH_PM[zone.id] ?? 20.0;
  const realDist = REAL_DIST_KM[zone.id] ?? pat.baseAvgDist;

  // ── P2a backtest : rideSpeedFactor ≠ repoSpeedFactor ─────────────────────
  // Correction du paradoxe : ratio_h bas (rush AM) allongeait l'avgDur du trajet chargé
  // → moins de courses/heure → score bas même avec surge élevé
  // Réalité : le TRAJET CHARGÉ est 22% plus rapide que le ratio trafic brut
  // (GPS optimal, priorité, moins d'arrêts). Le REPO à vide est encore plus lent.
  const rawRatio = getRatioH(h);
  const rideRatio = Math.min(rawRatio * 1.22, 1.05); // trajet chargé — plancher 88% rush PM
  const repoRatio = rawRatio * 0.82;                  // repo à vide — encore plus lent que trafic moyen
  const effRideSpeed = Math.max(baseSpeed * rideRatio, baseSpeed * 0.88);
  const effRepoSpeed = Math.max(baseSpeed * repoRatio, 4.0);  // min 4 km/h (embouteillage extrême)

  // avgDist = distance moyenne d'une COURSE depuis cette zone (pas le trajet aller)
  // calibré : CDG→Paris ~42km, Orly→Paris ~30km, zones 93 ~12-18km
  const distMultiplier = isPeak ? 1.12 : (isMidDay ? 1.05 : 0.92);
  const avgDist = pat.baseAvgDist * distMultiplier + Math.sin(seedVariance + h) * 1.5;

  // ── ETA avec densité trafic historique (TRAFFIC_DENSITY par zone × ratio horaire) ──────────
  // getCongestedETA remplace le simple effRideSpeed pour tenir compte de la congestion locale
  // historique par zone (TRAFFIC_DENSITY[zoneId][h]) en plus du ratio global.
  // blend alpha=0.35 : 35% ratio global / 65% densité zone — paramétrage terrain 93.
  const congestedRoute = getCongestedETA(zone.id, realDist, h, { alphaBlend: 0.35 });
  // avgDur = durée effective du trajet chargé selon trafic historique de la zone
  // On prend le max entre le modèle congestion et le calcul classique (garde-fou cohérence)
  const avgDurCongested = congestedRoute.etaMin;
  const avgDurClassic   = (avgDist / effRideSpeed) * 60;
  // Pondération : 60% congestion historique + 40% modèle classique (hybride)
  const avgDur = avgDurCongested * 0.60 + avgDurClassic * 0.40;

  const avgFare = avgDist * 1.30 + 2.80;

  // ── Métriques congestion exposées ──────────────────────────────────────────
  const congestionFactor = congestedRoute.congestionFactor;
  const congestionLabel  = congestedRoute.congestionLabel;

  // ── Surge — calibré 11h-18h ────────────────────────────────────────────────
  // Rush PM 17h+ : surge déclenché plus tôt (observé terrain)
  // Mi-journée : surge modéré mais réel sur zones business
  const isMorningRush = h >= 6 && h < 9; // Rush AM — demande >>> offre
  // BUG #2: seuils de nuit profonde abaissés sur aéroports — évite l'anomalie de seuil
  // (bruit sinusoïdal faisait tomber le surge Orly h=0 à 1.75 au lieu de plein régime)
  const surgeThreshold1 = isMorningRush ? 1.5 : isMidDay ? 1.9 : (isNight && zone.type === "airport" ? 1.9 : 2.2);
  const surgeThreshold2 = isMorningRush ? 1.1 : isMidDay ? 1.4 : (isNight && zone.type === "airport" ? 1.3 : 1.7);
  const surgeThreshold3 = isMorningRush ? 0.9 : isMidDay ? 1.1 : (isNight && zone.type === "airport" ? 1.0 : 1.3);
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
  // P2a: repoMin calculé avec effRepoSpeed (affecté par trafic) — pas rideSpeed
  // Repo réaliste : aéroports restent sur zone ou file vers zone voisine (3-7km)
  // Zones courtes (<15km) : rotation rapide, repo ≈ 35% du trajet
  // Zones longues (>20km) : repo partiel ≈ 40% (pas retour complet)
  const repoRatio_km = zone.type === "airport" ? 0.12  // CDG/Orly → reste sur zone ou Villepinte/Tremblay
    : avgDist < 15 ? 0.35  // zones courtes : rotation rapide
    : 0.40;                 // zones longues : retour partiel
  const repoKm = Math.max(3, avgDist * repoRatio_km);
  const repoMin = Math.min(30, Math.max(2, (repoKm / effRepoSpeed) * 60)); // plafonné 30min (était 45)
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

  // Sigmoid ← audit H1: inflexion adaptative selon demande du jour
  // Jeudi demand=1.18 → inflexion 46.8€/h (attentes plus élevées)
  // Dimanche demand=0.74 → inflexion 37.4€/h (seuil plus bas)
  // Sigmoïde calibrée sur le seuil de rentabilité réel VTC (35€/h = break-even)
  // Inflexion 35€/h = score 50 (neutre), 55€/h = score ~85, 70€/h = score ~95
  // Zones longues (CDG) : cycles rares mais tarifs élevés — la sigmoïde doit les valoriser
  const BASE_INFLECTION = 35;
  const inflectionAdjust = (dayCo.demand - 1.0) * 8; // ±8 pts selon contexte journalier
  const inflection = Math.max(25, Math.min(55, BASE_INFLECTION + inflectionAdjust));
  const sigRent = 1 / (1 + Math.exp(-0.10 * (netHourly - inflection)));

  // ── Bonus court-trajet + surge élevé (backtest P1c) ───────────────────────
  // Zones < 12km avec surge > ×1.5 : le modèle sous-estimait leur rentabilité
  // car netHourly absolu faible même si les courses s'enchaînent vite
  // Corrigé: jusqu'à +8 pts bonus pour surge ×2.5 sur zone courte
  // ← audit E1: guard isShortRideZone (baseAvgDist<13) — évite déclenchement sur Villepinte off-peak (avgDist min 11.38 par bruit sinus)
  const isShortRideZone = pat.baseAvgDist < 13;
  const shortRideBonus = (isShortRideZone && avgDist < 12 && surge > 1.5)
    ? Math.min(8, (surge - 1.5) * 6.4)
    : 0;

  // Ratio D/O log-normalisé [0-1] — cap à ratio=6 (au lieu de saturer à ratio>2)
  const ratioNorm = Math.min(Math.log1p(ratio) / Math.log1p(6), 1.0);

  // Long ride × distance normalisée [0-1]
  const distNorm = Math.min(avgDist / 55, 1.0); // 55km = distance max CDG longue
  const longScore = longRide * (0.55 + 0.45 * distNorm);

  // Surge log-scale [0-1] — ← audit D1: normalisé par log(SURGE_CAP=3.8) pour que surgeNorm=1.0 soit atteignable (au lieu de 0.963 max)
  const SURGE_CAP = 3.8;
  const surgeNorm = surge > 1 ? Math.min(Math.log(surge) / Math.log(SURGE_CAP), 1.0) : 0;

  // ← audit A1: eventNorm dérivé DEPUIS LA DB (zoneActiveEvents) — plus de constante fantôme
  // maxBoost = demand_boost max de tous les events actifs de cette zone
  // EVENT_NORM_CEILING = 6.0 (demand_boost concert Guetta=4.8 → eventNorm=0.80 → +4.0pts)
  // Zone sans event actif → eventNorm=0 (plus de +0.75pt fantôme Villepinte, +1.25pt Le Bourget etc.)
  const EVENT_NORM_CEILING = 6.0;
  const maxBoost = zoneActiveEvents.length > 0
    ? Math.max(...zoneActiveEvents.map((e: any) => e.demand_boost ?? 0))
    : 0;
  const eventNorm = Math.min(1.0, maxBoost / EVENT_NORM_CEILING);

  // Score composite [0-95] — cap 95 pour garder granularité visible
  // ← backtest P1c: surgeNorm 0.10→0.14, ratioNorm 0.20→0.16 (+shortRideBonus injecté directement)
  const profIdx = Math.min(95, Math.max(5, Math.round((
    0.50 * sigRent * 100 +
    0.16 * ratioNorm * 100 +
    0.15 * longScore * 100 +
    0.14 * surgeNorm * 100 +
    0.05 * eventNorm * 100 +
    shortRideBonus
  ) * 10) / 10));

  // ── Facteur de disponibilité réelle — calibré sur sièges/heure ADP + attente à vide ──────
  // Sources : Airport Information CDG, Cohor (couvre-feu 0h-5h), Chris Whong (attente taxi JFK)
  // Résultat : empêche qu'un ratio D/O théorique élevé sur-score un créneau à faible volume
  const AIRPORT_AVAILABILITY: Record<number, number> = {
    // Deep analysis 17/06/2026 : h=0..4 couvre-feu ADP (quasi-0), h=10 pic absolu flux (19376 sièges), h=11 2ème plage, h=19 2ème pic soir
    0: 0.03, 1: 0.02, 2: 0.02, 3: 0.02, 4: 0.04, 5: 0.45,
    // Entraînement 17/06/2026 : h=6+0.06, h=7+0.14, h=8+0.03, h=9-0.19 (creux BookCab h=9=30€/h)
    6: 0.94, 7: 1.14, 8: 1.03, 9: 0.81, 10: 1.10, 11: 0.98,
    12: 0.84, 13: 0.86, 14: 0.68, 15: 0.60, 16: 0.88, 17: 0.72,
    18: 0.72, 19: 0.85, 20: 1.05, 21: 0.90, 22: 0.58, 23: 0.35,
  };
  // Orly — entraînement 17/06/2026 : sur-estimé h=5..9 vs historique BookCab/ADP Orly
  // Orly DOM-TOM : trafic matin moins dense que CDG, départs long-courriers plus tardifs
  const ORLY_AVAILABILITY: Record<number, number> = {
    0: 0.03, 1: 0.02, 2: 0.02, 3: 0.02, 4: 0.04, 5: 0.36,
    6: 0.66, 7: 0.79, 8: 0.71, 9: 0.68, 10: 1.10, 11: 0.98,
    12: 0.84, 13: 0.86, 14: 0.68, 15: 0.60, 16: 0.88, 17: 0.72,
    18: 0.72, 19: 0.85, 20: 1.05, 21: 0.90, 22: 0.58, 23: 0.35,
  };
  // Zones urbaines : commute bimodal (rush AM/PM = peak), nuit 0h-5h calibrée 18/06/2026
  // Calibration nuit 18/06 : URBAN_AVAILABILITY_WEEKDAY[0..3] corrigé depuis historique réel
  // Méthode : finalProfIdx = profIdx_raw × avail → avail_req = hist_target / profIdx_raw
  // Données : h=0 hist=50.2 (avail 0.38→0.86), h=1 hist=54.2 (0.30→0.83),
  //           h=2 hist=44.1 (0.25→0.67), h=3 hist=33.4 (0.25→0.53)
  // Interprétation : travailleurs nuit 93 (logistique CDG, sécurité, restauration) actifs h=0..2
  const URBAN_AVAILABILITY_WEEKDAY: Record<number, number> = {
    0: 0.86, 1: 0.83, 2: 0.67, 3: 0.53, 4: 0.55, 5: 0.72,  // calibré 18/06/2026 données terrain
    // Entraînement 17/06/2026 : h=7+0.07, h=8+0.13, h=9+0.17 (rush AM zones 93 DiRIF sous-estimé)
    6: 0.82, 7: 1.07, 8: 1.13, 9: 1.09, 10: 0.75, 11: 0.78,
    12: 0.78, 13: 0.72, 14: 0.68, 15: 0.65, 16: 0.72, 17: 1.00,
    18: 1.00, 19: 0.90, 20: 0.70, 21: 0.65, 22: 0.55, 23: 0.45,
  };
  // Weekend : nuit plus active (sorties), rush AM absent, journée homogène
  const URBAN_AVAILABILITY_WEEKEND: Record<number, number> = {
    0: 0.85, 1: 0.90, 2: 0.75, 3: 0.55, 4: 0.38, 5: 0.35,
    6: 0.42, 7: 0.52, 8: 0.60, 9: 0.70, 10: 0.82, 11: 0.85,
    12: 0.90, 13: 0.88, 14: 0.85, 15: 0.85, 16: 0.88, 17: 0.92,
    18: 0.95, 19: 0.98, 20: 0.98, 21: 0.95, 22: 0.98, 23: 0.95,
  };

  let availabilityFactor: number;
  if (zone.id === "z_orly") {
    // Orly : table séparée — calibrée 17/06/2026 (trafic matin différent de CDG)
    availabilityFactor = ORLY_AVAILABILITY[h] ?? 0.70;
  } else if (zone.type === "airport") {
    availabilityFactor = AIRPORT_AVAILABILITY[h] ?? 0.70;
  } else if (dt === "weekend") {
    availabilityFactor = URBAN_AVAILABILITY_WEEKEND[h] ?? 0.80;
  } else {
    availabilityFactor = URBAN_AVAILABILITY_WEEKDAY[h] ?? 0.80;
  }
  // Entertainment (Stade de France) : facteur spécifique — quasi nul hors event, 1.0 pendant
  // Si un event actif : la zone a son propre boost via eventNorm → garder l'availability normal
  // Sans event actif : peu de demande, réduire l'availability
  if (zone.type === "entertainment" && maxBoost < 1.5) {
    availabilityFactor = Math.min(availabilityFactor, 0.50); // Stade calme = demi-disponibilité
  }

  // ── Pénalité congestion — seuil 1 min/km (règle métier stricte) ──────────────────────────
  // Seuil appliqué sur le TRAJET COURSE (avgDur/avgDist), pas sur le trajet aller vers la zone.
  // Logique : si la course elle-même prend >1 min/km, le tarif/km est insuffisant vs coûts.
  // Aéroports : seuil 1.35 min/km (tarif forfaitaire plus élevé — compense le temps de trajet).
  // Pénalité dégressive : 0 si OK, max -15 pts si très hors seuil.
  // Note : le repoMin (trajet aller vers zone) pénalise déjà via cycleMins/netHourly.
  const breakEven = computeBreakEvenPenalty(
    zone.id,
    avgDist,             // distance course moyenne (km)
    avgDur,              // durée course moyenne avec congestion (min) — pas l'ETA aller
    congestionFactor
  );
  // profIdx avec pénalité congestion intégrée
  const profIdxWithPenalty = Math.max(5, profIdx - breakEven.penalty);

  const finalProfIdx = Math.min(95, Math.max(5, Math.round(profIdxWithPenalty * availabilityFactor * 10) / 10));

  return {
    demand: Math.round(demand * 10) / 10,
    supply: Math.round(supply * 10) / 10,
    ratio: Math.round(ratio * 100) / 100,
    avgDist: Math.round(avgDist * 10) / 10,
    avgDur: Math.round(avgDur * 10) / 10,
    avgFare: Math.round(avgFare * 100) / 100,
    profIdx: Math.round(finalProfIdx * 10) / 10,
    longRide: Math.round(longRide * 1000) / 1000,
    surge: Math.round(surge * 100) / 100,
    rawRatio: Math.round(rawRatio * 1000) / 1000,
    supplyCoeffLabel: isMorning ? "supply_morning" : (isMidDay ? "supply_midday" : "supply"),
    // Nouveaux champs : densité trafic historique + seuil 1 min/km
    congestionFactor: congestionFactor,
    congestionLabel:  congestionLabel,
    minPerKm:         breakEven.minPerKm,
    breakEvenOk:      breakEven.breakEvenOk,
    congestionPenalty: Math.round(breakEven.penalty * 10) / 10,
    etaToZone:        avgDurCongested,  // ETA aller vers la zone (vs avgDur = durée course)
  };
}

function reseedScores(today: string, dayOfWeek: number) {
  const insS = sqlite.prepare(
    `INSERT INTO profitability_scores (zone_id,hour,day_type,demand_score,supply_score,ratio_ds,avg_distance_km,avg_duration_min,avg_fare,profitability_index,long_ride_probability,surge_multiplier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  const insH = sqlite.prepare(
    `INSERT OR IGNORE INTO score_history (zone_id,hour,day_type,profitability_index,surge_multiplier,demand_score,supply_score,seed_date) VALUES (?,?,?,?,?,?,?,?)`
  );

  // ← audit C1: préchargement events en Map<zoneId, events[]> — 1 SELECT au lieu de 672 N+1
  const now = new Date().toISOString();
  const allActiveEvents = sqlite.prepare(
    `SELECT zone_id, event_type, demand_boost FROM events WHERE is_active=1 AND start_time <= ? AND end_time >= ?`
  ).all(now, now) as any[];
  const eventsByZone = new Map<string, any[]>();
  for (const ev of allActiveEvents) {
    if (!eventsByZone.has(ev.zone_id)) eventsByZone.set(ev.zone_id, []);
    eventsByZone.get(ev.zone_id)!.push(ev);
  }

  for (let zi = 0; zi < zones93.length; zi++) {
    const zone = zones93[zi];
    const seedVar = zi * 1.37; // variance déterministe par zone
    const zoneEvents = eventsByZone.get(zone.id) ?? [];
    for (const dt of ["weekday", "weekend"]) {
      // BUG #1 : dériver le bon dayOfWeek selon le day_type pour que les
      // DAY_COEFFICIENTS weekday et weekend diffèrent réellement (h=4..21).
      const effectiveDow = dt === "weekday"
        ? ([0, 6].includes(dayOfWeek) ? 2 : dayOfWeek)   // jour ouvré (mardi par défaut si on est le weekend)
        : ([0, 6].includes(dayOfWeek) ? dayOfWeek : 6);   // weekend réel sinon samedi représentatif
      for (let h = 0; h < 24; h++) {
        const s = computeScore(zone, h, dt, effectiveDow, seedVar, zoneEvents);
        insS.run(zone.id, h, dt, s.demand, s.supply, s.ratio, s.avgDist, s.avgDur, s.avgFare, s.profIdx, s.longRide, s.surge);
        insH.run(zone.id, h, dt, s.profIdx, s.surge, s.demand, s.supply, today);
      }
    }
  }
}

// ─── THÈME 1 : Prédiction de demande (ML scoring) ────────────────────────────
// Génère les prédictions H+1 à H+12 pour chaque zone via le moteur computeScore.
function generateDemandPredictions(): void {
  const now = new Date();
  const createdAt = now.toISOString();

  // Précharger les events actifs par zone (évite N+1 dans computeScore)
  const allActiveEvents = sqlite.prepare(
    `SELECT zone_id, event_type, demand_boost FROM events WHERE is_active=1 AND start_time <= ? AND end_time >= ?`
  ).all(createdAt, createdAt) as any[];
  const eventsByZone = new Map<string, any[]>();
  for (const ev of allActiveEvents) {
    if (!eventsByZone.has(ev.zone_id)) eventsByZone.set(ev.zone_id, []);
    eventsByZone.get(ev.zone_id)!.push(ev);
  }
  const eventIdsByZone = new Map<string, string[]>();
  const allActiveEventsFull = sqlite.prepare(
    `SELECT id, zone_id FROM events WHERE is_active=1 AND start_time <= ? AND end_time >= ?`
  ).all(createdAt, createdAt) as any[];
  for (const ev of allActiveEventsFull) {
    if (!eventIdsByZone.has(ev.zone_id)) eventIdsByZone.set(ev.zone_id, []);
    eventIdsByZone.get(ev.zone_id)!.push(String(ev.id));
  }

  // ── CHANGEMENT 4 : baseline J-7 pondérée (périodicité hebdomadaire dominante) ──
  // Chargement scores J-7 (même jour de semaine, pas J-1 qui peut avoir un day_type différent)
  // La périodicité hebdomadaire est le signal dominant (Sage journals 2023)
  const lastWeek = new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0];
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000).toISOString().split("T")[0];

  const histScores = sqlite.prepare(
    `SELECT zone_id, hour, day_type, profitability_index, seed_date FROM score_history
     WHERE seed_date IN (?, ?) ORDER BY seed_date DESC`
  ).all(lastWeek, twoWeeksAgo) as any[];

  // Pondérations exponentielles : J-7 poids 0.65, J-14 poids 0.35
  const histMap = new Map<string, number>();
  const histByKey = new Map<string, { recent: number; older: number }>();
  for (const row of histScores) {
    const key = `${row.zone_id}|${row.hour}|${row.day_type}`;
    const existing = histByKey.get(key);
    if (!existing) {
      histByKey.set(key, { recent: -1, older: -1 });
    }
    const entry = histByKey.get(key)!;
    if (row.seed_date === lastWeek && entry.recent < 0) entry.recent = row.profitability_index;
    else if (row.seed_date === twoWeeksAgo && entry.older < 0) entry.older = row.profitability_index;
  }
  // Construire la baseline pondérée J-7/J-14
  for (const [key, { recent, older }] of histByKey) {
    if (recent >= 0 && older >= 0) {
      histMap.set(key, recent * 0.65 + older * 0.35);
    } else if (recent >= 0) {
      histMap.set(key, recent);
    } else if (older >= 0) {
      histMap.set(key, older);
    }
  }

  const tx = sqlite.transaction(() => {
    for (let zi = 0; zi < zones93.length; zi++) {
      const zone = zones93[zi];
      const seedVar = zi * 1.37;
      const zoneEvents = eventsByZone.get(zone.id) ?? [];
      for (let ahead = 1; ahead <= 12; ahead++) {
        const target = new Date(now.getTime() + ahead * 3600000);
        const targetHour = target.getHours();
        const targetDate = target.toISOString().split("T")[0];
        const dayOfWeek = target.getDay();
        const dt = [0, 6].includes(dayOfWeek) ? "weekend" : "weekday";
        const s = computeScore(zone, targetHour, dt, dayOfWeek, seedVar, zoneEvents);
        const confidence = Math.max(0.65, 0.9 - (ahead - 1) * 0.05);
        const dayCo = DAY_COEFFICIENTS[dayOfWeek] || DAY_COEFFICIENTS[2];
        const isMorning = targetHour >= 6 && targetHour < 10;
        const isMidDay = targetHour >= 11 && targetHour <= 13;
        const factors = JSON.stringify({
          traffic_ratio: s.rawRatio,
          events_active: eventIdsByZone.get(zone.id) ?? [],
          day_coeff: dayCo.demand,
          supply_coeff: isMorning ? dayCo.supply_morning : (isMidDay ? dayCo.supply_midday : dayCo.supply),
          supply_applied: s.supplyCoeffLabel,
        });
        // CHANGEMENT 4 : modèle additif J-7 pondéré + tendance récente décroissante
        const histKey = `${zone.id}|${targetHour}|${dt}`;
        const histBaseline = histMap.get(histKey);

        let predictedIdx = s.profIdx;
        if (histBaseline !== undefined) {
          // Tendance récente = écart actuel vs baseline historique
          const currentScore = s.profIdx;
          const trendDelta = (currentScore - histBaseline) * 0.25; // momentum 25%
          // Decay exponentiel de la tendance : 0.70^k (k = horizon en heures)
          const decayedTrend = trendDelta * Math.pow(0.70, ahead - 1);
          // Légère pénalité de précision avec l'horizon
          const horizonPenalty = (ahead - 1) * 0.3;
          predictedIdx = Math.min(95, Math.max(5,
            Math.round((histBaseline + decayedTrend - horizonPenalty) * 10) / 10
          ));
        }

        stmtInsertPrediction.run(
          zone.id, targetHour, targetDate,
          zone.id, targetHour, targetDate,
          predictedIdx,
          Math.round(confidence * 100) / 100,
          "v3_j7_trend",
          factors,
          createdAt
        );
      }
    }
  });
  tx();
}

// ─── THÈME 2 : Maintenance prédictive véhicule ───────────────────────────────
const DEFAULT_MAINTENANCE = [
  { component: "oil",      label_fr: "Huile moteur", interval_km: 10000, estimated_cost_eur: 80  },
  { component: "tires",    label_fr: "Pneus",        interval_km: 40000, estimated_cost_eur: 400 },
  { component: "brakes",   label_fr: "Freins",       interval_km: 30000, estimated_cost_eur: 250 },
  { component: "filters",  label_fr: "Filtres",      interval_km: 20000, estimated_cost_eur: 60  },
  { component: "revision", label_fr: "Révision",     interval_km: 15000, estimated_cost_eur: 150 },
];

function computeUrgency(remaining: number, intervalKm: number): string {
  if (remaining < 0) return "overdue";
  if (remaining < intervalKm * 0.1) return "urgent";
  if (remaining < intervalKm * 0.2) return "soon";
  return "ok";
}

function seedMaintenance(): void {
  const cnt = (sqlite.prepare("SELECT COUNT(*) as c FROM vehicle_maintenance").get() as any).c;
  if (cnt > 0) return;
  const nowIso = new Date().toISOString();
  const ins = sqlite.prepare(
    `INSERT INTO vehicle_maintenance
       (component, label_fr, interval_km, last_done_km, total_km_driven, urgency, estimated_cost_eur, next_due_km, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const tx = sqlite.transaction(() => {
    for (const m of DEFAULT_MAINTENANCE) {
      ins.run(m.component, m.label_fr, m.interval_km, 0, 0, "ok", m.estimated_cost_eur, m.interval_km, nowIso, nowIso);
    }
  });
  tx();
}

function updateMaintenanceKm(addedKm: number): void {
  if (!addedKm || addedKm <= 0) return;
  const rows = sqlite.prepare("SELECT * FROM vehicle_maintenance").all() as any[];
  const nowIso = new Date().toISOString();
  const upd = sqlite.prepare(
    "UPDATE vehicle_maintenance SET total_km_driven=?, urgency=?, updated_at=? WHERE id=?"
  );
  const tx = sqlite.transaction(() => {
    for (const r of rows) {
      const total = (r.total_km_driven ?? 0) + addedKm;
      const remaining = (r.next_due_km ?? r.interval_km) - total;
      const urgency = computeUrgency(remaining, r.interval_km);
      upd.run(Math.round(total), urgency, nowIso, r.id);
    }
  });
  tx();
}

function markMaintenanceDone(component: string): any {
  const r = sqlite.prepare("SELECT * FROM vehicle_maintenance WHERE component=?").get(component) as any;
  if (!r) return null;
  const nowIso = new Date().toISOString();
  const lastDoneKm = r.total_km_driven ?? 0;
  const nextDueKm = lastDoneKm + r.interval_km;
  sqlite.prepare(
    "UPDATE vehicle_maintenance SET last_done_km=?, next_due_km=?, urgency='ok', updated_at=? WHERE id=?"
  ).run(Math.round(lastDoneKm), Math.round(nextDueKm), nowIso, r.id);
  return sqlite.prepare("SELECT * FROM vehicle_maintenance WHERE id=?").get(r.id);
}

// ─── THÈME 3 : Scoring comportement conducteur + feedback IA ──────────────────
function computeDriverPerformance(period: "daily" | "weekly"): any {
  const now = new Date();
  const periodStart = new Date(now);
  if (period === "daily") {
    periodStart.setHours(0, 0, 0, 0);
  } else {
    const day = (periodStart.getDay() + 6) % 7; // lundi=0
    periodStart.setDate(periodStart.getDate() - day);
    periodStart.setHours(0, 0, 0, 0);
  }
  const periodDate = periodStart.toISOString().split("T")[0];

  const rides = sqlite.prepare(
    "SELECT * FROM rides WHERE timestamp >= ? ORDER BY timestamp ASC"
  ).all(periodStart.toISOString()) as any[];

  const profile: any = sqlite.prepare("SELECT * FROM driver_profile LIMIT 1").get() || {};
  const hourlyTarget = profile.hourly_target_income ?? 35;

  const totalRides = rides.length;
  const profitableRides = rides.filter(r => r.is_profitable === 1).length;
  const totalKm = Math.round(rides.reduce((a, r) => a + (r.distance_km ?? 0), 0));
  const totalNet = Math.round(rides.reduce((a, r) => a + (r.net_profit ?? 0), 0) * 100) / 100;
  const avgHourlyRate = totalRides > 0
    ? Math.round((rides.reduce((a, r) => a + (r.hourly_rate ?? 0), 0) / totalRides) * 100) / 100
    : 0;

  const efficiencyScore = totalRides > 0 ? Math.round((profitableRides / totalRides) * 100) : 0;

  // positioning : % courses dont la zone de pickup avait un score > 60 à l'heure de la course
  let goodPositions = 0;
  for (const r of rides) {
    const d = new Date(r.timestamp);
    const h = d.getHours();
    const dt = [0, 6].includes(d.getDay()) ? "weekend" : "weekday";
    const ps = sqlite.prepare(
      "SELECT profitability_index FROM profitability_scores WHERE zone_id=? AND hour=? AND day_type=? LIMIT 1"
    ).get(r.pickup_zone_id, h, dt) as any;
    if (ps && ps.profitability_index > 60) goodPositions++;
  }
  const positioningScore = totalRides > 0 ? Math.round((goodPositions / totalRides) * 100) : 0;

  const profitabilityScore = totalRides > 0
    ? Math.round((rides.filter(r => (r.hourly_rate ?? 0) > hourlyTarget).length / totalRides) * 100)
    : 0;

  // consistency : 100 - coefficient de variation du taux horaire
  let consistencyScore = 0;
  if (totalRides > 1) {
    const rates = rides.map(r => r.hourly_rate ?? 0);
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    if (mean > 0) {
      const variance = rates.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rates.length;
      const stddev = Math.sqrt(variance);
      consistencyScore = Math.max(0, Math.min(100, Math.round(100 - (stddev / mean) * 100)));
    }
  } else if (totalRides === 1) {
    consistencyScore = 100;
  }

  const globalScore = Math.round(
    0.3 * efficiencyScore + 0.3 * profitabilityScore + 0.25 * positioningScore + 0.15 * consistencyScore
  );

  // ai_tips déterministes
  const tips: string[] = [];
  if (positioningScore < 50) {
    tips.push("Repositionnez-vous sur CDG ou Orly aux heures de pointe matinales (6h-9h) pour maximiser vos courses longues");
  }
  if (profitabilityScore < 60) {
    tips.push("Évitez les courses < 10km en dehors des créneaux surge — elles dégradent votre taux horaire");
  }
  if (avgHourlyRate > hourlyTarget) {
    // meilleure heure = heure avec le meilleur taux moyen
    const byHour: Record<number, number[]> = {};
    for (const r of rides) {
      const h = new Date(r.timestamp).getHours();
      (byHour[h] ||= []).push(r.hourly_rate ?? 0);
    }
    let bestHour = -1, bestAvg = -Infinity;
    for (const h of Object.keys(byHour)) {
      const arr = byHour[Number(h)];
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      if (avg > bestAvg) { bestAvg = avg; bestHour = Number(h); }
    }
    const hourLabel = bestHour >= 0 ? `${bestHour}h` : "vos meilleurs créneaux";
    tips.push(`Excellent — maintenez vos créneaux ${hourLabel} pour ce niveau de performance`);
  }
  if (consistencyScore < 40) {
    tips.push("Adoptez des créneaux fixes (7h-9h et 17h-19h) pour stabiliser vos revenus");
  }
  if (tips.length === 0) {
    tips.push("Performances équilibrées — continuez à privilégier les zones à fort indice de rentabilité");
  }

  const record = {
    period, period_date: periodDate,
    total_rides: totalRides, profitable_rides: profitableRides, total_km: totalKm,
    total_net_eur: totalNet, avg_hourly_rate: avgHourlyRate,
    efficiency_score: efficiencyScore, positioning_score: positioningScore,
    profitability_score: profitabilityScore, consistency_score: consistencyScore,
    global_score: globalScore, ai_tips: JSON.stringify(tips),
    created_at: now.toISOString(),
  };

  sqlite.prepare(
    `INSERT INTO driver_performance
       (period, period_date, total_rides, profitable_rides, total_km, total_net_eur, avg_hourly_rate,
        efficiency_score, positioning_score, profitability_score, consistency_score, global_score, ai_tips, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    record.period, record.period_date, record.total_rides, record.profitable_rides, record.total_km,
    record.total_net_eur, record.avg_hourly_rate, record.efficiency_score, record.positioning_score,
    record.profitability_score, record.consistency_score, record.global_score, record.ai_tips, record.created_at
  );

  return record;
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

    // ← audit C2: transaction atomique DELETE+reseed — table jamais visible à vide
    const reseedTx = sqlite.transaction(() => {
      sqlite.exec("DELETE FROM profitability_scores");
      reseedScores(today, dayOfWeek);
    });
    reseedTx();

    const newCnt = (sqlite.prepare("SELECT COUNT(*) as c FROM profitability_scores").get() as any).c;
    console.log(`[storage] ${newCnt} scores calculés pour ${today}`);
    // Charger les overrides seeds dynamiques persistés (survie redémarrage)
    loadLiveSeedsFromDb();

    // ── Archive temps réel : mettre à jour score_history pour today à chaque reseed ──────────
    // Cela permet à /api/history?date=today de retourner des données fraîches sans attendre minuit.
    // ON CONFLICT REPLACE = écrase les lignes existantes pour (zone_id, hour, seed_date).
    // Schema : score_history a une contrainte UNIQUE sur (zone_id, hour, seed_date) via INSERT OR IGNORE —
    // on utilise un DELETE + INSERT pour forcer la mise à jour.
    try {
      sqlite.exec(`DELETE FROM score_history WHERE seed_date='${today}'`);
      sqlite.exec(`INSERT OR IGNORE INTO score_history (zone_id,hour,day_type,profitability_index,surge_multiplier,demand_score,supply_score,seed_date)
        SELECT zone_id,hour,day_type,profitability_index,surge_multiplier,demand_score,supply_score,'${today}' FROM profitability_scores`);
    } catch (e) {
      console.warn("[storage] Archive temps réel score_history échouée :", e);
    }

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

  // ── BUG #6 : historique synthétique 14 jours si manquant ──
  // score_history vide ou < 7 jours → génère J-1..J-13 avec variation déterministe
  // autour des scores actuels, en respectant le day_type de chaque date passée.
  const histDays = (sqlite.prepare("SELECT COUNT(DISTINCT seed_date) as cnt FROM score_history").get() as any).cnt;
  if (histDays < 7) {
    console.log(`[storage] Génération historique synthétique 14 jours...`);
    const insH = sqlite.prepare(
      `INSERT OR IGNORE INTO score_history (zone_id,hour,day_type,profitability_index,surge_multiplier,demand_score,supply_score,seed_date) VALUES (?,?,?,?,?,?,?,?)`
    );
    const currentScores = sqlite.prepare("SELECT * FROM profitability_scores").all() as any[];

    const histTx = sqlite.transaction(() => {
      for (let daysBack = 1; daysBack <= 13; daysBack++) {
        const pastDate = new Date(now.getTime() - daysBack * 86400000);
        const pastDateStr = pastDate.toISOString().split("T")[0];
        const pastDow = pastDate.getDay();
        const dateSeed = daysBack * 7.3 + pastDow * 1.9;

        for (const score of currentScores) {
          const noise = Math.sin(dateSeed + score.hour * 0.4) * 0.08; // ±8% déterministe
          const pastDt = [0, 6].includes(pastDow) ? "weekend" : "weekday";
          if (pastDt !== score.day_type) continue; // cohérence day_type
          const adjProfIdx = Math.min(95, Math.max(5, Math.round(score.profitability_index * (1 + noise) * 10) / 10));
          const adjSurge = Math.min(3.8, Math.max(1.0, Math.round(score.surge_multiplier * (1 + noise * 0.5) * 100) / 100));
          const adjDemand = Math.min(100, Math.max(5, Math.round(score.demand_score * (1 + noise) * 10) / 10));
          const adjSupply = Math.min(100, Math.max(5, Math.round(score.supply_score * (1 + noise * 0.3) * 10) / 10));
          insH.run(score.zone_id, score.hour, score.day_type, adjProfIdx, adjSurge, adjDemand, adjSupply, pastDateStr);
        }
      }
    });
    histTx();
    const newHistDays = (sqlite.prepare("SELECT COUNT(DISTINCT seed_date) as cnt FROM score_history").get() as any).cnt;
    console.log(`[storage] Historique généré : ${newHistDays} jours disponibles`);
  }

  // ── THÈME 2 : init maintenance véhicule ──
  seedMaintenance();

  // ── THÈME 1 : génération initiale des prédictions de demande ──
  try {
    generateDemandPredictions();
  } catch (err) {
    console.error("[storage] Erreur generateDemandPredictions (seed):", err);
  }
}

// ─── Seed des événements quotidiens ──────────────────────────────────────────

function seedEvents(today: string, now: Date) {
  sqlite.exec("DELETE FROM events");
  sqlite.exec("DELETE FROM alerts WHERE is_read=0");

  const insE = sqlite.prepare("INSERT INTO events (name,zone_id,event_type,start_time,end_time,expected_attendance,demand_boost,is_active) VALUES (?,?,?,?,?,?,?,1)");

  // Événements fixes de la semaine (mise à jour avec date du jour)
  // ── Événements réels vérifiés 11/06/2026 ────────────────────────────────
  // Concert David Guetta — Stade de France (portes 16h30, concert 21h)
  // Boost massif 14h-23h : restrictions circulation + 55 000 spectateurs
  insE.run("Concert David Guetta — Stade de France", "z_stade_france", "concert",
    `${today}T14:00:00`, `${today}T23:59:00`, 55000, 4.8);
  // Note : Paris Air Show N'EST PAS EN 2026 (biennal 2025/2027) — Le Bourget = aviation d'affaires seulement
  // Note : Eurosatory Villepinte commence le 15/06/2026 — PAS actif le 11/06
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
  const h = (now.getUTCHours()+2)%24;
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

  // 3. Supprimer toutes les alertes non lues avant régénération (garder les lues = historique)
  sqlite.prepare("DELETE FROM alerts WHERE is_read = 0").run();

  const insA = sqlite.prepare(
    "INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0)"
  );

  const alertsGenerated: string[] = [];

  // Helper pour insérer une alerte surge depuis un score (règle 1)
  const insertSurgeAlert = (score: any) => {
    if (alertsGenerated.includes(score.zone_id)) return;
    if (score.ratio_ds < 3.0) return;
    const ttlH = score.ratio_ds > 4.0 ? 2 : 4;
    const expires = new Date(now.getTime() + ttlH * 3600000).toISOString();
    const priority = score.ratio_ds > 4.5 ? "critical"
      : score.ratio_ds > 3.5 ? "high" : "medium";
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
  };

  // ── RÈGLE 2 : Événements actifs — EN PREMIER pour garantir leur visibilité ──
  // Le Bourget, Stade de France, Villepinte ont priorité sur surge générique
  for (const ev of activeEvents) {
    if (alertsGenerated.length >= 6) break; // max 6 events (laisser 2 pour aéroports)
    if (alertsGenerated.includes(ev.zone_id)) continue;
    if (ev.demand_boost < 1.5) continue;

    const zoneScore = currentScores.find((s: any) => s.zone_id === ev.zone_id);
    if (!zoneScore) continue;

    const minutesLeft = Math.round(
      (new Date(ev.end_time).getTime() - now.getTime()) / 60000
    );
    if (minutesLeft <= 0) continue;

    const ttlMs = Math.min(minutesLeft * 60000, 4 * 3600000);
    const expires = new Date(now.getTime() + ttlMs).toISOString();

    // ── Backtest P1b/P1c : concert_day_boost — si concert dans < 8h → boost +12 ─
    const hoursUntilEvent = (new Date(ev.start_time).getTime() - now.getTime()) / 3600000;
    const concertDayBoost = (ev.event_type === "concert" && hoursUntilEvent < 8 && hoursUntilEvent > -1)
      ? 12 : 0;
    const effectiveBoost = ev.demand_boost + concertDayBoost * 0.1;

    const priority = effectiveBoost >= 3.5 ? "critical"
      : effectiveBoost >= 2.5 ? "critical"
      : ev.demand_boost >= 3.0 ? "critical"
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

  // ── RÈGLE 1 : Surge critique — complète les slots restants jusqu'à 8 ────────
  // Zones avec forte densité trafic (ratio D/O > 3.0) non encore couvertes
  for (const score of currentScores) {
    if (alertsGenerated.length >= 8) break;
    insertSurgeAlert(score);
  }

  // ── RÈGLE 4 : Alerte sous-performance — zones 93 avec ratio < 0.8 ─────────
  // Avertir le chauffeur des zones à éviter (offre > demande = mauvais)
  // Exclure les zones qui ont déjà une alerte (événement ou aéroport)
  const eventZoneIds = new Set(activeEvents.map((e: any) => e.zone_id));
  const lowZones = currentScores.filter((s: any) =>
    s.ratio_ds < 0.8 && s.demand_score < 30 &&
    !eventZoneIds.has(s.zone_id) &&
    !alertsGenerated.includes(s.zone_id)
  ).slice(0, 2);
  if (lowZones.length > 0 && alertsGenerated.length < 8) {
    const names = lowZones.map((z: any) => z.zone_name).join(", ");
    const expires = new Date(now.getTime() + 1 * 3600000).toISOString();
    insA.run(
      "low_demand",
      `Zones à éviter — Offre > Demande`,
      `${names} : saturation chauffeurs. D/O < 0.8. Préférer CDG, Stade ou zones rush.`,
      lowZones[0].zone_id, "low", null, expires, now.toISOString()
    );
  }

  // ── RÈGLE 5 : Perturbation transports (grève, incidents) ─────────────────────
  // ← audit A2: DB-driven — détection grève via events actifs (event_type='greve')
  // Remplace la logique hardcodée dayOfWeekNow===4 (Jeudi 11/06 uniquement)
  // Désormais déclenché dynamiquement si un event grève est actif dans la DB
  const isGrevePeriod = h >= 6 && h <= 12;
  if (isGrevePeriod && alertsGenerated.length < 8) {
    const nowIso = now.toISOString();
    const activeGreve = (sqlite.prepare(
      `SELECT e.name, e.demand_boost, z.name AS zone_name, e.zone_id
       FROM events e
       LEFT JOIN zones z ON z.id = e.zone_id
       WHERE e.event_type = 'greve'
         AND e.start_time <= ? AND e.end_time >= ?
       LIMIT 1`
    ).get(nowIso, nowIso) as any);
    if (activeGreve) {
      const expires = new Date(now.getTime() + 2 * 3600000).toISOString();
      const alreadyHasGreve = (sqlite.prepare("SELECT 1 FROM alerts WHERE type='transport_disruption' AND is_read=0 LIMIT 1").get() as any);
      if (!alreadyHasGreve) {
        const boostLabel = activeGreve.demand_boost >= 2.0 ? 'forte perturbation' : 'perturbation modérée';
        insA.run(
          "transport_disruption",
          `⚠️ ${activeGreve.name} — Reports VTC élevés`,
          `Grève active : ${activeGreve.name} (${boostLabel}, boost ×${activeGreve.demand_boost.toFixed(1)}). ` +
          `Zone épicentre : ${activeGreve.zone_name}. Reports modaux vers VTC sur Saint-Denis, Bobigny, Aubervilliers, Montreuil. ` +
          "Zones chaudes : Saint-Denis Gare, Bobigny, Pantin.",
          activeGreve.zone_id, "high", 0, expires, nowIso
        );
      }
    }
  }

  // ── THÈME 7 : Alertes danger route + météo sévère ──────────────────────────
  // RÈGLE 6 : météo sévère — probabilité simulée 10% en horaires nocturnes
  const isNightHours = h < 6 || h > 22;
  if (isNightHours && Math.random() < 0.10) {
    const already = sqlite.prepare("SELECT 1 FROM alerts WHERE type='weather_hazard' AND is_read=0 LIMIT 1").get();
    if (!already) {
      const expires = new Date(now.getTime() + 3 * 3600000).toISOString();
      insA.run(
        "weather_hazard",
        "Conditions météo dégradées",
        "Pluie intense prévue ce soir — augmentez votre marge de sécurité et comptez +15min sur vos ETAs",
        null, "medium", null, expires, now.toISOString()
      );
    }
  }

  // RÈGLE 7 : segment accidentogène — rush AM/PM + nuit/pluie
  const isRushHour = (h >= 7 && h <= 9) || (h >= 17 && h <= 19);
  if (isRushHour && (isNightHours || Math.random() < 0.20)) {
    const already = sqlite.prepare("SELECT 1 FROM alerts WHERE type='road_hazard' AND is_read=0 LIMIT 1").get();
    if (!already) {
      const expires = new Date(now.getTime() + 2 * 3600000).toISOString();
      insA.run(
        "road_hazard",
        "Zone accidentogène — Vigilance A1/A86",
        "Segment A1 Porte de la Chapelle → St-Denis historiquement dangereux en rush+pluie. Restez vigilant.",
        "z_saint_denis_gare", "medium", null, expires, now.toISOString()
      );
    }
  }

  // RÈGLE 8 : temps mort excessif — aucune course depuis > 45min
  const lastRide = sqlite.prepare("SELECT timestamp FROM rides ORDER BY timestamp DESC LIMIT 1").get() as any;
  if (lastRide) {
    const minutesSinceLast = (now.getTime() - new Date(lastRide.timestamp).getTime()) / 60000;
    if (minutesSinceLast > 45) {
      const already = sqlite.prepare("SELECT 1 FROM alerts WHERE type='idle_too_long' AND is_read=0 LIMIT 1").get();
      if (!already) {
        // zone la plus rentable au moment du déclenchement
        const bestZone = currentScores.length > 0 ? currentScores[0] : null;
        const zoneId = bestZone?.zone_id ?? "z_cdg";
        const zoneName = bestZone?.zone_name ?? "CDG";
        const score = bestZone ? Math.round(bestZone.profitability_index) : 0;
        const expires = new Date(now.getTime() + 1 * 3600000).toISOString();
        insA.run(
          "idle_too_long",
          "Temps mort détecté — repositionnement conseillé",
          `Aucune course depuis ${Math.round(minutesSinceLast)}min. Score ${zoneName} actuel : ${score}. Opportunité à saisir.`,
          zoneId, "medium", null, expires, now.toISOString()
        );
      }
    }
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
    // ← audit C2: transaction atomique — aucune requête HTTP ne voit la table vide
    const t0 = Date.now();
    // ── Seeds dynamiques : recalibrer AVANT le reseed ──────────────────────
    // updateLivePatterns() compare hist réel vs prédit et met à jour livePat.
    // reseedScores() utilise ensuite computeScore → livePat (seeds fraîches).
    updateLivePatterns();

    const reseedTx3min = sqlite.transaction(() => {
      sqlite.exec("DELETE FROM profitability_scores");
      reseedScores(today, dayOfWeek);
    });
    reseedTx3min();
    const durationMs = Date.now() - t0;
    // Régénérer les alertes dynamiques après recalcul des scores
    generateDynamicAlerts();
    // ← F2: WAL checkpoint adaptatif
    // PASSIVE si WAL < seuil (pas de blocage lectures), TRUNCATE si WAL > 1000 pages (~ 4MB)
    // Objectif: prévenir le WAL file growth sans pénaliser la disponibilité
    const walInfo = sqlite.pragma('wal_checkpoint(PASSIVE)') as any[];
    const walPages = walInfo?.[0]?.log ?? 0;
    const walThreshold = 500; // pages (4KB/page = ~2MB) — checkpoint plus fréquent
    if (walPages > walThreshold) {
      // WAL trop gros: checkpoint TRUNCATE (rewrite + réinitialise le fichier WAL)
      // Peut bloquer 50-200ms si lectures actives — acceptable sur cycle 3min
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
      console.log(`[storage] WAL checkpoint TRUNCATE (${walPages} pages > seuil ${walThreshold})`);
    }
    // Méta refresh
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_refresh_ts',?)").run(now.toISOString());
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_refresh_duration_ms',?)").run(String(durationMs));
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_seed_date',?)").run(today);
    sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key,value) VALUES ('last_wal_pages',?)").run(String(walPages));
    if (durationMs > 500) console.warn(`[storage] Refresh lent: ${durationMs}ms`);
    console.log(`[storage] Auto-refresh 3min: scores recalculés à ${now.toLocaleTimeString('fr-FR')} (${durationMs}ms, WAL=${walPages}p)`);
  } catch (err) {
    console.error("[storage] Erreur auto-refresh:", err);
  }
}, REFRESH_INTERVAL_MS);

// ─── API Storage ──────────────────────────────────────────────────────────────

export interface IStorage {
  getAllZones(): any[];
  getCurrentScores(): any[];
  getProfitabilityByHour(hour: number, dayType: string): any[];
  getTopZones(hour: number, dayType: string, limit?: number): any[];
  getActiveEvents(): any[];
  getActiveAlerts(): any[];
  clearExpiredAlerts(): void;
  generateDynamicAlerts(): void;
  markAlertRead(id: number): void;
  createAlert(alert: any): any;
  createRide(ride: any): any;
  addRide(ride: any): any;
  getRideStats(): any;
  getRecentRides(limit?: number): any[];
  getDriverProfile(): any;
  updateDriverProfile(profile: any): any;
  getSeedMeta(): any;
  getScoreHistory(date?: string): any[];
  getDailyDiff(): any;
  forceReseed(): any;
  getLastRefreshTs(): string;
  getSeeds(): Record<string, Record<string, number>>;
  updateSeeds(seeds: Record<string, Record<string, number>>, meta?: {trigger?: string; mae_before?: number; mae_after?: number}): {zones_updated: number; zones: string[]};
  getLiveSeeds(): Record<string, any>;
  getLiveSeedsMeta(): typeof livePatMeta;
  generateDemandPredictions(): void;
  getPredictions(hoursAhead?: number, zoneId?: string): any;
  getMaintenance(): any[];
  markMaintenanceDone(component: string): any;
  updateMaintenanceKm(addedKm: number): void;
  getDriverPerformance(): any;
  computeDriverPerformance(period: "daily" | "weekly"): any;
  incrementProfileKm(addedKm: number): void;
  getPlatformCredentials(): any[];
  getPlatformCredential(platform: string): any;
  savePlatformCredential(platform: string, apiKey: string): void;
  updatePlatformStatus(platform: string, status: string, errorMsg?: string): void;
  upsertPredictHQEvents(events: PredictHQEventRow[]): void;
  getActivePredictHQEvents(zone_id?: string): PredictHQEventRow[];
  getPredictHQBoostForZone(zone_id: string, hour: number): number;
  clearOldPredictHQEvents(): void;
}

// Type structurel local (évite l'import circulaire avec predictHQService.ts)
export interface PredictHQEventRow {
  id: string;
  title: string;
  category: string;
  start: string;
  end: string;
  rank: number;
  local_rank: number;
  phq_attendance: number;
  transport_spend: number;
  lat: number;
  lng: number;
  zone_id: string;
  demand_boost: number;
  is_active: boolean;
  hours_until_start: number;
}

export const storage: IStorage = {
  getAllZones: () => stmtGetAllZones.all(),  // ← F1: prepared statement global

  getCurrentScores: () => {
    const now = new Date();
    const h = (now.getUTCHours()+2)%24;
    const dayType = [0,6].includes(now.getDay()) ? 'weekend' : 'weekday';
    return stmtGetCurrentScores.all(h, dayType);
  },

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

  getActiveEvents: () => stmtGetActiveEvents.all(),  // ← F1: prepared statement global

  getActiveAlerts: () => stmtGetActiveAlerts.all(new Date().toISOString()),  // ← F1: prepared statement global

  generateDynamicAlerts: () => generateDynamicAlerts(),

  markAlertRead: (id: number) => stmtMarkAlertRead.run(id),  // ← F1
  clearExpiredAlerts: () => stmtClearExpiredAlerts.run(new Date().toISOString()),  // ← F1

  createAlert: (alert) =>
    sqlite.prepare("INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0) RETURNING *")
      .get(alert.type, alert.title, alert.message, alert.zoneId || null, alert.priority, alert.estimatedRevenue || null, alert.expiresAt, alert.createdAt),

  createRide: (ride) =>
    sqlite.prepare("INSERT INTO rides (pickup_zone_id,dropoff_zone_id,distance_km,duration_min,fare,commission,fuel_cost,net_profit,hourly_rate,is_profitable,is_long_ride,timestamp,weather) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *")
      .get(ride.pickupZoneId, ride.dropoffZoneId, ride.distanceKm, ride.durationMin, ride.fare, ride.commission, ride.fuelCost, ride.netProfit, ride.hourlyRate, ride.isProfitable ? 1 : 0, ride.isLongRide ? 1 : 0, ride.timestamp, ride.weather || null),

  // addRide : accepte un objet aux clés snake_case (schéma table rides)
  addRide: (ride: any) =>
    sqlite.prepare("INSERT INTO rides (pickup_zone_id,dropoff_zone_id,distance_km,duration_min,fare,commission,fuel_cost,net_profit,hourly_rate,is_profitable,is_long_ride,timestamp,weather) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *")
      .get(
        ride.pickup_zone_id,
        ride.dropoff_zone_id,
        ride.distance_km,
        ride.duration_min,
        ride.fare,
        ride.commission,
        ride.fuel_cost,
        ride.net_profit,
        ride.hourly_rate,
        ride.is_profitable ? 1 : 0,
        ride.is_long_ride ? 1 : 0,
        ride.timestamp ?? new Date().toISOString(),
        ride.weather ?? null,
      ),

  getRideStats: () => {
    const stats = stmtGetRideStats.get() as any;  // ← F1: prepared statement global
    return { total: stats.total || 0, totalNetProfit: Math.round((stats.totalNet || 0) * 100) / 100, avgHourlyRate: Math.round((stats.avgRate || 0) * 100) / 100, avgDistance: Math.round((stats.avgDist || 0) * 10) / 10, profitableCount: stats.profitable || 0, longRideCount: stats.longRides || 0 };
  },

  getRecentRides: (limit = 10) => stmtGetRecentRides.all(limit),  // ← F1

  getDriverProfile: () => stmtGetDriverProfile.get(),  // ← F1

  updateDriverProfile: (profile) => {
    const existing = sqlite.prepare("SELECT * FROM driver_profile LIMIT 1").get() as any;
    // THÈME 4 : préférences personnalisées (colonnes ajoutées par migration)
    const preferredZones = profile.preferredZones !== undefined
      ? JSON.stringify(profile.preferredZones)
      : (existing?.preferred_zones ?? "[]");
    const workStart = profile.workHoursStart ?? existing?.work_hours_start ?? 6;
    const workEnd = profile.workHoursEnd ?? existing?.work_hours_end ?? 22;
    const avoidHighway = (profile.avoidHighway ?? Boolean(existing?.avoid_highway)) ? 1 : 0;
    const vehicleBrand = profile.vehicleBrand ?? existing?.vehicle_brand ?? "";
    const vehicleModel = profile.vehicleModel ?? existing?.vehicle_model ?? "";
    const vehicleYear = profile.vehicleYear ?? existing?.vehicle_year ?? 2020;
    if (existing) {
      sqlite.prepare(`UPDATE driver_profile SET
        fuel_consumption_per100km=?,fuel_price_per_liter=?,platform_commission_pct=?,hourly_target_income=?,wear_cost_per_km=?,vehicle_type=?,prefer_long_rides=?,
        preferred_zones=?,work_hours_start=?,work_hours_end=?,avoid_highway=?,vehicle_brand=?,vehicle_model=?,vehicle_year=?
        WHERE id=?`)
        .run(
          profile.fuelConsumptionPer100km ?? existing.fuel_consumption_per100km ?? 7.5,
          profile.fuelPricePerLiter ?? existing.fuel_price_per_liter ?? 1.92,
          profile.platformCommissionPct ?? existing.platform_commission_pct ?? 25,
          profile.hourlyTargetIncome ?? existing.hourly_target_income ?? 35,
          profile.wearCostPerKm ?? existing.wear_cost_per_km ?? 0.08,
          profile.vehicleType ?? existing.vehicle_type ?? "berline",
          (profile.preferLongRides ?? Boolean(existing.prefer_long_rides)) ? 1 : 0,
          preferredZones, workStart, workEnd, avoidHighway, vehicleBrand, vehicleModel, vehicleYear,
          existing.id
        );
    } else {
      sqlite.prepare(`INSERT INTO driver_profile
        (fuel_consumption_per100km,fuel_price_per_liter,platform_commission_pct,hourly_target_income,wear_cost_per_km,vehicle_type,prefer_long_rides,
         preferred_zones,work_hours_start,work_hours_end,avoid_highway,vehicle_brand,vehicle_model,vehicle_year)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          profile.fuelConsumptionPer100km ?? 7.5, profile.fuelPricePerLiter ?? 1.92, profile.platformCommissionPct ?? 25,
          profile.hourlyTargetIncome ?? 35, profile.wearCostPerKm ?? 0.08, profile.vehicleType ?? "berline",
          profile.preferLongRides ? 1 : 0,
          preferredZones, workStart, workEnd, avoidHighway, vehicleBrand, vehicleModel, vehicleYear
        );
    }
    return sqlite.prepare("SELECT * FROM driver_profile LIMIT 1").get();
  },

  incrementProfileKm: (addedKm: number) => {
    if (!addedKm || addedKm <= 0) return;
    const existing = sqlite.prepare("SELECT id, total_km_driven FROM driver_profile LIMIT 1").get() as any;
    if (!existing) return;
    const total = Math.round((existing.total_km_driven ?? 0) + addedKm);
    sqlite.prepare("UPDATE driver_profile SET total_km_driven=? WHERE id=?").run(total, existing.id);
  },

  getSeedMeta: () => {
    const rows = sqlite.prepare("SELECT key, value FROM seed_meta").all() as any[];
    const meta: Record<string, string> = {};
    rows.forEach((r: any) => { meta[r.key] = r.value; });
    return meta;
  },

  getScoreHistory: (date?: string) => {
    if (date) {
      const rows = sqlite.prepare("SELECT * FROM score_history WHERE seed_date=? ORDER BY zone_id, hour").all(date);
      if (rows.length > 0) return rows;
      // Fallback : si la date demandée est aujourd'hui, retourner les scores actuels (profitability_scores)
      // Ceux-ci ne sont archivés dans score_history qu'au reseed de minuit — mais ils sont valides aujourd'hui.
      const today = getTodayStr();
      if (date === today) {
        const live = sqlite.prepare(
          "SELECT zone_id, hour, day_type, profitability_index, surge_multiplier, demand_score, supply_score, ? as seed_date FROM profitability_scores ORDER BY zone_id, hour"
        ).all(today);
        return live;
      }
      return rows; // vide
    }
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

  // ── Seeds / Auto-retraining — lire et mettre à jour les overrides de seeds ──
  getSeeds: () => {
    const rows = sqlite
      .prepare("SELECT key, value FROM seed_meta WHERE key LIKE 'seed_override_%'")
      .all() as any[];
    const result: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      const zone = row.key.replace('seed_override_', '');
      try { result[zone] = JSON.parse(row.value); } catch { /* skip malformed */ }
    }
    return result;
  },

  updateSeeds: (seeds, meta = {}) => {
    const now = new Date().toISOString();
    const ins = sqlite.prepare("INSERT OR REPLACE INTO seed_meta (key, value) VALUES (?, ?)");
    const updated: string[] = [];
    // Lire overrides existants
    const existing: Record<string, Record<string, number>> = {};
    const rows = sqlite.prepare("SELECT key, value FROM seed_meta WHERE key LIKE 'seed_override_%'").all() as any[];
    for (const row of rows) {
      try { existing[row.key.replace('seed_override_', '')] = JSON.parse(row.value); } catch { /* skip */ }
    }
    for (const [zoneId, params] of Object.entries(seeds)) {
      if (typeof params !== 'object' || !params) continue;
      const merged = { ...(existing[zoneId] || {}), ...params };
      ins.run(`seed_override_${zoneId}`, JSON.stringify(merged));
      updated.push(zoneId);
    }
    // Métadonnées retrain
    ins.run('retrain_trigger', meta.trigger ?? 'manual');
    ins.run('retrain_mae_before', String(meta.mae_before ?? 0));
    ins.run('retrain_mae_after', String(meta.mae_after ?? 0));
    ins.run('retrain_ts', now);
    ins.run('retrain_zones_count', String(updated.length));
    console.log(`[storage] updateSeeds: ${updated.length} zones (trigger=${meta.trigger}, MAE ${meta.mae_before}→${meta.mae_after})`);
    return { zones_updated: updated.length, zones: updated };
  },

  getLiveSeeds: () => livePat,
  getLiveSeedsMeta: () => livePatMeta,
  generateDemandPredictions: () => generateDemandPredictions(),

  // THÈME 1 : prédictions des N prochaines heures, toutes zones (ou filtrées)
  getPredictions: (hoursAhead = 6, zoneId?: string) => {
    const now = new Date();
    const targetDateByHour: { date: string; hour: number }[] = [];
    for (let ahead = 1; ahead <= hoursAhead; ahead++) {
      const t = new Date(now.getTime() + ahead * 3600000);
      targetDateByHour.push({ date: t.toISOString().split("T")[0], hour: t.getHours() });
    }
    // Récupérer toutes les prédictions correspondant aux (date,hour) cibles
    const rows: any[] = [];
    for (const { date, hour } of targetDateByHour) {
      const q = zoneId
        ? sqlite.prepare("SELECT dp.*, z.name as zone_name FROM demand_predictions dp LEFT JOIN zones z ON z.id=dp.zone_id WHERE dp.target_date=? AND dp.target_hour=? AND dp.zone_id=?").all(date, hour, zoneId)
        : sqlite.prepare("SELECT dp.*, z.name as zone_name FROM demand_predictions dp LEFT JOIN zones z ON z.id=dp.zone_id WHERE dp.target_date=? AND dp.target_hour=?").all(date, hour);
      rows.push(...(q as any[]));
    }
    // Grouper par zone
    const byZone = new Map<string, any>();
    const order: string[] = [];
    for (const { date, hour } of targetDateByHour) {
      for (const r of rows.filter(x => x.target_date === date && x.target_hour === hour)) {
        if (!byZone.has(r.zone_id)) {
          byZone.set(r.zone_id, { zone_id: r.zone_id, zone_name: r.zone_name, hours: [] });
          order.push(r.zone_id);
        }
        let factors: any = {};
        try { factors = JSON.parse(r.factors); } catch { factors = {}; }
        byZone.get(r.zone_id).hours.push({
          hour: r.target_hour,
          predicted_index: r.predicted_index,
          confidence: r.confidence,
          factors,
        });
      }
    }
    return { predictions: order.map(z => byZone.get(z)) };
  },

  // THÈME 2
  getMaintenance: () => stmtGetMaintenance.all(),
  markMaintenanceDone: (component: string) => markMaintenanceDone(component),
  updateMaintenanceKm: (addedKm: number) => updateMaintenanceKm(addedKm),

  // THÈME 3
  getDriverPerformance: () => {
    const daily = computeDriverPerformance("daily");
    const weekly = computeDriverPerformance("weekly");
    const parse = (rec: any) => ({ ...rec, ai_tips: (() => { try { return JSON.parse(rec.ai_tips); } catch { return []; } })() });
    return { daily: parse(daily), weekly: parse(weekly) };
  },
  computeDriverPerformance: (period) => computeDriverPerformance(period),

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

  // ─── Platform credentials ───────────────────────────────────────────────────
  getPlatformCredentials(): any[] {
    return sqlite.prepare("SELECT * FROM platform_credentials").all();
  },
  getPlatformCredential(platform: string): any {
    return sqlite.prepare("SELECT * FROM platform_credentials WHERE platform=?").get(platform);
  },
  savePlatformCredential(platform: string, apiKey: string): void {
    sqlite.prepare("UPDATE platform_credentials SET api_key=?, status='unconfigured', error_msg='' WHERE platform=?").run(apiKey, platform);
  },
  updatePlatformStatus(platform: string, status: string, errorMsg: string = ''): void {
    sqlite.prepare("UPDATE platform_credentials SET status=?, last_tested=?, error_msg=? WHERE platform=?").run(status, Date.now(), errorMsg, platform);
  },

  // ─── PredictHQ events ───────────────────────────────────────────────────
  upsertPredictHQEvents(events: PredictHQEventRow[]): void {
    if (!Array.isArray(events) || events.length === 0) return;
    const now = new Date().toISOString();
    const stmt = sqlite.prepare(`
      INSERT INTO predicthq_events
        (id, title, category, zone_id, start_time, end_time, rank, local_rank,
         phq_attendance, transport_spend, demand_boost, lat, lng, fetched_at, is_active)
      VALUES
        (@id, @title, @category, @zone_id, @start_time, @end_time, @rank, @local_rank,
         @phq_attendance, @transport_spend, @demand_boost, @lat, @lng, @fetched_at, @is_active)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        category=excluded.category,
        zone_id=excluded.zone_id,
        start_time=excluded.start_time,
        end_time=excluded.end_time,
        rank=excluded.rank,
        local_rank=excluded.local_rank,
        phq_attendance=excluded.phq_attendance,
        transport_spend=excluded.transport_spend,
        demand_boost=excluded.demand_boost,
        lat=excluded.lat,
        lng=excluded.lng,
        fetched_at=excluded.fetched_at,
        is_active=excluded.is_active
    `);
    const tx = sqlite.transaction((rows: PredictHQEventRow[]) => {
      for (const e of rows) {
        stmt.run({
          id: e.id,
          title: e.title,
          category: e.category,
          zone_id: e.zone_id,
          start_time: e.start,
          end_time: e.end,
          rank: Math.round(e.rank ?? 0),
          local_rank: Math.round(e.local_rank ?? 0),
          phq_attendance: Math.round(e.phq_attendance ?? 0),
          transport_spend: e.transport_spend ?? 0,
          demand_boost: e.demand_boost ?? 1.0,
          lat: e.lat ?? null,
          lng: e.lng ?? null,
          fetched_at: now,
          is_active: e.is_active ? 1 : 0,
        });
      }
    });
    tx(events);
  },

  getActivePredictHQEvents(zone_id?: string): PredictHQEventRow[] {
    // Un event est considéré actif s'il n'est pas terminé (end_time >= maintenant).
    const nowIso = new Date().toISOString();
    const rows = zone_id
      ? sqlite.prepare(
          "SELECT * FROM predicthq_events WHERE zone_id=? AND end_time >= ? ORDER BY start_time ASC"
        ).all(zone_id, nowIso) as any[]
      : sqlite.prepare(
          "SELECT * FROM predicthq_events WHERE end_time >= ? ORDER BY start_time ASC"
        ).all(nowIso) as any[];
    const nowMs = Date.now();
    return rows.map((r) => {
      const startMs = new Date(r.start_time).getTime();
      const endMs = new Date(r.end_time).getTime();
      const isOngoing = startMs <= nowMs && endMs >= nowMs;
      const startsSoon = startMs > nowMs && startMs - nowMs <= 3 * 60 * 60 * 1000;
      return {
        id: r.id,
        title: r.title,
        category: r.category,
        zone_id: r.zone_id,
        start: r.start_time,
        end: r.end_time,
        rank: r.rank,
        local_rank: r.local_rank,
        phq_attendance: r.phq_attendance,
        transport_spend: r.transport_spend,
        demand_boost: r.demand_boost,
        lat: r.lat,
        lng: r.lng,
        is_active: isOngoing || startsSoon,
        hours_until_start: Math.round(((startMs - nowMs) / (60 * 60 * 1000)) * 10) / 10,
      } as PredictHQEventRow;
    });
  },

  getPredictHQBoostForZone(zone_id: string, hour: number): number {
    // Cherche les events de la zone qui couvrent l'heure demandée (aujourd'hui).
    // Retourne le boost maximal trouvé, ou 1.0 si aucun event.
    const rows = sqlite.prepare(
      "SELECT start_time, end_time, demand_boost FROM predicthq_events WHERE zone_id=?"
    ).all(zone_id) as any[];
    if (rows.length === 0) return 1.0;

    const ref = new Date();
    ref.setHours(hour, 0, 0, 0);
    const refStart = ref.getTime();
    const refEnd = refStart + 60 * 60 * 1000; // fenêtre d'une heure

    let maxBoost = 1.0;
    for (const r of rows) {
      const s = new Date(r.start_time).getTime();
      const e = new Date(r.end_time).getTime();
      // chevauchement entre [s,e] et [refStart,refEnd]
      if (s < refEnd && e > refStart) {
        const b = Number(r.demand_boost) || 1.0;
        if (b > maxBoost) maxBoost = b;
      }
    }
    // Plafond métier absolu
    return Math.min(2.5, maxBoost);
  },

  clearOldPredictHQEvents(): void {
    // Supprime les events terminés depuis plus de 2 heures.
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sqlite.prepare("DELETE FROM predicthq_events WHERE end_time < ?").run(cutoff);
  },
};
