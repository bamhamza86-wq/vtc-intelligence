/**
 * predictHQService.ts — Service d'intégration PredictHQ pour VTC Intelligence
 *
 * PredictHQ fournit des données d'événements (concerts, sports, festivals…) et
 * des pics de demande ("demand surge") permettant d'anticiper la demande VTC sur
 * les 14 zones (Seine-Saint-Denis 93 + CDG + Orly).
 *
 * - Events API        : GET https://api.predicthq.com/v1/events/
 * - Demand Surge API  : GET https://api.predicthq.com/v1/demand-surge/
 * - Auth              : Authorization: Bearer $API_KEY
 *
 * Règles métier :
 *  - Clé API toujours lue depuis SQLite (table platform_credentials, platform='predicthq').
 *    Jamais hardcodée. Cache de la clé : 60 s.
 *  - Cache mémoire des events : TTL 15 min. Cache des surges : TTL 60 min.
 *  - Fallback gracieux : pas de clé → status "no_key", events vides (jamais d'erreur 500).
 *    Erreur réseau → fallback sur le cache SQLite existant.
 *  - demand_boost plafonné à 2.5 (jamais plus).
 */

import { storage } from "./storage";

const fetch = globalThis.fetch;

// ─── Coordonnées centres de zone (dupliquées de platformDemand.ts) ────────────
// Point de référence : axe principal de la zone (autoroute ou boulevard majeur).
// Note : ces 14 entrées couvrent le 93 + les 2 aéroports (CDG, Orly).
export const ZONE_COORDS: Record<string, { lat: number; lng: number; name: string }> = {
  z_cdg:                  { lat: 49.0097, lng: 2.5479, name: "CDG" },
  z_orly:                 { lat: 48.7262, lng: 2.3652, name: "Orly" },
  z_saint_denis_gare:     { lat: 48.9362, lng: 2.3560, name: "Saint-Denis Gare" },
  z_bobigny_gare:         { lat: 48.9011, lng: 2.4400, name: "Bobigny" },
  z_aubervilliers:        { lat: 48.9144, lng: 2.3831, name: "Aubervilliers" },
  z_plaine_commune:       { lat: 48.9221, lng: 2.3427, name: "Plaine Commune" },
  z_le_bourget:           { lat: 48.9411, lng: 2.4256, name: "Le Bourget" },
  z_villepinte:           { lat: 48.9668, lng: 2.5311, name: "Villepinte" },
  z_tremblay:             { lat: 48.9578, lng: 2.5756, name: "Tremblay" },
  z_epinay_gennevilliers: { lat: 48.9510, lng: 2.3120, name: "Épinay/Gennevilliers" },
  z_montreuil:            { lat: 48.8636, lng: 2.4432, name: "Montreuil" },
  z_aulnay:               { lat: 48.9395, lng: 2.4978, name: "Aulnay" },
  z_93_centre:            { lat: 48.9200, lng: 2.3900, name: "93 Centre" },
  z_stade_france:         { lat: 48.9244, lng: 2.3600, name: "Stade de France" },
};

const ALL_ZONE_IDS = Object.keys(ZONE_COORDS);

// ─── Interfaces ───────────────────────────────────────────────────────────────
export interface PredictHQEvent {
  id: string;
  title: string;
  category: string;
  start: string;            // ISO
  end: string;              // ISO
  rank: number;             // 0-100 global
  local_rank: number;       // 0-100 local
  phq_attendance: number;   // attendees prédits
  transport_spend: number;  // USD transport spend prédit
  lat: number;
  lng: number;
  zone_id: string;          // zone VTC la plus proche (parmi 14)
  demand_boost: number;     // calculé : 1.0 à 2.5x selon rank+attendance
  is_active: boolean;       // actif maintenant ou dans les 3 prochaines heures
  hours_until_start: number;
}

export interface DemandSurgeDate {
  date: string;
  phq_attendance_sum: number;
  intensity: "low" | "medium" | "high" | "extreme";
}

export type PredictHQConnectionStatus = "connected" | "disconnected" | "no_key";

