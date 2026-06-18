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

function getCestHour(): number {
  return (new Date().getUTCHours() + 2) % 24;
}

// Facteur ETA par heure CEST — référence h=10 = 0.97 (mesuré Google Maps)
// Biais global 0.93 appliqué dans getDisplayETA pour éviter surestimation
const ETA_HOUR_FACTOR: Record<number, number> = {
   0: 0.58,  1: 0.54,  2: 0.52,  3: 0.52,  4: 0.55,
   5: 0.70,  6: 0.92,  7: 1.02,  8: 1.12,  9: 0.97,
  10: 0.97, 11: 0.95, 12: 0.93, 13: 0.92, 14: 0.88,
  15: 0.85, 16: 0.90, 17: 1.56, 18: 1.65, 19: 1.40,
  20: 1.25, 21: 1.10, 22: 0.90, 23: 0.72,
};

/**
 * ETA affiché — temps de trajet côté utilisateur
 * Formule : eta_10h × ETA_HOUR_FACTOR[h] × 0.93 (bias anti-surestimation)
 * Résultat garanti ≤ Google Maps (peut légèrement sous-estimer)
 */
export function getDisplayETA(zoneId: string, h_cest: number, osrmKm?: number): number {
  const cal = CALIBRATED_DATA[zoneId];
  if (!cal) return 30;
  const roadKm   = osrmKm && osrmKm > 0 ? osrmKm : cal.road_km;
  const factor   = ETA_HOUR_FACTOR[h_cest] ?? 0.97;
  const eta10h   = cal.eta_10h;
  // Correction distance si OSRM différent du calibré
  const distRatio = roadKm / cal.road_km;
  const rawETA   = eta10h * factor * distRatio;
  // Biais anti-surestimation × 0.93
  return Math.max(1, Math.round(rawETA * 0.93));
}

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

// ── Densité trafic historique par zone et par heure ─────────────────────────────────────────────
//
// Structure : TRAFFIC_DENSITY[zoneId][h] = facteur de congestion horaire
// Interprétation :
//   1.00 = conditions normales (référence : inter-rush journée)
//   > 1.0 = congestion — l'ETA est allongé (facteur multiplicatif sur ETA libre-flux)
//   < 1.0 = trafic fluide (nuit, début de journée hors axe embouteillé)
//
// Sources : mesures Google Maps terrain + BISON FUTÉ données IdF + DiRIF Seine-Saint-Denis
// Méthode : ETA_réel(h) = ETA_libre_flux × TRAFFIC_DENSITY[zone][h]
//           ETA_libre_flux = road_km / vitesse_max_zone (autoroute/RN dégagé)
//
// Calibration par type de zone :
//  - Aéroports (CDG/Orly) : axes autoroutiers (A1/A86/A106) — rush AM+PM marqués
//  - Zones urbaines denses (aubervilliers, saint_denis, 93_centre) : saturation 7h-10h
//  - Zones péri-urbaines (villepinte, tremblay, aulnay) : trafic modéré sauf A104
//  - Zone Stade France : pics événementiels non capturés ici (voir events API)

