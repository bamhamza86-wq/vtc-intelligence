/**
 * weatherService.ts — Service météo Open-Meteo pour booster la rentabilité VTC
 * Source : Open-Meteo (GRATUIT, sans clé API) — https://open-meteo.com/
 *
 * Pluie / orage / neige → demande VTC ↑ (les gens prennent plus de VTC).
 * Centre de référence : Saint-Denis 93 (cœur de la zone d'opération).
 *
 * Architecture calquée sur flightService.ts :
 *   - module https natif Node.js (pas fetch browser, pas node-fetch)
 *   - cache mémoire TTL 15min (respect fair-use Open-Meteo)
 *   - fallback silencieux (boost=0) si API indisponible
 */

import https from "https";

// ─── Constantes ───────────────────────────────────────────────────────────────

// Centre IDF pour la météo (Saint-Denis 93)
const IDF_LAT = 48.9356;
const IDF_LNG = 2.3535;
const REFRESH_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WeatherCondition {
  code: number;          // WMO code
  description: string;   // "Pluie modérée", etc.
  precipitation_mm: number;
  windspeed_kmh: number;
  demand_boost: number;  // 0.0 à 0.35 (facteur additionnel)
  updated_at: string;    // ISO
  icon: string;          // "🌧️" emoji pour l'UI
  isFallback?: boolean;  // true si Open-Meteo indisponible (boost forcé à 0)
}

// ─── Cache mémoire TTL 15min ──────────────────────────────────────────────────

let weatherCache: WeatherCondition | null = null;
let weatherLastFetch = 0;

// ─── Table WMO Weather Code → boost VTC + description + icône ──────────────────
// Référence : https://open-meteo.com/en/docs (WMO Weather interpretation codes)

interface WmoMapping {
  description: string;
  boost: number;
  icon: string;
}

const WMO_TABLE: Record<number, WmoMapping> = {
  // Code 0-3 : ciel dégagé/nuageux → boost 0.0 (pas d'effet)
  0:  { description: "Ciel dégagé",        boost: 0.0,  icon: "☀️" },
  1:  { description: "Peu nuageux",         boost: 0.0,  icon: "🌤️" },
  2:  { description: "Partiellement nuageux", boost: 0.0, icon: "⛅" },
  3:  { description: "Couvert",             boost: 0.0,  icon: "☁️" },
  // Code 45,48 : brouillard → 0.10
  45: { description: "Brouillard",          boost: 0.10, icon: "🌫️" },
  48: { description: "Brouillard givrant",  boost: 0.10, icon: "🌫️" },
  // Code 51,53,55 : bruine → 0.15
  51: { description: "Bruine légère",       boost: 0.15, icon: "🌦️" },
  53: { description: "Bruine modérée",      boost: 0.15, icon: "🌦️" },
  55: { description: "Bruine dense",        boost: 0.15, icon: "🌦️" },
  // Code 61 : pluie légère → 0.15
  61: { description: "Pluie légère",        boost: 0.15, icon: "🌧️" },
  // Code 63 : pluie modérée → 0.20
  63: { description: "Pluie modérée",       boost: 0.20, icon: "🌧️" },
  // Code 65 : pluie forte → 0.25
  65: { description: "Pluie forte",         boost: 0.25, icon: "🌧️" },
  // Code 71,73,75 : neige → 0.35
  71: { description: "Neige légère",        boost: 0.35, icon: "🌨️" },
  73: { description: "Neige modérée",       boost: 0.35, icon: "🌨️" },
  75: { description: "Neige forte",         boost: 0.35, icon: "🌨️" },
  // Code 80,81,82 : averses → 0.20
  80: { description: "Averses légères",     boost: 0.20, icon: "🌧️" },
  81: { description: "Averses modérées",    boost: 0.20, icon: "🌧️" },
  82: { description: "Averses violentes",   boost: 0.20, icon: "⛈️" },
  // Code 95 : orage → 0.30
  95: { description: "Orage",               boost: 0.30, icon: "⛈️" },
  // Code 96,99 : orage grêle → 0.35
  96: { description: "Orage avec grêle",    boost: 0.35, icon: "⛈️" },
  99: { description: "Orage avec grêle forte", boost: 0.35, icon: "⛈️" },
};

