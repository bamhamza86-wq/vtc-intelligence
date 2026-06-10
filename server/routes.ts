import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { getFlightData, getFlightBoostForZone } from "./flightService";
import {
  getAllCachedRoutes,
  getCachedRoute,
  getCacheStats,
  invalidateCache,
  refreshAllZones,
  warmupCache,
  DEFAULT_ORIGIN,
  CALIBRATED_DATA,
  ROAD_FACTOR as RC_ROAD_FACTOR,
  getHourlyRatio as RC_getHourlyRatio,
} from "./routingCache";

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE TEMPS RÉEL — Système hybride OSRM + Google Maps (optionnel)
// Niveau 1 : OSRM gratuit — distances routières réelles + durée sans trafic
// Niveau 2 : Google Maps Distance Matrix (si GOOGLE_MAPS_KEY présent)
// Cache 30 minutes — fallback données calibrées mesures 10/06/2026
// Origine par défaut : Bd Ney (48.8976, 2.3299) — Paris 18e
// ═══════════════════════════════════════════════════════════════════════════════

// Alias locaux pour compatibilité descendante
const ROAD_FACTOR = RC_ROAD_FACTOR;
const getHourlyRatio = RC_getHourlyRatio;

// ── Clé Google Maps (optionnelle) ─────────────────────────────────────────────
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY ?? "";

// ── Gestion du cycle de vie du cache routingCache ─────────────────────────────
let routingLastRefresh: Date = new Date();
let routingNextRefresh: Date = new Date(Date.now() + 30 * 60 * 1000);
let routingRefreshCount = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// FIN CACHE — le setInterval est lancé dans registerRoutes()
// ═══════════════════════════════════════════════════════════════════════════════

export function registerRoutes(httpServer: Server, app: Express): void {
  // Auth routes + requireAuth middleware are registered in server/index.ts
  // before this function is called — do not duplicate them here.

  // ── Warmup cache au démarrage (non bloquant) ──────────────────────────────
  warmupCache(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng, GOOGLE_MAPS_KEY || undefined);

  // ── Refresh OSRM/Google toutes les 30 minutes ─────────────────────────────
  setInterval(async () => {
    routingRefreshCount++;
    try {
      const result = await refreshAllZones(
        DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng,
        GOOGLE_MAPS_KEY || undefined
      );
      routingLastRefresh = new Date();
      routingNextRefresh = new Date(Date.now() + 30 * 60 * 1000);
      console.log(`[routing-cache] Refresh #${routingRefreshCount} — ${result.refreshed} zones via ${result.source} en ${result.durationMs}ms`);
    } catch (err) {
      console.warn(`[routing-cache] Refresh #${routingRefreshCount} échoué:`, err);
    }
  }, 30 * 60 * 1000); // 30 minutes

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
    const entries = getAllCachedRoutes(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng);
    const stats   = getCacheStats();
    res.json({
      entries,
      lastUpdated:        routingLastRefresh.toISOString(),
      nextUpdate:         routingNextRefresh.toISOString(),
      updateCount:        routingRefreshCount,
      calibrationDate:    "2026-06-10",
      currentHourlyRatio: getHourlyRatio(new Date().getHours()),
      zonesCount:         Object.keys(entries).length,
      cacheStats:         stats,
    });
  });

  // GET /api/gmaps-distances/status
  // Version légère — état du cache seulement (pas toutes les entrées)
  app.get("/api/gmaps-distances/status", (_req, res) => {
    const now              = new Date();
    const secondsUntilNext = Math.max(0, Math.round((routingNextRefresh.getTime() - now.getTime()) / 1000));
    const stats            = getCacheStats();
    res.json({
      lastUpdated:        routingLastRefresh.toISOString(),
      nextUpdate:         routingNextRefresh.toISOString(),
      secondsUntilNext,
      updateCount:        routingRefreshCount,
      currentHour:        now.getHours(),
      currentHourlyRatio: getHourlyRatio(now.getHours()),
      calibrationDate:    "2026-06-10",
      zonesCount:         Object.keys(CALIBRATED_DATA).length,
      cacheSource:        stats.googleAvailable ? "google" : (stats.osrmAvailable ? "osrm" : "calibrated"),
      ttlMinutes:         30,
    });
  });

  // ─── Cache routing — stats et refresh admin ─────────────────────────────────
  // GET /api/routing-cache/stats
  app.get("/api/routing-cache/stats", (_req, res) => {
    const stats = getCacheStats();
    res.json({
      ...stats,
      lastRefresh:  routingLastRefresh.toISOString(),
      nextRefresh:  routingNextRefresh.toISOString(),
      ttlMinutes:   30,
      costEstimate: {
        osrmPerMonth:   "0€ (gratuit, open source)",
        googlePerMonth: stats.googleAvailable
          ? "~75€ brut → FREE TIER (crédit 200$/mois)"
          : "N/A (clé non configurée)",
        reduction:      "90% vs refresh 3min (cache 30min × 14 zones)",
        apiCallsSaved:  `${Math.round(stats.refreshCount * 14 * (10 - 1))} appels économisés vs refresh 3min`,
      },
    });
  });

  // POST /api/routing-cache/refresh
  // Force un refresh immédiat de toutes les zones (admin)
  app.post("/api/routing-cache/refresh", async (_req, res) => {
    try {
      invalidateCache();
      const result = await refreshAllZones(
        DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng,
        GOOGLE_MAPS_KEY || undefined
      );
      routingLastRefresh = new Date();
      routingNextRefresh = new Date(Date.now() + 30 * 60 * 1000);
      routingRefreshCount++;
      console.log(`[routing-cache] Force refresh admin — ${result.refreshed} zones via ${result.source} en ${result.durationMs}ms`);
      res.json({
        success:    true,
        refreshed:  result.refreshed,
        source:     result.source,
        durationMs: result.durationMs,
        nextRefresh: routingNextRefresh.toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
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

        // ── Distances et ETA depuis routingCache (OSRM / Google / calibré) ────────
        // Cache 30min — source réelle si disponible, sinon fallback calibré
        const rcEntry = getCachedRoute(z.id, lat, lng);

        // Distance routière réelle (OSRM ou mesure calibrée)
        const distanceKm = rcEntry.roadKm > 0
          ? rcEntry.roadKm
          : Math.round(straightKm * (ROAD_FACTOR[z.id] ?? 1.35) * 10) / 10;

        // ETA avec trafic (Google) ou OSRM × ratio horaire, ou calibré
        const etaMinutes = rcEntry.etaMin > 0 ? rcEntry.etaMin
          : Math.max(1, Math.round(distanceKm / (rcEntry.speedKmH || 20) * 60));

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
          distanceSource: rcEntry.source,
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
        routingCache: {
          lastUpdated:     routingLastRefresh.toISOString(),
          nextUpdate:      routingNextRefresh.toISOString(),
          updateCount:     routingRefreshCount,
          hourlyRatio:     getHourlyRatio(hour),
        },
      });
    } catch (err) {
      console.error("[best-route] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