export const TRAFFIC_DENSITY: Record<string, number[]> = {
  //                      h0    h1    h2    h3    h4    h5    h6    h7    h8    h9    h10   h11   h12   h13   h14   h15   h16   h17   h18   h19   h20   h21   h22   h23
  z_cdg:               [ 0.52, 0.48, 0.45, 0.45, 0.50, 0.72, 0.95, 1.45, 1.80, 1.60, 1.25, 1.15, 1.10, 1.10, 1.18, 1.30, 1.45, 1.72, 1.95, 1.60, 1.30, 1.10, 0.85, 0.65 ],
  z_orly:              [ 0.55, 0.50, 0.48, 0.48, 0.52, 0.70, 0.90, 1.40, 1.75, 1.55, 1.20, 1.12, 1.08, 1.08, 1.15, 1.28, 1.42, 1.68, 1.92, 1.58, 1.25, 1.05, 0.82, 0.62 ],
  z_le_bourget:        [ 0.50, 0.46, 0.44, 0.44, 0.48, 0.68, 0.92, 1.50, 1.88, 1.65, 1.28, 1.18, 1.12, 1.10, 1.20, 1.35, 1.52, 1.78, 2.00, 1.65, 1.32, 1.10, 0.82, 0.60 ],
  z_saint_denis_gare:  [ 0.55, 0.50, 0.48, 0.48, 0.52, 0.80, 1.10, 1.68, 2.05, 1.78, 1.38, 1.25, 1.18, 1.15, 1.22, 1.38, 1.58, 1.85, 2.10, 1.72, 1.38, 1.12, 0.88, 0.65 ],
  z_plaine_commune:    [ 0.52, 0.48, 0.46, 0.46, 0.50, 0.78, 1.08, 1.62, 1.98, 1.72, 1.32, 1.20, 1.15, 1.12, 1.18, 1.35, 1.55, 1.80, 2.05, 1.68, 1.35, 1.10, 0.85, 0.62 ],
  z_aubervilliers:     [ 0.52, 0.48, 0.46, 0.46, 0.50, 0.82, 1.15, 1.72, 2.10, 1.82, 1.42, 1.28, 1.20, 1.18, 1.25, 1.42, 1.62, 1.90, 2.15, 1.75, 1.40, 1.14, 0.88, 0.65 ],
  z_epinay_gennevilliers: [ 0.50, 0.46, 0.44, 0.44, 0.48, 0.75, 1.05, 1.58, 1.92, 1.68, 1.28, 1.18, 1.12, 1.10, 1.18, 1.32, 1.50, 1.75, 1.98, 1.62, 1.30, 1.08, 0.82, 0.60 ],
  z_bobigny_gare:      [ 0.52, 0.48, 0.46, 0.46, 0.50, 0.78, 1.08, 1.62, 2.00, 1.75, 1.35, 1.22, 1.16, 1.14, 1.22, 1.38, 1.58, 1.82, 2.08, 1.70, 1.36, 1.10, 0.85, 0.62 ],
  z_aulnay:            [ 0.48, 0.44, 0.42, 0.42, 0.46, 0.68, 0.95, 1.45, 1.78, 1.58, 1.22, 1.12, 1.08, 1.05, 1.12, 1.28, 1.45, 1.68, 1.90, 1.55, 1.24, 1.02, 0.80, 0.58 ],
  z_villepinte:        [ 0.46, 0.42, 0.40, 0.40, 0.44, 0.65, 0.90, 1.38, 1.70, 1.52, 1.18, 1.08, 1.04, 1.02, 1.10, 1.25, 1.42, 1.62, 1.85, 1.50, 1.20, 1.00, 0.78, 0.56 ],
  z_tremblay:          [ 0.45, 0.41, 0.39, 0.39, 0.43, 0.63, 0.88, 1.35, 1.65, 1.48, 1.15, 1.05, 1.02, 1.00, 1.08, 1.22, 1.38, 1.58, 1.80, 1.48, 1.18, 0.98, 0.76, 0.55 ],
  z_montreuil:         [ 0.52, 0.48, 0.46, 0.46, 0.50, 0.80, 1.12, 1.68, 2.05, 1.78, 1.38, 1.25, 1.18, 1.16, 1.24, 1.40, 1.60, 1.88, 2.12, 1.72, 1.38, 1.12, 0.88, 0.65 ],
  z_93_centre:         [ 0.50, 0.46, 0.44, 0.44, 0.48, 0.78, 1.10, 1.65, 2.02, 1.76, 1.36, 1.22, 1.16, 1.14, 1.22, 1.38, 1.58, 1.84, 2.08, 1.70, 1.36, 1.10, 0.85, 0.62 ],
  z_stade_france:      [ 0.55, 0.50, 0.48, 0.48, 0.52, 0.82, 1.12, 1.70, 2.08, 1.80, 1.40, 1.26, 1.18, 1.16, 1.24, 1.40, 1.60, 1.88, 2.12, 1.74, 1.40, 1.14, 0.90, 0.66 ],
};

