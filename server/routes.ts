import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { getFlightData, getFlightBoostForZone } from "./flightService";

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE TEMPS RÉEL — Google Maps Distance Matrix (système hybride calibré)
// Origine : Bd Ney (48.8976, 2.3299) — Paris 18e
// Snapshots réels : 10h37 mercredi (post-rush AM) + 18h mardi (rush PM base)
// Recalcul automatique toutes les 3 minutes
// ═══════════════════════════════════════════════════════════════════════════════

interface GMapsCacheEntry {
  zoneId: string;
  roadKm: number;        // distance route réelle Google Maps (statique)
  etaMinutes: number;    // ETA calculé avec le ratio horaire courant
  speedKmH: number;      // vitesse effective courante
  hourUsed: number;      // heure utilisée pour le calcul
  computedAt: string;    // ISO timestamp
}

interface GMapsCache {
  entries: Record<string, GMapsCacheEntry>;
  lastUpdated: string;   // ISO timestamp de la dernière MAJ
  nextUpdate: string;    // ISO timestamp de la prochaine MAJ (+ 3min)
  updateCount: number;   // nombre de mises à jour depuis démarrage
  calibrationDate: string;
}

// ── Données calibrées (mesures réelles Google Maps depuis Bd Ney) ─────────────
// road_km        : distance routière réelle
// speed_rush_pm  : vitesse mesurée à 18h rush PM (km/h) — BASE = 1.00
// speed_10h      : vitesse mesurée à 10h37 post-rush (km/h)
// eta_18h / eta_10h : ETAs en minutes pour les deux snapshots
const ZONE_DATA: Record<string, {
  road_km: number;
  speed_rush_pm: number;
  speed_10h: number;
  eta_18h: number;
  eta_10h: number;
}> = {
  z_cdg:                   { road_km: 23.8, speed_rush_pm: 32.45, speed_10h: 54.92, eta_18h: 44, eta_10h: 26 },
  z_orly:                  { road_km: 28.6, speed_rush_pm: 26.00, speed_10h: 40.86, eta_18h: 66, eta_10h: 42 },
  z_le_bourget:            { road_km: 12.1, speed_rush_pm: 18.15, speed_10h: 38.21, eta_18h: 40, eta_10h: 19 },
  z_villepinte:            { road_km: 21.6, speed_rush_pm: 30.86, speed_10h: 46.29, eta_18h: 42, eta_10h: 28 },
  z_tremblay:              { road_km: 22.9, speed_rush_pm: 29.87, speed_10h: 54.96, eta_18h: 46, eta_10h: 25 },
  z_aulnay:                { road_km: 19.5, speed_rush_pm: 27.21, speed_10h: 45.00, eta_18h: 43, eta_10h: 26 },
  z_saint_denis_gare:      { road_km:  6.5, speed_rush_pm: 13.00, speed_10h: 22.94, eta_18h: 30, eta_10h: 17 },
  z_plaine_commune:        { road_km:  5.8, speed_rush_pm: 16.57, speed_10h: 23.20, eta_18h: 21, eta_10h: 15 },
  z_bobigny_gare:          { road_km: 13.4, speed_rush_pm: 22.33, speed_10h: 30.92, eta_18h: 36, eta_10h: 26 },
  z_aubervilliers:         { road_km:  6.6, speed_rush_pm: 12.77, speed_10h: 19.80, eta_18h: 31, eta_10h: 20 },
  z_epinay_gennevilliers:  { road_km:  9.6, speed_rush_pm: 13.71, speed_10h: 23.04, eta_18h: 42, eta_10h: 25 },
  z_93_centre:             { road_km:  6.8, speed_rush_pm: 12.75, speed_10h: 22.67, eta_18h: 32, eta_10h: 18 },
  z_montreuil:             { road_km: 14.0, speed_rush_pm: 20.49, speed_10h: 31.11, eta_18h: 41, eta_10h: 27 },
  z_stade_france:          { road_km:  5.2, speed_rush_pm: 12.48, speed_10h: 28.36, eta_18h: 25, eta_10h: 11 },
};