export interface PredictHQStatus {
  status: PredictHQConnectionStatus;
  connected: boolean;       // true si status === 'connected'
  has_key: boolean;
  active_events: number;
  max_boost: number;        // boost demand maximal parmi les events actifs (>= 1.0)
  last_fetch: string | null;
  cache_age_seconds: number | null;
  error: string | null;
}

// ─── Constantes API ───────────────────────────────────────────────────────────
const PHQ_BASE = "https://api.predicthq.com/v1";
const PARIS_PLACE_ID = "2988507"; // GeoNames ID de Paris
const CENTRE_93 = { lat: 48.9200, lng: 2.3900 };
const EVENT_CATEGORIES = "concerts,sports,festivals,performing-arts,community,conferences,expos";
const RANK_LEVELS = "3,4,5"; // Important → Major
const MAX_DEMAND_BOOST = 2.5;

// ─── Caches mémoire ─────────────────────────────────────────────────────────
const EVENTS_CACHE_TTL_MS = 15 * 60 * 1000;   // 15 minutes
const SURGES_CACHE_TTL_MS = 60 * 60 * 1000;   // 60 minutes
const KEY_CACHE_TTL_MS = 60 * 1000;            // 60 secondes

let eventsCache: { data: PredictHQEvent[]; fetchedAt: number } | null = null;
let surgesCache: { data: DemandSurgeDate[]; fetchedAt: number } | null = null;
let keyCache: { key: string | null; status: string; fetchedAt: number } | null = null;
let lastError: string | null = null;

// ─── Lecture de la clé API depuis SQLite (cache 60 s) ─────────────────────────
export function getPredictHQKey(): { key: string | null; status: string } {
  const now = Date.now();
  if (keyCache && now - keyCache.fetchedAt < KEY_CACHE_TTL_MS) {
    return { key: keyCache.key, status: keyCache.status };
  }
  let key: string | null = null;
  let status = "disconnected";
  try {
    const cred = storage.getPlatformCredential("predicthq");
    if (cred) {
      key = cred.api_key && cred.api_key.length > 0 ? cred.api_key : null;
      status = cred.status || "disconnected";
    }
  } catch {
    key = null;
    status = "disconnected";
  }
  keyCache = { key, status, fetchedAt: now };
  return { key, status };
}

// ─── Utilitaires géographiques ────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Trouve la zone VTC la plus proche d'un couple (lat,lng). */
export function findNearestZone(lat: number, lng: number): string {
  let best = ALL_ZONE_IDS[0];
  let bestDist = Infinity;
  for (const zoneId of ALL_ZONE_IDS) {
    const c = ZONE_COORDS[zoneId];
    const d = haversineKm(lat, lng, c.lat, c.lng);
    if (d < bestDist) {
      bestDist = d;
      best = zoneId;
    }
  }
  return best;
}

// ─── Calcul demand_boost depuis rank + phq_attendance ─────────────────────────
// rank >= 80 (Major)        → boost = 2.0 + (phq_attendance/50000), capé 2.5
// rank 60-79 (Significant)  → boost = 1.5 + (phq_attendance/100000), capé 2.0
// rank 40-59 (Important)    → boost = 1.3
// rank < 40                 → boost = 1.1
export function computeDemandBoost(rank: number, phqAttendance: number): number {
  let boost: number;
  if (rank >= 80) {
    boost = Math.min(2.5, 2.0 + phqAttendance / 50000);
  } else if (rank >= 60) {
    boost = Math.min(2.0, 1.5 + phqAttendance / 100000);
  } else if (rank >= 40) {
    boost = 1.3;
  } else {
    boost = 1.1;
  }
  // Plafond métier absolu : jamais > 2.5
  boost = Math.min(MAX_DEMAND_BOOST, boost);
  return Math.round(boost * 100) / 100;
}

