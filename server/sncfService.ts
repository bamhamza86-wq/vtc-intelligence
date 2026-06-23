/**
 * sncfService.ts — Service signal "trains" 100% heuristique (sans token, sans API externe)
 *
 * Stratégie : les trains Transilien / RER / Intercités / TGV des grandes gares IDF
 * suivent des patterns horaires très réguliers. On modélise ces patterns par gare
 * (heures de pointe + nombre de départs/h) et on en dérive un boost de demande VTC
 * pour les zones impactées autour de chaque gare.
 *
 * Aucune dépendance réseau : tout est calculé localement à partir de
 * GARE_ZONE_MAPPING. Le résultat est mis en cache mémoire (TTL 5 min) par heure.
 *
 * TODO (extension navitia.io) : si un token NAVITIA_TOKEN est disponible dans
 * l'environnement, on pourra remplacer la couche heuristique par un appel à
 * https://api.navitia.io/v1/coverage/sncf/stop_areas/<gare>/departures pour
 * obtenir les départs théoriques temps réel. La signature getSncfSignals() et la
 * forme de SncfStats restent inchangées — seul le calcul de departures_count
 * serait branché sur l'API. Voir fetchNavitiaDepartures() (stub ci-dessous).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TrainSignal {
  gare_id: string;
  gare_name: string;
  heure: number;          // heure CEST 0-23
  departures_count: number;
  is_peak: boolean;
  zones_impacted: string[];
  demand_boost: number;   // 0.0 à 0.30
  type: "intercites" | "transilien" | "rer" | "tgv";
  updated_at: string;
}

export interface SncfStats {
  active_signals: TrainSignal[];
  total_boost: number;     // boost maximum parmi tous les signaux actifs
  peak_zones: string[];    // zones impactées en ce moment
  next_peak_hour: number;  // prochaine heure de pointe globale
  updated_at: string;
}

// ─── Configuration des gares ──────────────────────────────────────────────────

interface GareConfig {
  name: string;
  lat: number;
  lng: number;
  type: TrainSignal["type"];
  zones: string[];
  boost_radius: number; // km (informatif / carte)
  peak_departures_per_hour: {
    weekday: Record<string, number>;
    weekend: Record<string, number>;
  };
  vtc_demand_boost: number; // boost nominal à l'heure de pointe exacte
}

// Mapping gare → zone VTC impactée + boost (fourni par le métier)
// Coordonnées GPS ajoutées pour l'affichage des marqueurs Leaflet côté carte.
export const GARE_ZONE_MAPPING: Record<string, GareConfig> = {
  gare_du_nord: {
    name: "Gare du Nord",
    lat: 48.8809,
    lng: 2.3553,
    type: "transilien",
    zones: ["z_saint_denis_gare", "z_93_centre", "z_stade_france"],
    boost_radius: 1.5,
    peak_departures_per_hour: {
      weekday: { "7": 18, "8": 22, "9": 15, "17": 16, "18": 20, "19": 16 },
      weekend: { "10": 8, "11": 8, "20": 10, "21": 10 },
    },
    vtc_demand_boost: 0.20,
  },
  gare_cdg: {
    name: "Aéroport CDG (RER B / TGV)",
    lat: 49.0044,
    lng: 2.5703,
    type: "rer",
    zones: ["z_cdg"],
    boost_radius: 5.0,
    peak_departures_per_hour: {
      weekday: { "6": 12, "7": 15, "8": 15, "12": 10, "17": 12, "18": 15, "19": 12 },
      weekend: { "8": 8, "12": 8, "16": 8 },
    },
    vtc_demand_boost: 0.25,
  },
  villepinte_expo: {
    name: "Parc des Expositions (Villepinte)",
    lat: 48.9744,
    lng: 2.5159,
    type: "rer",
    zones: ["z_villepinte", "z_le_bourget", "z_aulnay"],
    boost_radius: 3.0,
    // Salons/événements : pic matin 8-10h et après-midi 16-19h
    peak_departures_per_hour: {
      weekday: { "8": 12, "9": 10, "16": 14, "17": 18, "18": 14 },
      weekend: {},
    },
    vtc_demand_boost: 0.20,
  },
  stade_de_france: {
    name: "Stade de France — Saint-Denis",
    lat: 48.9245,
    lng: 2.3601,
    type: "rer",
    zones: ["z_stade_france", "z_93_centre", "z_saint_denis_gare"],
    boost_radius: 2.0,
    peak_departures_per_hour: {
      weekday: { "8": 8, "9": 6, "17": 8, "18": 12, "19": 14, "20": 18, "21": 16, "22": 10 },
      weekend: { "10": 6, "14": 8, "20": 18, "21": 16, "22": 10, "23": 8 },
    },
    vtc_demand_boost: 0.25,
  },
};

// ─── Helpers temps ─────────────────────────────────────────────────────────────

// Heure CEST courante (UTC+2). Cohérent avec le reste de l'app (storage.ts).
function currentCestHour(): number {
  return (new Date().getUTCHours() + 2) % 24;
}

function isWeekendNow(): boolean {
  // getDay() est en heure locale serveur ; on reste cohérent avec generateDynamicAlerts
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

// ─── Cache mémoire (TTL 5 min, clé = heure) ─────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const statsCache = new Map<string, { data: SncfStats; fetchedAt: number }>();

// ─── Calcul du boost progressif autour d'une heure de pointe ───────────────────
//
// Signal actif = heure courante à ±30 min d'une heure de pointe (donc l'heure
// exacte). Boost progressif autour du pic :
//   - pic à l'heure exacte (delta 0)        → 100 %
//   - ±1h                                    →  50 %
//   - ±2h                                    →  20 %
//   - au-delà                                →   0 %
// On retourne le boost effectif d'UNE gare pour UNE heure donnée.
function gareBoostAtHour(cfg: GareConfig, hour: number, weekend: boolean): { boost: number; departures: number; isPeak: boolean } {
  const table = weekend ? cfg.peak_departures_per_hour.weekend : cfg.peak_departures_per_hour.weekday;
  const peakHours = Object.keys(table).map((k) => parseInt(k, 10));
  if (peakHours.length === 0) return { boost: 0, departures: 0, isPeak: false };

  // Trouver l'heure de pointe la plus proche (en tenant compte du wrap minuit)
  let bestDelta = 99;
  let bestPeakHour = -1;
  for (const ph of peakHours) {
    const raw = Math.abs(ph - hour);
    const delta = Math.min(raw, 24 - raw); // distance circulaire
    if (delta < bestDelta) {
      bestDelta = delta;
      bestPeakHour = ph;
    }
  }

  // Atténuation progressive selon l'écart à l'heure de pointe
  let attenuation: number;
  if (bestDelta === 0) attenuation = 1.0;
  else if (bestDelta <= 1) attenuation = 0.5; // -50 % à ±1h
  else if (bestDelta <= 2) attenuation = 0.2; // -80 % à ±2h
  else return { boost: 0, departures: 0, isPeak: false };

  const departuresPeak = table[String(bestPeakHour)] ?? 0;
  // departures effectifs estimés à cette heure (proportionnels à l'atténuation)
  const departures = Math.round(departuresPeak * attenuation);

  // Boost = boost_gare × (departures_count / 20) plafonné à 1.0, puis atténué
  // departures_count est le nombre de départs à l'heure de pointe (densité gare).
  const densityFactor = Math.min(departuresPeak / 20, 1.0);
  const boost = cfg.vtc_demand_boost * densityFactor * attenuation;

  return { boost: Math.min(boost, 0.30), departures, isPeak: bestDelta === 0 };
}

// ─── Calcul de tous les signaux actifs pour une heure ──────────────────────────

function computeSignals(hour: number, weekend: boolean): SncfStats {
  const now = new Date().toISOString();
  const active: TrainSignal[] = [];

  for (const [gareId, cfg] of Object.entries(GARE_ZONE_MAPPING)) {
    const { boost, departures, isPeak } = gareBoostAtHour(cfg, hour, weekend);
    if (boost <= 0) continue;
    active.push({
      gare_id: gareId,
      gare_name: cfg.name,
      heure: hour,
      departures_count: departures,
      is_peak: isPeak,
      zones_impacted: cfg.zones,
      demand_boost: Math.round(boost * 1000) / 1000,
      type: cfg.type,
      updated_at: now,
    });
  }

  const totalBoost = active.reduce((max, s) => Math.max(max, s.demand_boost), 0);
  const peakZones = Array.from(
    new Set(active.filter((s) => s.demand_boost > 0).flatMap((s) => s.zones_impacted))
  );

  // Prochaine heure de pointe globale (toutes gares confondues)
  const nextPeakHour = computeNextGlobalPeakHour(hour, weekend);

  return {
    active_signals: active.sort((a, b) => b.demand_boost - a.demand_boost),
    total_boost: Math.round(totalBoost * 1000) / 1000,
    peak_zones: peakZones,
    next_peak_hour: nextPeakHour,
    updated_at: now,
  };
}

function computeNextGlobalPeakHour(hour: number, weekend: boolean): number {
  const allPeaks = new Set<number>();
  for (const cfg of Object.values(GARE_ZONE_MAPPING)) {
    const table = weekend ? cfg.peak_departures_per_hour.weekend : cfg.peak_departures_per_hour.weekday;
    for (const k of Object.keys(table)) allPeaks.add(parseInt(k, 10));
  }
  if (allPeaks.size === 0) return -1;
  const sorted = Array.from(allPeaks).sort((a, b) => a - b);
  for (let delta = 1; delta <= 24; delta++) {
    const h = (hour + delta) % 24;
    if (sorted.includes(h)) return h;
  }
  return sorted[0];
}

// ─── API publique ──────────────────────────────────────────────────────────────

/**
 * Calcule les signaux de trains actifs pour l'heure donnée (défaut : heure CEST
 * actuelle). Retourne les zones impactées et le boost associé. Cache TTL 5 min.
 */