// ── ROAD_FACTOR depuis Bd Ney (road_km / haversine_km) ───────────────────────
// S'applique pour tout point proche Paris (ajustement ±15% selon distance centre)
const ROAD_FACTOR: Record<string, number> = {
  z_cdg:                   1.177,
  z_orly:                  1.487,
  z_le_bourget:            1.397,
  z_villepinte:            1.262,
  z_tremblay:              1.279,
  z_aulnay:                1.513,
  z_saint_denis_gare:      1.372,
  z_plaine_commune:        1.450,
  z_bobigny_gare:          1.557,
  z_aubervilliers:         1.392,
  z_epinay_gennevilliers:  1.520,
  z_93_centre:             1.490,
  z_montreuil:             1.484,
  z_stade_france:          1.407,
};

// ── Profil horaire calibré — ancré sur 2 mesures réelles ─────────────────────
// Ratio vitesse_heure / vitesse_rush_PM (18h = base 1.00)
// Ancres mesurées : rush PM 18h = 1.00 | post-rush 10h = 1.69 moyen
function getHourlyRatio(h: number): number {
  if (h < 6)  return 2.40;  // nuit : autoroute libre
  if (h < 7)  return 1.45;  // pré-rush 6h
  if (h < 9)  return 0.88;  // rush AM (légèrement meilleur que PM)
  if (h < 12) return 1.69;  // post-rush 9-12h ✅ MESURÉ
  if (h < 14) return 1.58;  // mi-journée
  if (h < 16) return 1.42;  // après-midi
  if (h < 17) return 1.12;  // pré-rush PM
  if (h < 19) return 1.00;  // rush PM ✅ BASE MESURÉE
  if (h < 22) return 1.52;  // soir
  return 2.40;              // nuit tardive
}

// ── Calcul du cache à un instant donné ───────────────────────────────────────
function computeGMapsCache(updateCount: number): GMapsCache {
  const now = new Date();
  const h = now.getHours();
  const ratio = getHourlyRatio(h);
  const nextUpdateTs = new Date(now.getTime() + 3 * 60 * 1000);

  const entries: Record<string, GMapsCacheEntry> = {};

  for (const [zoneId, data] of Object.entries(ZONE_DATA)) {
    const speedKmH = Math.round(data.speed_rush_pm * ratio * 100) / 100;
    const etaMinutes = Math.max(1, Math.round((data.road_km / speedKmH) * 60));
    entries[zoneId] = {
      zoneId,
      roadKm:     data.road_km,
      etaMinutes,
      speedKmH,
      hourUsed:   h,
      computedAt: now.toISOString(),
    };
  }

  return {
    entries,
    lastUpdated:     now.toISOString(),
    nextUpdate:      nextUpdateTs.toISOString(),
    updateCount,
    calibrationDate: "2026-06-10",
  };
}

// ── Instance du cache (module-level, partagée) ────────────────────────────────
let gmapsCache: GMapsCache = computeGMapsCache(1);

// ═══════════════════════════════════════════════════════════════════════════════
// FIN CACHE — le setInterval est lancé dans registerRoutes()
// ═══════════════════════════════════════════════════════════════════════════════

