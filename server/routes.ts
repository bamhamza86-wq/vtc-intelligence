import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
// ← H2 : fusion adaptative multi-sources (TomTom + PHQ + vols + seeds)
import {
  fusionSignals,
  detectRegime,
  computeTomTomContrib,
  computeAdaptiveWeights,
  computeAdaptiveScore,
  setTomTomDemandSnapshot,
  getTomTomDemandSignal,
  isZonePeakHour,
  getTrend,
  getSupplyDynamics,
  type SignalWeights,
  type Regime,
} from "./storage";
import { getFlightData, getFlightBoostForZone } from "./flightService";
import {
  testTomTomConnection,
  testGigDataConnection,
  fetchAllPlatformDemand,
} from "./platformDemand";
// ← PredictHQ : boost demande lié aux événements (concerts, sports, salons…)
// Stub fourni par l'Agent 2 tant que l'Agent 1 n'a pas livré l'intégration réelle.
import {
  getEventBoostForZone,
  getPredictHQStatus,
  getActivePredictHQEvents,
  fetchEventsForZones,
  fetchDemandSurges,
  refreshPredictHQEvents,
  testPredictHQConnection,
} from "./predictHQService";

// Helper boost combiné flight × PredictHQ, plafonné à 2.5× au total.
function combinePredictHQBoost(flightBoost: number, phqBoost: number): number {
  return Math.min(2.5, (flightBoost || 1.0) * (phqBoost || 1.0));
}

// ← F3: Cache en mémoire pour getFlightData avec mutex concurrent-safe
// TTL = 3min (aligné sur REFRESH_INTERVAL_MS storage)
// Mutex: si 2 req simultanées avec cache froid → 1 seul appel réseau (pas 2)
const FLIGHT_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
let _flightCacheData: any = null;
let _flightCacheTs = 0;
let _flightFetchPromise: Promise<any> | null = null; // mutex concurrent

async function getFlightDataCached(): Promise<any> {
  const now = Date.now();
  // Cache chaud → retour immédiat (0ms)
  if (_flightCacheData && (now - _flightCacheTs) < FLIGHT_CACHE_TTL_MS) {
    return _flightCacheData;
  }
  // Fetch déjà en cours → attendre le même (mutex)
  if (_flightFetchPromise) {
    return _flightFetchPromise;
  }
  // Cache froid → 1 seul appel réseau
  _flightFetchPromise = getFlightData().then(data => {
    _flightCacheData = data;
    _flightCacheTs = Date.now();
    _flightFetchPromise = null;
    return data;
  }).catch(err => {
    _flightFetchPromise = null;
    if (_flightCacheData) return _flightCacheData; // retourne ancien cache si dispo
    throw err;
  });
  return _flightFetchPromise;
}

// ← H2 : Cache mémoire du signal TomTom (demande temps réel) par zone.
// TTL 3 min (aligné sur le refresh trafic). Mutex concurrent-safe. Non bloquant :
// si TomTom indisponible (pas de clé, erreur réseau) → snapshot vide, la fusion
// fonctionne sans TomTom (poids redistribués).
const TOMTOM_DEMAND_TTL_MS = 3 * 60 * 1000; // 3 minutes
let _tomtomDemandTs = 0;
let _tomtomDemandPromise: Promise<void> | null = null;