export async function getSncfSignals(hour?: number): Promise<SncfStats> {
  const weekend = isWeekendNow();
  const h = hour ?? currentCestHour();
  const cacheKey = `${weekend ? "we" : "wd"}_${h}`;

  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const data = computeSignals(h, weekend);
  statsCache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}

/**
 * Retourne le boost SNCF pour une zone donnée à une heure donnée (0.0 à 0.30).
 * Synchrone (pas d'I/O) — utilisable directement dans computeScore().
 * Si plusieurs gares impactent la même zone, on retient le boost maximum.
 */
export function getZoneSncfBoost(zoneId: string, hour: number): number {
  const weekend = isWeekendNow();
  let best = 0;
  for (const cfg of Object.values(GARE_ZONE_MAPPING)) {
    if (!cfg.zones.includes(zoneId)) continue;
    const { boost } = gareBoostAtHour(cfg, hour, weekend);
    if (boost > best) best = boost;
  }
  return Math.min(best, 0.30);
}

/**
 * Variante synchrone de getSncfSignals() — utile dans les contextes non-async
 * (ex. generateDynamicAlerts dans storage.ts). Pas d'I/O, pas de cache.
 */
export function getSncfSignalsSync(hour?: number): SncfStats {
  const weekend = isWeekendNow();
  const h = hour ?? currentCestHour();
  return computeSignals(h, weekend);
}

// ─── Stub navitia.io (TODO branchement futur si token dispo) ───────────────────
// Laissé non câblé volontairement : aucune requête réseau n'est émise tant que
// NAVITIA_TOKEN n'est pas défini ET que ce stub n'est pas appelé.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function fetchNavitiaDepartures(_gareId: string): Promise<number | null> {
  const token = process.env.NAVITIA_TOKEN;
  if (!token) return null; // pas de token → on reste 100% heuristique
  // TODO: appeler https://api.navitia.io/v1/coverage/sncf/stop_areas/<id>/departures
  //       avec header Authorization: <token>, parser departures.length sur 1h.
  return null;
}