function mapWmoCode(code: number): WmoMapping {
  return WMO_TABLE[code] ?? { description: "Conditions inconnues", boost: 0.0, icon: "🌡️" };
}

// ─── Condition neutre (fallback) ───────────────────────────────────────────────

function neutralCondition(): WeatherCondition {
  return {
    code: 0,
    description: "Ciel dégagé",
    precipitation_mm: 0,
    windspeed_kmh: 0,
    demand_boost: 0.0,
    updated_at: new Date().toISOString(),
    icon: "☀️",
    isFallback: true,
  };
}

// ─── Fetch Open-Meteo via https natif Node.js ──────────────────────────────────

function fetchOpenMeteo(): Promise<any | null> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${IDF_LAT}&longitude=${IDF_LNG}` +
    `&current=precipitation,weathercode,windspeed_10m` +
    `&hourly=precipitation,weathercode,windspeed_10m` +
    `&forecast_days=1&timezone=Europe/Paris`;

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { "User-Agent": "VTC-Intelligence/1.0" },
      timeout: 6000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(body));
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ─── Parsing + calcul du boost ──────────────────────────────────────────────────

function parseWeather(raw: any): WeatherCondition {
  const current = raw?.current ?? {};
  const code = Number(current.weathercode ?? 0);
  const precipitation = Number(current.precipitation ?? 0);
  const windspeed = Number(current.windspeed_10m ?? 0);
  const mapping = mapWmoCode(code);

  return {
    code,
    description: mapping.description,
    precipitation_mm: Math.round(precipitation * 100) / 100,
    windspeed_kmh: Math.round(windspeed * 10) / 10,
    demand_boost: mapping.boost,
    updated_at: new Date().toISOString(),
    icon: mapping.icon,
    isFallback: false,
  };
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * getCurrentWeather — Récupère la météo actuelle (cache TTL 15min).
 * Fetch Open-Meteo, parse, calcule demand_boost, met en cache.
 * En cas d'erreur réseau → retourne une condition neutre (boost=0) silencieusement.
 */
export async function getCurrentWeather(): Promise<WeatherCondition> {
  // Cache valide → retour immédiat
  if (weatherCache && Date.now() - weatherLastFetch < REFRESH_TTL_MS) {
    return weatherCache;
  }

  const raw = await fetchOpenMeteo();
  if (!raw) {
    // Fallback silencieux : boost=0, on conserve éventuellement l'ancien cache
    // si présent (évite de perdre une donnée valide récente sur un blip réseau).
    if (weatherCache) {
      return weatherCache;
    }
    const neutral = neutralCondition();
    weatherCache = neutral;
    weatherLastFetch = Date.now();
    return neutral;
  }

  const condition = parseWeather(raw);
  weatherCache = condition;
  weatherLastFetch = Date.now();
  return condition;
}

/**
 * getWeatherBoost — Retourne le boost météo actuel (sync, depuis le cache).
 * 0.0 si le cache est vide ou expiré (lecture non bloquante).
 */
export function getWeatherBoost(): number {
  if (!weatherCache) return 0.0;
  if (Date.now() - weatherLastFetch >= REFRESH_TTL_MS) return 0.0;
  return weatherCache.demand_boost ?? 0.0;
}

/**
 * getCachedWeather — Retourne la condition en cache (ou null), sans fetch.
 * Utilitaire pour exposer la donnée brute sans déclencher d'appel réseau.
 */
export function getCachedWeather(): WeatherCondition | null {
  return weatherCache;
}

/**
 * refreshWeather — Force le refresh du cache (appelé périodiquement).
 * Non bloquant en cas d'erreur : conserve le boost neutre.
 */
export async function refreshWeather(): Promise<void> {
  weatherLastFetch = 0; // invalide le cache pour forcer le fetch
  await getCurrentWeather();
}