// ─── Mapping d'un event PredictHQ brut → PredictHQEvent enrichi ───────────────
function mapRawEvent(raw: any): PredictHQEvent | null {
  if (!raw || !raw.id) return null;

  // Coordonnées : geo.geometry.coordinates = [lng, lat] (ordre GeoJSON)
  let lat = CENTRE_93.lat;
  let lng = CENTRE_93.lng;
  const coords = raw.geo?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
    lng = coords[0];
    lat = coords[1];
  } else if (Array.isArray(raw.location) && raw.location.length >= 2) {
    // certains endpoints renvoient location:[lng,lat]
    lng = raw.location[0];
    lat = raw.location[1];
  }

  const rank = Number(raw.rank ?? 0);
  const localRank = Number(raw.local_rank ?? raw.aviation_rank ?? 0);
  const phqAttendance = Number(raw.phq_attendance ?? 0);
  const transportSpend = Number(
    raw.predicted_event_spend_industries?.transportation ??
      raw.predicted_event_spend ??
      0
  );

  const start = raw.start ?? raw.start_local ?? new Date().toISOString();
  const end = raw.end ?? raw.end_local ?? start;

  const now = Date.now();
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const hoursUntilStart = Math.round(((startMs - now) / (60 * 60 * 1000)) * 10) / 10;

  // Actif : en cours OU démarre dans les 7 prochains jours
  // Raison : les events PredictHQ à venir (ex. Top 14 Final le 28 juin) doivent
  // déjà influer sur le boost de demande afin d'anticiper les pics.
  const isOngoing = startMs <= now && endMs >= now;
  const startsSoon = startMs > now && startMs - now <= 7 * 24 * 60 * 60 * 1000;
  const isActive = isOngoing || startsSoon;

  const zoneId = findNearestZone(lat, lng);
  const demandBoost = computeDemandBoost(rank, phqAttendance);

  return {
    id: String(raw.id),
    title: raw.title ?? "(sans titre)",
    category: raw.category ?? "unknown",
    start,
    end,
    rank,
    local_rank: localRank,
    phq_attendance: phqAttendance,
    transport_spend: transportSpend,
    lat,
    lng,
    zone_id: zoneId,
    demand_boost: demandBoost,
    is_active: isActive,
    hours_until_start: hoursUntilStart,
  };
}

// ─── Appel HTTP générique vers PredictHQ ──────────────────────────────────────
async function phqGet(path: string, params: Record<string, string>, apiKey: string): Promise<any | null> {
  const qs = new URLSearchParams(params).toString();
  const url = `${PHQ_BASE}${path}?${qs}`;
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        lastError = "Clé API invalide ou non autorisée";
      } else if (resp.status === 429) {
        lastError = "Quota PredictHQ dépassé";
      } else {
        lastError = `HTTP ${resp.status}`;
      }
      return null;
    }
    lastError = null;
    return await resp.json();
  } catch (e: any) {
    lastError = e?.message ?? "Erreur réseau";
    return null;
  }
}

// ─── Fenêtre temporelle active.gte / active.lte (aujourd'hui → +7j) ───────────
function activeWindow(days = 7): { gte: string; lte: string } {
  const now = new Date();
  const gte = now.toISOString().slice(0, 10);
  const later = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const lte = later.toISOString().slice(0, 10);
  return { gte, lte };
}

// ─── fetchNearbyEvents : events dans un rayon autour d'un point ───────────────
export async function fetchNearbyEvents(
  lat: number,
  lng: number,
  radiusKm = 30
): Promise<PredictHQEvent[]> {
  const { key } = getPredictHQKey();
  if (!key) return [];
  const win = activeWindow(7);
  const raw = await phqGet(
    "/events/",
    {
      within: `${radiusKm}km@${lat},${lng}`,
      category: EVENT_CATEGORIES,
      "impact.industry": "transportation",
      "active.gte": win.gte,
      "active.lte": win.lte,
      rank_level: RANK_LEVELS,
      limit: "50",
    },
    key
  );
  if (!raw || !Array.isArray(raw.results)) return [];
  return raw.results.map(mapRawEvent).filter((e: PredictHQEvent | null): e is PredictHQEvent => e !== null);
}

