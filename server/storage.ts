import Database from "better-sqlite3";
import { Zone, ProfitabilityScore, Event, Ride, Alert, DriverProfile, InsertAlert, InsertRide, InsertDriverProfile } from "@shared/schema";

const sqlite = new Database("data.db");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS zones (id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, type TEXT NOT NULL, city TEXT NOT NULL DEFAULT 'Seine-Saint-Denis');
  CREATE TABLE IF NOT EXISTS profitability_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, zone_id TEXT NOT NULL, hour INTEGER NOT NULL, day_type TEXT NOT NULL, demand_score REAL NOT NULL, supply_score REAL NOT NULL, ratio_ds REAL NOT NULL, avg_distance_km REAL NOT NULL, avg_duration_min REAL NOT NULL, avg_fare REAL NOT NULL, profitability_index REAL NOT NULL, long_ride_probability REAL NOT NULL, surge_multiplier REAL NOT NULL DEFAULT 1.0);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, zone_id TEXT NOT NULL, event_type TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, expected_attendance INTEGER, demand_boost REAL NOT NULL DEFAULT 1.0, is_active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS rides (id INTEGER PRIMARY KEY AUTOINCREMENT, pickup_zone_id TEXT NOT NULL, dropoff_zone_id TEXT NOT NULL, distance_km REAL NOT NULL, duration_min REAL NOT NULL, fare REAL NOT NULL, commission REAL NOT NULL, fuel_cost REAL NOT NULL, net_profit REAL NOT NULL, hourly_rate REAL NOT NULL, is_profitable INTEGER NOT NULL, is_long_ride INTEGER NOT NULL, timestamp TEXT NOT NULL, weather TEXT);
  CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, zone_id TEXT, priority TEXT NOT NULL, estimated_revenue REAL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS driver_profile (id INTEGER PRIMARY KEY AUTOINCREMENT, fuel_consumption_per100km REAL NOT NULL DEFAULT 7.0, fuel_price_per_liter REAL NOT NULL DEFAULT 1.85, platform_commission_pct REAL NOT NULL DEFAULT 25.0, hourly_target_income REAL NOT NULL DEFAULT 35.0, wear_cost_per_km REAL NOT NULL DEFAULT 0.08, min_profitable_km_per_min REAL NOT NULL DEFAULT 1.0, vehicle_type TEXT NOT NULL DEFAULT 'berline', prefer_long_rides INTEGER NOT NULL DEFAULT 1);