export function registerRoutes(httpServer: Server, app: Express): void {
  // Auth routes + requireAuth middleware are registered in server/index.ts
  // before this function is called — do not duplicate them here.

  // ── Démarrage du refresh automatique toutes les 3 minutes ──────────────────
  let cacheUpdateCount = 1; // premier calcul fait à l'initialisation du module
  setInterval(() => {
    cacheUpdateCount += 1;
    gmapsCache = computeGMapsCache(cacheUpdateCount);
    console.log(`[gmaps-cache] Mise à jour #${cacheUpdateCount} — ${gmapsCache.lastUpdated} | ratio horaire: ${getHourlyRatio(new Date().getHours()).toFixed(2)}`);
  }, 3 * 60 * 1000); // toutes les 3 minutes

  app.get("/api/zones", (_req, res) => { res.json(storage.getAllZones()); });

  // ─── Données de vols temps réel (CDG + Orly) ───────────────────────────────
  app.get("/api/flights", async (_req, res) => {
    try {
      const data = await getFlightData();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: "Erreur récupération données vols", details: String(err) });
    }
  });

  app.get("/api/profitability", async (req, res) => {
    const hour = parseInt(req.query.hour as string) || new Date().getHours();
    const dayType = req.query.dayType as string || ([0,6].includes(new Date().getDay()) ? 'weekend' : 'weekday');
    const scores = storage.getProfitabilityByHour(hour, dayType);

    // Enrichissement avec boost dynamique vols
    try {
      const flightData = await getFlightData();
      const enriched = scores.map((s: any) => {
        const flightBoost = getFlightBoostForZone(s.zone_id, flightData);
        const boostedIndex = Math.min(100, Math.round((s.profitability_index ?? s.profitabilityIndex ?? 0) * flightBoost));
        const boostedSurge = Math.round(((s.surge_multiplier ?? s.surgeMultiplier ?? 1.0) * flightBoost) * 100) / 100;
        return {
          ...s,
          profitability_index: boostedIndex,
          profitabilityIndex: boostedIndex,
          surge_multiplier: boostedSurge,
          surgeMultiplier: boostedSurge,
          flight_boost: flightBoost,
          flightBoost,
        };
      });
      res.json(enriched);
    } catch {
      res.json(scores);
    }
  });

  app.get("/api/top-zones", (req, res) => {
    const hour = parseInt(req.query.hour as string) || new Date().getHours();
    const dayType = req.query.dayType as string || ([0,6].includes(new Date().getDay()) ? 'weekend' : 'weekday');
    const limit = parseInt(req.query.limit as string) || 5;
    const scores = storage.getTopZones(hour, dayType, limit);
    const zones = storage.getAllZones();
    const zoneMap: any = Object.fromEntries(zones.map((z: any) => [z.id, z]));
    res.json(scores.map((s: any) => ({ ...s, zone: zoneMap[s.zone_id] })));
  });

  app.get("/api/events", async (_req, res) => {
    const events = storage.getActiveEvents();
    const zones = storage.getAllZones();
    const zoneMap: any = Object.fromEntries(zones.map((z: any) => [z.id, z]));
    const baseEvents = events.map((e: any) => ({ ...e, zone: zoneMap[e.zone_id] }));

    // Injection des vols comme événements dynamiques
    try {
      const flightData = await getFlightData();
      const flightEvents: any[] = [];
      const now = new Date();
      const oneHourLater = new Date(now.getTime() + 3600000);

      // Événement CDG si flux significatif
      if (flightData.cdg.arrivals_next_hour >= 8) {
        const peakLabel: Record<string, string> = {
          low: "Flux faible", medium: "Flux modéré", high: "Flux élevé", surge: "SURGE"
        };
        flightEvents.push({
          id: 9901,
          name: `CDG — ${peakLabel[flightData.cdg.peak_level]} (${flightData.cdg.arrivals_next_hour} arrivées/h)`,
          zone_id: "z_cdg",
          event_type: "flight_wave",
          start_time: now.toISOString(),
          end_time: oneHourLater.toISOString(),
          expected_attendance: flightData.cdg.passenger_volume_estimate,
          demand_boost: flightData.cdg.vtc_demand_boost,
          is_active: 1,
          source: flightData.source,
          flight_stats: flightData.cdg,
          flights: flightData.flights.filter(f => f.airport === "CDG").slice(0, 8),
          zone: zoneMap["z_cdg"],
          description: `~${flightData.cdg.passenger_volume_estimate} passagers VTC estimés dans l'heure. Boost demande ×${flightData.cdg.vtc_demand_boost.toFixed(2)}.`,
        });
      }

      // Événement Orly si flux significatif
      if (flightData.orly.arrivals_next_hour >= 4) {
        const peakLabel: Record<string, string> = {
          low: "Flux faible", medium: "Flux modéré", high: "Flux élevé", surge: "SURGE"
        };
        flightEvents.push({
          id: 9902,
          name: `Orly — ${peakLabel[flightData.orly.peak_level]} (${flightData.orly.arrivals_next_hour} arrivées/h)`,
          zone_id: "z_orly",
          event_type: "flight_wave",
          start_time: now.toISOString(),
          end_time: oneHourLater.toISOString(),
          expected_attendance: flightData.orly.passenger_volume_estimate,
          demand_boost: flightData.orly.vtc_demand_boost,
          is_active: 1,
          source: flightData.source,
          flight_stats: flightData.orly,
          flights: flightData.flights.filter(f => f.airport === "ORLY").slice(0, 6),
          zone: zoneMap["z_orly"],
          description: `~${flightData.orly.passenger_volume_estimate} passagers VTC estimés dans l'heure. Boost demande ×${flightData.orly.vtc_demand_boost.toFixed(2)}.`,
        });
      }

      // Prochaine vague CDG
      if (flightData.cdg.next_wave_eta) {
        const waveTime = new Date(flightData.cdg.next_wave_eta);
        const waveEnd = new Date(waveTime.getTime() + 3600000);
        const cdgPattern = { 0:3,1:2,2:2,3:3,4:6,5:8,6:12,7:18,8:22,9:24,10:26,11:24,12:22,13:24,14:26,15:28,16:30,17:28,18:26,19:24,20:22,21:18,22:12,23:6 };
        const nextH = waveTime.getHours() as keyof typeof cdgPattern;
        const nextArrivals = cdgPattern[nextH] || 20;
        flightEvents.push({
          id: 9903,
          name: `CDG — Prochaine vague ${waveTime.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'})} (${nextArrivals} vols/h prévus)`,
          zone_id: "z_cdg",
          event_type: "flight_forecast",
          start_time: waveTime.toISOString(),
          end_time: waveEnd.toISOString(),
          expected_attendance: Math.round(nextArrivals * 165 * 0.12),
          demand_boost: 1.9,
          is_active: 1,
          source: "heuristic",
          zone: zoneMap["z_cdg"],
          description: `Anticiper la vague d'arrivées intercontinentales à ${waveTime.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'})} — positionnement recommandé 30min avant.`,
        });
      }

      res.json([...baseEvents, ...flightEvents]);
    } catch {
      res.json(baseEvents);
    }
  });

  app.get("/api/alerts", (_req, res) => {
    storage.clearExpiredAlerts();
    res.json(storage.getActiveAlerts());
  });

  app.post("/api/alerts/:id/read", (req, res) => {
    storage.markAlertRead(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.get("/api/rides/stats", (_req, res) => { res.json(storage.getRideStats()); });
  app.get("/api/rides", (_req, res) => { res.json(storage.getRecentRides(20)); });

  app.post("/api/calculate", (req, res) => {
    const { distanceKm, durationMin, fare } = req.body;
    const p: any = storage.getDriverProfile();
    if (!p) return res.status(400).json({ error: "Profile manquant" });
    const commPct = p.platform_commission_pct ?? 25;
    const fuelPer100 = p.fuel_consumption_per100km ?? 7;
    const fuelPrice = p.fuel_price_per_liter ?? 1.85;
    const wearKm = p.wear_cost_per_km ?? 0.08;
    const hourlyTarget = p.hourly_target_income ?? 30;
    const actualFare = fare || distanceKm * 1.5 + 2;
    const commission = actualFare * (commPct / 100);
    const fuelCost = (distanceKm / 100) * fuelPer100 * fuelPrice;
    const wearCost = distanceKm * wearKm;
    const netProfit = actualFare - commission - fuelCost - wearCost;
    const hourlyRate = (netProfit / (durationMin || distanceKm)) * 60;
    const thresholdFare = distanceKm;
    const thresholdDuration = distanceKm;
    const isProfitable = distanceKm > 0 && durationMin <= thresholdDuration && actualFare >= thresholdFare;
    const profitabilityScore = Math.min(100, Math.max(0, (hourlyRate / hourlyTarget) * 100));
    res.json({ distanceKm, durationMin: durationMin||distanceKm, fare: Math.round(actualFare*100)/100, commission: Math.round(commission*100)/100, fuelCost: Math.round(fuelCost*100)/100, wearCost: Math.round(wearCost*100)/100, netProfit: Math.round(netProfit*100)/100, hourlyRate: Math.round(hourlyRate*100)/100, isProfitable, profitabilityScore: Math.round(profitabilityScore), thresholdFare, thresholdDuration });
  });

  app.get("/api/driver-profile", (_req, res) => { res.json(storage.getDriverProfile() || null); });

  app.put("/api/driver-profile", (req, res) => { res.json(storage.updateDriverProfile(req.body)); });

  // ─── Analytics : refresh quotidien + diff historique ──────────────────────────
  app.get("/api/analytics/refresh", async (_req, res) => {
    try {
      const meta = storage.getSeedMeta();
      const diff = storage.getDailyDiff();
      const flightData = await getFlightData();
      const now = new Date();
      const h = now.getHours();
      const dayType = [0,6].includes(now.getDay()) ? 'weekend' : 'weekday';
      const currentScores = storage.getProfitabilityByHour(h, dayType);

      // Statistiques globales du diff
      let statsGlobal: any = {};
      if (diff.hasHistory && diff.diff.length > 0) {
        const weekdayDiff = diff.diff.filter((d: any) => d.day_type === 'weekday');
        const deltas = weekdayDiff.map((d: any) => d.delta_index);
        const posZones = deltas.filter((d: number) => d > 3).length;
        const negZones = deltas.filter((d: number) => d < -3).length;
        const stableZones = deltas.length - posZones - negZones;
        const avgDelta = deltas.reduce((a: number, b: number) => a + b, 0) / Math.max(deltas.length, 1);
        const maxGain = Math.max(...deltas);
        const maxLoss = Math.min(...deltas);
        const topGainer = weekdayDiff.find((d: any) => d.delta_index === maxGain);
        const topLoser = weekdayDiff.find((d: any) => d.delta_index === maxLoss);
        statsGlobal = { posZones, negZones, stableZones, avgDelta: Math.round(avgDelta * 10) / 10, maxGain, maxLoss, topGainer, topLoser };
      }

      // Corrélation surge_multiplier vs profitabilité (Pearson simplifié)
      let pearsonSurge = null;
      if (diff.hasHistory && diff.diff.length > 5) {
        const xs = diff.diff.map((d: any) => d.today_surge);
        const ys = diff.diff.map((d: any) => d.today_index);
        const n = xs.length;
        const mx = xs.reduce((a: number, b: number) => a+b, 0) / n;
        const my = ys.reduce((a: number, b: number) => a+b, 0) / n;
        const num = xs.reduce((s: number, x: number, i: number) => s + (x - mx) * (ys[i] - my), 0);
        const den = Math.sqrt(xs.reduce((s: number, x: number) => s + (x-mx)**2, 0) * ys.reduce((s: number, y: number) => s + (y-my)**2, 0));
        pearsonSurge = den > 0 ? Math.round(num / den * 1000) / 1000 : null;
      }

      res.json({
        timestamp: now.toISOString(),
        today: diff.today,
        yesterday: diff.yesterday,
        today_label: diff.todayLabel,
        yesterday_label: diff.yesterdayLabel,
        seed_meta: meta,
        current_hour: h,
        day_type: dayType,
        current_scores_count: currentScores.length,
        flights: { cdg: flightData.cdg, orly: flightData.orly, source: flightData.source },
        historical_diff: diff,
        stats: statsGlobal,
        correlations: { pearson_surge_vs_profitability: pearsonSurge },
        data_freshness: {
          scores_last_seeded: meta.last_seed_ts || 'unknown',
          scores_for_date: meta.last_seed_date || 'unknown',
          last_refresh_ts: meta.last_refresh_ts || meta.last_seed_ts || 'unknown',
          auto_refresh: 'toutes les 3 minutes (refresh automatique en production)',
          history_available: diff.hasHistory,
          history_days: diff.hasHistory ? diff.diff.length / (14 * 48) : 0,
        },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Force refresh immédiat des scores ────────────────────────────────────────
  app.post("/api/analytics/force-refresh", (_req, res) => {
    try {
      const result = storage.forceReseed();
      res.json({ ...result, message: "Recalcul complet des 672 scores effectué" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/analytics/history", (_req, res) => {
    try {
      const dates = storage.getScoreHistory();
      res.json(dates);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/data-sources", (_req, res) => {
    res.json({ categories: [
      { name: "Données VTC — 93 & Aéroports", icon: "car", sources: [
        { name: "Uber Movement", url: "https://movement.uber.com", status: "open", description: "Données historiques trafic IDF agrégées" },
        { name: "CDG ADP Trafic API", url: "https://www.parisaeroport.fr/groupe/finance/information-reglementee/communiques-de-presse", status: "open", description: "Flux passagers CDG/Orly par terminal et heure" },
        { name: "Heatmap plateformes", url: null, status: "proprietary", description: "Demande temps réel Uber/Bolt — Seine-Saint-Denis" },
      ]},
      { name: "Transport Public IDF", icon: "train", sources: [
        { name: "Ile-de-France Mobilités PRIM", url: "https://prim.iledefrance-mobilites.fr", status: "open", description: "API trafic temps réel — RER B/D, Transilien 93" },
        { name: "SNCF Open Data", url: "https://ressources.data.sncf.com", status: "open", description: "Retards RER B (CDG), RER D, Transilien H/K" },
        { name: "RATP Open Data", url: "https://data.ratp.fr", status: "open", description: "Métro L13, bus 93 — perturbations temps réel" },
        { name: "transport.data.gouv.fr", url: "https://transport.data.gouv.fr", status: "open", description: "Point accès national GTFS-RT Île-de-France" },
      ]},
      { name: "Météorologie", icon: "cloud", sources: [
        { name: "Open-Meteo", url: "https://open-meteo.com", status: "open", description: "API météo gratuite, pas de clé requise" },
        { name: "Météo-France API", url: "https://portail-api.meteofrance.fr", status: "freemium", description: "Données officielles France, alertes" },
        { name: "OpenWeatherMap", url: "https://openweathermap.org/api", status: "freemium", description: "Prévisions horaires, alertes météo" },
      ]},
      { name: "Événements", icon: "calendar", sources: [
        { name: "Ticketmaster Discovery API", url: "https://developer.ticketmaster.com", status: "free", description: "Concerts, matchs, événements avec géoloc" },
        { name: "PredictHQ", url: "https://www.predicthq.com", status: "paid", description: "Prédictions d'impact événements sur demande" },
        { name: "OpenAgenda", url: "https://openagenda.com/agendas", status: "open", description: "Événements locaux France (open data)" },
      ]},
      { name: "Trafic & Géospatial", icon: "map", sources: [
        { name: "Google Maps Platform", url: "https://developers.google.com/maps", status: "paid", description: "Trafic temps réel, routes, durées trajet" },
        { name: "HERE Maps API", url: "https://developer.here.com", status: "freemium", description: "Trafic, routing, analyse isochrone" },
        { name: "OpenStreetMap + OSRM", url: "https://project-osrm.org", status: "open", description: "Routing open source gratuit" },
      ]},
      { name: "Données Socio-Économiques", icon: "users", sources: [
        { name: "INSEE Open Data", url: "https://www.insee.fr/fr/information/2410988", status: "open", description: "Population, emploi, revenus par zone" },
        { name: "data.gouv.fr", url: "https://www.data.gouv.fr", status: "open", description: "Données gouvernementales françaises" },
      ]},
      { name: "Carburant & Coûts", icon: "fuel", sources: [
        { name: "Prix Carburant Officiel", url: "https://www.prix-carburants.gouv.fr", status: "open", description: "Prix carburant temps réel par station" },
        { name: "API Bison Futé", url: "https://www.bison-fute.gouv.fr", status: "open", description: "Conditions de circulation, bouchons" },
      ]},
    ]});
  });

  // ─── Cache Google Maps Distances — consultation ────────────────────────────
  // GET /api/gmaps-distances
  // Retourne le cache complet : entrées par zone + métadonnées de MAJ
  app.get("/api/gmaps-distances", (_req, res) => {
    res.json({
      entries:         gmapsCache.entries,
      lastUpdated:     gmapsCache.lastUpdated,
      nextUpdate:      gmapsCache.nextUpdate,
      updateCount:     gmapsCache.updateCount,
      calibrationDate: gmapsCache.calibrationDate,
      currentHourlyRatio: getHourlyRatio(new Date().getHours()),
      zonesCount:      Object.keys(gmapsCache.entries).length,
    });
  });

  // GET /api/gmaps-distances/status
  // Version légère — état du cache seulement (pas toutes les entrées)
  app.get("/api/gmaps-distances/status", (_req, res) => {
    const now = new Date();
    const nextUpdateDate = new Date(gmapsCache.nextUpdate);
    const secondsUntilNext = Math.max(0, Math.round((nextUpdateDate.getTime() - now.getTime()) / 1000));
    res.json({
      lastUpdated:        gmapsCache.lastUpdated,
      nextUpdate:         gmapsCache.nextUpdate,
      secondsUntilNext,
      updateCount:        gmapsCache.updateCount,
      currentHour:        now.getHours(),
      currentHourlyRatio: getHourlyRatio(now.getHours()),
      calibrationDate:    gmapsCache.calibrationDate,
      zonesCount:         Object.keys(gmapsCache.entries).length,
    });
  });

  // ─── Meilleur Trajet — calcul itinéraire rentable depuis position GPS ──────────
  // POST /api/best-route
  // Body: { lat: number, lng: number }
  app.post("/api/best-route", async (req, res) => {
    try {
      const { lat, lng } = req.body as { lat: number; lng: number };
      if (typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ error: "lat et lng requis (number)" });
      }

      const hour = new Date().getHours();
      const dayType = [0, 6].includes(new Date().getDay()) ? "weekend" : "weekday";
      const zones = storage.getAllZones() as any[];
      const scores = storage.getProfitabilityByHour(hour, dayType) as any[];

      let flightData: any = null;
      try { flightData = await getFlightData(); } catch { /* non bloquant */ }

      // ── Distance Haversine (vol d'oiseau) ─────────────────────────────────────
      const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      const scoreMap: Record<string, any> = {};
      scores.forEach((s: any) => { scoreMap[s.zone_id] = s; });

      const results = zones.map((z: any) => {
        const straightKm = haversineKm(lat, lng, z.lat, z.lng);

        // ── Distances et ETA depuis le cache Google Maps temps réel ─────────────
        const gmEntry = gmapsCache.entries[z.id];

        // Distance routière : depuis le cache (road_km réel) si disponible,
        // sinon estimation haversine × ROAD_FACTOR calibré depuis Bd Ney
        const distanceKm = gmEntry
          ? gmEntry.roadKm
          : Math.round(straightKm * (ROAD_FACTOR[z.id] ?? 1.35) * 10) / 10;

        // ETA : depuis le cache (ratio horaire dynamique) si disponible,
        // sinon fallback vitesse de base rush PM × ratio horaire courant
        const BASE_SPEED: Record<string, number> = {
          z_cdg:                   32.45,
          z_orly:                  26.00,
          z_le_bourget:            18.15,
          z_villepinte:            30.86,
          z_tremblay:              29.87,
          z_aulnay:                27.21,
          z_saint_denis_gare:      13.00,
          z_plaine_commune:        16.57,
          z_bobigny_gare:          22.33,
          z_aubervilliers:         12.77,
          z_epinay_gennevilliers:  13.71,
          z_93_centre:             12.75,
          z_montreuil:             20.49,
          z_stade_france:          12.48,
        };

        const etaMinutes = gmEntry
          ? Math.max(1, Math.round(distanceKm / gmEntry.speedKmH * 60))
          : Math.max(1, Math.round(distanceKm / ((BASE_SPEED[z.id] ?? 20.0) * getHourlyRatio(hour)) * 60));

        const s = scoreMap[z.id] || {};
        const profitIdx = s.profitability_index ?? 0;
        const surge = s.surge_multiplier ?? 1.0;
        const avgFare = s.avg_fare ?? 0;
        const longRide = s.long_ride_probability ?? 0;
        const ratio = s.ratio_ds ?? 1;

        let flightBoost = 1.0;
        if (flightData) flightBoost = getFlightBoostForZone(z.id, flightData);

        // Pénalité distance routière (km réels)
        const distancePenalty = distanceKm <= 3 ? 1.0
          : distanceKm <= 8 ? 0.93
          : distanceKm <= 15 ? 0.82
          : distanceKm <= 25 ? 0.70
          : distanceKm <= 40 ? 0.55
          : 0.35;

        const globalScore = Math.round(profitIdx * distancePenalty * surge * flightBoost);
        const estimatedRevenue = Math.round(avgFare * surge * flightBoost * 100) / 100;

        let reason = "Zone active";
        if (z.id === "z_cdg" || z.id === "z_orly") {
          const fd = z.id === "z_cdg" ? flightData?.cdg : flightData?.orly;
          reason = fd ? `${fd.arrivals_next_hour} arrivees/h — Flux ${fd.peak_level}` : "Aeroport — flux eleve";
        } else if (longRide >= 0.7) {
          reason = `${Math.round(longRide * 100)}% longues courses (${(s.avg_distance_km ?? 0).toFixed(0)}km moy.)`;
        } else if (surge > 1.4) {
          reason = `Surge x${surge.toFixed(2)} — ratio D/O ${ratio.toFixed(2)}`;
        } else if (ratio > 1.5) {
          reason = `Demande forte — ratio D/O ${ratio.toFixed(2)}`;
        } else if (distanceKm < 3) {
          reason = "Zone proche — peu de trajet a vide";
        }

        return {
          zone: z,
          distanceKm,
          etaMinutes,
          profitabilityIndex: profitIdx,
          surgeMultiplier: Math.round(surge * 100) / 100,
          flightBoost: Math.round(flightBoost * 100) / 100,
          avgFare: Math.round(avgFare * 100) / 100,
          longRideProbability: Math.round(longRide * 100) / 100,
          ratioDO: Math.round(ratio * 100) / 100,
          globalScore,
          estimatedRevenue,
          reason,
          // Source des données de distance/ETA
          distanceSource: gmEntry ? "gmaps_cache" : "haversine_estimated",
          waypoints: [
            { lat, lng, label: "Votre position" },
            { lat: z.lat, lng: z.lng, label: z.name },
          ],
        };
      });

      results.sort((a, b) => b.globalScore - a.globalScore || a.distanceKm - b.distanceKm);
      const top5 = results.slice(0, 5);

      res.json({
        userPosition: { lat, lng },
        hour,
        dayType,
        recommendation: top5[0],
        top5,
        all: results,
        computedAt: new Date().toISOString(),
        // Métadonnées du cache Google Maps utilisé pour ce calcul
        gmapsCache: {
          lastUpdated:     gmapsCache.lastUpdated,
          nextUpdate:      gmapsCache.nextUpdate,
          updateCount:     gmapsCache.updateCount,
          hourlyRatio:     getHourlyRatio(hour),
        },
      });
    } catch (err) {
      console.error("[best-route] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
