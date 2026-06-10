/**
 * routingCache.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Stratégie de cache intelligent pour les distances/ETAs — 2 niveaux :
 *
 *  Niveau 1 : OSRM public (gratuit, open source, sans clé)
 *    → http://router.project-osrm.org/route/v1/driving/{lng1},{lat1};{lng2},{lat2}
 *    → Données routières réelles (OpenStreetMap) + distance + durée sans trafic
 *    → TTL : 30 minutes (routes ne changent pas)
 *
 *  Niveau 2 : Google Maps Distance Matrix (optionnel, si GOOGLE_MAPS_KEY présent)
 *    → https://maps.googleapis.com/maps/api/distancematrix/json
 *    → Durée avec trafic temps réel (departure_time=now)
 *    → TTL : 30 minutes (cohérent avec l'évolution du trafic)
 *    → Fallback sur OSRM × ratio horaire si quota dépassé ou clé absente
 *
 * Architecture cache :
 *  ┌─────────────────────────────────────────────────────┐
 *  │  memoryCache  (Map<key, CacheEntry>)                 │
 *  │  ├─ key  = "zoneId:originLat:originLng"             │
 *  │  ├─ roadKm    = distance routière réelle OSRM        │
 *  │  ├─ durationS = durée de base OSRM (sans trafic)     │
 *  │  ├─ etaMin    = durée avec trafic (Google) ou OSRM   │
 *  │  ├─ source    = "google" | "osrm" | "calibrated"     │
 *  │  └─ cachedAt  = timestamp (ms)                       │
 *  └─────────────────────────────────────────────────────┘
 *
 * Coût estimé :
 *  - OSRM seul    : 0€/mois (gratuit, open source)
 *  - Google seul  : ~75€/mois brut (dans le free tier 200$/mois)
 *  - Cache 30min  : 90% de réduction vs refresh 3min
 *
 * ──────────────────────────────────────────────────────────────────────────────
 */

import https from "https";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouteEntry {
  zoneId:    string;
  roadKm:    number;   // distance routière réelle (km)
  durationS: number;   // durée OSRM sans trafic (secondes)
  etaMin:    number;   // ETA avec trafic si Google, sinon OSRM × ratio
  speedKmH:  number;   // vitesse effective (roadKm / etaMin * 60)
  source:    "google" | "osrm" | "calibrated";
  cachedAt:  number;   // Date.now()
  expiresAt: number;   // cachedAt + TTL_MS
}