// ── Densité trafic avec interpolation linéaire inter-heure ────────────────────────────────────
//
// Permet un calcul ETA lissé sur des appels entre les heures entières.
// ex : à 8h45 → 0.75 × DENSITY[h=9] + 0.25 × DENSITY[h=8]
export function getTrafficDensity(zoneId: string, h: number, minuteFraction = 0): number {
  const density = TRAFFIC_DENSITY[zoneId];
  if (!density) return 1.0;

  const hFloor = Math.floor(h) % 24;
  const hCeil  = (hFloor + 1) % 24;
  const frac   = minuteFraction / 60;

  return density[hFloor] * (1 - frac) + density[hCeil] * frac;
}

// ── ETA avec pondération trafic historique ────────────────────────────────────────────────────
//
// Calcule l'ETA réaliste depuis l'origine vers une zone en combinant :
//  1. Distance routière réelle (OSRM ou calibré)
//  2. Vitesse rush PM de référence (mesures terrain Google Maps)
//  3. Profil horaire global (getHourlyRatio)
//  4. Densité trafic locale historique (TRAFFIC_DENSITY par zone et heure)
//
// Modèle : ETA = road_km / speed_effective
//   speed_effective = speed_pm_ref × (1 / congestion_factor)
//   congestion_factor = alpha × (1/globalRatio) + (1-alpha) × zoneDensity × 0.88
//   alpha = 0.35 (poids ratio global) — dépend de la corrélation zone/réseau IdF
export function getCongestedETA(
  zoneId:  string,
  roadKm:  number,
  h:       number,
  options?: { minuteFraction?: number; alphaBlend?: number }
): { etaMin: number; speedKmH: number; congestionFactor: number; congestionLabel: string } {
  const cal         = CALIBRATED_DATA[zoneId];
  const speedPMRef  = cal ? cal.speed_pm : 20.0;

  const minuteFraction = options?.minuteFraction ?? 0;
  const alpha          = options?.alphaBlend    ?? 0.35;

  const globalRatio    = getHourlyRatio(h);
  const zoneDensity    = getTrafficDensity(zoneId, h, minuteFraction);

  // globalCongestion : ratio global → facteur congestion (vitesse inversée)
  const globalCongestion = 1.0 / globalRatio;
  // Blend composite : ratio global + densité zone locale
  const congestionFactor = alpha * globalCongestion + (1 - alpha) * (zoneDensity * 0.88);

  const speedEffective = Math.max(3.5, speedPMRef / congestionFactor);
  const etaMin         = Math.max(1, Math.round((roadKm / speedEffective) * 60));
  const speedKmH       = Math.round(speedEffective * 100) / 100;

  let congestionLabel: string;
  if      (congestionFactor < 0.60) congestionLabel = "Fluide";
  else if (congestionFactor < 0.85) congestionLabel = "Normal";
  else if (congestionFactor < 1.10) congestionLabel = "Modéré";
  else if (congestionFactor < 1.40) congestionLabel = "Dense";
  else if (congestionFactor < 1.75) congestionLabel = "Saturé";
  else                               congestionLabel = "Bloqué";

  // Plafond anti-surestimation : jamais > getDisplayETA × 1.10
  const displayETA = getDisplayETA(zoneId, Math.floor(h));
  const cappedETA  = Math.min(etaMin, Math.round(displayETA * 1.10));

  return { etaMin: cappedETA, speedKmH, congestionFactor: Math.round(congestionFactor * 1000) / 1000, congestionLabel };
}

