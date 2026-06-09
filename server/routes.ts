import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { getFlightData, getFlightBoostForZone } from "./flightService";

export function registerRoutes(httpServer: Server, app: Express): void {
  // Auth routes + requireAuth middleware are registered in server/index.ts
  // before this function is called — do not duplicate them here.

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
        // Zone avec la plus forte variation
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
      function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }

      // ── Facteurs de correction routière par zone ──────────────────────────────
      // Calibrés sur distances Google Maps réelles depuis positions typiques IDF
      // Aéroports : accès autoroute sinueux (A1, A6, A86) → facteur élevé ~1.38-1.42
      // Zones proches Paris : voirie urbaine dense → ~1.25-1.30
      // Zones résidentielles / business 93 : mixte → ~1.28-1.35
      const ROAD_FACTOR: Record<string, number> = {
        z_cdg:                1.40, // A1/A3 depuis Paris → 28km réel pour ~20km vol
        z_orly:               1.47, // A6/A106 traverse Paris → 28.2km réel pour ~19km vol (calibré Google Maps)
        z_tremblay:           1.38, // Proche CDG, même accès A104
        z_villepinte:         1.35, // A104 + N2 depuis Paris
        z_le_bourget:         1.30, // A1 court depuis Paris Nord
        z_aulnay:             1.33, // D40/A3 banlieue est
        z_saint_denis_gare:   1.28, // A1 + urbain Saint-Denis
        z_plaine_commune:     1.27, // D20 / A86 couronne
        z_bobigny_gare:       1.28, // A3 + urbain Bobigny
        z_aubervilliers:      1.26, // Urbain dense Aubervilliers
        z_epinay_gennevilliers: 1.30, // D14 / RD1
        z_93_centre:          1.26, // Urbain Saint-Denis Centre
        z_montreuil:          1.27, // Urbain Montreuil
        z_stade_france:       1.25, // A1 + D20 court
      };

      // ── Vitesse moyenne réaliste par heure et distance ────────────────────────
      // Vitesse effective IDF = f(distance, heure, type de route)
      // Pour les aéroports : trajet mixte urbain + autoroute → vitesse plus élevée
      // que le pur urbain, mais ralentie par trafic dense aux heures de pointe
      // Profil de vitesse horaire calibré Google Maps IDF
      // Référence : Bd Ney (Paris 18e) → CDG = 28.3km
      //   7h-9h (rush AM) = 44 min → 38.6 km/h
      //   10h-11h (post-rush) = 44 min → 38.6 km/h (encore dense)
      //   13h-15h (creux) = ~39 min → ~44 km/h (autoroute fluide)
      //   17h-19h (rush PM) = ~55 min → ~31 km/h
      //   22h-6h (nuit) = ~26 min → ~65 km/h
      function estimateSpeedKmH(zoneId: string, roadDistKm: number, h: number): number {
        // ── Aéroports NORD (CDG, Tremblay) : trajet via A1/A3, peu de traversée Paris ──
        const isCdgNord = zoneId === "z_cdg" || zoneId === "z_tremblay";
        // ── Orly : DIFFÉRENT — traverse tout Paris Nord→Sud (A13/Bd Péri/A6) ──
        const isOrly = zoneId === "z_orly";
        const isNight = h >= 22 || h < 6;

        if (isCdgNord) {
          // Vitesse mixte urbain+autoroute A1, calibrée Google Maps : Bd Ney → CDG 28.3km
          if (h >= 6  && h < 7)   return 44; // Pré-rush : A1 encore fluide
          if (h >= 7  && h < 9)   return 38; // Rush AM : bouchons A1 → 44min
          if (h >= 9  && h < 12)  return 39; // Post-rush : encore dense → 44min
          if (h >= 12 && h < 14)  return 44; // Mi-journée : A1 fluide
          if (h >= 14 && h < 16)  return 46; // Après-midi creux
          if (h >= 16 && h < 17)  return 40; // Pré-rush PM
          if (h >= 17 && h < 19)  return 30; // Rush PM
          if (h >= 19 && h < 22)  return 48; // Soir post-rush
          return 65;                          // Nuit
        }

        if (isOrly) {
          // Traversée NORD→SUD de Paris (Bd Ney → Orly via Bd Péri/A6)
          // Calibré Google Maps : 28.2km, 1h08 à 17h47 → 24.9 km/h
          if (h >= 6  && h < 7)   return 38; // Pré-rush urbain
          if (h >= 7  && h < 9)   return 33; // Rush AM traversée Paris ~51min
          if (h >= 9  && h < 12)  return 35; // Post-rush encore chargé ~48min
          if (h >= 12 && h < 14)  return 37; // Mi-journée ~46min
          if (h >= 14 && h < 16)  return 38; // Après-midi ~45min
          if (h >= 16 && h < 17)  return 32; // Pré-rush PM ~53min
          if (h >= 17 && h < 19)  return 25; // Rush PM CALIBRÉ ~68min ✅ Google Maps 1h08
          if (h >= 19 && h < 22)  return 42; // Soir post-rush ~40min
          return 56;                          // Nuit ~30min
        }

        // Zones urbaines / banlieue
        const isRushAM = h >= 7 && h <= 9;
        const isRushPM = h >= 17 && h <= 19;
        const isRush = isRushAM || isRushPM;
        const isPostRush = (h >= 9 && h <= 11) || (h >= 19 && h <= 21);

        if (roadDistKm <= 5) {
          // Urbain dense court
          return isRush ? 15 : isPostRush ? 18 : (isNight ? 35 : 22);
        }
        if (roadDistKm <= 12) {
          // Urbain + rocade
          return isRush ? 20 : isPostRush ? 24 : (isNight ? 45 : 30);
        }
        // Banlieue > 12km
        return isRush ? 25 : isPostRush ? 30 : (isNight ? 55 : 38);
      }

      const scoreMap: Record<string, any> = {};
      scores.forEach((s: any) => { scoreMap[s.zone_id] = s; });

      const results = zones.map((z: any) => {
        const straightKm = haversineKm(lat, lng, z.lat, z.lng);
        const roadFactor = ROAD_FACTOR[z.id] ?? 1.30;
        // Distance routière estimée = vol d'oiseau × facteur de tortuosité
        const distanceKm = Math.round(straightKm * roadFactor * 10) / 10;
        const speedKmH = estimateSpeedKmH(z.id, distanceKm, hour);
        const etaMinutes = Math.max(1, Math.round((distanceKm / speedKmH) * 60));

        const s = scoreMap[z.id] || {};
        const profitIdx = s.profitability_index ?? 0;
        const surge = s.surge_multiplier ?? 1.0;
        const avgFare = s.avg_fare ?? 0;
        const longRide = s.long_ride_probability ?? 0;
        const ratio = s.ratio_ds ?? 1;

        let flightBoost = 1.0;
        if (flightData) flightBoost = getFlightBoostForZone(z.id, flightData);

        // Pénalité distance routière : seuils recalibrés sur km réels (not vol d'oiseau)
        // CDG = ~28km réel depuis Paris → reste très rentable malgré la distance
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
      });
    } catch (err) {
      console.error("[best-route] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