export interface RoutingCacheStats {
  totalEntries:    number;
  validEntries:    number;
  expiredEntries:  number;
  googleHits:      number;
  osrmHits:        number;
  calibratedHits:  number;
  lastOsrmFetch:   string | null;
  lastGoogleFetch: string | null;
  googleAvailable: boolean;
  osrmAvailable:   boolean;
  refreshCount:    number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

const TTL_MS              = 30 * 60 * 1000;  // 30 minutes
const OSRM_BASE_URL       = "https://router.project-osrm.org";
const OSRM_TIMEOUT_MS     = 8_000;
const GOOGLE_TIMEOUT_MS   = 10_000;
const BATCH_DELAY_MS      = 200;  // délai entre requêtes pour ne pas surcharger OSRM

// Point de départ par défaut : Bd Ney (Paris 18e) — base chauffeurs 93
export const DEFAULT_ORIGIN = { lat: 48.8976, lng: 2.3299 };

// ── Zones calibrées (fallback si OSRM et Google indisponibles) ────────────────
// Données mesures réelles Google Maps 10/06/2026 depuis Bd Ney

export const CALIBRATED_DATA: Record<string, {
  road_km:      number;
  speed_pm:     number;  // vitesse rush PM 18h (km/h)
  eta_18h:      number;  // ETA mesuré à 18h (min)
  eta_10h:      number;  // ETA mesuré à 10h37 (min)
}> = {
  z_cdg:                  { road_km: 23.8, speed_pm: 32.45, eta_18h: 44, eta_10h: 26 },
  z_orly:                 { road_km: 28.6, speed_pm: 26.00, eta_18h: 66, eta_10h: 42 },
  z_le_bourget:           { road_km: 12.1, speed_pm: 18.15, eta_18h: 40, eta_10h: 19 },
  z_villepinte:           { road_km: 21.6, speed_pm: 30.86, eta_18h: 42, eta_10h: 28 },
  z_tremblay:             { road_km: 22.9, speed_pm: 29.87, eta_18h: 46, eta_10h: 25 },
  z_aulnay:               { road_km: 19.5, speed_pm: 27.21, eta_18h: 43, eta_10h: 26 },
  z_saint_denis_gare:     { road_km:  6.5, speed_pm: 13.00, eta_18h: 30, eta_10h: 17 },
  z_plaine_commune:       { road_km:  5.8, speed_pm: 16.57, eta_18h: 21, eta_10h: 15 },
  z_bobigny_gare:         { road_km: 13.4, speed_pm: 22.33, eta_18h: 36, eta_10h: 26 },
  z_aubervilliers:        { road_km:  6.6, speed_pm: 12.77, eta_18h: 31, eta_10h: 20 },
  z_epinay_gennevilliers: { road_km:  9.6, speed_pm: 13.71, eta_18h: 42, eta_10h: 25 },
  z_93_centre:            { road_km:  6.8, speed_pm: 12.75, eta_18h: 32, eta_10h: 18 },
  z_montreuil:            { road_km: 14.0, speed_pm: 20.49, eta_18h: 41, eta_10h: 27 },
  z_stade_france:         { road_km:  5.2, speed_pm: 12.48, eta_18h: 25, eta_10h: 11 },
};

// Coordonnées des zones destination
export const ZONE_COORDS: Record<string, { lat: number; lng: number }> = {
  z_cdg:                  { lat: 49.0097, lng: 2.5479  },
  z_orly:                 { lat: 48.7233, lng: 2.3794  },
  z_le_bourget:           { lat: 48.9344, lng: 2.4391  },
  z_villepinte:           { lat: 48.9600, lng: 2.5416  },
  z_tremblay:             { lat: 48.9750, lng: 2.5661  },
  z_aulnay:               { lat: 48.9400, lng: 2.4900  },
  z_saint_denis_gare:     { lat: 48.9362, lng: 2.3560  },
  z_plaine_commune:       { lat: 48.9200, lng: 2.3450  },
  z_bobigny_gare:         { lat: 48.9100, lng: 2.4400  },
  z_aubervilliers:        { lat: 48.9170, lng: 2.3830  },
  z_epinay_gennevilliers: { lat: 48.9500, lng: 2.3050  },
  z_93_centre:            { lat: 48.9200, lng: 2.4600  },
  z_montreuil:            { lat: 48.8630, lng: 2.4440  },
  z_stade_france:         { lat: 48.9244, lng: 2.3601  },
};

// ── Facteur de détour routier par zone ────────────────────────────────────────
// ROAD_FACTOR[zoneId] = road_km calibré / distance Haversine (vol d'oiseau)
// depuis DEFAULT_ORIGIN. Utilisé en fallback dans routes.ts quand le cache
// OSRM/Google ne fournit pas de distance routière réelle.
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const ROAD_FACTOR: Record<string, number> = Object.fromEntries(
  Object.keys(CALIBRATED_DATA).map((zoneId) => {
    const coords = ZONE_COORDS[zoneId];
    const roadKm = CALIBRATED_DATA[zoneId].road_km;
    if (!coords) return [zoneId, 1.35];
    const straight = haversineKm(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng, coords.lat, coords.lng);
    const factor = straight > 0 ? roadKm / straight : 1.35;
    return [zoneId, Math.round(factor * 1000) / 1000];
  })
);

// ── Profil horaire trafic (ratio vs vitesse rush PM 18h = 1.00) ───────────────
export function getHourlyRatio(h: number): number {
  if (h < 6)  return 2.40;  // nuit
  if (h < 7)  return 1.45;  // pré-rush 6h
  if (h < 9)  return 0.88;  // rush AM
  if (h < 12) return 1.69;  // post-rush ✅ MESURÉ 10h37
  if (h < 14) return 1.58;  // mi-journée
  if (h < 16) return 1.42;  // après-midi
  if (h < 17) return 1.12;  // pré-rush PM
  if (h < 19) return 1.00;  // rush PM ✅ BASE MESURÉE 18h
  if (h < 22) return 1.52;  // soir
  return 2.40;              // nuit tardive
}

// ── Cache mémoire ─────────────────────────────────────────────────────────────

const memoryCache = new Map<string, RouteEntry>();

// Stats globales
let statsGoogle    = 0;
let statsOsrm      = 0;
let statsCalibrated = 0;
let lastOsrmFetch: string | null  = null;
let lastGoogleFetch: string | null = null;
let refreshCount   = 0;
let osrmAvailable  = true;   // pessimiste → mis à jour après premier test
let googleAvailable = false; // optimiste → mis à jour si clé présente

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

function httpsGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── OSRM : route réelle (distance + durée sans trafic) ────────────────────────

async function fetchOsrmRoute(
  originLat: number, originLng: number,
  destLat:   number, destLng:   number
): Promise<{ roadKm: number; durationS: number } | null> {
  const url =
    `${OSRM_BASE_URL}/route/v1/driving/` +
    `${originLng},${originLat};${destLng},${destLat}` +
    `?overview=false&annotations=false`;
  try {
    const body = await httpsGet(url, OSRM_TIMEOUT_MS);
    const json = JSON.parse(body);
    if (json.code !== "Ok" || !json.routes?.length) return null;
    const route = json.routes[0];
    return {
      roadKm:    Math.round(route.distance / 100) / 10,   // m → km (1 déc.)
      durationS: Math.round(route.duration),               // secondes
    };
  } catch {
    return null;
  }
}

// ── Google Maps Distance Matrix : durée avec trafic ───────────────────────────

async function fetchGoogleDuration(
  originLat: number, originLng: number,
  destLat:   number, destLng:   number,
  apiKey:    string
): Promise<{ durationInTrafficS: number; distanceM: number } | null> {
  const departureTime = Math.floor(Date.now() / 1000);
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${originLat},${originLng}` +
    `&destinations=${destLat},${destLng}` +
    `&departure_time=${departureTime}` +
    `&traffic_model=best_guess` +
    `&key=${encodeURIComponent(apiKey)}`;
  try {
    const body = await httpsGet(url, GOOGLE_TIMEOUT_MS);
    const json = JSON.parse(body);
    if (json.status !== "OK") return null;
    const el = json.rows?.[0]?.elements?.[0];
    if (!el || el.status !== "OK") return null;
    return {
      durationInTrafficS: el.duration_in_traffic?.value ?? el.duration?.value ?? 0,
      distanceM:          el.distance?.value ?? 0,
    };
  } catch {
    return null;
  }
}

// ── Google Batch (1 requête → 14 destinations) ────────────────────────────────

async function fetchGoogleBatch(
  originLat: number, originLng: number,
  zoneIds:   string[],
  apiKey:    string
): Promise<Map<string, { durationS: number; roadKm: number }>> {
  const results = new Map<string, { durationS: number; roadKm: number }>();
  if (!zoneIds.length) return results;

  const destinations = zoneIds
    .map(id => {
      const c = ZONE_COORDS[id];
      return c ? `${c.lat},${c.lng}` : null;
    })
    .filter(Boolean)
    .join("|");

  const departureTime = Math.floor(Date.now() / 1000);
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${originLat},${originLng}` +
    `&destinations=${encodeURIComponent(destinations)}` +
    `&departure_time=${departureTime}` +
    `&traffic_model=best_guess` +
    `&key=${encodeURIComponent(apiKey)}`;

  try {
    const body = await httpsGet(url, GOOGLE_TIMEOUT_MS);
    const json = JSON.parse(body);
    if (json.status !== "OK") return results;

    const elements = json.rows?.[0]?.elements ?? [];
    const validIds = zoneIds.filter(id => ZONE_COORDS[id]);

    validIds.forEach((zoneId, i) => {
      const el = elements[i];
      if (el?.status === "OK") {
        results.set(zoneId, {
          durationS: el.duration_in_traffic?.value ?? el.duration?.value ?? 0,
          roadKm:    Math.round((el.distance?.value ?? 0) / 100) / 10,
        });
      }
    });
    return results;
  } catch {
    return results;
  }
}

// ── Fallback calibré (toujours disponible) ────────────────────────────────────

function getCalibratedEntry(zoneId: string, h: number): RouteEntry {
  const cal = CALIBRATED_DATA[zoneId];
  if (!cal) {
    return {
      zoneId, roadKm: 20, durationS: 1800, etaMin: 30, speedKmH: 40,
      source: "calibrated", cachedAt: Date.now(), expiresAt: Date.now() + TTL_MS,
    };
  }
  const ratio = getHourlyRatio(h);
  const speedKmH = Math.round(cal.speed_pm * ratio * 100) / 100;
  const etaMin   = Math.max(1, Math.round((cal.road_km / speedKmH) * 60));
  return {
    zoneId,
    roadKm:    cal.road_km,
    durationS: Math.round(cal.road_km / cal.speed_pm * 3600),  // durée rush PM base
    etaMin,
    speedKmH,
    source:    "calibrated",
    cachedAt:  Date.now(),
    expiresAt: Date.now() + TTL_MS,
  };
}

// ── Clé de cache ──────────────────────────────────────────────────────────────

function cacheKey(zoneId: string, lat: number, lng: number): string {
  // Arrondi à 3 déc. (~110m) → même clé pour positions proches
  return `${zoneId}:${lat.toFixed(3)}:${lng.toFixed(3)}`;
}

// ── API publique ──────────────────────────────────────────────────────────────

/**
 * Récupère la route pour une zone depuis le cache ou les APIs.
 * Priorité : cache valide → Google → OSRM → calibré
 */
export async function getRouteForZone(
  zoneId:    string,
  originLat: number,
  originLng: number,
  apiKey?:   string
): Promise<RouteEntry> {
  const key = cacheKey(zoneId, originLat, originLng);
  const now = Date.now();
  const h   = new Date().getHours();

  // 1. Cache valide ?
  const cached = memoryCache.get(key);
  if (cached && now < cached.expiresAt) return cached;

  // 2. Google si clé présente
  if (apiKey && apiKey.length > 10) {
    const dest = ZONE_COORDS[zoneId];
    if (dest) {
      const g = await fetchGoogleDuration(originLat, originLng, dest.lat, dest.lng, apiKey);
      if (g) {
        const roadKm   = g.distanceM > 0 ? Math.round(g.distanceM / 100) / 10 : CALIBRATED_DATA[zoneId]?.road_km ?? 20;
        const etaMin   = Math.max(1, Math.round(g.durationInTrafficS / 60));
        const speedKmH = Math.round(roadKm / (g.durationInTrafficS / 3600) * 100) / 100;
        const entry: RouteEntry = {
          zoneId, roadKm, durationS: g.durationInTrafficS, etaMin, speedKmH,
          source: "google", cachedAt: now, expiresAt: now + TTL_MS,
        };
        memoryCache.set(key, entry);
        statsGoogle++;
        lastGoogleFetch = new Date().toISOString();
        googleAvailable = true;
        return entry;
      }
    }
  }

  // 3. OSRM
  const dest = ZONE_COORDS[zoneId];
  if (dest) {
    const o = await fetchOsrmRoute(originLat, originLng, dest.lat, dest.lng);
    if (o) {
      const ratio    = getHourlyRatio(h);
      const speedBase = o.roadKm / (o.durationS / 3600);     // vitesse OSRM sans trafic
      const speedKmH  = Math.round(speedBase * ratio * 100) / 100;  // × ratio trafic
      const etaMin    = Math.max(1, Math.round((o.roadKm / speedKmH) * 60));
      const entry: RouteEntry = {
        zoneId, roadKm: o.roadKm, durationS: o.durationS, etaMin, speedKmH,
        source: "osrm", cachedAt: now, expiresAt: now + TTL_MS,
      };
      memoryCache.set(key, entry);
      statsOsrm++;
      lastOsrmFetch = new Date().toISOString();
      osrmAvailable = true;
      return entry;
    }
  }

  // 4. Fallback calibré
  const entry = getCalibratedEntry(zoneId, h);
  memoryCache.set(key, entry);
  statsCalibrated++;
  return entry;
}

/**
 * Rafraîchit toutes les zones en batch depuis l'origine donnée.
 * Stratégie :
 *  - Google disponible → 1 requête batch pour toutes les zones
 *  - OSRM → requêtes séquentielles avec délai (respecter rate limit)
 *  - Calibré → instantané, pas de réseau
 */
export async function refreshAllZones(
  originLat: number,
  originLng: number,
  apiKey?:   string
): Promise<{ refreshed: number; source: string; durationMs: number }> {
  const t0     = Date.now();
  const zoneIds = Object.keys(CALIBRATED_DATA);
  const h       = new Date().getHours();
  let refreshed = 0;
  let source    = "calibrated";

  // ── Tentative Google batch ──────────────────────────────────────────────────
  if (apiKey && apiKey.length > 10) {
    console.log(`[routing-cache] Google batch pour ${zoneIds.length} zones...`);
    const gMap = await fetchGoogleBatch(originLat, originLng, zoneIds, apiKey);
    if (gMap.size > 0) {
      const now = Date.now();
      for (const zoneId of zoneIds) {
        const g = gMap.get(zoneId);
        if (g) {
          const roadKm   = g.roadKm > 0 ? g.roadKm : CALIBRATED_DATA[zoneId]?.road_km ?? 20;
          const etaMin   = Math.max(1, Math.round(g.durationS / 60));
          const speedKmH = Math.round(roadKm / (g.durationS / 3600) * 100) / 100;
          const entry: RouteEntry = {
            zoneId, roadKm, durationS: g.durationS, etaMin, speedKmH,
            source: "google", cachedAt: now, expiresAt: now + TTL_MS,
          };
          memoryCache.set(cacheKey(zoneId, originLat, originLng), entry);
          refreshed++;
          statsGoogle++;
        }
      }
      lastGoogleFetch = new Date().toISOString();
      googleAvailable = true;
      source = "google";
      refreshCount++;
      console.log(`[routing-cache] Google batch ✅ ${refreshed}/${zoneIds.length} zones en ${Date.now() - t0}ms`);
      return { refreshed, source, durationMs: Date.now() - t0 };
    }
    console.warn(`[routing-cache] Google batch échoué — fallback OSRM`);
    googleAvailable = false;
  }

  // ── OSRM séquentiel (respecte les rate limits du serveur public) ────────────
  console.log(`[routing-cache] OSRM séquentiel pour ${zoneIds.length} zones...`);
  for (const zoneId of zoneIds) {
    const dest = ZONE_COORDS[zoneId];
    if (!dest) continue;

    const o = await fetchOsrmRoute(originLat, originLng, dest.lat, dest.lng);
    if (o) {
      const ratio    = getHourlyRatio(h);
      const speedBase = o.roadKm / (o.durationS / 3600);
      const speedKmH  = Math.round(speedBase * ratio * 100) / 100;
      const etaMin    = Math.max(1, Math.round((o.roadKm / speedKmH) * 60));
      const entry: RouteEntry = {
        zoneId, roadKm: o.roadKm, durationS: o.durationS, etaMin, speedKmH,
        source: "osrm", cachedAt: Date.now(), expiresAt: Date.now() + TTL_MS,
      };
      memoryCache.set(cacheKey(zoneId, originLat, originLng), entry);
      refreshed++;
      statsOsrm++;
      osrmAvailable = true;
      source = "osrm";
    } else {
      // Fallback calibré pour cette zone
      const entry = getCalibratedEntry(zoneId, h);
      memoryCache.set(cacheKey(zoneId, originLat, originLng), entry);
      statsCalibrated++;
    }

    await sleep(BATCH_DELAY_MS); // 200ms entre requêtes OSRM
  }

  lastOsrmFetch = new Date().toISOString();
  refreshCount++;
  const elapsed = Date.now() - t0;
  console.log(`[routing-cache] OSRM batch ✅ ${refreshed}/${zoneIds.length} zones via OSRM en ${elapsed}ms`);
  return { refreshed, source, durationMs: elapsed };
}

/**
 * Accès direct au cache pour une zone (sans fetch réseau).
 * Retourne l'entrée en cache ou le fallback calibré.
 */
export function getCachedRoute(
  zoneId:    string,
  originLat: number = DEFAULT_ORIGIN.lat,
  originLng: number = DEFAULT_ORIGIN.lng
): RouteEntry {
  const key    = cacheKey(zoneId, originLat, originLng);
  const cached = memoryCache.get(key);
  const now    = Date.now();

  if (cached && now < cached.expiresAt) return cached;

  // Retourne calibré si expiré ou absent (ne bloque pas)
  return getCalibratedEntry(zoneId, new Date().getHours());
}

/**
 * Retourne toutes les entrées du cache pour l'origine donnée
 * (zones valides uniquement).
 */
export function getAllCachedRoutes(
  originLat: number = DEFAULT_ORIGIN.lat,
  originLng: number = DEFAULT_ORIGIN.lng
): Record<string, RouteEntry> {
  const result: Record<string, RouteEntry> = {};
  const now = Date.now();
  const h   = new Date().getHours();

  for (const zoneId of Object.keys(CALIBRATED_DATA)) {
    const key    = cacheKey(zoneId, originLat, originLng);
    const cached = memoryCache.get(key);
    result[zoneId] = (cached && now < cached.expiresAt)
      ? cached
      : getCalibratedEntry(zoneId, h);
  }
  return result;
}

/**
 * Expire manuellement toutes les entrées du cache.
 * Utile pour forcer un refresh complet (endpoint admin).
 */
export function invalidateCache(): void {
  memoryCache.clear();
  console.log("[routing-cache] Cache invalidé manuellement");
}

/**
 * Statistiques du cache pour le monitoring.
 */
export function getCacheStats(): RoutingCacheStats {
  const now     = Date.now();
  let valid     = 0;
  let expired   = 0;

  memoryCache.forEach(e => {
    if (now < e.expiresAt) valid++; else expired++;
  });

  return {
    totalEntries:    memoryCache.size,
    validEntries:    valid,
    expiredEntries:  expired,
    googleHits:      statsGoogle,
    osrmHits:        statsOsrm,
    calibratedHits:  statsCalibrated,
    lastOsrmFetch,
    lastGoogleFetch,
    googleAvailable,
    osrmAvailable,
    refreshCount,
  };
}

/**
 * Pré-chauffe le cache au démarrage du serveur.
 * Lance le refresh en arrière-plan (non bloquant).
 */
export function warmupCache(
  originLat: number = DEFAULT_ORIGIN.lat,
  originLng: number = DEFAULT_ORIGIN.lng,
  apiKey?:   string
): void {
  console.log(`[routing-cache] Warmup démarré — origine (${originLat}, ${originLng})`);
  refreshAllZones(originLat, originLng, apiKey).then(result => {
    console.log(`[routing-cache] Warmup terminé — ${result.refreshed} zones via ${result.source} en ${result.durationMs}ms`);
  }).catch(err => {
    console.warn(`[routing-cache] Warmup échoué — fallback calibré actif:`, err.message);
  });
}