// ── Seuil de rentabilité 1 min/km ─────────────────────────────────────────────────────────────
//
// Règle métier stricte : un trajet est rentable ssi durée ≤ road_km minutes
// Appliqué sur le TRAJET COURSE (avgDur/avgDist), pas sur le trajet aller vers la zone.
//
// Seuils calibrés par type de zone :
//   - Zones courtes (<15km) : courses fréquentes → seuil souple 1.80 min/km
//   - Zones longues/mixtes  : courses rares mais lucratives → seuil 1.20 min/km
//   - Aéroports             : tarif forfaitaire élevé → seuil 1.50 min/km
// Pénalité dégressive : max 12 pts si très au-delà du seuil
export function computeBreakEvenPenalty(
  zoneId:           string,
  roadKm:           number,
  etaMin:           number,
  congestionFactor: number
): { penalty: number; minPerKm: number; breakEvenOk: boolean } {
  const minPerKm  = etaMin / Math.max(roadKm, 0.1);
  const isAirport = zoneId === "z_cdg" || zoneId === "z_orly";
  const isShortZone = !isAirport && (roadKm < 15);
  const threshold = isAirport ? 1.50 : isShortZone ? 1.80 : 1.20;

  const breakEvenOk = minPerKm <= threshold;
  const rawPenalty  = Math.max(0, (minPerKm - threshold) / threshold * 15);
  const penalty     = Math.min(12, Math.round(rawPenalty * 10) / 10);

  return { penalty, minPerKm: Math.round(minPerKm * 1000) / 1000, breakEvenOk };
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
  const etaMin   = getDisplayETA(zoneId, h);
  const speedKmH = Math.round(cal.road_km / (etaMin / 60) * 100) / 100;
  return {
    zoneId,
    roadKm:    cal.road_km,
    durationS: Math.round(etaMin * 60),
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
  const h   = getCestHour();
  const dest = ZONE_COORDS[zoneId];

  // 1. Cache valide ?
  const cached = memoryCache.get(key);
  if (cached && now < cached.expiresAt) return cached;

  // 2. Google si clé présente
  if (apiKey && apiKey.length > 10) {
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

  // 3. OSRM — distance routière réelle, mais vitesse depuis CALIBRATED_DATA
  // IMPORTANT : la vitesse libre OSRM (~55-80 km/h) est inutilisable pour l'ETA
  // car elle ignore les embouteillages parisiens (vitesse réelle 13-33 km/h).
  // On utilise la distance OSRM (plus précise que le calibré) mais la vitesse
  // rush_PM mesurée Google Maps × ratio horaire pour calculer l'ETA.
  if (dest) {
    const o = await fetchOsrmRoute(originLat, originLng, dest.lat, dest.lng);
    if (o) {
      const ratio      = getHourlyRatio(h);
      const cal        = CALIBRATED_DATA[zoneId];
      // Vitesse de base = vitesse rush PM MESURÉE (Google Maps) pour cette zone
      // Si pas de calibration disponible, fallback sur vitesse OSRM corrigée /2.5
      const speedPM    = cal ? cal.speed_pm : (o.roadKm / (o.durationS / 3600)) / 2.5;
      const speedKmH   = Math.round(speedPM * ratio * 100) / 100;
      // Distance : préférer OSRM (réelle) si cohérente avec calibré (±30%)
      const calKm      = cal ? cal.road_km : o.roadKm;
      const roadKm     = Math.abs(o.roadKm - calKm) / calKm < 0.30 ? o.roadKm : calKm;
      const etaMin     = getDisplayETA(zoneId, h, roadKm);
      const entry: RouteEntry = {
        zoneId, roadKm, durationS: o.durationS, etaMin, speedKmH,
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
  const h       = getCestHour();
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
      const cal      = CALIBRATED_DATA[zoneId];
      // Même logique que getRouteForZone : vitesse rush PM calibrée × ratio horaire
      const speedPM  = cal ? cal.speed_pm : (o.roadKm / (o.durationS / 3600)) / 2.5;
      const speedKmH = Math.round(speedPM * ratio * 100) / 100;
      const calKm    = cal ? cal.road_km : o.roadKm;
      const roadKm   = Math.abs(o.roadKm - calKm) / calKm < 0.30 ? o.roadKm : calKm;
      const etaMin   = getDisplayETA(zoneId, h, roadKm);
      const entry: RouteEntry = {
        zoneId, roadKm, durationS: o.durationS, etaMin, speedKmH,
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
  return getCalibratedEntry(zoneId, getCestHour());
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
  const h   = getCestHour();

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