`);

function seedData() {
  const cnt = (sqlite.prepare("SELECT COUNT(*) as c FROM zones").get() as any).c;
  if (cnt > 0) return;

  // Zones Seine-Saint-Denis (93) + Aéroports CDG et Orly
  const zones93 = [
    // --- AÉROPORTS (priorité maximale) ---
    { id: "z_cdg",          name: "CDG — Roissy-en-France",     lat: 49.0097,  lng: 2.5479,  type: "airport" },
    { id: "z_orly",         name: "Orly — Terminal Sud/Ouest",  lat: 48.7262,  lng: 2.3652,  type: "airport" },
    // --- GARES & TRANSPORTS 93 ---
    { id: "z_saint_denis_gare", name: "Gare Saint-Denis",       lat: 48.9362,  lng: 2.3573,  type: "transport" },
    { id: "z_bobigny_gare",    name: "Bobigny Pablo Picasso",   lat: 48.9059,  lng: 2.4470,  type: "transport" },
    { id: "z_aubervilliers",   name: "Aubervilliers — Pantin",  lat: 48.9144,  lng: 2.3895,  type: "transport" },
    { id: "z_epinay_gennevilliers", name: "Épinay / Gennevilliers", lat: 48.9527, lng: 2.3090, type: "transport" },
    // --- HUBS ÉCONOMIQUES & BUSINESS ---
    { id: "z_plaine_commune",  name: "Plaine Commune — Affaires", lat: 48.9209, lng: 2.3716, type: "business" },
    { id: "z_le_bourget",      name: "Le Bourget — Parc Expo",  lat: 48.9437,  lng: 2.4254,  type: "business" },
    { id: "z_villepinte",      name: "Villepinte — Paris Nord", lat: 48.9744,  lng: 2.5330,  type: "business" },
    { id: "z_tremblay",        name: "Tremblay-en-France",      lat: 48.9579,  lng: 2.5572,  type: "business" },
    // --- STADES & DIVERTISSEMENT ---
    { id: "z_stade_france",    name: "Stade de France",         lat: 48.9245,  lng: 2.3596,  type: "entertainment" },
    { id: "z_93_centre",       name: "Saint-Denis — Centre",    lat: 48.9356,  lng: 2.3535,  type: "entertainment" },
    // --- RÉSIDENTIEL DENSE ---
    { id: "z_montreuil",       name: "Montreuil",               lat: 48.8637,  lng: 2.4482,  type: "residential" },
    { id: "z_aulnay",          name: "Aulnay-sous-Bois",        lat: 48.9383,  lng: 2.4951,  type: "residential" },
  ];

  const insZ = sqlite.prepare("INSERT OR IGNORE INTO zones (id,name,lat,lng,type,city) VALUES (?,?,?,?,?,'Seine-Saint-Denis')");
  for (const z of zones93) insZ.run(z.id, z.name, z.lat, z.lng, z.type);

  // Patterns horaires par zone — calibrés pour le 93 et les aéroports parisiens
  // CDG : courses longues (30–55km), tarifs élevés, demande 24h/7
  // Stade de France : pics événementiels intenses (+80k spectateurs)
  // Villepinte / Le Bourget : salons professionnels, flux business
  // Gares : heures pointe RER B/D, correspondances
  const patterns: Record<string, { peakHours: number[], baseAvgDist: number, baseLongRide: number }> = {
    z_cdg:               { peakHours: [4,5,6,7,8,9,10,11,18,19,20,21,22,23], baseAvgDist: 38, baseLongRide: 0.92 },
    z_orly:              { peakHours: [5,6,7,8,9,10,16,17,18,19,20,21],      baseAvgDist: 24, baseLongRide: 0.80 },
    z_saint_denis_gare:  { peakHours: [6,7,8,9,17,18,19,20],                 baseAvgDist: 15, baseLongRide: 0.38 },
    z_bobigny_gare:      { peakHours: [7,8,9,17,18,19],                      baseAvgDist: 12, baseLongRide: 0.30 },
    z_aubervilliers:     { peakHours: [7,8,9,17,18,19,22,23],                baseAvgDist: 14, baseLongRide: 0.35 },
    z_epinay_gennevilliers: { peakHours: [6,7,8,17,18,19],                   baseAvgDist: 18, baseLongRide: 0.42 },
    z_plaine_commune:    { peakHours: [7,8,9,12,17,18,19],                   baseAvgDist: 16, baseLongRide: 0.45 },
    z_le_bourget:        { peakHours: [7,8,9,10,17,18,19,20],                baseAvgDist: 22, baseLongRide: 0.55 },
    z_villepinte:        { peakHours: [8,9,10,11,17,18,19,20],               baseAvgDist: 28, baseLongRide: 0.65 },
    z_tremblay:          { peakHours: [6,7,8,17,18,19],                      baseAvgDist: 32, baseLongRide: 0.70 },
    z_stade_france:      { peakHours: [18,19,20,21,22,23],                   baseAvgDist: 14, baseLongRide: 0.32 },
    z_93_centre:         { peakHours: [8,9,12,13,17,18,20,21,22],            baseAvgDist: 13, baseLongRide: 0.28 },
    z_montreuil:         { peakHours: [7,8,9,17,18,19],                      baseAvgDist: 11, baseLongRide: 0.25 },
    z_aulnay:            { peakHours: [6,7,8,17,18,22,23],                   baseAvgDist: 20, baseLongRide: 0.48 },
  };

  const insS = sqlite.prepare(`INSERT INTO profitability_scores (zone_id,hour,day_type,demand_score,supply_score,ratio_ds,avg_distance_km,avg_duration_min,avg_fare,profitability_index,long_ride_probability,surge_multiplier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (const zone of zones93) {
    const pat = patterns[zone.id] || { peakHours: [8,12,18], baseAvgDist: 15, baseLongRide: 0.30 };
    for (const dt of ['weekday','weekend']) {
      for (let h = 0; h < 24; h++) {
        const isPeak = pat.peakHours.includes(h);
        const isNight = h >= 0 && h < 5;
        const isWeekendNight = dt === 'weekend' && (h >= 22 || h <= 3);

        // Demande : aéroports actifs 24h, stades en soirée événementielle
        let demandBase = isPeak ? 80 : (isNight ? 35 : 48);
        if (zone.type === 'airport') demandBase = isPeak ? 85 : (isNight ? 55 : 60); // 24h
        if (zone.id === 'z_stade_france' && !isPeak) demandBase = 25; // creux hors événement
        if (isWeekendNight) demandBase += 20;
        const demand = Math.min(100, demandBase + (Math.random() * 14 - 7));

        // Offre : plus faible en nuit profonde, saturée aux heures de pointe gares
        let supplyBase = isPeak ? 60 : (isNight ? 18 : 48);
        if (zone.type === 'airport') supplyBase = isPeak ? 50 : 35;
        if (zone.id === 'z_stade_france' && !isPeak) supplyBase = 60; // beaucoup de VTC à l'affût
        const supply = Math.max(5, Math.min(100, supplyBase + (Math.random() * 18 - 9)));

        const ratio = demand / Math.max(supply, 1);

        // Distances et tarifs : CDG = long, Orly = moyen-long
        const distMultiplier = isPeak ? 1.12 : 0.92;
        const avgDist = pat.baseAvgDist * distMultiplier + Math.random() * 4;
        // Temps de trajet : trafic IDF plus chargé (+20% vs province)
        const speed = isPeak ? 0.6 : (isNight ? 1.1 : 0.85); // km/min
        const avgDur = avgDist / speed;
        // Tarif IDF : base 1.2€/km + prise en charge 2.50€ (vs 2€ à Lyon)
        const avgFare = avgDist * 1.25 + 2.5;
        const surge = ratio > 2.2 ? 1.6 : ratio > 1.6 ? 1.3 : ratio > 1.2 ? 1.1 : 1.0;
        const longRide = Math.min(0.98, pat.baseLongRide * (zone.type === 'airport' ? 1.2 : 1.0));

        // Calcul rentabilité nette
        const commission = avgFare * 0.25;
        const fuel = (avgDist / 100) * 7 * 1.85;
        const wear = avgDist * 0.08;
        const net = avgFare - commission - fuel - wear;
        const hRate = (net / Math.max(avgDur, 1)) * 60;

        // Index de rentabilité
        const profIdx = Math.min(100, Math.max(0,
          (ratio * 18) +
          (longRide * 28) +
          (Math.min(hRate, 70) / 70 * 32) +
          (surge > 1.3 ? 22 : surge > 1.1 ? 10 : 0)
        ));

        insS.run(
          zone.id, h, dt,
          Math.round(demand * 10) / 10,
          Math.round(supply * 10) / 10,
          Math.round(ratio * 100) / 100,
          Math.round(avgDist * 10) / 10,
          Math.round(avgDur * 10) / 10,
          Math.round(avgFare * 100) / 100,
          Math.round(profIdx * 10) / 10,
          Math.round(longRide * 100) / 100,
          surge
        );
      }
    }
  }

  // Événements Seine-Saint-Denis
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const insE = sqlite.prepare("INSERT INTO events (name,zone_id,event_type,start_time,end_time,expected_attendance,demand_boost,is_active) VALUES (?,?,?,?,?,?,?,1)");
  insE.run("Match Équipe de France — Stade de France", "z_stade_france", "match", `${today}T20:45:00`, `${today}T23:30:00`, 80000, 4.2);
  insE.run("Paris Air Show — Le Bourget", "z_le_bourget", "conference", `${today}T09:00:00`, `${today}T19:00:00`, 12000, 2.4);
  insE.run("Salon Paris Nord Villepinte", "z_villepinte", "conference", `${today}T09:00:00`, `${today}T18:00:00`, 8000, 2.0);
  insE.run("Pic arrivées CDG — Vols internationaux", "z_cdg", "transport", `${today}T06:00:00`, `${today}T11:00:00`, 5000, 1.8);
  insE.run("Pic arrivées Orly — Vols domestiques", "z_orly", "transport", `${today}T07:00:00`, `${today}T10:00:00`, 3500, 1.6);

  // Profil chauffeur par défaut — adapté IDF (objectif 35€/h)
  sqlite.prepare("INSERT OR IGNORE INTO driver_profile (fuel_consumption_per100km,fuel_price_per_liter,platform_commission_pct,hourly_target_income,wear_cost_per_km,min_profitable_km_per_min,vehicle_type,prefer_long_rides) VALUES (7.5,1.92,25.0,35.0,0.08,1.0,'berline',1)").run();

  // Alertes temps réel — contexte 93 et aéroports
  const insA = sqlite.prepare("INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0)");
  const e1 = new Date(now.getTime() + 8 * 3600000).toISOString();
  const e2 = new Date(now.getTime() + 10 * 3600000).toISOString();
  const e3 = new Date(now.getTime() + 6 * 3600000).toISOString();
  const e4 = new Date(now.getTime() + 5 * 3600000).toISOString();
  insA.run("event_ending", "Stade de France — Sortie dans 45 min", "80 000 spectateurs. Positionnez-vous rue Jules Rimet ou Parking P4. Surge x4.2 actif.", "z_stade_france", "critical", 65, e1, now.toISOString());
  insA.run("long_ride_opportunity", "CDG — Flux arrivées massif", "Ratio D/O : 3.6x. Courses moyennes 38km vers Paris, La Défense, 93. Tarifs 45–70€.", "z_cdg", "critical", 58, e2, now.toISOString());
  insA.run("demand_spike", "Villepinte — Salon en cours", "Paris Nord Expo : 8 000 visiteurs. Courses PRO longues vers Paris/La Défense. Surge x2.0.", "z_villepinte", "high", 40, e3, now.toISOString());
  insA.run("long_ride_opportunity", "Orly — Créneaux arrivées", "Terminal Ouest & Sud actifs. Courses 20–35km. Priorité passagers Paris Rive Gauche.", "z_orly", "high", 38, e4, now.toISOString());
}