// ─── fetchEventsForZones : events pour les 14 zones VTC (93 + CDG + Orly) ─────
export async function fetchEventsForZones(): Promise<PredictHQEvent[]> {
  // Cache mémoire valide → retour immédiat
  if (eventsCache && Date.now() - eventsCache.fetchedAt < EVENTS_CACHE_TTL_MS) {
    return eventsCache.data;
  }

  const { key } = getPredictHQKey();
  if (!key) {
    // Pas de clé : retour gracieux, on tente le cache SQLite existant
    const fromDb = storage.getActivePredictHQEvents();
    return fromDb;
  }

  const win = activeWindow(7);
  const dedup = new Map<string, PredictHQEvent>();

  // 1) Requête centrale 93 (rayon 30 km depuis le centre 93)
  const central = await phqGet(
    "/events/",
    {
      within: `30km@${CENTRE_93.lat},${CENTRE_93.lng}`,
      category: EVENT_CATEGORIES,
      "impact.industry": "transportation",
      "active.gte": win.gte,
      "active.lte": win.lte,
      rank_level: RANK_LEVELS,
      limit: "50",
    },
    key
  );

  // 2) Aéroport CDG (place.scope=CDG)
  const cdg = await phqGet(
    "/events/",
    {
      "place.scope": "CDG",
      category: EVENT_CATEGORIES,
      "active.gte": win.gte,
      "active.lte": win.lte,
      rank_level: RANK_LEVELS,
      limit: "50",
    },
    key
  );

  // 3) Aéroport Orly (place.scope=ORY)
  const ory = await phqGet(
    "/events/",
    {
      "place.scope": "ORY",
      category: EVENT_CATEGORIES,
      "active.gte": win.gte,
      "active.lte": win.lte,
      rank_level: RANK_LEVELS,
      limit: "50",
    },
    key
  );

  const networkFailed = central === null && cdg === null && ory === null;
  if (networkFailed) {
    // Fallback sur le cache SQLite existant en cas d'échec réseau total
    const fromDb = storage.getActivePredictHQEvents();
    if (fromDb.length > 0) return fromDb;
  }

  for (const payload of [central, cdg, ory]) {
    if (payload && Array.isArray(payload.results)) {
      for (const raw of payload.results) {
        const ev = mapRawEvent(raw);
        if (ev) dedup.set(ev.id, ev);
      }
    }
  }

  const events = Array.from(dedup.values());

  // Persister en SQLite + mettre à jour le cache mémoire
  try {
    storage.upsertPredictHQEvents(events);
    storage.clearOldPredictHQEvents();
  } catch {
    /* persistance best-effort */
  }
  eventsCache = { data: events, fetchedAt: Date.now() };

  console.log(`[PredictHQ] fetched ${events.length} events for ${ALL_ZONE_IDS.length} zones`);
  return events;
}

// ─── fetchDemandSurges : prochains pics de demande (7 jours) ──────────────────
export async function fetchDemandSurges(days = 7): Promise<DemandSurgeDate[]> {
  if (surgesCache && Date.now() - surgesCache.fetchedAt < SURGES_CACHE_TTL_MS) {
    return surgesCache.data;
  }

  const { key } = getPredictHQKey();
  if (!key) return [];

  const win = activeWindow(days);
  const raw = await phqGet(
    "/demand-surge/",
    {
      date_from: win.gte,
      date_to: win.lte,
      min_surge_intensity: "m",
      "location.place_id": PARIS_PLACE_ID,
    },
    key
  );

  if (!raw) {
    // Erreur réseau : conserver l'ancien cache s'il existe
    if (surgesCache) return surgesCache.data;
    return [];
  }

  const results: any[] = raw.results ?? raw.demand_surges ?? [];
  const surges: DemandSurgeDate[] = results.map((r: any) => {
    const attendance = Number(r.phq_attendance_sum ?? r.phq_attendance ?? 0);
    return {
      date: r.date ?? r.event_date ?? win.gte,
      phq_attendance_sum: attendance,
      intensity: classifySurgeIntensity(attendance),
    };
  });

  surgesCache = { data: surges, fetchedAt: Date.now() };
  return surges;
}