async function refreshTomTomDemandCache(): Promise<void> {
  const now = Date.now();
  if ((now - _tomtomDemandTs) < TOMTOM_DEMAND_TTL_MS) return;   // cache chaud
  if (_tomtomDemandPromise) return _tomtomDemandPromise;        // fetch en cours
  _tomtomDemandPromise = (async () => {
    try {
      const cred = storage.getPlatformCredential("tomtom");
      const key = cred?.api_key && cred.status === "connected" ? cred.api_key : null;
      if (!key) { setTomTomDemandSnapshot({}); _tomtomDemandTs = Date.now(); return; }
      const zones = await fetchAllPlatformDemand(key, null);
      const snapshot: Record<string, number | null> = {};
      for (const z of zones) {
        snapshot[z.zone_id] = z.tomtom_status === "ok" ? z.tomtom_demand_signal : null;
      }
      setTomTomDemandSnapshot(snapshot);
      _tomtomDemandTs = Date.now();
    } catch {
      // Réseau/clé KO → on n'écrase pas un snapshot récent valide, sinon vide.
      if (_tomtomDemandTs === 0) setTomTomDemandSnapshot({});
    } finally {
      _tomtomDemandPromise = null;
    }
  })();
  return _tomtomDemandPromise;
}
import {
  getAllCachedRoutes,
  getCachedRoute,
  getRouteForZone,
  getCacheStats,
  invalidateCache,
  refreshAllZones,
  warmupCache,
  getTomTomKey,
  DEFAULT_ORIGIN,
  CALIBRATED_DATA,
  ROAD_FACTOR as RC_ROAD_FACTOR,
  getHourlyRatio as RC_getHourlyRatio,
  getCongestedETA,
  computeBreakEvenPenalty,
  getTrafficDensity,
  TRAFFIC_DENSITY,
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
// TTL TomTom = 3 minutes (trafic temps réel) → refresh aligné sur 3 min
const ROUTING_REFRESH_MS = 3 * 60 * 1000;
let routingLastRefresh: Date = new Date();
let routingNextRefresh: Date = new Date(Date.now() + ROUTING_REFRESH_MS);
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
      routingNextRefresh = new Date(Date.now() + ROUTING_REFRESH_MS);
      console.log(`[routing-cache] Refresh #${routingRefreshCount} — ${result.refreshed} zones via ${result.source} en ${result.durationMs}ms`);
    } catch (err) {
      console.warn(`[routing-cache] Refresh #${routingRefreshCount} échoué:`, err);
    }
  }, ROUTING_REFRESH_MS); // 3 minutes (aligné TTL TomTom trafic temps réel)

  // Headers cache HTTP pour optimiser le refresh 2s côté navigateur
  // profitability/current/alerts : no-store (données toujours fraîches)
  // zones/profile : cache 60s navigateur
  app.use("/api/profitability", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    next();
  });
  app.use("/api/current", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    next();
  });
  app.use("/api/alerts", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    next();
  });
  app.use("/api/zones", (_req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    next();
  });

  app.get("/api/zones", (_req, res) => { res.json(storage.getAllZones()); });

  // ─── /api/current — Snapshot temps réel (2s refresh) ──────────────────
  // Regroupe profitability + top-zones + alertes actives + meta refresh
  // en 1 seul appel — réduit les requêtes de 3 → 1 par cycle 2s
  app.get("/api/current", async (req, res) => {
    const now = new Date();
    const h = (now.getUTCHours()+2)%24;
    const dayType = [0,6].includes(now.getDay()) ? 'weekend' : 'weekday';

    try {
      // Données synchrones SQLite (instantané)
      const scores = storage.getProfitabilityByHour(h, dayType);
      const zones  = storage.getAllZones();
      const alerts = storage.getActiveAlerts();
      const zoneMap: any = Object.fromEntries(zones.map((z: any) => [z.id, z]));

      // Enrichissement vols depuis cache (0ms si cache chaud) — AVANT tri topZones
      let enrichedScores = scores;
      try {
        const flightData = await getFlightDataCached();
        enrichedScores = await Promise.all(scores.map(async (s: any) => {
          const flightBoost = getFlightBoostForZone(s.zone_id, flightData);
          // ← PredictHQ : boost events (1.0 si aucun). Combiné avec flight (cap 2.5×).
          let phqBoost = 1.0;
          try { phqBoost = await getEventBoostForZone(s.zone_id, h); } catch { phqBoost = 1.0; }
          const baseIdx = s.profitability_index ?? 0;
          // Couvre-feu aéroports h=0..4 : score plancher = 5, boosts neutralisés
          const isCurfew = (s.zone_type === 'airport' || s.zone_id === 'z_cdg' || s.zone_id === 'z_orly') && baseIdx <= 5;
          const combinedBoost = isCurfew ? 1.0 : combinePredictHQBoost(flightBoost, phqBoost);
          const boostPts = (combinedBoost > 1 && !isCurfew) ? Math.round(Math.log(combinedBoost) / Math.log(2) * 12) : 0;
          const boostedIndex = Math.min(95, Math.round(baseIdx + boostPts));
          const boostedSurge = isCurfew ? 1.0 : Math.min(4.5, Math.round(((s.surge_multiplier ?? 1.0) * Math.min(combinedBoost, 1.5)) * 100) / 100);
          const effPhqBoost = isCurfew ? 1.0 : phqBoost;
          return { ...s, profitability_index: boostedIndex, profitabilityIndex: boostedIndex, surge_multiplier: boostedSurge, surgeMultiplier: boostedSurge, flight_boost: isCurfew ? 1.0 : flightBoost, flightBoost: isCurfew ? 1.0 : flightBoost, phq_boost: Math.round(effPhqBoost * 100) / 100, phq_boost_active: effPhqBoost > 1.0, combined_event_boost: Math.round(combinedBoost * 100) / 100 };
        }));
      } catch { /* garde scores non-enrichis */ }

      // Top 5 zones triées sur scores ENRICHIS (avec flight_boost appliqué)
      const topZones = [...enrichedScores]
        .sort((a: any, b: any) => (b.profitability_index ?? 0) - (a.profitability_index ?? 0))
        .slice(0, 5)
        .map((s: any) => ({ ...s, zone: zoneMap[s.zone_id] }));

      // lastRefresh depuis seed_meta (clé 'last_refresh_ts' OU 'last_seed_ts')
      const meta = storage.getSeedMeta();
      const lastRefreshTs = meta['last_refresh_ts'] || meta['last_seed_ts'] || now.toISOString();
      res.json({
        hour: h,
        dayType,
        timestamp: now.toISOString(),
        profitability: enrichedScores,
        topZones,
        alerts: alerts.slice(0, 10), // limite 10 pour perf
        lastRefresh: lastRefreshTs,
        nextRefresh: new Date(new Date(lastRefreshTs).getTime() + 3 * 60 * 1000).toISOString(),
        zones: zoneMap,
      });
    } catch (err) {
      res.status(500).json({ error: "Erreur /api/current", details: String(err) });
    }
  });

  // ─── Données de vols temps réel (CDG + Orly) ───────────────────────────────
  app.get("/api/flights", async (_req, res) => {
    try {
      const data = await getFlightDataCached();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: "Erreur récupération données vols", details: String(err) });
    }
  });

  app.get("/api/profitability", async (req, res) => {
    const _hourRaw = parseInt(req.query.hour as string);
    const hour = isNaN(_hourRaw) ? (new Date().getUTCHours()+2)%24 : _hourRaw;
    const dayType = req.query.dayType as string || ([0,6].includes(new Date().getDay()) ? 'weekend' : 'weekday');
    // Origine GPS fraîche : si le frontend passe ?lat=&lng=, on calcule l'ETA des
    // zones depuis la vraie position du chauffeur (clé de cache OSRM correcte).
    // Sinon, fallback sur l'origine par défaut (Bd Ney).
    const originLat = parseFloat(req.query.lat as string ?? "") || DEFAULT_ORIGIN.lat;
    const originLng = parseFloat(req.query.lng as string ?? "") || DEFAULT_ORIGIN.lng;
    const scores = storage.getProfitabilityByHour(hour, dayType);

    // Enrichissement avec boost dynamique vols
    try {
      const flightData = await getFlightDataCached();
      // ← H2 : rafraîchit le snapshot TomTom (demande temps réel) avant la fusion.
      //   Non bloquant si TomTom indisponible → la fusion fonctionne sans.
      try { await refreshTomTomDemandCache(); } catch { /* TomTom optionnel */ }
      const flightsSource: string = flightData?.source ?? "heuristic";
      const enriched = await Promise.all(scores.map(async (s: any) => {
        const flightBoost = getFlightBoostForZone(s.zone_id, flightData);
        // ← PredictHQ : boost events (1.0 si aucun event). Combiné avec flight,
        //    plafonné à 2.5× au total. Non bloquant (stub → 1.0).
        let phqBoost = 1.0;
        try { phqBoost = await getEventBoostForZone(s.zone_id, hour); } catch { phqBoost = 1.0; }
        const baseIdx = s.profitability_index ?? s.profitabilityIndex ?? 0;
        // Couvre-feu aéroports h=0..4 : score plancher = 5, boosts neutralisés
        const isCurfew = (s.zone_type === 'airport' || s.zone_id === 'z_cdg' || s.zone_id === 'z_orly') && baseIdx <= 5;
        // Boost combiné flight × PredictHQ (cap 2.5×). Neutralisé en couvre-feu.
        const combinedBoost = isCurfew ? 1.0 : combinePredictHQBoost(flightBoost, phqBoost);
        // Boost additif (log-scale) sur le boost COMBINÉ — évite la saturation
        // combinedBoost=2.5 → +14pts, 1.9 → +11pts, 1.5 → +7pts, 1.0 → +0
        const boostPts = (combinedBoost > 1 && !isCurfew) ? Math.round(Math.log(combinedBoost) / Math.log(2) * 12) : 0;
        const boostedIndex = Math.min(95, Math.round(baseIdx + boostPts));
        // Surge boost multiplicatif (sur boost combiné) plafonné à 4.5×
        const boostedSurge = isCurfew ? 1.0 : Math.min(4.5, Math.round(((s.surge_multiplier ?? s.surgeMultiplier ?? 1.0) * Math.min(combinedBoost, 1.5)) * 100) / 100);
        // Enrichissement congestion en temps réel sur les données stockées.
        // roadKm calculé depuis la VRAIE origine GPS (cache OSRM/Google par origine),
        // fallback calibré si pas d'entrée fraîche pour cette origine.
        const cachedRoute = getCachedRoute(s.zone_id, originLat, originLng);
        const roadKm      = cachedRoute.roadKm > 0
          ? cachedRoute.roadKm
          : (CALIBRATED_DATA[s.zone_id]?.road_km ?? 20);
        const congestedRT = getCongestedETA(s.zone_id, roadKm, hour);
        const breakEvenRT = computeBreakEvenPenalty(s.zone_id, roadKm, congestedRT.etaMin, congestedRT.congestionFactor);
        const effPhqBoost = isCurfew ? 1.0 : phqBoost;
        const roundedPhqBoost = Math.round(effPhqBoost * 100) / 100;

        // ← Agent B : récupère l'event PredictHQ top de la zone (rank max) pour
        //    persistance + enrichissement réponse. Non bloquant.
        let phqTopTitle = '';
        let phqTopRank = 0;
        let phqActiveEvents = 0;
        try {
          const zoneEvents = storage.getActivePredictHQEvents(s.zone_id)
            .filter((e: any) => e.is_active);
          phqActiveEvents = zoneEvents.length;
          if (zoneEvents.length > 0) {
            const top = zoneEvents.reduce((a: any, b: any) => (b.rank ?? 0) > (a.rank ?? 0) ? b : a);
            phqTopTitle = top.title ?? '';
            phqTopRank = Math.round(top.rank ?? 0);
          }
        } catch { /* PredictHQ indisponible — valeurs neutres */ }

        // Persiste le boost PredictHQ + l'event top dans profitability_scores
        // (+ snapshot historique). Couvre-feu → boost neutralisé (1.0).
        try {
          storage.upsertProfitabilityScore({
            zone_id: s.zone_id,
            hour,
            day_type: dayType,
            phq_boost: roundedPhqBoost,
            phq_event_title: isCurfew ? '' : phqTopTitle,
            phq_event_rank: isCurfew ? 0 : phqTopRank,
            phq_active_events: isCurfew ? 0 : phqActiveEvents,
          });
        } catch { /* persistance non bloquante */ }

        // demand_level dérivé de l'index boosté (rendu dashboard)
        const demandLevel =
          boostedIndex >= 85 ? 'extreme'
          : boostedIndex >= 70 ? 'high'
          : boostedIndex >= 50 ? 'moderate'
          : 'low';

        // ─── H2 : FUSION ADAPTATIVE MULTI-SOURCES ────────────────────────────
        // Combine seeds (baseIdx) + TomTom (temps réel) + PHQ + vols avec une
        // pondération adaptative selon le régime détecté. Non bloquant : si un
        // signal manque, son poids est mis à 0 et redistribué.
        const seedScore = baseIdx;
        const tomtomSignal = getTomTomDemandSignal(s.zone_id);   // null si indispo
        const tomtomAvailable = tomtomSignal !== null;
        const tomtomContrib = computeTomTomContrib(tomtomSignal);
        const effFlightBoost = isCurfew ? 1.0 : flightBoost;
        const flightsFromOpenSky = !isCurfew && flightsSource === "opensky" && effFlightBoost > 1.0;
        // Régime : event (PHQ>1.5 ou surge>1.3) / disruption (alerte ou trafic≥80) / normal
        let regime: Regime;
        try { regime = detectRegime(s.zone_id, hour); } catch { regime = "normal"; }
        const effPhqRank = isCurfew ? 0 : phqTopRank;
        const sigWeights: SignalWeights = computeAdaptiveWeights({
          regime,
          zoneId: s.zone_id,
          hour,
          tomtomAvailable,
          phqBoost: effPhqBoost,
          phqEventRank: effPhqRank,
          flightsFromOpenSky,
        });
        // Score adaptatif : clamp [5,100] + anti-surestimation (≤ +20% du seed)
        const adaptiveScoreVal = computeAdaptiveScore(
          seedScore, tomtomContrib, effPhqBoost, effFlightBoost, sigWeights,
        );

        return {
          ...s,
          profitability_index: boostedIndex,
          profitabilityIndex: boostedIndex,
          surge_multiplier: boostedSurge,
          surgeMultiplier: boostedSurge,
          flight_boost: isCurfew ? 1.0 : flightBoost,
          flightBoost: isCurfew ? 1.0 : flightBoost,
          // ← Champs PredictHQ
          phq_boost:            roundedPhqBoost,
          phq_boost_active:     effPhqBoost > 1.0,
          phq_event_title:      isCurfew ? '' : phqTopTitle,
          phq_event_rank:       isCurfew ? 0 : phqTopRank,
          phq_active_events:    isCurfew ? 0 : phqActiveEvents,
          demand_level:         demandLevel,
          combined_event_boost: Math.round(combinedBoost * 100) / 100,
          // Champs trafic historique
          congestion_factor:  congestedRT.congestionFactor,
          congestion_label:   congestedRT.congestionLabel,
          eta_to_zone:        congestedRT.etaMin,
          speed_effective:    congestedRT.speedKmH,
          min_per_km:         breakEvenRT.minPerKm,
          break_even_ok:      breakEvenRT.breakEvenOk,
          congestion_penalty: breakEvenRT.penalty,
          // ── H4 : tendance glissante 3h + anomalie z-score + EMA offre ──────
          ...(() => {
            try {
              const dyn = getSupplyDynamics(s.zone_id, hour);
              return {
                trend:           dyn.trend,            // "up" | "down" | "flat"
                trend_magnitude: dyn.trend_magnitude,  // pts sur 3h
                trend_hours:     3,
                anomaly:         dyn.anomaly,
                z_score:         dyn.z_score,
                ema_supply:      dyn.ema_supply,
              };
            } catch {
              return { trend: "flat", trend_magnitude: 0, trend_hours: 3, anomaly: false, z_score: 0, ema_supply: 0 };
            }
          })(),
          // ← H2 : fusion adaptative multi-sources (rétrocompatible : champs existants conservés)
          adaptive_score:       true,
          regime,
          tomtom_demand_signal: tomtomSignal,
          tomtom_available:     tomtomAvailable,
          score:                adaptiveScoreVal,
          signal_weights:       sigWeights,
          signal_values: {
            seeds:   Math.round(seedScore * 10) / 10,
            tomtom:  Math.round(tomtomContrib * 100) / 100,
            phq:     Math.round(effPhqBoost * 100) / 100,
            flights: Math.round(effFlightBoost * 100) / 100,
          },
        };
      }));
      res.json(enriched);
    } catch {
      res.json(scores);
    }
  });

  // ← H2 : régime de fusion + score fusionné + poids adaptatifs par zone.
  // GET /api/profitability/regime?zone_id=z_stade_france[&hour=18]
  //   → détail d'une zone (fusionSignals)
  // GET /api/profitability/regime           → toutes les zones
  app.get("/api/profitability/regime", async (req, res) => {
    try {
      const _hourRaw = parseInt(req.query.hour as string);
      const hour = isNaN(_hourRaw) ? (new Date().getUTCHours() + 2) % 24 : _hourRaw;
      // Rafraîchit le snapshot TomTom (non bloquant) + vols pour la source.
      try { await refreshTomTomDemandCache(); } catch { /* TomTom optionnel */ }
      let flightsSource = "heuristic";
      let flightData: any = null;
      try { flightData = await getFlightDataCached(); flightsSource = flightData?.source ?? "heuristic"; } catch { /* vols optionnels */ }

      const buildFor = (zoneId: string) => {
        let flightBoost = 1.0;
        try { if (flightData) flightBoost = getFlightBoostForZone(zoneId, flightData); } catch { flightBoost = 1.0; }
        return fusionSignals(zoneId, hour, { flightBoost, flightsSource });
      };

      const zoneId = (req.query.zone_id as string || "").trim();
      if (zoneId) {
        return res.json(buildFor(zoneId));
      }
      // Toutes les zones
      const zones = storage.getAllZones() as any[];
      const results = zones.map((z: any) => buildFor(z.id ?? z.zone_id)).sort(
        (a, b) => b.fused_score - a.fused_score,
      );
      return res.json({ hour, count: results.length, zones: results });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? "regime computation failed" });
    }
  });

  // ← Agent B : historique des scores + boost PredictHQ pour une zone (dashboard analytics).
  // GET /api/profitability/history?zone_id=z_stade_france&days=7
  // Retourne la série temporelle des snapshots (profitability_phq_history).
  app.get("/api/profitability/history", (req, res) => {
    try {
      const zoneId = (req.query.zone_id as string || '').trim();
      if (!zoneId) {
        return res.status(400).json({ error: "zone_id requis", zone_id: null, days: 0, points: [], count: 0 });
      }
      const _daysRaw = parseInt(req.query.days as string);
      const days = isNaN(_daysRaw) || _daysRaw <= 0 ? 7 : Math.min(90, _daysRaw);
      const rows = storage.getProfitabilityHistory(zoneId, days);
      const points = rows.map((r: any) => ({
        zone_id:           r.zone_id,
        hour:              r.hour,
        day_type:          r.day_type,
        profitability_index: Math.round((r.profitability_index ?? 0) * 100) / 100,
        score:             Math.round((r.profitability_index ?? 0) * 100) / 100,
        phq_boost:         Math.round((r.phq_boost ?? 1.0) * 100) / 100,
        phq_boost_active:  (r.phq_boost ?? 1.0) > 1.0,
        phq_event_title:   r.phq_event_title ?? '',
        phq_event_rank:    r.phq_event_rank ?? 0,
        phq_active_events: r.phq_active_events ?? 0,
        recorded_at:       r.recorded_at,
      }));
      res.json({ zone_id: zoneId, days, count: points.length, points });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'history error', zone_id: null, days: 0, points: [], count: 0 });
    }
  });

  // ── H4 : dynamique de l'offre — EMA supply + tendance 3h + z-score anomalie ──
  // GET /api/profitability/supply?zone_id=z_stade_france[&hour=14]
  // Retourne ema_supply, trend, trend_magnitude, z_score, anomaly pour la zone.
  // Sans zone_id : renvoie l'ensemble des zones pour l'heure courante (ou ?hour).
  app.get("/api/profitability/supply", (req, res) => {
    try {
      const zoneId = (req.query.zone_id as string || '').trim();
      const _hRaw = parseInt(req.query.hour as string);
      const hour = isNaN(_hRaw) ? (new Date().getUTCHours() + 2) % 24 : _hRaw;
      if (zoneId) {
        const dyn = getSupplyDynamics(zoneId, hour);
        return res.json(dyn);
      }
      // Toutes les zones pour l'heure demandée
      const zones = storage.getAllZones();
      const all = zones.map((z: any) => getSupplyDynamics(z.id, hour));
      return res.json({ hour, count: all.length, supply: all });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'supply dynamics error' });
    }
  });

  app.get("/api/top-zones", (req, res) => {
    const _hourRaw2 = parseInt(req.query.hour as string);
    const hour = isNaN(_hourRaw2) ? (new Date().getUTCHours()+2)%24 : _hourRaw2;
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
      const flightData = await getFlightDataCached();
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

  app.get("/api/alerts", async (_req, res) => {
    storage.clearExpiredAlerts();
    const dbAlerts = storage.getActiveAlerts();

    // ← PredictHQ : alertes dynamiques (NON persistées en DB) pour les events
    //    majeurs actifs (rank >= 70). Non bloquant : stub → aucun event.
    let phqAlerts: any[] = [];
    try {
      const phqEvents = await getActivePredictHQEvents();
      phqAlerts = phqEvents
        .filter((e: any) => (e.rank ?? 0) >= 70)
        .map((e: any) => {
          const rank = e.rank ?? 0;
          const demandBoost = e.demand_boost ?? 1.0;
          return {
            type: 'predicthq_event',
            title: `🎯 ${e.title}`,
            message: `${e.category} — ${e.phq_attendance} personnes attendues. Boost demande ×${demandBoost.toFixed(1)}`,
            zone_id: e.zone_id,
            priority: rank >= 80 ? 'high' : 'medium',
            estimated_revenue: Math.round((e.transport_spend ?? 0) / 100),
            expires_at: e.end,
            demand_boost: demandBoost,
          };
        });
    } catch { phqAlerts = []; }

    res.json([...phqAlerts, ...dbAlerts]);
  });

  app.post("/api/alerts/:id/read", (req, res) => {
    storage.markAlertRead(parseInt(req.params.id));
    res.json({ success: true });
  });

  // POST /api/alerts/refresh — force la régénération des alertes dynamiques
  app.post("/api/alerts/refresh", (_req, res) => {
    storage.clearExpiredAlerts();
    (storage as any).generateDynamicAlerts?.() ?? null;
    const alerts = storage.getActiveAlerts();
    res.json({ success: true, count: alerts.length, alerts });
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

  // ─── Platform credentials ────────────────────────────────────────────────────
  app.get("/api/platforms/credentials", (_req, res) => {
    const creds = storage.getPlatformCredentials();
    // Masquer les clés (ne retourner que les 4 premiers caractères + "****")
    const masked = creds.map((c: any) => ({
      ...c,
      api_key: c.api_key ? c.api_key.slice(0, 4) + "****" : "",
      has_key: c.api_key?.length > 0,
    }));
    res.json(masked);
  });

  app.put("/api/platforms/credentials/:platform", (req, res) => {
    const { platform } = req.params;
    const { api_key } = req.body as { api_key: string };
    if (!["tomtom", "gigdata", "predicthq"].includes(platform)) {
      return res.status(400).json({ error: "Plateforme non supportée" });
    }
    storage.savePlatformCredential(platform, api_key || "");
    res.json({ success: true });
  });

  app.post("/api/platforms/test/:platform", async (req, res) => {
    const { platform } = req.params;
    const cred = storage.getPlatformCredential(platform);
    if (!cred?.api_key) {
      return res.status(400).json({ ok: false, error: "Aucune clé configurée" });
    }

    let result: { ok: boolean; error?: string };

    if (platform === "tomtom") {
      result = await testTomTomConnection(cred.api_key);
    } else if (platform === "gigdata") {
      result = await testGigDataConnection(cred.api_key);
    } else if (platform === "predicthq") {
      result = await testPredictHQConnection(cred.api_key);
    } else {
      return res.status(400).json({ ok: false, error: "Plateforme inconnue" });
    }

    storage.updatePlatformStatus(platform, result.ok ? "connected" : "error", result.error || "");
    res.json(result);
  });

  app.get("/api/platforms/demand", async (_req, res) => {
    const tomtomCred = storage.getPlatformCredential("tomtom");
    const gigCred    = storage.getPlatformCredential("gigdata");
    const tomtomKey  = tomtomCred?.api_key && tomtomCred.status === "connected" ? tomtomCred.api_key : null;
    const gigdataKey = gigCred?.api_key  && gigCred.status  === "connected" ? gigCred.api_key  : null;

    if (!tomtomKey && !gigdataKey) {
      return res.json({ zones: [], message: "Aucune plateforme configurée" });
    }

    const zones = await fetchAllPlatformDemand(tomtomKey, gigdataKey);
    res.json({ zones, fetched_at: new Date().toISOString() });
  });

  // ─── PredictHQ ──────────────────────────────────────────────────────────────
  // Statut connexion + nb events actifs
  app.get("/api/predicthq/status", (_req, res) => {
    try {
      const status = getPredictHQStatus();
      res.json(status);
    } catch (e: any) {
      // Fallback gracieux : jamais d'erreur 500
      res.json({
        status: "no_key",
        connected: false,
        has_key: false,
        active_events: 0,
        max_boost: 1.0,
        last_fetch: null,
        cache_age_seconds: null,
        error: e?.message ?? "Erreur interne",
      });
    }
  });

  // Liste de tous les events actifs (avec zone_id + boost)
  app.get("/api/predicthq/events", async (_req, res) => {
    try {
      const events = await fetchEventsForZones();
      const active = events.filter((e) => e.is_active);
      res.json({
        events: active,
        total: events.length,
        active_count: active.length,
        fetched_at: new Date().toISOString(),
      });
    } catch {
      // Fallback sur le cache SQLite
      const fromDb = storage.getActivePredictHQEvents();
      res.json({ events: fromDb, total: fromDb.length, active_count: fromDb.length, fetched_at: new Date().toISOString() });
    }
  });

  // Events pour une zone spécifique
  app.get("/api/predicthq/events/:zone_id", async (req, res) => {
    const { zone_id } = req.params;
    try {
      // S'assure que le cache est rafraîchi puis lit la zone depuis SQLite
      await fetchEventsForZones();
    } catch {
      /* fallback sur SQLite ci-dessous */
    }
    const events = storage.getActivePredictHQEvents(zone_id);
    res.json({ zone_id, events, count: events.length, fetched_at: new Date().toISOString() });
  });

  // Prochains pics de demande (7 jours)
  app.get("/api/predicthq/surges", async (_req, res) => {
    try {
      const surges = await fetchDemandSurges(7);
      res.json({ surges, count: surges.length, fetched_at: new Date().toISOString() });
    } catch (e: any) {
      res.json({ surges: [], count: 0, error: e?.message ?? "Erreur interne", fetched_at: new Date().toISOString() });
    }
  });

  // Force le refresh des events depuis l'API (auth requise via middleware /api/*)
  app.post("/api/predicthq/refresh", async (_req, res) => {
    try {
      const result = await refreshPredictHQEvents();
      const status = getPredictHQStatus();
      res.json({ success: true, ...result, status_detail: status });
    } catch (e: any) {
      res.status(200).json({ success: false, count: 0, error: e?.message ?? "Erreur lors du refresh" });
    }
  });

  // ─── Synthèse PredictHQ par zone VTC ────────────────────────────────────────
  // GET /api/predicthq/zones-summary
  // Pour chaque zone VTC : nb d'events actifs, boost max, top event (rank le plus
  // élevé) et niveau de demande qualitatif dérivé du boost max.
  //   demand_level : boost < 1.2 → low, < 1.5 → medium, < 2.0 → high, >= 2.0 → extreme.
  app.get("/api/predicthq/zones-summary", async (_req, res) => {
    const demandLevel = (boost: number): "low" | "medium" | "high" | "extreme" => {
      if (boost >= 2.0) return "extreme";
      if (boost >= 1.5) return "high";
      if (boost >= 1.2) return "medium";
      return "low";
    };

    // Events PredictHQ actifs indexés par zone (non bloquant : fallback SQLite).
    const eventsByZone: Record<string, any[]> = {};
    try {
      const phqEvents = await getActivePredictHQEvents();
      for (const ev of phqEvents) {
        (eventsByZone[ev.zone_id] ||= []).push(ev);
      }
    } catch {
      try {
        const fromDb = storage.getActivePredictHQEvents();
        for (const ev of fromDb) {
          if (!ev.is_active) continue;
          (eventsByZone[ev.zone_id] ||= []).push(ev);
        }
      } catch { /* aucun event */ }
    }

    // Une zone n'apparaît dans la synthèse que si elle a au moins un event actif.
    const zones = Object.entries(eventsByZone).map(([zoneId, evts]) => {
      let maxBoost = 1.0;
      let topEvent: any = null;
      for (const ev of evts) {
        const b = Number(ev.demand_boost) || 1.0;
        if (b > maxBoost) maxBoost = b;
        if (!topEvent || Number(ev.rank ?? 0) > Number(topEvent.rank ?? 0)) {
          topEvent = ev;
        }
      }
      maxBoost = Math.min(2.5, Math.round(maxBoost * 100) / 100);
      return {
        zone_id: zoneId,
        active_events: evts.length,
        max_boost: maxBoost,
        top_event: topEvent?.title ?? null,
        top_event_rank: topEvent ? Number(topEvent.rank ?? 0) : 0,
        top_event_start: topEvent?.start ?? null,
        demand_level: demandLevel(maxBoost),
      };
    });

    // Tri par boost décroissant (zones les plus sous tension en tête).
    zones.sort((a, b) => b.max_boost - a.max_boost);

    res.json({ zones, count: zones.length, fetched_at: new Date().toISOString() });
  });

  // ─── Analytics : refresh quotidien + diff historique ──────────────────────────
  app.get("/api/analytics/refresh", async (_req, res) => {
    try {
      const meta = storage.getSeedMeta();
      const diff = storage.getDailyDiff();
      const flightData = await getFlightDataCached();
      const now = new Date();
      const h = (now.getUTCHours()+2)%24;
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

  // ─── Admin reseed (alias pour CRON auto-retrain) ──────────────────────────────
  app.post("/api/admin/reseed", (_req, res) => {
    try {
      const result = storage.forceReseed();
      res.json({ ...result, message: "Auto-retrain reseed déclenché", triggered_by: "cron" });
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

  // ─── Historique scores par date et heure — utilisé par le CRON horaire ──────
  // GET /api/history?date=YYYY-MM-DD&hour=H
  // Retourne les scores historiques pour une date+heure données (depuis score_history)
  // Format réponse : { date, hour, zones: {zone_id: {...}}, list: [...], count }
  // 'list' = tableau compatible CRON b3ed8968 (même format que /api/profitability)
  app.get("/api/history", (req, res) => {
    try {
      const date = typeof req.query.date === "string" ? req.query.date
        : new Date(Date.now() - 86400000).toISOString().split("T")[0]; // J-1 par défaut
      const hour = req.query.hour !== undefined ? parseInt(String(req.query.hour)) : undefined;
      const rows = storage.getScoreHistory(date) as any[];
      const filtered = hour !== undefined ? rows.filter((r: any) => r.hour === hour) : rows;
      // day_type calculé depuis la date demandée (pas celui stocké en DB qui peut être erroné)
      const parsedDate = new Date(date + "T12:00:00Z"); // midi UTC pour éviter les décalages DST
      const correctDayType = [0, 6].includes(parsedDate.getDay()) ? "weekend" : "weekday";
      // Transformer en {zone_id: {...}} pour simplifier la consommation
      const byZone: Record<string, any> = {};
      const asList: any[] = [];
      for (const r of filtered) {
        const entry = {
          zone_id:            r.zone_id,
          profitability_index: r.profitability_index,
          demand_score:       r.demand_score,
          supply_score:       r.supply_score,
          surge_multiplier:   r.surge_multiplier,
          hour:               r.hour,
          day_type:           correctDayType, // forcé depuis la date
          seed_date:          r.seed_date,
        };
        byZone[r.zone_id] = entry;
        asList.push(entry);
      }
      res.json({ date, hour: hour ?? null, zones: byZone, list: asList, count: filtered.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Seeds / Auto-retraining ──────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/traffic
  // Retourne la densité trafic historique par zone pour une heure donnée,
  // avec ETA congestionné, facteur de congestion et seuil 1 min/km.
  // Query : ?hour=H (entier 0-23, défaut = heure courante CEST)
  // ────────────────────────────────────────────────────────────────────────────
  app.get("/api/traffic", (req, res) => {
    try {
      const hQuery = parseInt(req.query.hour as string ?? "", 10);
      const h = isNaN(hQuery) ? (new Date().getUTCHours()+2)%24 : Math.max(0, Math.min(23, hQuery));
      const lat = parseFloat(req.query.lat as string ?? "") || DEFAULT_ORIGIN.lat;
      const lng = parseFloat(req.query.lng as string ?? "") || DEFAULT_ORIGIN.lng;

      const zones = Object.keys(TRAFFIC_DENSITY);
      const result = zones.map(zoneId => {
        const cal = CALIBRATED_DATA[zoneId];
        const roadKm = cal?.road_km ?? 20;
        const congested = getCongestedETA(zoneId, roadKm, h);
        const breakEven = computeBreakEvenPenalty(zoneId, roadKm, congested.etaMin, congested.congestionFactor);
        return {
          zone_id:            zoneId,
          hour:               h,
          road_km:            roadKm,
          eta_min:            congested.etaMin,
          speed_kmh:          congested.speedKmH,
          congestion_factor:  congested.congestionFactor,
          congestion_label:   congested.congestionLabel,
          traffic_density:    getTrafficDensity(zoneId, h),
          min_per_km:         breakEven.minPerKm,
          break_even_ok:      breakEven.breakEvenOk,
          congestion_penalty: breakEven.penalty,
          // ETA de référence libre-flux (nuit h=2) pour comparaison
          eta_freeflow_min:   cal ? Math.round((roadKm / cal.speed_pm) * 60 * 2.4) : null,
        };
      });

      res.json({
        hour:      h,
        timestamp: new Date().toISOString(),
        zones:     result,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET  /api/seeds        — retourne les seeds overrides actifs persistés
  // POST /api/seeds/update — met à jour les seeds en SQLite + déclenche un reseed

  app.get("/api/seeds", (_req, res) => {
    try {
      const seeds = storage.getSeeds();
      res.json(seeds);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── GET /api/seeds/live — Seeds actives en temps réel (recalculées 3 min) ─
  // Retourne livePat complet : pour chaque zone, les seeds actuellement utilisées
  // par computeScore (fusion statiques + overrides dynamiques).
  // Inclut les métadonnées du dernier run (MAE avant/après, zones mises à jour).
  app.get("/api/seeds/live", (_req, res) => {
    try {
      const live = storage.getLiveSeeds();
      const meta = storage.getLiveSeedsMeta();
      // Résumé propre par zone : masquer les champs internes
      const summary: Record<string, any> = {};
      for (const [zoneId, pat] of Object.entries(live as Record<string, any>)) {
        summary[zoneId] = {
          peakHours:       pat.peakHours,
          demandBoost6_10: pat.demandBoost6_10  ?? 0,
          demandBoost10:   pat.demandBoost10    ?? 0,
          demandBoost11_14:pat.demandBoost11_14 ?? 0,
          demandBoost14_18:pat.demandBoost14_18 ?? 0,
          baseAvgDist:     pat.baseAvgDist,
          baseLongRide:    pat.baseLongRide,
          _live:           pat._live ?? false,
          _updated_at:     pat._updated_at ?? null,
        };
      }
      res.json({
        seeds: summary,
        meta: {
          last_update:    meta.last_update,
          mae_before:     Number(meta.mae_before.toFixed(2)),
          mae_after:      Number(meta.mae_after.toFixed(2)),
          zones_updated:  meta.zones_updated,
          run_count:      meta.run_count,
          refresh_interval_min: 3,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── GET /api/debug/hourly-overrides?zone_id=X — H1 diagnostic granulaire ──
  // Retourne les overrides/biais horaires actifs (h0..h23) pour une zone.
  // Chaque entrée : { hour, demand (résidu EMA α=0.30), supply, confidence, bias, n_samples }.
  app.get("/api/debug/hourly-overrides", (req, res) => {
    try {
      const zoneId = String(req.query.zone_id ?? "").trim();
      if (!zoneId) {
        return res.status(400).json({ error: "zone_id query param required" });
      }
      const overrides = storage.getHourlyOverrides(zoneId);
      res.json({
        zone_id: zoneId,
        ema_alpha_hourly: 0.30,
        safety_pct: 0.95,
        count: overrides.length,
        overrides,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/seeds/update", (req, res) => {
    try {
      const { seeds, trigger, mae_before, mae_after } = req.body as {
        seeds: Record<string, Record<string, number>>;
        trigger?: string;
        mae_before?: number;
        mae_after?: number;
      };
      if (!seeds || typeof seeds !== 'object') {
        return res.status(400).json({ error: 'seeds object required' });
      }
      const result = storage.updateSeeds(seeds, { trigger, mae_before, mae_after });
      // Reseed immédiat pour appliquer les nouveaux poids
      try { storage.forceReseed(); } catch (e) { console.warn('[seeds/update] forceReseed:', e); }
      res.json({
        success: true,
        zones_updated: result.zones_updated,
        zones: result.zones,
        trigger,
        mae_before,
        mae_after,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[seeds/update] error:', err);
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
      currentHourlyRatio: getHourlyRatio((new Date().getUTCHours()+2)%24),
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
      currentHour:        (now.getUTCHours()+2)%24,
      currentHourlyRatio: getHourlyRatio((now.getUTCHours()+2)%24),
      calibrationDate:    "2026-06-10",
      zonesCount:         Object.keys(CALIBRATED_DATA).length,
      cacheSource:        stats.tomtomHits > 0 ? "tomtom"
        : stats.googleAvailable ? "google"
        : (stats.osrmAvailable ? "osrm" : "calibrated"),
      ttlMinutes:         3,
    });
  });

  // GET /api/routing-status
  // État de la migration TomTom Routing : source active + connexion clé TomTom
  app.get("/api/routing-status", async (_req, res) => {
    const stats      = getCacheStats();
    const tomtomCred = storage.getPlatformCredential("tomtom");

    // ← PredictHQ : état connexion + nb events actifs + boost max. Non bloquant.
    let phqConnected = false;
    let phqActiveEvents = 0;
    let phqMaxBoost = 1.0;
    try {
      const phqStatus = getPredictHQStatus();
      phqConnected    = !!phqStatus.connected;
      phqActiveEvents = phqStatus.active_events ?? 0;
      phqMaxBoost     = phqStatus.max_boost ?? 1.0;
      // Fallback : recalcule le boost max depuis les events si non fourni.
      if ((!phqMaxBoost || phqMaxBoost <= 1.0)) {
        try {
          const evts = await getActivePredictHQEvents();
          if (evts.length) {
            phqMaxBoost = Math.max(1.0, ...evts.map((e: any) => e.demand_boost ?? 1.0));
            if (!phqActiveEvents) phqActiveEvents = evts.length;
          }
        } catch { /* non bloquant */ }
      }
    } catch { /* stub indisponible → valeurs neutres */ }

    res.json({
      ...stats,
      lastRefresh:         routingLastRefresh.toISOString(),
      nextRefresh:         routingNextRefresh.toISOString(),
      ttlMinutes:          3,
      tomtom_connected:    !!(tomtomCred?.api_key && tomtomCred.status === "connected"),
      tomtom_source_active: stats.tomtomHits > 0,
      tomtom_key_configured: !!(tomtomCred?.api_key && tomtomCred.api_key.length > 5),
      tomtom_status:       tomtomCred?.status ?? "unconfigured",
      routing_priority:    stats.tomtomAvailable ? "tomtom" : stats.osrmAvailable ? "osrm" : "calibrated",
      activeSource:        stats.tomtomHits > 0 ? "tomtom"
        : stats.googleAvailable ? "google"
        : (stats.osrmAvailable ? "osrm" : "calibrated"),
      // ← Champs PredictHQ
      predicthq_connected:    phqConnected,
      predicthq_active_events: phqActiveEvents,
      predicthq_max_boost:    Math.round(phqMaxBoost * 100) / 100,
    });
  });

  // ─── PredictHQ — aperçu du boost events par zone ────────────────────────────
  // GET /api/predicthq/boost-preview?hour=10
  // Retourne, pour les 14 zones, le boost PredictHQ, le boost vols et le boost
  // combiné (cap 2.5×), avec la liste des events PredictHQ actifs de la zone.
  app.get("/api/predicthq/boost-preview", async (req, res) => {
    const _hourRaw = parseInt(req.query.hour as string);
    const hour = isNaN(_hourRaw) ? (new Date().getUTCHours() + 2) % 24 : _hourRaw;
    const zones = storage.getAllZones() as any[];

    // Données vols (non bloquant) pour calculer le flight_boost par zone.
    let flightData: any = null;
    try { flightData = await getFlightDataCached(); } catch { flightData = null; }

    // Events PredictHQ actifs indexés par zone (non bloquant : stub → vide).
    const eventsByZone: Record<string, any[]> = {};
    try {
      const phqEvents = await getActivePredictHQEvents();
      for (const ev of phqEvents) {
        (eventsByZone[ev.zone_id] ||= []).push(ev);
      }
    } catch { /* aucun event */ }

    const preview = await Promise.all(zones.map(async (z: any) => {
      const flightBoost = flightData ? getFlightBoostForZone(z.id, flightData) : 1.0;
      let phqBoost = 1.0;
      try { phqBoost = await getEventBoostForZone(z.id, hour); } catch { phqBoost = 1.0; }
      const combinedBoost = combinePredictHQBoost(flightBoost, phqBoost);
      return {
        zone_id: z.id,
        zone_name: z.name,
        phq_boost: Math.round(phqBoost * 100) / 100,
        flight_boost: Math.round(flightBoost * 100) / 100,
        combined_boost: Math.round(combinedBoost * 100) / 100,
        events: eventsByZone[z.id] ?? [],
      };
    }));

    res.json(preview);
  });

  // ─── Cache routing — stats et refresh admin ─────────────────────────────────
  // GET /api/routing-cache/stats
  app.get("/api/routing-cache/stats", (_req, res) => {
    const stats = getCacheStats();
    res.json({
      ...stats,
      lastRefresh:  routingLastRefresh.toISOString(),
      nextRefresh:  routingNextRefresh.toISOString(),
      ttlMinutes:   3,
      costEstimate: {
        tomtomPerMonth: stats.tomtomAvailable
          ? "0€ (free tier 2500 req/jour)"
          : "N/A (clé non configurée)",
        osrmPerMonth:   "0€ (gratuit, open source)",
        googlePerMonth: stats.googleAvailable
          ? "~75€ brut → FREE TIER (crédit 200$/mois)"
          : "N/A (clé non configurée)",
        reduction:      "cache 3min × 14 zones (trafic temps réel)",
        apiCallsSaved:  `${Math.round(stats.refreshCount * 14)} appels routing depuis le démarrage`,
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
      routingNextRefresh = new Date(Date.now() + ROUTING_REFRESH_MS);
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

  // ─── Mise à jour de l'origine routing depuis la vraie position GPS ─────────────
  // POST /api/routing/update-origin
  // Body: { lat: number, lng: number }
  // Invalide le cache des zones depuis l'ancienne origine (DEFAULT_ORIGIN / Bd Ney)
  // et recalcule l'ETA/distance de toutes les zones depuis la nouvelle position.
  // Appelé par le frontend quand le chauffeur s'est déplacé de plus de 500m.
  app.post("/api/routing/update-origin", async (req, res) => {
    const { lat, lng } = req.body as { lat: number; lng: number };
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat/lng requis" });
    }
    // Invalider le cache des zones depuis l'ancienne origine
    // et recalculer depuis la nouvelle position
    try {
      invalidateCache();
      const result = await refreshAllZones(lat, lng, GOOGLE_MAPS_KEY || undefined);
      routingLastRefresh = new Date();
      routingNextRefresh = new Date(Date.now() + ROUTING_REFRESH_MS);
      routingRefreshCount++;
      console.log(`[routing-cache] Origine GPS mise à jour (${lat.toFixed(4)},${lng.toFixed(4)}) — ${result.refreshed} zones via ${result.source} en ${result.durationMs}ms`);
      res.json({ ok: true, zones: result.refreshed, source: result.source });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Meilleur Trajet — calcul itinéraire rentable depuis position GPS ──────────
  // GET /api/best-route?from_lat=...&from_lng=...  (alias pratique pour tests)
  // Injecte lat/lng dans req.body puis passe la main au POST handler
  app.use("/api/best-route", (req: any, _res: any, next: any) => {
    if (req.method === 'GET') {
      const lat = parseFloat((req.query.from_lat ?? req.query.lat) as string);
      const lng = parseFloat((req.query.from_lng ?? req.query.lng) as string);
      if (!isNaN(lat) && !isNaN(lng)) {
        req.body = { lat, lng };
        req.method = 'POST'; // forcer le POST handler
      }
    }
    next();
  });

  // POST /api/best-route
  // Body: { lat: number, lng: number }
  app.post("/api/best-route", async (req, res) => {
    try {
      const { lat, lng } = req.body as { lat: number; lng: number };
      if (typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ error: "lat et lng requis (number)" });
      }

      const hour = (new Date().getUTCHours()+2)%24;
      const dayType = [0, 6].includes(new Date().getDay()) ? "weekend" : "weekday";
      const zones = storage.getAllZones() as any[];
      const scores = storage.getProfitabilityByHour(hour, dayType) as any[];

      let flightData: any = null;
      try { flightData = await getFlightDataCached(); } catch { /* non bloquant */ }

      // ← PredictHQ : events actifs indexés par zone (titre du plus gros event/zone)
      let phqEventsByZone: Record<string, any> = {};
      try {
        const phqEvents = await getActivePredictHQEvents();
        for (const ev of phqEvents) {
          const cur = phqEventsByZone[ev.zone_id];
          if (!cur || (ev.rank ?? 0) > (cur.rank ?? 0)) phqEventsByZone[ev.zone_id] = ev;
        }
      } catch { phqEventsByZone = {}; }
      const currentHour = hour;

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

      const results = await Promise.all(zones.map(async (z: any) => {
        const straightKm = haversineKm(lat, lng, z.lat, z.lng);

        // ── Distances et ETA depuis routingCache (OSRM / Google / calibré) ────────
        // Calculé en parallèle (Promise.all) depuis la vraie position GPS utilisateur
        const rcEntry = await getRouteForZone(z.id, lat, lng, GOOGLE_MAPS_KEY || undefined);

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

        // ← PredictHQ : boost events pour cette zone (1.0 si aucun). Non bloquant.
        let phqBoost = 1.0;
        try { phqBoost = await getEventBoostForZone(z.id, currentHour); } catch { phqBoost = 1.0; }
        const phqEvent = phqEventsByZone[z.id];
        // Boost combiné flight × PredictHQ, plafonné à 2.5×
        const combinedBoost = combinePredictHQBoost(flightBoost, phqBoost);

        // Pénalité distance routière (km réels)
        const distancePenalty = distanceKm <= 3 ? 1.0
          : distanceKm <= 8 ? 0.93
          : distanceKm <= 15 ? 0.82
          : distanceKm <= 25 ? 0.70
          : distanceKm <= 40 ? 0.55
          : 0.35;

        // Score et revenu calculés sur le boost COMBINÉ (flight × PredictHQ)
        const globalScore = Math.round(profitIdx * distancePenalty * surge * combinedBoost);
        const estimatedRevenue = Math.round(avgFare * surge * combinedBoost * 100) / 100;

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

        // Congestion en temps réel pour cette zone à l'heure courante
        const roadKmZ     = CALIBRATED_DATA[z.id]?.road_km ?? distanceKm;
        const congestedZ  = getCongestedETA(z.id, roadKmZ, hour);
        const breakEvenZ  = computeBreakEvenPenalty(z.id, roadKmZ, congestedZ.etaMin, congestedZ.congestionFactor);

        return {
          zone: z,
          distanceKm,
          etaMinutes,
          profitabilityIndex: profitIdx,
          surgeMultiplier: Math.round(surge * 100) / 100,
          flightBoost: Math.round(flightBoost * 100) / 100,
          // ← Champs PredictHQ
          phq_boost: Math.round(phqBoost * 100) / 100,
          phq_event_title: phqBoost > 1.0 && phqEvent ? phqEvent.title : null,
          combined_event_boost: Math.round(combinedBoost * 100) / 100,
          avgFare: Math.round(avgFare * 100) / 100,
          longRideProbability: Math.round(longRide * 100) / 100,
          ratioDO: Math.round(ratio * 100) / 100,
          globalScore,
          estimatedRevenue,
          reason,
          // Source des données de distance/ETA (tomtom / osrm / google / calibrated)
          distanceSource: rcEntry.source ?? "calibrated",
          // Trafic historique — densité de congestion par zone
          congestionFactor:  congestedZ.congestionFactor,
          congestionLabel:   congestedZ.congestionLabel,
          minPerKm:          breakEvenZ.minPerKm,
          breakEvenOk:       breakEvenZ.breakEvenOk,
          congestionPenalty: breakEvenZ.penalty,
          waypoints: [
            { lat, lng, label: "Votre position" },
            { lat: z.lat, lng: z.lng, label: z.name },
          ],
        };
      }));

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


  // ─── Propositions chronologiques par événement (Trajet enrichi) ──────────
  // POST /api/best-route/event-schedule
  // Body: { lat: number, lng: number, clickedAt: string (ISO) }
  // Retourne, pour chaque événement actif, la liste des créneaux de positionnement
  // triés chronologiquement avec heure de départ recommandée depuis la position GPS.
  app.post("/api/best-route/event-schedule", async (req, res) => {
    try {
      const { lat, lng, clickedAt } = req.body as { lat: number; lng: number; clickedAt: string };
      if (typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ error: "lat et lng requis" });
      }

      const clickTs = clickedAt ? new Date(clickedAt) : new Date();
      const now = new Date();
      const zones = storage.getAllZones() as any[];
      const zoneMap: any = Object.fromEntries(zones.map((z: any) => [z.id, z]));

      // ── Haversine helper ─────────────────────────────────────────────────────
      const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      // ETA vers une zone (utilise le routingCache en priorité)
      const getEtaToZone = (zoneId: string, zLat: number, zLng: number): { etaMin: number; distKm: number } => {
        const cached = getCachedRoute(zoneId, lat, lng);
        if (cached.etaMin > 0 && cached.roadKm > 0) {
          return { etaMin: cached.etaMin, distKm: cached.roadKm };
        }
        const straightKm = haversineKm(lat, lng, zLat, zLng);
        const road = Math.round(straightKm * (ROAD_FACTOR[zoneId] ?? 1.35) * 10) / 10;
        const eta = Math.max(3, Math.round(road / 20 * 60));
        return { etaMin: eta, distKm: road };
      };

      // ── Données de vols ───────────────────────────────────────────────────────
      let flightData: any = null;
      try { flightData = await getFlightDataCached(); } catch {}

      // ── Événements statiques DB ───────────────────────────────────────────────
      const dbEvents = storage.getActiveEvents() as any[];

      // ── Construction des blocs par événement ──────────────────────────────────
      interface Slot {
        slotId: string;
        label: string;          // ex: "Vol AF447 — 14h35"
        eventTime: string;      // ISO — heure de l'événement réel (atterrissage, concert, etc.)
        departAt: string;       // ISO — quand le chauffeur doit partir
        arriveBy: string;       // ISO — heure d'arrivée prévue sur zone
        etaMin: number;
        distKm: number;
        bufferMin: number;      // marge tampon avant l'événement
        urgency: "now" | "soon" | "upcoming" | "later";
        detail?: string;        // infos complémentaires (provenance vol, etc.)
        flightCallsign?: string;
        flightOrigin?: string;
      }

      interface EventBlock {
        eventId: string | number;
        eventName: string;
        zoneId: string;
        zoneName: string;
        zoneType: string;
        zoneLat: number;
        zoneLng: number;
        etaMin: number;
        distKm: number;
        demandBoost: number;
        eventType: string;
        clickedAt: string;      // timestamp exact du clic chauffeur
        slots: Slot[];          // propositions chronologiques
        mapsUrl: string;
      }

      const eventBlocks: EventBlock[] = [];

      // ── Helper urgency ─────────────────────────────────────────────────────────
      const computeUrgency = (departAt: Date): Slot["urgency"] => {
        const diffMin = (departAt.getTime() - now.getTime()) / 60000;
        if (diffMin <= 5) return "now";
        if (diffMin <= 20) return "soon";
        if (diffMin <= 60) return "upcoming";
        return "later";
      };

      const fmtTime = (d: Date) =>
        d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      // ── 1. Événements AÉROPORTS (CDG + Orly) avec vols réels ─────────────────
      const airportZones = [
        { id: "z_cdg",  label: "CDG — Charles-de-Gaulle", lat: 49.0097, lng: 2.5479, bufferMin: 20 },
        { id: "z_orly", label: "Orly — Terminal Sud/Ouest", lat: 48.7262, lng: 2.3652, bufferMin: 15 },
      ];

      for (const ap of airportZones) {
        const { etaMin, distKm } = getEtaToZone(ap.id, ap.lat, ap.lng);
        const airportFlights = flightData?.flights?.filter((f: any) => f.airport === (ap.id === "z_cdg" ? "CDG" : "ORLY")) || [];
        const apStats = ap.id === "z_cdg" ? flightData?.cdg : flightData?.orly;

        // Générer les slots depuis les vols réels/simulés (triés par heure d'arrivée)
        const slots: Slot[] = [];

        if (airportFlights.length > 0) {
          // Trier les vols par heure d'arrivée estimée
          const sorted = [...airportFlights].sort((a: any, b: any) =>
            (a.arrival_time || 0) - (b.arrival_time || 0)
          );

          for (const flight of sorted.slice(0, 6)) {
            const arrEpoch = flight.arrival_time ? flight.arrival_time * 1000 : now.getTime() + 30 * 60000;
            const arrivalDate = new Date(arrEpoch);

            // Heure de départ = heure d'arrivée vol - ETA chauffeur - buffer
            const departTs = new Date(arrivalDate.getTime() - (etaMin + ap.bufferMin) * 60000);
            const arriveTs = new Date(departTs.getTime() + etaMin * 60000);

            // Ne garder que les slots futurs (département dans les 3h)
            const diffMin = (departTs.getTime() - now.getTime()) / 60000;
            if (diffMin < -5 || diffMin > 180) continue;

            slots.push({
              slotId: `${ap.id}_${flight.callsign}`,
              label: `✈️ ${flight.callsign} — arrivée ${fmtTime(arrivalDate)}`,
              eventTime: arrivalDate.toISOString(),
              departAt: departTs.toISOString(),
              arriveBy: arriveTs.toISOString(),
              etaMin,
              distKm,
              bufferMin: ap.bufferMin,
              urgency: computeUrgency(departTs),
              detail: flight.origin_airport ? `Provenance : ${flight.origin_airport}` : undefined,
              flightCallsign: flight.callsign,
              flightOrigin: flight.origin_airport,
            });
          }
        }

        // Toujours ajouter des slots heuristiques basés sur la prochaine vague
        if (apStats?.next_wave_eta) {
          const waveDate = new Date(apStats.next_wave_eta);
          const departTs = new Date(waveDate.getTime() - (etaMin + ap.bufferMin) * 60000);
          const arriveTs = new Date(departTs.getTime() + etaMin * 60000);
          const diffMin = (departTs.getTime() - now.getTime()) / 60000;
          if (diffMin > -5 && diffMin < 180) {
            slots.push({
              slotId: `${ap.id}_wave`,
              label: `🌊 Vague d'arrivées — ${fmtTime(waveDate)}`,
              eventTime: waveDate.toISOString(),
              departAt: departTs.toISOString(),
              arriveBy: arriveTs.toISOString(),
              etaMin,
              distKm,
              bufferMin: ap.bufferMin,
              urgency: computeUrgency(departTs),
              detail: `${apStats.arrivals_next_hour} arrivées/h prévues — ${apStats.peak_level?.toUpperCase()}`,
            });
          }
        }

        // Fallback : créneaux toutes les 30min si pas de données
        if (slots.length === 0) {
          for (let delta = 30; delta <= 150; delta += 30) {
            const eventDate = new Date(now.getTime() + delta * 60000);
            const departTs = new Date(eventDate.getTime() - (etaMin + ap.bufferMin) * 60000);
            const arriveTs = new Date(departTs.getTime() + etaMin * 60000);
            if ((departTs.getTime() - now.getTime()) / 60000 < -5) continue;
            slots.push({
              slotId: `${ap.id}_t${delta}`,
              label: `🕐 Créneau estimé — ${fmtTime(eventDate)}`,
              eventTime: eventDate.toISOString(),
              departAt: departTs.toISOString(),
              arriveBy: arriveTs.toISOString(),
              etaMin, distKm, bufferMin: ap.bufferMin,
              urgency: computeUrgency(departTs),
            });
          }
        }

        // Trier par heure de départ
        slots.sort((a, b) => new Date(a.departAt).getTime() - new Date(b.departAt).getTime());

        if (slots.length > 0) {
          eventBlocks.push({
            eventId: ap.id,
            eventName: ap.label,
            zoneId: ap.id,
            zoneName: ap.label,
            zoneType: "airport",
            zoneLat: ap.lat,
            zoneLng: ap.lng,
            etaMin,
            distKm,
            demandBoost: apStats?.vtc_demand_boost ?? 1.0,
            eventType: "airport",
            clickedAt: clickTs.toISOString(),
            slots,
            mapsUrl: `https://www.google.com/maps/dir/${lat},${lng}/${ap.lat},${ap.lng}`,
          });
        }
      }

      // ── 2. Événements statiques (matchs, concerts, salons) ────────────────────
      for (const ev of dbEvents) {
        // Skip les événements aéroport déjà traités
        if (ev.zone_id === "z_cdg" || ev.zone_id === "z_orly") continue;

        const zone = zoneMap[ev.zone_id];
        if (!zone) continue;

        const { etaMin, distKm } = getEtaToZone(zone.id, zone.lat, zone.lng);
        const evStart = new Date(ev.start_time);
        const evEnd = ev.end_time ? new Date(ev.end_time) : new Date(evStart.getTime() + 3 * 3600000);

        // Buffer selon type d'événement
        const bufferMap: Record<string, number> = {
          match: 30, concert: 25, salon: 20, festival: 20,
          congres: 15, transport: 10, default: 15
        };
        const bufferMin = bufferMap[ev.event_type] || bufferMap.default;

        const slots: Slot[] = [];

        // Slot 1 : Positionnement avant le début (entrée du public)
        const preStart = new Date(evStart.getTime() - bufferMin * 60000);
        const departPre = new Date(preStart.getTime() - etaMin * 60000);
        if ((departPre.getTime() - now.getTime()) / 60000 > -10 &&
            (departPre.getTime() - now.getTime()) / 60000 < 240) {
          slots.push({
            slotId: `${ev.id}_pre`,
            label: `🟢 Avant début — arrivée prévue ${fmtTime(preStart)}`,
            eventTime: evStart.toISOString(),
            departAt: departPre.toISOString(),
            arriveBy: new Date(departPre.getTime() + etaMin * 60000).toISOString(),
            etaMin, distKm, bufferMin,
            urgency: computeUrgency(departPre),
            detail: `${ev.expected_attendance ? ev.expected_attendance.toLocaleString("fr-FR") + " personnes attendues" : ""}`,
          });
        }

        // Slot 2 : Mi-événement (rotation chauffeurs)
        const midEvent = new Date((evStart.getTime() + evEnd.getTime()) / 2);
        const departMid = new Date(midEvent.getTime() - etaMin * 60000);
        if ((departMid.getTime() - now.getTime()) / 60000 > -10 &&
            (departMid.getTime() - now.getTime()) / 60000 < 240) {
          slots.push({
            slotId: `${ev.id}_mid`,
            label: `🔄 Mi-événement — ${fmtTime(midEvent)}`,
            eventTime: midEvent.toISOString(),
            departAt: departMid.toISOString(),
            arriveBy: new Date(departMid.getTime() + etaMin * 60000).toISOString(),
            etaMin, distKm, bufferMin: 0,
            urgency: computeUrgency(departMid),
            detail: "Rotation — bonne densité de demande",
          });
        }

        // Slot 3 : Fin d'événement (sortie masse)
        const departEnd = new Date(evEnd.getTime() - etaMin * 60000 - 10 * 60000);
        if ((departEnd.getTime() - now.getTime()) / 60000 > -10 &&
            (departEnd.getTime() - now.getTime()) / 60000 < 240) {
          slots.push({
            slotId: `${ev.id}_end`,
            label: `🏁 Sortie — ${fmtTime(evEnd)}`,
            eventTime: evEnd.toISOString(),
            departAt: departEnd.toISOString(),
            arriveBy: new Date(departEnd.getTime() + etaMin * 60000).toISOString(),
            etaMin, distKm, bufferMin: 10,
            urgency: computeUrgency(departEnd),
            detail: "Pic de demande à la sortie",
          });
        }

        slots.sort((a, b) => new Date(a.departAt).getTime() - new Date(b.departAt).getTime());

        if (slots.length > 0) {
          eventBlocks.push({
            eventId: ev.id,
            eventName: ev.name,
            zoneId: ev.zone_id,
            zoneName: zone.name,
            zoneType: zone.type || "entertainment",
            zoneLat: zone.lat,
            zoneLng: zone.lng,
            etaMin,
            distKm,
            demandBoost: ev.demand_boost ?? 1.0,
            eventType: ev.event_type,
            clickedAt: clickTs.toISOString(),
            slots,
            mapsUrl: `https://www.google.com/maps/dir/${lat},${lng}/${zone.lat},${zone.lng}`,
          });
        }
      }

      // Trier les blocs par prochain slot disponible
      eventBlocks.sort((a, b) => {
        const aNext = a.slots[0]?.departAt || "9999";
        const bNext = b.slots[0]?.departAt || "9999";
        return aNext.localeCompare(bNext);
      });

      res.json({
        userPosition: { lat, lng },
        clickedAt: clickTs.toISOString(),
        computedAt: new Date().toISOString(),
        eventBlocks,
      });

    } catch (err) {
      console.error("[event-schedule] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });


  // ═════════════════════════════════════════════════════════════════════════════
  // POST /api/smart-plan
  // Planification intelligente : croise vols temps réel CDG/Orly, position GPS,
  // alertes top4, chronologie journée et calcule le créneau optimal de départ.
  // Body: { lat: number, lng: number, clickedAt: string (ISO) }
  // ═════════════════════════════════════════════════════════════════════════════
  app.post("/api/smart-plan", async (req, res) => {
    try {
      const { lat, lng, clickedAt } = req.body as { lat: number; lng: number; clickedAt: string };
      if (typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ error: "lat et lng requis" });
      }

      const clickTs    = clickedAt ? new Date(clickedAt) : new Date();
      const now        = new Date();
      const hour       = (now.getUTCHours()+2)%24;
      const dayType    = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";
      const dayOfWeek  = now.getDay();

      // ── Helpers puṙement locaux ──────────────────────────────────────────────
      const haversineKm = (la1: number, ln1: number, la2: number, ln2: number) => {
        const R = 6371, dLat = (la2 - la1) * Math.PI / 180, dLng = (ln2 - ln1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      const etaToZone = (zoneId: string, zLat: number, zLng: number): { etaMin: number; distKm: number; distanceSource: string } => {
        const cached = getCachedRoute(zoneId, lat, lng);
        if (cached.etaMin > 0 && cached.roadKm > 0) return { etaMin: cached.etaMin, distKm: cached.roadKm, distanceSource: cached.source ?? "calibrated" };
        const straight = haversineKm(lat, lng, zLat, zLng);
        const road     = Math.round(straight * (ROAD_FACTOR[zoneId] ?? 1.35) * 10) / 10;
        const eta      = Math.max(3, Math.round(road / 20 * 60));
        return { etaMin: eta, distKm: road, distanceSource: "calibrated" };
      };

      const addMins = (base: Date, mins: number): Date => new Date(base.getTime() + mins * 60000);
      const fmt     = (d: Date) => d.toISOString();
      const fmtHM   = (d: Date) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Paris" });

      // ── Données de vols (étapes) ────────────────────────────────────────────
      let flightData: any = null;
      try { flightData = await getFlightDataCached(); } catch {}

      // ── Zones de référence (étapes) ─────────────────────────────────────────
      const zones = storage.getAllZones() as any[];
      const zoneMap: Record<string, any> = Object.fromEntries(zones.map((z: any) => [z.id, z]));

      // ── Alertes top 4 actives (étapes) ─────────────────────────────────────
      const allAlerts = storage.getActiveAlerts() as any[];
      const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
      const top4Alerts = allAlerts
        .filter((a: any) => !a.is_read && new Date(a.expires_at) > now)
        .sort((a: any, b: any) => (PRIORITY_ORDER[a.priority as keyof typeof PRIORITY_ORDER] ?? 4) - (PRIORITY_ORDER[b.priority as keyof typeof PRIORITY_ORDER] ?? 4))
        .slice(0, 4)
        .map((a: any) => ({
          id:               a.id,
          type:             a.type,
          title:            a.title,
          message:          a.message,
          zone_id:          a.zone_id,
          priority:         a.priority,
          estimated_revenue: a.estimated_revenue,
          expires_at:       a.expires_at,
          created_at:       a.created_at,
          is_read:          a.is_read,
          // Enrichir avec ETA depuis position GPS
          ...(a.zone_id && zoneMap[a.zone_id] ? (() => {
            const z = zoneMap[a.zone_id];
            const { etaMin, distKm } = etaToZone(a.zone_id, z.lat, z.lng);
            const departAt = addMins(now, Math.max(0, etaMin - 3));
            return { etaMin, distKm, departAt: fmt(departAt), departAtHM: fmtHM(departAt) };
          })() : {}),
        }));

      // ── Scores horairesp our chaque heure 6h-23h (étapes) ─────────────────
      const AIRPORT_ZONES = [
        { id: "z_cdg",  ap: "CDG", buffer: 20 },
        { id: "z_orly", ap: "ORLY", buffer: 15 },
      ];

      // ── Événements DB actifs (étapes) ───────────────────────────────────────
      const dbEvents = storage.getActiveEvents() as any[];

      // ── CHRONOLOGIE JOURNÉE ──────────────────────────────────────────────
      // Construit une timeline heure par heure jusqu'à 23h (depuis l'heure actuelle)
      // en croisant : vols CDG/Orly + événements DB + pattern heuristique
      interface TimelineEntry {
        time:          string;          // ISO
        timeHM:        string;          // "HH:MM"
        hour:          number;
        type:          "flight_wave" | "event_start" | "event_end" | "peak_start" | "peak_end" | "rush" | "dead_zone";
        label:         string;
        zoneId:        string;
        zoneName:      string;
        etaMin:        number;
        distKm:        number;
        expectedDemand:  number;         // score 0-100
        estimatedRevenue: number;        // €/h estimé
        recommendation: string;          // texte action
        priority:      "critical" | "high" | "medium" | "low";
        departAt:      string;           // ISO
        departAtHM:    string;           // "HH:MM"
        flightData?:   { arrivals: number; peak: string; nextWave?: string; paxVtc: number };
        isNow:         boolean;
        isPast:        boolean;
      }

      const timeline: TimelineEntry[] = [];

      // — Vols CDG/Orly : scanner chaque heure restante dans la journée
      const CDG_PAX_PER_FLIGHT_RATE = 165 * 0.12;  // ~20 passagers VTC/vol
      const ORLY_PAX_PER_FLIGHT_RATE = 140 * 0.09; // ~13 passagers VTC/vol

      const CDG_HOURLY: Record<number, number> = {
        6:12, 7:18, 8:22, 9:24, 10:26, 11:24, 12:22, 13:24, 14:26, 15:28, 16:30, 17:28, 18:26, 19:24, 20:22, 21:18, 22:12, 23:6
      };
      const ORLY_HOURLY: Record<number, number> = {
        6:2, 7:6, 8:10, 9:12, 10:10, 11:8, 12:8, 13:10, 14:12, 15:14, 16:16, 17:14, 18:12, 19:10, 20:8, 21:6, 22:4, 23:2
      };

      // ETA vers CDG et Orly depuis la position actuelle
      const cdgZone  = zoneMap["z_cdg"];
      const orlyZone = zoneMap["z_orly"];
      const etaCdg   = cdgZone  ? etaToZone("z_cdg",  cdgZone.lat,  cdgZone.lng)  : { etaMin: 25, distKm: 26, distanceSource: "calibrated" };
      const etaOrly  = orlyZone ? etaToZone("z_orly", orlyZone.lat, orlyZone.lng) : { etaMin: 35, distKm: 30, distanceSource: "calibrated" };

      // Pour chaque heure à venir (et actuelle)
      for (let h = Math.max(6, hour); h <= 23; h++) {
        const slotTime = new Date(now);
        slotTime.setHours(h, 0, 0, 0);
        const isPast = slotTime < now && h < hour;
        const isNow  = h === hour;

        // — CDG —
        const cdgArrivals = CDG_HOURLY[h] ?? 0;
        if (cdgArrivals > 0 && cdgZone) {
          const vtcPax = Math.round(cdgArrivals * CDG_PAX_PER_FLIGHT_RATE);
          const demand = Math.min(100, Math.round(cdgArrivals / 30 * 100));
          const flightPeak = cdgArrivals >= 26 ? "surge" : cdgArrivals >= 18 ? "high" : "medium";
          const surgeBoost = cdgArrivals >= 26 ? 3.5 : cdgArrivals >= 18 ? 2.4 : 1.6;
          const netH = 62 * surgeBoost * 0.75 - etaCdg.distKm * 0.224 / Math.max((80 + etaCdg.etaMin) / 60, 0.5);
          // Départ recommandé : arriver 20min avant l'heure d'arrivée des vols (buffer CDG)
          const idealArrival   = new Date(slotTime.getTime() - 20 * 60000);
          const departForCdg   = new Date(idealArrival.getTime() - etaCdg.etaMin * 60000);
          const depInFuture    = departForCdg > now;
          const urgency: "critical"|"high"|"medium"|"low" = !depInFuture ? "critical"
            : (departForCdg.getTime() - now.getTime()) < 15 * 60000 ? "critical"
            : (departForCdg.getTime() - now.getTime()) < 30 * 60000 ? "high"
            : (departForCdg.getTime() - now.getTime()) < 60 * 60000 ? "medium" : "low";

          timeline.push({
            time:         fmt(slotTime),
            timeHM:       fmtHM(slotTime),
            hour:         h,
            type:         cdgArrivals >= 26 ? "flight_wave" : "peak_start",
            label:        `CDG — ${cdgArrivals} arrivées (${vtcPax} passagers VTC estimés)`,
            zoneId:       "z_cdg",
            zoneName:     "CDG — Charles-de-Gaulle",
            etaMin:       etaCdg.etaMin,
            distKm:       etaCdg.distKm,
            expectedDemand: demand,
            estimatedRevenue: Math.round(netH * 10) / 10,
            recommendation: `Partir à ${fmtHM(departForCdg)} → arriver avant ${fmtHM(idealArrival)} (buffer 20min)`,
            priority:     urgency,
            departAt:     fmt(departForCdg),
            departAtHM:   fmtHM(departForCdg),
            flightData:   { arrivals: cdgArrivals, peak: flightPeak, paxVtc: vtcPax,
                           nextWave: flightData?.cdg?.next_wave_eta },
            isNow,
            isPast,
          });
        }

        // — Orly —
        const orlyArrivals = ORLY_HOURLY[h] ?? 0;
        if (orlyArrivals > 0 && orlyZone) {
          const vtcPax = Math.round(orlyArrivals * ORLY_PAX_PER_FLIGHT_RATE);
          const demand = Math.min(100, Math.round(orlyArrivals / 16 * 100));
          const flightPeak = orlyArrivals >= 14 ? "surge" : orlyArrivals >= 9 ? "high" : "medium";
          const surgeBoost = orlyArrivals >= 14 ? 2.8 : orlyArrivals >= 9 ? 2.0 : 1.4;
          const netH = 44 * surgeBoost * 0.75 - etaOrly.distKm * 0.224 / Math.max((60 + etaOrly.etaMin) / 60, 0.5);
          const idealArrival = new Date(slotTime.getTime() - 15 * 60000);
          const departForOrly = new Date(idealArrival.getTime() - etaOrly.etaMin * 60000);
          const depInFuture = departForOrly > now;
          const urgency: "critical"|"high"|"medium"|"low" = !depInFuture ? "critical"
            : (departForOrly.getTime() - now.getTime()) < 15 * 60000 ? "critical"
            : (departForOrly.getTime() - now.getTime()) < 30 * 60000 ? "high"
            : (departForOrly.getTime() - now.getTime()) < 60 * 60000 ? "medium" : "low";

          timeline.push({
            time:         fmt(slotTime),
            timeHM:       fmtHM(slotTime),
            hour:         h,
            type:         orlyArrivals >= 12 ? "flight_wave" : "peak_start",
            label:        `Orly — ${orlyArrivals} arrivées (${vtcPax} passagers VTC estimés)`,
            zoneId:       "z_orly",
            zoneName:     "Orly — Terminal Sud/Ouest",
            etaMin:       etaOrly.etaMin,
            distKm:       etaOrly.distKm,
            expectedDemand: demand,
            estimatedRevenue: Math.round(netH * 10) / 10,
            recommendation: `Partir à ${fmtHM(departForOrly)} → arriver avant ${fmtHM(idealArrival)} (buffer 15min)`,
            priority:     urgency,
            departAt:     fmt(departForOrly),
            departAtHM:   fmtHM(departForOrly),
            flightData:   { arrivals: orlyArrivals, peak: flightPeak, paxVtc: vtcPax,
                           nextWave: flightData?.orly?.next_wave_eta },
            isNow,
            isPast,
          });
        }

        // — Événements DB actifs sur ce créneau —
        for (const ev of dbEvents) {
          const evStart = new Date(ev.start_time);
          const evEnd   = new Date(ev.end_time);
          const evH     = evStart.getHours();
          const evZ     = zoneMap[ev.zone_id];
          if (!evZ || ev.zone_id === "z_cdg" || ev.zone_id === "z_orly") continue;

          // Générer 3 créneaux : ouverture, milieu, sortie
          const evSlots: Array<{ t: Date; type: TimelineEntry["type"]; label: string; rec: string }> = [
            { t: evStart, type: "event_start", label: `${ev.name} — Ouverture`, rec: `Se positionner près ${evZ.name} avant ${fmtHM(evStart)}` },
          ];
          const midTime = new Date((evStart.getTime() + evEnd.getTime()) / 2);
          evSlots.push({ t: midTime, type: "rush", label: `${ev.name} — Pic activité`, rec: `Zone ${evZ.name} — surge actif` });
          evSlots.push({ t: new Date(evEnd.getTime() - 30*60000), type: "event_end", label: `${ev.name} — Sortie imminente`, rec: `Positionner 30min avant la fin pour capter la vague sortie` });

          for (const sl of evSlots) {
            if (sl.t.getHours() !== h) continue;
            const { etaMin, distKm } = etaToZone(ev.zone_id, evZ.lat, evZ.lng);
            const departAt = new Date(sl.t.getTime() - etaMin * 60000 - 10 * 60000);
            const minsUntil = (departAt.getTime() - now.getTime()) / 60000;
            const evUrgency: "critical"|"high"|"medium"|"low" =
              minsUntil < 10 ? "critical" : minsUntil < 25 ? "high" : minsUntil < 55 ? "medium" : "low";
            const evBoost = ev.demand_boost ?? 1.0;
            timeline.push({
              time:            fmt(sl.t),
              timeHM:          fmtHM(sl.t),
              hour:            h,
              type:            sl.type,
              label:           sl.label,
              zoneId:          ev.zone_id,
              zoneName:        evZ.name,
              etaMin,
              distKm,
              expectedDemand:  Math.min(100, Math.round(evBoost * 35)),
              estimatedRevenue: Math.round(evBoost * 28 * 10) / 10,
              recommendation:  sl.rec,
              priority:        evUrgency,
              departAt:        fmt(departAt),
              departAtHM:      fmtHM(departAt),
              isNow:           h === hour,
              isPast:          sl.t < now,
            });
          }
        }
      }

      // Trier la timeline chronologiquement
      timeline.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

      // ── CRÉNEAU OPTIMAL ─────────────────────────────────────────────────────────
      // Trouver la prochaine opportunité maximale parmi les créneaux futurs
      // Score = expectedDemand × urgencyWeight × revenueWeight
      const URGENCY_W = { critical: 2.0, high: 1.5, medium: 1.0, low: 0.5 };
      const futurSlots = timeline.filter(t => !t.isPast && new Date(t.departAt) > now);

      let bestSlot = futurSlots[0] ?? null;
      let bestScore = -1;
      for (const slot of futurSlots) {
        const minutesUntilDepart = (new Date(slot.departAt).getTime() - now.getTime()) / 60000;
        const recencyBonus = minutesUntilDepart < 60 ? 1.3 : 1.0; // favoriser le proche
        const score = slot.expectedDemand
          * (URGENCY_W[slot.priority] ?? 1)
          * Math.min(slot.estimatedRevenue / 40, 2.5)
          * recencyBonus;
        if (score > bestScore) { bestScore = score; bestSlot = slot; }
      }

      // ── SCORE RENTABILITÉ GLOBAL 6h-23h (étapes) ────────────────────────────
      // Récupérer les scores horaires de toutes les zones pour la heatmap
      const hourlyScores: Record<number, { topZone: string; topScore: number; mean: number }> = {};
      for (let h2 = hour; h2 <= 23; h2++) {
        const sc = storage.getProfitabilityByHour(h2, dayType) as any[];
        if (sc && sc.length > 0) {
          const sorted = [...sc].sort((a, b) => b.profitability_index - a.profitability_index);
          const mean = sc.reduce((s: number, r: any) => s + r.profitability_index, 0) / sc.length;
          hourlyScores[h2] = {
            topZone:  sorted[0]?.zone_id ?? "",
            topScore: sorted[0]?.profitability_index ?? 0,
            mean:     Math.round(mean * 10) / 10,
          };
        }
      }

      // ── SCORES TOP ZONES MAINTENANT (étapes) ──────────────────────────────
      const currentScores = storage.getProfitabilityByHour(hour, dayType) as any[];
      const topZonesNow = (currentScores || []).slice(0, 5).map((s: any) => ({
        zoneId:   s.zone_id,
        zoneName: s.zone_name ?? s.zone_id,
        score:    s.profitability_index,
        surge:    s.surge_multiplier,
        fare:     s.avg_fare,
        ...etaToZone(s.zone_id, zoneMap[s.zone_id]?.lat ?? 0, zoneMap[s.zone_id]?.lng ?? 0),
      }));

      // ── TEMPS RÉEL VOLS (CDG/Orly, prochain créneau concret) (étapes) ──────
      const realFlights = (flightData?.flights ?? []).filter((f: any) => f.status === "arriving").slice(0, 6).map((f: any) => ({
        callsign:         f.callsign,
        airport:          f.airport,
        estimatedArrival: f.estimated_arrival,
        origin:           f.origin_airport ?? f.origin_country,
        paxVtc:           Math.round((f.passengers_estimate ?? 150) * (f.airport === "CDG" ? 0.12 : 0.09)),
        vtcBoost:         f.vtc_demand_boost,
      }));

      // ── RÉPONSE ────────────────────────────────────────────────────────────
      res.json({
        userPosition:   { lat, lng },
        clickedAt:      clickTs.toISOString(),
        computedAt:     now.toISOString(),
        currentHour:    hour,
        dayType,
        // Top 4 alertes prioritaires enrichies GPS
        top4Alerts,
        // Créneau optimal calculé
        bestSlot,
        bestScore: Math.round(bestScore * 10) / 10,
        // Chronologie complète de la journée
        timeline,
        // ETA aimaéroports depuis position
        etaCdg:   { ...etaCdg,  zone: "z_cdg",  name: "CDG — Charles-de-Gaulle" },
        etaOrly:  { ...etaOrly, zone: "z_orly", name: "Orly — Terminal Sud/Ouest" },
        // Top zones maintenant
        topZonesNow,
        // Heatmap rentabilité horaire
        hourlyScores,
        // Vols temps réel
        realFlights,
        flightSource: flightData?.source ?? "heuristic",
        // Source primaire des données trafic/distance (tomtom / osrm / google / calibrated)
        primarySource: (() => {
          const st = getCacheStats();
          return st.tomtomAvailable ? "tomtom" : st.osrmAvailable ? "osrm" : st.googleAvailable ? "google" : "calibrated";
        })(),
      });

    } catch (err) {
      console.error("[smart-plan] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // POST /api/return-journey
  // « Meilleure course en chemin de retour » — trouve les zones rentables
  // situées le long du trajet position GPS → destination de retour.
  // Body: { lat, lng, destLat, destLng, destName }
  // ═══════════════════════════════════════════════════════════════════════════════
  app.post("/api/return-journey", async (req, res) => {
    try {
      const { lat, lng, destLat, destLng, destName } = req.body as {
        lat: number; lng: number; destLat: number; destLng: number; destName: string;
      };

      if (
        typeof lat !== "number" || typeof lng !== "number" ||
        typeof destLat !== "number" || typeof destLng !== "number"
      ) {
        return res.status(400).json({ error: "lat, lng, destLat, destLng requis (number)" });
      }

      const hour = (new Date().getUTCHours()+2)%24;
      const dayType = [0, 6].includes(new Date().getDay()) ? "weekend" : "weekday";
      const zones = storage.getAllZones() as any[];
      const scores = storage.getProfitabilityByHour(hour, dayType) as any[];

      let flightData: any = null;
      try { flightData = await getFlightDataCached(); } catch { /* non bloquant */ }

      const profile: any = storage.getDriverProfile() || {};
      const fuelPer100 = profile.fuel_consumption_per100km ?? 7.5;
      const fuelPrice  = profile.fuel_price_per_liter ?? 1.92;
      const wearKm     = profile.wear_cost_per_km ?? 0.08;

      // ── Distance Haversine (vol d'oiseau) — identique à /api/best-route ────────
      const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      // ── Distance perpendiculaire point→segment + projection (proj 0..1.5) ──────
      const distPointToSegmentKm = (
        px: number, py: number, ax: number, ay: number, bx: number, by: number,
      ): { dist: number; proj: number } => {
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) {
          const d = Math.sqrt((px - ax) ** 2 + (py - ay) ** 2) * 111;
          return { dist: d, proj: 0 };
        }
        const t = Math.max(0, Math.min(1.5, ((px - ax) * dx + (py - ay) * dy) / lenSq));
        const closestX = ax + t * dx, closestY = ay + t * dy;
        const dist = Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2) * 111;
        return { dist, proj: t };
      };

      const scoreMap: Record<string, any> = {};
      scores.forEach((s: any) => { scoreMap[s.zone_id] = s; });

      // ── Trajet direct position → destination ───────────────────────────────────
      const directStraightKm = haversineKm(lat, lng, destLat, destLng);
      const directDistanceKm = Math.round(directStraightKm * 1.35 * 10) / 10;
      // ETA trajet direct — utilise routingCache si dispo, sinon haversine/vitesse moyenne
      const _directCached = getCachedRoute("_direct_", lat, lng);
      const directEtaMin = (() => {
        // Pas de cache pour trajet direct générique → utiliser distance routière / vitesse réelle
        // Vitesse moyenne pondérée selon heure : rush → 18km/h, normal → 28km/h, off → 35km/h
        const _h = (new Date().getUTCHours()+2)%24;
        const _speedKmH = (_h >= 7 && _h <= 9) || (_h >= 17 && _h <= 19) ? 18
          : (_h >= 10 && _h <= 16) ? 28
          : 35;
        return Math.max(1, Math.round(directDistanceKm / _speedKmH * 60));
      })();

      // ── Analyse de chaque zone par rapport au segment origine→destination ──────
      const routeZones = zones.map((z: any) => {
        // Distance perpendiculaire + projection (coords brutes lng=x, lat=y)
        const { dist: distToRouteRaw, proj } = distPointToSegmentKm(
          z.lng, z.lat, lng, lat, destLng, destLat,
        );
        const distToRoute = Math.round(distToRouteRaw * 10) / 10;
        const progressRatio = Math.round(proj * 1000) / 1000;

        // Distance / ETA réels depuis le cache routingCache
        const straightKm = haversineKm(lat, lng, z.lat, z.lng);
        const rcEntry = getCachedRoute(z.id, lat, lng);
        const distanceKm = rcEntry.roadKm > 0
          ? rcEntry.roadKm
          : Math.round(straightKm * (ROAD_FACTOR[z.id] ?? 1.35) * 10) / 10;
        const etaMinutes = rcEntry.etaMin > 0 ? rcEntry.etaMin
          : Math.max(1, Math.round(distanceKm / (rcEntry.speedKmH || 20) * 60));

        // Détour estimé (aller-retour de la déviation perpendiculaire)
        const detourKm = Math.round(distToRoute * 2 * 10) / 10;
        const detourMinutes = Math.round(detourKm / 20 * 60);

        const s = scoreMap[z.id] || {};
        const profitIdx = s.profitability_index ?? 0;
        const surge = s.surge_multiplier ?? 1.0;
        const avgFare = s.avg_fare ?? 0;
        const longRide = s.long_ride_probability ?? 0;
        const ratio = s.ratio_ds ?? 1;

        let flightBoost = 1.0;
        if (flightData) flightBoost = getFlightBoostForZone(z.id, flightData);

        const distancePenalty = distanceKm <= 3 ? 1.0
          : distanceKm <= 8 ? 0.93
          : distanceKm <= 15 ? 0.82
          : distanceKm <= 25 ? 0.70
          : distanceKm <= 40 ? 0.55
          : 0.35;

        const globalScore = Math.round(profitIdx * distancePenalty * surge * flightBoost);
        const estimatedRevenue = Math.round(avgFare * surge * flightBoost * 100) / 100;

        // Coûts du détour (carburant + usure)
        const detourCost = detourKm * wearKm + (detourKm / 100) * fuelPer100 * fuelPrice;
        const netGain = Math.round((estimatedRevenue - detourCost) * 100) / 100;
        const efficiency = Math.round((netGain / Math.max(detourMinutes, 1)) * 100) / 100;

        // Score de route : pénalise déviation perpendiculaire et longueur du détour
        const routeScore = Math.round(
          globalScore * (1 - distToRoute / 20) * Math.max(0.3, 1 - detourKm / 30),
        );
        const viability = netGain > 0 && progressRatio > 0.1;

        let reason = "Zone sur le trajet";
        if (z.id === "z_cdg" || z.id === "z_orly") {
          const fd = z.id === "z_cdg" ? flightData?.cdg : flightData?.orly;
          reason = fd ? `${fd.arrivals_next_hour} arrivees/h — Flux ${fd.peak_level}` : "Aeroport — flux eleve";
        } else if (distToRoute < 3) {
          reason = `Quasi sur le trajet — détour +${detourKm}km`;
        } else if (longRide >= 0.7) {
          reason = `${Math.round(longRide * 100)}% longues courses`;
        } else if (surge > 1.4) {
          reason = `Surge x${surge.toFixed(2)} — ratio D/O ${ratio.toFixed(2)}`;
        } else if (!viability) {
          reason = `Détour peu rentable (+${detourKm}km)`;
        }

        const mapsDetourUrl =
          `https://www.google.com/maps/dir/${lat},${lng}/${z.lat},${z.lng}/${destLat},${destLng}`;

        return {
          zone: { id: z.id, name: z.name, lat: z.lat, lng: z.lng, type: z.type },
          distanceKm,
          etaMinutes,
          distToRoute,
          detourKm,
          detourMinutes,
          progressRatio,
          profitabilityIndex: profitIdx,
          surgeMultiplier: Math.round(surge * 100) / 100,
          avgFare: Math.round(avgFare * 100) / 100,
          estimatedRevenue,
          netGain,
          efficiency,
          routeScore,
          viability,
          reason,
          mapsDetourUrl,
          globalScore,
          // Source des données distance/ETA (tomtom = trafic temps réel)
          distanceSource: rcEntry.source,
        };
      });

      // Conserver seulement les zones réellement « en chemin »
      const onRoute = routeZones.filter((z: any) =>
        z.progressRatio >= 0.05 && z.progressRatio <= 1.1 && z.distToRoute < 20,
      );

      onRoute.sort((a: any, b: any) => b.routeScore - a.routeScore);
      const top5 = onRoute.slice(0, 5);

      res.json({
        userPosition: { lat, lng },
        destination: { lat: destLat, lng: destLng, name: destName ?? "Destination" },
        directDistanceKm,
        directEtaMin,
        routeZones: top5,
        recommendation: top5[0] ?? null,
        hour,
        dayType,
        computedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[return-journey] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // POST /api/rides/complete
  // Enregistre une course terminée + rafraîchit les alertes dynamiques.
  // Body: { pickup_zone_id, dropoff_zone_id, distance_km, duration_min, fare }
  // ═══════════════════════════════════════════════════════════════════════════════
  app.post("/api/rides/complete", (req, res) => {
    try {
      const { pickup_zone_id, dropoff_zone_id, distance_km, duration_min, fare } = req.body as {
        pickup_zone_id: string; dropoff_zone_id: string;
        distance_km: number; duration_min: number; fare: number;
      };

      if (
        typeof distance_km !== "number" || typeof duration_min !== "number" ||
        typeof fare !== "number"
      ) {
        return res.status(400).json({ error: "distance_km, duration_min, fare requis (number)" });
      }

      const profile: any = storage.getDriverProfile() || {};
      const commPct    = profile.platform_commission_pct ?? 25;
      const fuelPer100 = profile.fuel_consumption_per100km ?? 7.5;
      const fuelPrice  = profile.fuel_price_per_liter ?? 1.92;
      const wearKm     = profile.wear_cost_per_km ?? 0.08;

      const commission = Math.round(fare * (commPct / 100) * 100) / 100;
      const fuel_cost  = Math.round((distance_km / 100) * fuelPer100 * fuelPrice * 100) / 100;
      const wear_cost  = Math.round(distance_km * wearKm * 100) / 100;
      const net_profit = Math.round((fare - commission - fuel_cost - wear_cost) * 100) / 100;
      const hourly_rate = Math.round((net_profit / Math.max(duration_min, 1)) * 60 * 100) / 100;

      // Seuil 1€/km + 1min/km
      const is_profitable = fare >= distance_km && duration_min <= distance_km ? 1 : 0;
      const is_long_ride  = distance_km >= 15 ? 1 : 0;

      const ride = {
        pickup_zone_id: pickup_zone_id ?? "unknown",
        dropoff_zone_id: dropoff_zone_id ?? "unknown",
        distance_km,
        duration_min,
        fare,
        commission,
        fuel_cost,
        net_profit,
        hourly_rate,
        is_profitable,
        is_long_ride,
        timestamp: new Date().toISOString(),
        weather: null,
      };

      storage.addRide(ride);
      // THÈME 2 : maintenance prédictive — cumuler les km parcourus
      storage.updateMaintenanceKm(distance_km);
      // THÈME 4 : cumuler le total km au profil chauffeur
      try { storage.incrementProfileKm?.(distance_km); } catch { /* colonne optionnelle */ }
      storage.generateDynamicAlerts();

      res.json({
        success: true,
        ride: { ...ride, wear_cost },
        stats: storage.getRideStats(),
      });
    } catch (err) {
      console.error("[rides/complete] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // IA 2026 — Nouveaux endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  // THÈME 1 : prédictions de demande (6 prochaines heures)
  app.get("/api/predictions", (req, res) => {
    try {
      const zoneId = typeof req.query.zone_id === "string" ? req.query.zone_id : undefined;
      res.json(storage.getPredictions(6, zoneId));
    } catch (err) {
      console.error("[predictions] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // THÈME 2 : maintenance prédictive
  app.get("/api/maintenance", (_req, res) => {
    res.json({ maintenance: storage.getMaintenance() });
  });

  app.put("/api/maintenance/:component/done", (req, res) => {
    const updated = storage.markMaintenanceDone(req.params.component);
    if (!updated) return res.status(404).json({ error: "Composant introuvable" });
    res.json({ success: true, component: updated });
  });

  // THÈME 3 : scoring comportement conducteur + feedback IA
  app.get("/api/driver-performance", (_req, res) => {
    try {
      res.json(storage.getDriverPerformance());
    } catch (err) {
      console.error("[driver-performance] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // THÈME 5 : tarification dynamique transparente
  app.get("/api/surge-transparency", (_req, res) => {
    try {
      const now = new Date();
      const h = (now.getUTCHours()+2)%24;
      const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";
      const scores = storage.getProfitabilityByHour(h, dayType) as any[];
      const activeEvents = storage.getActiveEvents() as any[];

      const isRush = (h >= 6 && h <= 9) || (h >= 17 && h <= 19);
      const isWeekendNight = dayType === "weekend" && (h >= 22 || h <= 3);

      const zones = scores
        .filter(s => (s.surge_multiplier ?? 1) > 1.2)
        .map(s => {
          const ratio = s.ratio_ds ?? 0;
          const surge = s.surge_multiplier ?? 1;
          const zoneEvent = activeEvents.find(e => e.zone_id === s.zone_id && (e.demand_boost ?? 0) > 1.5);
          let explanation: string;
          if (zoneEvent) {
            const att = zoneEvent.expected_attendance > 0 ? `${zoneEvent.expected_attendance} ` : "";
            explanation = `Événement ${zoneEvent.name} — ${att}personnes attendues`;
          } else if (ratio > 2.5) {
            explanation = `Forte demande, offre insuffisante (${Math.round(s.demand_score)}D / ${Math.round(s.supply_score)}O)`;
          } else if (isRush) {
            explanation = "Heure de pointe — trafic dense, demande maximale";
          } else if (isWeekendNight) {
            explanation = "Nuit festive — demande nocturne élevée";
          } else {
            explanation = `Demande supérieure à l'offre (${Math.round(s.demand_score)}D / ${Math.round(s.supply_score)}O)`;
          }
          const surgeLevel = surge >= 1.8 ? "très élevé" : surge >= 1.5 ? "élevé" : "modéré";
          const validUntil = new Date(now.getTime() + 60 * 60000);
          validUntil.setMinutes(0, 0, 0);
          return {
            zone_id: s.zone_id,
            zone_name: s.zone_name,
            surge_multiplier: Math.round(surge * 100) / 100,
            surge_level: surgeLevel,
            explanation,
            demand_score: Math.round(s.demand_score),
            supply_score: Math.round(s.supply_score),
            ratio: Math.round(ratio * 100) / 100,
            estimated_fare_boost_pct: Math.round((surge - 1) * 100),
            valid_until: validUntil.toISOString(),
          };
        })
        .sort((a, b) => b.surge_multiplier - a.surge_multiplier);

      res.json({ zones });
    } catch (err) {
      console.error("[surge-transparency] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // THÈME 6 : optimiseur temps mort / repositionnement actif
  app.get("/api/idle-optimizer", (req, res) => {
    try {
      const now = new Date();
      const h = (now.getUTCHours()+2)%24;
      const hNext = (h + 1) % 24;
      const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";
      const dayTypeNext = (() => {
        const nd = new Date(now.getTime() + 3600000);
        return [0, 6].includes(nd.getDay()) ? "weekend" : "weekday";
      })();
      // Vraie position GPS du chauffeur (query params)
      const originLat = parseFloat(req.query.lat as string ?? "") || DEFAULT_ORIGIN.lat;
      const originLng = parseFloat(req.query.lng as string ?? "") || DEFAULT_ORIGIN.lng;

      const scoresNow = storage.getProfitabilityByHour(h, dayType) as any[];
      const scoresNext = storage.getProfitabilityByHour(hNext, dayTypeNext) as any[];
      const nextById = new Map(scoresNext.map(s => [s.zone_id, s]));

      const recos = scoresNow.map(s => {
        const scoreNow = s.profitability_index ?? 0;
        const next = nextById.get(s.zone_id) as any;
        const scoreNext = next?.profitability_index ?? scoreNow;
        const avgScore = (scoreNow + scoreNext) / 2;
        const route = getCachedRoute(s.zone_id, originLat, originLng);
        const etaMin = route?.etaMin ?? 30;
        const repoCost = etaMin;
        const netScore = avgScore - repoCost * 0.5;
        const trend = scoreNext > scoreNow + 2 ? "hausse" : scoreNext < scoreNow - 2 ? "baisse" : "stable";
        const arrival = new Date(now.getTime() + etaMin * 60000);
        const arrivalHM = `${String(arrival.getHours()).padStart(2, "0")}:${String(arrival.getMinutes()).padStart(2, "0")}`;
        return {
          zone_id: s.zone_id,
          zone_name: s.zone_name,
          lat: s.lat, lng: s.lng,
          score_now: Math.round(scoreNow),
          score_next_hour: Math.round(scoreNext),
          avg_score: Math.round(avgScore),
          eta_min: etaMin,
          repo_cost_min: repoCost,
          net_score: Math.round(netScore),
          // Source distance/ETA (tomtom = trafic temps réel)
          distance_source: route?.source ?? "calibrated",
          action: `Partir maintenant — arrivée optimale ${arrivalHM}`,
          reason: trend === "hausse" ? "Score en hausse — vague d'arrivées à venir"
            : trend === "baisse" ? "Score en baisse — fenêtre courte" : "Score stable — opportunité solide",
        };
      })
        // Filtre adaptatif : prendre les top zones triées par net_score
        // Pas de filtre dur sur eta_min (peut être >20 si chauffeur est loin de 93)
        .filter(r => r.avg_score > 40)
        .sort((a, b) => b.net_score - a.net_score)
        .slice(0, 5);

      res.json({ recommendations: recos });
    } catch (err) {
      console.error("[idle-optimizer] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