seedData();

export interface IStorage {
  getAllZones(): any[];
  getProfitabilityByHour(hour: number, dayType: string): any[];
  getTopZones(hour: number, dayType: string, limit?: number): any[];
  getActiveEvents(): any[];
  createRide(ride: InsertRide): any;
  getRecentRides(limit?: number): any[];
  getRideStats(): any;
  getActiveAlerts(): any[];
  createAlert(alert: InsertAlert): any;
  markAlertRead(id: number): void;
  clearExpiredAlerts(): void;
  getDriverProfile(): any;
  upsertDriverProfile(profile: InsertDriverProfile): any;
}

export const storage: IStorage = {
  getAllZones: () => sqlite.prepare("SELECT * FROM zones").all(),
  getProfitabilityByHour: (hour, dayType) => sqlite.prepare("SELECT * FROM profitability_scores WHERE hour=? AND day_type=? ORDER BY profitability_index DESC").all(hour, dayType),
  getTopZones: (hour, dayType, limit = 5) => sqlite.prepare("SELECT * FROM profitability_scores WHERE hour=? AND day_type=? ORDER BY profitability_index DESC LIMIT ?").all(hour, dayType, limit),
  getActiveEvents: () => sqlite.prepare("SELECT * FROM events WHERE is_active=1 AND end_time>? ORDER BY start_time ASC").all(new Date().toISOString()),
  createRide: (ride) => sqlite.prepare("INSERT INTO rides (pickup_zone_id,dropoff_zone_id,distance_km,duration_min,fare,commission,fuel_cost,net_profit,hourly_rate,is_profitable,is_long_ride,timestamp,weather) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *").get(ride.pickupZoneId, ride.dropoffZoneId, ride.distanceKm, ride.durationMin, ride.fare, ride.commission, ride.fuelCost, ride.netProfit, ride.hourlyRate, ride.isProfitable ? 1 : 0, ride.isLongRide ? 1 : 0, ride.timestamp, ride.weather || null),
  getRecentRides: (limit = 20) => sqlite.prepare("SELECT * FROM rides ORDER BY timestamp DESC LIMIT ?").all(limit),
  getRideStats: () => { const s = sqlite.prepare("SELECT COUNT(*) as total, AVG(hourly_rate) as avgH, AVG(CASE WHEN is_profitable=1 THEN 1.0 ELSE 0.0 END) as profR, AVG(distance_km) as avgD FROM rides").get() as any; return { totalRides: s.total || 0, avgHourlyRate: Math.round((s.avgH || 0) * 100) / 100, profitableRatio: Math.round((s.profR || 0) * 1000) / 10, avgDistance: Math.round((s.avgD || 0) * 10) / 10 }; },
  getActiveAlerts: () => sqlite.prepare("SELECT * FROM alerts WHERE expires_at>? ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC").all(new Date().toISOString()),
  createAlert: (alert) => sqlite.prepare("INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0) RETURNING *").get(alert.type, alert.title, alert.message, alert.zoneId || null, alert.priority, alert.estimatedRevenue || null, alert.expiresAt, alert.createdAt),
  markAlertRead: (id) => { sqlite.prepare("UPDATE alerts SET is_read=1 WHERE id=?").run(id); },
  clearExpiredAlerts: () => { sqlite.prepare("DELETE FROM alerts WHERE expires_at<?").run(new Date().toISOString()); },
  getDriverProfile: () => sqlite.prepare("SELECT * FROM driver_profile LIMIT 1").get(),
  upsertDriverProfile: (profile) => {
    const ex = sqlite.prepare("SELECT id FROM driver_profile LIMIT 1").get() as any;
    if (ex) sqlite.prepare("UPDATE driver_profile SET fuel_consumption_per100km=?,fuel_price_per_liter=?,platform_commission_pct=?,hourly_target_income=?,wear_cost_per_km=?,min_profitable_km_per_min=?,vehicle_type=?,prefer_long_rides=? WHERE id=?").run(profile.fuelConsumptionPer100km, profile.fuelPricePerLiter, profile.platformCommissionPct, profile.hourlyTargetIncome, profile.wearCostPerKm, profile.minProfitableKmPerMin, profile.vehicleType, profile.preferLongRides ? 1 : 0, ex.id);
    else sqlite.prepare("INSERT INTO driver_profile (fuel_consumption_per100km,fuel_price_per_liter,platform_commission_pct,hourly_target_income,wear_cost_per_km,min_profitable_km_per_min,vehicle_type,prefer_long_rides) VALUES (?,?,?,?,?,?,?,?)").run(profile.fuelConsumptionPer100km, profile.fuelPricePerLiter, profile.platformCommissionPct, profile.hourlyTargetIncome, profile.wearCostPerKm, profile.minProfitableKmPerMin, profile.vehicleType, profile.preferLongRides ? 1 : 0);
    return sqlite.prepare("SELECT * FROM driver_profile LIMIT 1").get();
  },
};