function classifySurgeIntensity(attendanceSum: number): DemandSurgeDate["intensity"] {
  if (attendanceSum >= 100000) return "extreme";
  if (attendanceSum >= 40000) return "high";
  if (attendanceSum >= 10000) return "medium";
  return "low";
}

// ─── getActivePredictHQEvents : events actifs (cache mémoire → SQLite fallback) ───
// Exposé pour les consommateurs (ex. calcul de boost par zone dans routes.ts).
// Async pour pouvoir déclencher un refresh transparent si le cache est vide.
export async function getActivePredictHQEvents(zoneId?: string): Promise<PredictHQEvent[]> {
  // Si le cache mémoire est valide, on l'utilise directement (hot-path rapide).
  let events: PredictHQEvent[];
  if (eventsCache && Date.now() - eventsCache.fetchedAt < EVENTS_CACHE_TTL_MS) {
    events = eventsCache.data;
  } else {
    // Sinon tenter un refresh (qui retombe gracieusement sur SQLite si pas de clé/réseau).
    try {
      events = await fetchEventsForZones();
    } catch {
      events = storage.getActivePredictHQEvents(zoneId) as unknown as PredictHQEvent[];
    }
  }
  let active = events.filter((e) => e.is_active);
  if (zoneId) active = active.filter((e) => e.zone_id === zoneId);
  return active;
}

// ─── getEventBoostForZone : boost horaire pour une zone donnée ────────────────
// Délègue au cache SQLite (rapide, hot-path) qui retourne 1.0 si aucun event.
export function getEventBoostForZone(zoneId: string, hour: number): number {
  try {
    return storage.getPredictHQBoostForZone(zoneId, hour);
  } catch {
    return 1.0;
  }
}

// ─── getPredictHQStatus : statut de connexion ─────────────────────────────────
export function getPredictHQStatus(): PredictHQStatus {
  const { key, status } = getPredictHQKey();
  let activeEvents = 0;
  let maxBoost = 1.0;
  try {
    const rows = storage.getActivePredictHQEvents();
    const active = rows.filter((e) => e.is_active);
    activeEvents = active.length;
    for (const e of active) {
      if ((e.demand_boost ?? 1.0) > maxBoost) maxBoost = e.demand_boost;
    }
    maxBoost = Math.min(MAX_DEMAND_BOOST, maxBoost);
  } catch {
    activeEvents = 0;
    maxBoost = 1.0;
  }

  let connStatus: PredictHQConnectionStatus;
  if (!key) {
    connStatus = "no_key";
  } else if (status === "connected") {
    connStatus = "connected";
  } else {
    connStatus = "disconnected";
  }

  const lastFetch = eventsCache ? new Date(eventsCache.fetchedAt).toISOString() : null;
  const cacheAge = eventsCache ? Math.round((Date.now() - eventsCache.fetchedAt) / 1000) : null;

  return {
    status: connStatus,
    connected: connStatus === "connected",
    has_key: !!key,
    active_events: activeEvents,
    max_boost: Math.round(maxBoost * 100) / 100,
    last_fetch: lastFetch,
    cache_age_seconds: cacheAge,
    error: lastError,
  };
}

// ─── refresh forcé (vide le cache mémoire puis refetch) ───────────────────────
export async function refreshPredictHQEvents(): Promise<{ count: number; status: PredictHQConnectionStatus }> {
  eventsCache = null;
  keyCache = null;
  const { key } = getPredictHQKey();
  if (!key) {
    return { count: 0, status: "no_key" };
  }
  const events = await fetchEventsForZones();
  const st = getPredictHQStatus();
  return { count: events.length, status: st.status };
}

// ─── Test de connexion (utilisé par /api/platforms/test/predicthq) ────────────
export async function testPredictHQConnection(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!apiKey || apiKey.length < 10) return { ok: false, error: "Clé API invalide (trop courte)" };
  try {
    const resp = await fetch(`${PHQ_BASE}/events/?limit=1`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) return { ok: true };
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: "Clé API invalide ou non autorisée" };
    if (resp.status === 429) return { ok: false, error: "Quota PredictHQ dépassé" };
    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Erreur réseau" };
  }
}
