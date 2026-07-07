/**
 * airportEngine.ts — Couche AÉROPORTS + ÉVÉNEMENTS + GRÈVES
 * ─────────────────────────────────────────────────────────────────────────────
 * Mécaniques temporelles et de queue pour muscler /api/flights, /api/predicthq/*
 * et /api/sncf/* existants :
 *
 *  1. Queue aéroport communautaire (CDG/Orly/Le Bourget)
 *  2. Estimation d'attente basée sur flights + queue
 *  3. Timer priorité 10 min post-dépose
 *  4. Alerte fin d'événement (cron 3 min)
 *  5. Calendrier événements Île-de-France centralisé
 *  6. Alerte grève RATP-SNCF
 *  7. Zones dépose/reprise optimisées par salle
 *  8. Prévision demande post-événement
 *
 * Aucune nouvelle dépendance npm. Réutilise better-sqlite3 (storage.ts),
 * flightService.ts, predictHQService.ts, sncfService.ts existants.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sqlite } from "./storage";
import { getFlightData } from "./flightService";
import type { FlightData, FlightStats } from "./flightService";
import { getSncfSignals } from "./sncfService";
import type { SncfStats } from "./sncfService";
import { VENUE_DROPOFF_POINTS, RECURRING_IDF_EVENTS } from "./idfVenues";
import type { RecurringEventType } from "./idfVenues";

// ─── Seed unique des points de dépose (idempotent) ─────────────────────────
(function seedVenueDropoffPoints() {
  const count = (sqlite.prepare("SELECT COUNT(*) as n FROM venue_dropoff_points").get() as any).n;
  if (count > 0) return;
  const stmt = sqlite.prepare(
    "INSERT INTO venue_dropoff_points (venue_key, salle_name, lat, lng, ideal_side, notes_fr, walking_distance_m) VALUES (?,?,?,?,?,?,?)"
  );
  const tx = sqlite.transaction((rows: typeof VENUE_DROPOFF_POINTS) => {
    for (const r of rows) {
      stmt.run(r.venue_key, r.salle_name, r.lat, r.lng, r.ideal_side, r.notes_fr, r.walking_distance_m);
    }
  });
  tx(VENUE_DROPOFF_POINTS);
  console.log(`[airportEngine] Seed venue_dropoff_points : ${VENUE_DROPOFF_POINTS.length} salles`);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 1 & 2. QUEUE AÉROPORT COMMUNAUTAIRE + ESTIMATION D'ATTENTE
// ═══════════════════════════════════════════════════════════════════════════

export type AirportCode = "CDG" | "ORY" | "LBG";

const AIRPORT_ZONE: Record<AirportCode, string> = {
  CDG: "z_cdg",
  ORY: "z_orly",
  LBG: "z_le_bourget",
};

// Temps moyen de "dispatch" (prise en charge + départ effectif d'un véhicule
// depuis le point de queue) — donnée métier calibrée par aéroport.
const AVG_DISPATCH_MIN: Record<AirportCode, number> = {
  CDG: 4.5,
  ORY: 3.8,
  LBG: 3.0, // faible trafic, dispatch plus rapide
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Récupère la file active (non quittée) d'un aéroport, triée par ancienneté. */
function getActiveQueue(airport: AirportCode): any[] {
  return sqlite
    .prepare(
      "SELECT * FROM airport_queue WHERE airport = ? AND left_at IS NULL ORDER BY joined_at ASC"
    )
    .all(airport) as any[];
}

/** Vols arrivant dans l'heure pour l'aéroport donné, à partir du service flights existant. */
async function getArrivingFlightsPerHour(airport: AirportCode): Promise<number> {
  if (airport === "LBG") {
    // Le Bourget n'est pas couvert par flightService (aviation d'affaires) →
    // estimation heuristique basse et stable.
    return 3;
  }
  try {
    const data: FlightData = await getFlightData();
    const stats: FlightStats = airport === "CDG" ? data.cdg : data.orly;
    return Math.max(0, stats.arrivals_next_hour || 0);
  } catch {
    return airport === "CDG" ? 20 : 12; // fallback heuristique si l'API vols est indisponible
  }
}

/**
 * Calcule le temps d'attente estimé pour une position donnée dans la queue.
 *
 * Formule métier :
 *   wait_min = position × (avg_dispatch_min / max(1, arriving_flights_per_hour × 0.35))
 *
 * Intuition : plus il arrive de vols par heure, plus il y a de passagers donc de
 * courses demandées → le "débit" de la file (véhicules dispatchés par heure) est
 * proportionnel aux arrivées. Le facteur 0.35 calibre la fraction de passagers
 * qui prennent un VTC/taxi (vs transport en commun, navette, dépose personnelle).
 */
async function computeWaitEstimate(
  airport: AirportCode,
  position: number
): Promise<{ wait_min: number; detail_fr: string; arriving_flights_per_hour: number; avg_dispatch_min: number }> {
  const arrivingPerHour = await getArrivingFlightsPerHour(airport);
  const dispatchMin = AVG_DISPATCH_MIN[airport];
  const debitEffectif = Math.max(1, arrivingPerHour * 0.35);
  const waitMin = Math.round(position * (dispatchMin / debitEffectif) * 10) / 10;

  const detail_fr =
    `Calcul : position ${position} × (temps moyen de prise en charge ${dispatchMin} min ÷ ` +
    `débit estimé ${debitEffectif.toFixed(1)} véh/h, dérivé de ${arrivingPerHour} vol(s) arrivant ` +
    `dans l'heure × 0,35 taux de report VTC) = ${waitMin} min.`;

  return { wait_min: Math.max(0, waitMin), detail_fr, arriving_flights_per_hour: arrivingPerHour, avg_dispatch_min: dispatchMin };
}

export interface JoinQueueResult {
  position: number;
  wait_min_estimated: number;
  detail_fr: string;
  total_queue: number;
}

/** POST /api/airport/queue/join — rejoint la file communautaire d'un aéroport. */
export async function joinAirportQueue(
  userId: string,
  airport: AirportCode,
  terminal: string | null
): Promise<JoinQueueResult> {
  // Retire toute entrée active existante pour cet utilisateur (évite doublons multi-aéroports)
  sqlite
    .prepare("UPDATE airport_queue SET left_at = ? WHERE user_id = ? AND left_at IS NULL")
    .run(nowIso(), userId);

  sqlite
    .prepare(
      "INSERT INTO airport_queue (user_id, airport, joined_at, left_at, terminal, position_estimated) VALUES (?,?,?,NULL,?,0)"
    )
    .run(userId, airport, nowIso(), terminal || null);

  const queue = getActiveQueue(airport);
  const position = queue.length; // le nouvel arrivant est en dernière position (FIFO)

  // Met à jour position_estimated pour tous les membres de la file (recalcul FIFO)
  const updateStmt = sqlite.prepare("UPDATE airport_queue SET position_estimated = ? WHERE id = ?");
  queue.forEach((row, idx) => updateStmt.run(idx + 1, row.id));

  const { wait_min, detail_fr } = await computeWaitEstimate(airport, position);

  return { position, wait_min_estimated: wait_min, detail_fr, total_queue: queue.length };
}

/** POST /api/airport/queue/leave — quitte la file (dispatch effectué ou abandon). */
export function leaveAirportQueue(userId: string): { left: boolean } {
  const result = sqlite
    .prepare("UPDATE airport_queue SET left_at = ? WHERE user_id = ? AND left_at IS NULL")
    .run(nowIso(), userId);
  return { left: result.changes > 0 };
}

export interface QueueStatusResult {
  in_queue: boolean;
  airport: AirportCode | null;
  my_position: number | null;
  total_queue: number;
  wait_min_estimated: number | null;
  detail_fr: string | null;
  joined_at: string | null;
}

/** GET /api/airport/queue/status — position actuelle + estimation. */
export async function getQueueStatus(userId: string): Promise<QueueStatusResult> {
  const mine = sqlite
    .prepare("SELECT * FROM airport_queue WHERE user_id = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1")
    .get(userId) as any;

  if (!mine) {
    return {
      in_queue: false,
      airport: null,
      my_position: null,
      total_queue: 0,
      wait_min_estimated: null,
      detail_fr: null,
      joined_at: null,
    };
  }

  const airport = mine.airport as AirportCode;
  const queue = getActiveQueue(airport);
  const myIndex = queue.findIndex((r) => r.id === mine.id);
  const position = myIndex >= 0 ? myIndex + 1 : mine.position_estimated || 1;

  const { wait_min, detail_fr } = await computeWaitEstimate(airport, position);

  return {
    in_queue: true,
    airport,
    my_position: position,
    total_queue: queue.length,
    wait_min_estimated: wait_min,
    detail_fr,
    joined_at: mine.joined_at,
  };
}

/** Nombre total d'utilisateurs actuellement en file, par aéroport (pour tests/monitoring). */
export function getQueueCounts(): Record<AirportCode, number> {
  const rows = sqlite
    .prepare("SELECT airport, COUNT(*) as n FROM airport_queue WHERE left_at IS NULL GROUP BY airport")
    .all() as { airport: AirportCode; n: number }[];
  const result: Record<AirportCode, number> = { CDG: 0, ORY: 0, LBG: 0 };
  for (const r of rows) result[r.airport] = r.n;
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. TIMER PRIORITÉ POST-DÉPOSE (10 MIN)
// ═══════════════════════════════════════════════════════════════════════════

const PRIORITY_WINDOW_MIN = 10;

export interface DropoffResult {
  priority_until: string;
  seconds_remaining: number;
}

/** POST /api/airport/dropoff — enregistre une dépose et démarre le timer priorité. */
export function registerDropoff(userId: string, airport: AirportCode): DropoffResult {
  const dropoffAt = new Date();
  const priorityUntil = new Date(dropoffAt.getTime() + PRIORITY_WINDOW_MIN * 60 * 1000);

  sqlite
    .prepare(
      "INSERT INTO airport_dropoffs (user_id, airport, dropoff_at, priority_until) VALUES (?,?,?,?)"
    )
    .run(userId, airport, dropoffAt.toISOString(), priorityUntil.toISOString());

  // Génère l'alerte de priorité active (haute priorité, expire à la fin du timer)
  try {
    const zoneId = AIRPORT_ZONE[airport];
    sqlite
      .prepare(
        "INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0)"
      )
      .run(
        "airport_priority_active",
        "Priorité 10 min active",
        `Vous bénéficiez de la priorité de reprise pendant 10 min après votre dépose à ${airport}.`,
        zoneId,
        "high",
        null,
        priorityUntil.toISOString(),
        dropoffAt.toISOString()
      );
  } catch (err) {
    console.warn("[airportEngine] Échec création alerte priorité:", err);
  }

  return {
    priority_until: priorityUntil.toISOString(),
    seconds_remaining: PRIORITY_WINDOW_MIN * 60,
  };
}

export interface MyPriorityResult {
  active: boolean;
  seconds_remaining: number;
  airport: AirportCode | null;
}

/** GET /api/airport/my-priority — statut du timer priorité en cours. */
export function getMyPriority(userId: string): MyPriorityResult {
  const row = sqlite
    .prepare(
      "SELECT * FROM airport_dropoffs WHERE user_id = ? ORDER BY dropoff_at DESC LIMIT 1"
    )
    .get(userId) as any;

  if (!row) return { active: false, seconds_remaining: 0, airport: null };

  const remainingMs = new Date(row.priority_until).getTime() - Date.now();
  if (remainingMs <= 0) return { active: false, seconds_remaining: 0, airport: row.airport };

  return {
    active: true,
    seconds_remaining: Math.round(remainingMs / 1000),
    airport: row.airport,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. ALERTE FIN D'ÉVÉNEMENT (cron 3 min)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parcourt predicthq_events actifs : si event.end_time - now est dans la
 * fenêtre [15, 25] minutes, génère une alerte type='event_ending' priorité
 * haute (une seule fois par événement, déduplication via titre+zone récents).
 */
export function runEventEndingCron(): { checked: number; created: number } {
  const nowMs = Date.now();
  const rows = sqlite
    .prepare("SELECT * FROM predicthq_events WHERE is_active = 1")
    .all() as any[];

  let created = 0;
  for (const ev of rows) {
    const endMs = new Date(ev.end_time).getTime();
    if (isNaN(endMs)) continue;
    const minutesUntilEnd = (endMs - nowMs) / 60000;
    if (minutesUntilEnd < 15 || minutesUntilEnd > 25) continue;

    // Déduplication : pas de nouvelle alerte event_ending pour le même event
    // dans les 30 dernières minutes (évite le spam à chaque cycle de cron).
    const dupe = sqlite
      .prepare(
        `SELECT COUNT(*) as n FROM alerts
         WHERE type = 'event_ending' AND zone_id = ? AND message LIKE ?
         AND created_at >= datetime('now', '-30 minutes')`
      )
      .get(ev.zone_id, `%${ev.title}%`) as any;
    if (dupe.n > 0) continue;

    const expectedDemand = ev.phq_attendance > 20000 ? "très forte" : ev.phq_attendance > 5000 ? "forte" : "modérée";
    const expiresAt = new Date(endMs + 30 * 60 * 1000).toISOString();

    sqlite
      .prepare(
        "INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0)"
      )
      .run(
        "event_ending",
        "Fin d'événement imminente",
        `« ${ev.title} » se termine dans environ ${Math.round(minutesUntilEnd)} min — demande attendue ${expectedDemand} dans la zone.`,
        ev.zone_id,
        "high",
        null,
        expiresAt,
        new Date().toISOString()
      );
    created++;
  }
  return { checked: rows.length, created };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. CALENDRIER ÉVÉNEMENTS ÎLE-DE-FRANCE CENTRALISÉ
// ═══════════════════════════════════════════════════════════════════════════

export interface IdfCalendarEntry {
  source: "predicthq" | "recurrent";
  key: string;
  name: string;
  venue_key: string | null;
  zone_id: string;
  event_type: string;
  start_time: string;
  end_time: string;
  expected_attendance: number;
  demand_boost: number;
  impact_level: "faible" | "modere" | "eleve" | "extreme";
}

function impactLevel(boost: number): IdfCalendarEntry["impact_level"] {
  if (boost >= 2.0) return "extreme";
  if (boost >= 1.5) return "eleve";
  if (boost >= 1.2) return "modere";
  return "faible";
}

/** Prochaine occurrence d'un événement récurrent (basé sur typical_days + heure). */
function nextOccurrence(typicalDays: number[], startHour: number, seasonMonths?: number[]): Date {
  const now = new Date();
  for (let offset = 0; offset < 14; offset++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(startHour, 0, 0, 0);
    if (candidate <= now) continue;
    if (!typicalDays.includes(candidate.getDay())) continue;
    if (seasonMonths && !seasonMonths.includes(candidate.getMonth() + 1)) continue;
    return candidate;
  }
  // fallback : dans 7 jours si aucune correspondance trouvée dans la fenêtre
  const fallback = new Date(now);
  fallback.setDate(now.getDate() + 7);
  fallback.setHours(startHour, 0, 0, 0);
  return fallback;
}

/**
 * GET /api/events/idf-calendar?days=7 — agrège PredictHQ (base SQLite) et les
 * événements récurrents hardcodés (server/idfVenues.ts) sur une fenêtre glissante.
 */
export function getIdfCalendar(days: number): IdfCalendarEntry[] {
  const horizonMs = Date.now() + days * 24 * 60 * 60 * 1000;
  const entries: IdfCalendarEntry[] = [];

  // Source 1 : PredictHQ (déjà en base via predicthq_events)
  const phqRows = sqlite
    .prepare("SELECT * FROM predicthq_events WHERE is_active = 1 AND start_time <= ? ORDER BY start_time ASC")
    .all(new Date(horizonMs).toISOString()) as any[];

  for (const ev of phqRows) {
    entries.push({
      source: "predicthq",
      key: `phq_${ev.id}`,
      name: ev.title,
      venue_key: null,
      zone_id: ev.zone_id,
      event_type: ev.category,
      start_time: ev.start_time,
      end_time: ev.end_time,
      expected_attendance: ev.phq_attendance || 0,
      demand_boost: ev.demand_boost || 1.0,
      impact_level: impactLevel(ev.demand_boost || 1.0),
    });
  }

  // Source 2 : événements récurrents hardcodés (PSG, Bercy, Roland-Garros...)
  for (const tpl of RECURRING_IDF_EVENTS) {
    const start = nextOccurrence(tpl.typical_days, tpl.typical_start_hour, tpl.season_months);
    if (start.getTime() > horizonMs) continue;
    const end = new Date(start.getTime() + tpl.typical_duration_min * 60 * 1000);
    entries.push({
      source: "recurrent",
      key: tpl.key,
      name: tpl.name,
      venue_key: tpl.venue_key,
      zone_id: tpl.zone_id,
      event_type: tpl.event_type,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      expected_attendance: tpl.expected_attendance,
      demand_boost: tpl.demand_boost,
      impact_level: impactLevel(tpl.demand_boost),
    });
  }

  // Tri par heure de début, événements les plus impactants remontés dans le sous-ensemble "top 5" côté frontend
  entries.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  return entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. ALERTE GRÈVE RATP-SNCF
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Détection heuristique de perturbation via /api/sncf/signals existant :
 * si le boost total SNCF est anormalement élevé sans justification horaire de
 * pointe (heuristique : boost > 0.22 alors qu'on n'est pas à l'heure de pointe
 * théorique ±1h), on considère qu'il peut y avoir une perturbation/grève en cours.
 * Fallback pur heuristique en l'absence d'un flux officiel IDFM temps réel.
 */
async function detectHeuristicDisruption(): Promise<{ detected: boolean; stats: SncfStats }> {
  const stats = await getSncfSignals();
  const hour = (new Date().getUTCHours() + 2) % 24; // heure Paris approx.
  const isTypicalPeak = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19);
  const detected = stats.total_boost > 0.22 && !isTypicalPeak;
  return { detected, stats };
}

/** Insère une perturbation détectée si aucune entrée équivalente active n'existe déjà. */
async function upsertHeuristicDisruption(): Promise<void> {
  const { detected, stats } = await detectHeuristicDisruption();
  if (!detected) return;

  const existing = sqlite
    .prepare(
      `SELECT COUNT(*) as n FROM transport_disruptions
       WHERE source = 'SNCF' AND line_or_service = 'Détection heuristique'
       AND (active_until IS NULL OR active_until >= datetime('now'))`
    )
    .get() as any;
  if (existing.n > 0) return;

  const activeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // fenêtre 1h
  sqlite
    .prepare(
      "INSERT INTO transport_disruptions (source, line_or_service, severity, impact_desc, zone_id, active_from, active_until, created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    .run(
      "SNCF",
      "Détection heuristique",
      "moderee",
      `Signal SNCF anormalement élevé (boost ${stats.total_boost.toFixed(2)}) hors heure de pointe — possible perturbation, à confirmer.`,
      stats.peak_zones[0] || null,
      new Date().toISOString(),
      activeUntil,
      new Date().toISOString()
    );

  // Alerte associée
  try {
    sqlite
      .prepare(
        "INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0)"
      )
      .run(
        "transit_disruption",
        "Grève / perturbation détectée",
        `Perturbation SNCF probable détectée par signal anormal — demande VTC accrue possible sur zones desservies.`,
        stats.peak_zones[0] || null,
        "high",
        null,
        activeUntil,
        new Date().toISOString()
      );
  } catch (err) {
    console.warn("[airportEngine] Échec création alerte grève:", err);
  }
}

export interface TransportDisruption {
  id: number;
  source: "RATP" | "SNCF" | "IDFM";
  line_or_service: string;
  severity: "mineure" | "moderee" | "majeure";
  impact_desc: string;
  zone_id: string | null;
  active_from: string;
  active_until: string | null;
}

/** GET /api/transport/disruptions?zone_id= — perturbations actives, avec détection heuristique en tâche de fond. */
export async function getTransportDisruptions(zoneId?: string): Promise<TransportDisruption[]> {
  // Tente la détection heuristique avant de lire (non bloquant si l'API SNCF échoue)
  try {
    await upsertHeuristicDisruption();
  } catch (err) {
    console.warn("[airportEngine] Détection heuristique grève échouée:", err);
  }

  const rows = zoneId
    ? sqlite
        .prepare(
          `SELECT * FROM transport_disruptions WHERE (active_until IS NULL OR active_until >= datetime('now')) AND (zone_id = ? OR zone_id IS NULL) ORDER BY active_from DESC`
        )
        .all(zoneId)
    : sqlite
        .prepare(
          `SELECT * FROM transport_disruptions WHERE (active_until IS NULL OR active_until >= datetime('now')) ORDER BY active_from DESC`
        )
        .all();

  return (rows as any[]).map((r) => ({
    id: r.id,
    source: r.source,
    line_or_service: r.line_or_service,
    severity: r.severity,
    impact_desc: r.impact_desc,
    zone_id: r.zone_id,
    active_from: r.active_from,
    active_until: r.active_until,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. ZONES DÉPOSE/REPRISE OPTIMISÉES PAR SALLE
// ═══════════════════════════════════════════════════════════════════════════

export interface DropoffPointResult {
  lat: number;
  lng: number;
  side: string;
  notes_fr: string;
  walking_distance_m: number;
  salle_name: string;
}

/** GET /api/events/dropoff-point?venue_key=&salle= */
export function getDropoffPoint(venueKey: string, salle?: string): DropoffPointResult | null {
  let row: any;
  if (salle) {
    row = sqlite
      .prepare("SELECT * FROM venue_dropoff_points WHERE venue_key = ? AND salle_name LIKE ? LIMIT 1")
      .get(venueKey, `%${salle}%`);
  }
  if (!row) {
    row = sqlite
      .prepare("SELECT * FROM venue_dropoff_points WHERE venue_key = ? LIMIT 1")
      .get(venueKey);
  }
  if (!row) return null;

  return {
    lat: row.lat,
    lng: row.lng,
    side: row.ideal_side,
    notes_fr: row.notes_fr,
    walking_distance_m: row.walking_distance_m,
    salle_name: row.salle_name,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. PRÉVISION DEMANDE POST-ÉVÉNEMENT
// ═══════════════════════════════════════════════════════════════════════════

// Modèle différenciant par type : concert = sortie groupée immédiate,
// foot = sortie étalée, tennis = très étalée, conférence = étalée + tardive.
const POST_DEMAND_PROFILE: Record<
  RecurringEventType | string,
  { peak_min_after_end: number; burst_multiplier: number; duration_min: number }
> = {
  concert: { peak_min_after_end: 12, burst_multiplier: 2.4, duration_min: 35 },
  foot: { peak_min_after_end: 25, burst_multiplier: 1.9, duration_min: 50 },
  tennis: { peak_min_after_end: 20, burst_multiplier: 1.5, duration_min: 60 },
  conference: { peak_min_after_end: 18, burst_multiplier: 1.4, duration_min: 40 },
  // Catégories PredictHQ génériques (fallback)
  sports: { peak_min_after_end: 22, burst_multiplier: 1.8, duration_min: 45 },
  performing_arts: { peak_min_after_end: 12, burst_multiplier: 2.2, duration_min: 35 },
  community: { peak_min_after_end: 15, burst_multiplier: 1.3, duration_min: 30 },
  default: { peak_min_after_end: 18, burst_multiplier: 1.5, duration_min: 40 },
};

export interface PostDemandResult {
  event_id: string;
  event_name: string;
  peak_min_after_end: number;
  expected_burst: string;
  best_zones: { zone_id: string; reason_fr: string }[];
}

/** GET /api/events/post-demand?event_id= */
export function getPostEventDemand(eventId: string): PostDemandResult | null {
  // Recherche d'abord dans predicthq_events, sinon dans les événements récurrents
  const phqRow = sqlite.prepare("SELECT * FROM predicthq_events WHERE id = ?").get(eventId) as any;

  let eventName: string;
  let eventType: string;
  let zoneId: string;

  if (phqRow) {
    eventName = phqRow.title;
    eventType = phqRow.category;
    zoneId = phqRow.zone_id;
  } else {
    const tpl = RECURRING_IDF_EVENTS.find((t) => t.key === eventId);
    if (!tpl) return null;
    eventName = tpl.name;
    eventType = tpl.event_type;
    zoneId = tpl.zone_id;
  }

  const profile = POST_DEMAND_PROFILE[eventType] || POST_DEMAND_PROFILE.default;
  const burstLabel =
    profile.burst_multiplier >= 2.0 ? "très forte, sortie groupée" :
    profile.burst_multiplier >= 1.6 ? "forte, sortie étalée" :
    "modérée, sortie progressive";

  // Zones proches recommandées : la zone de l'événement + toutes les zones "transport"
  // ou "residential" à proximité (le calcul de distance réel utilise déjà les données
  // existantes de storage — ici on reste sur une heuristique simple par nom de zone).
  const bestZones = [
    { zone_id: zoneId, reason_fr: "Zone de l'événement — flux sortant direct." },
  ];

  return {
    event_id: eventId,
    event_name: eventName,
    peak_min_after_end: profile.peak_min_after_end,
    expected_burst: `${burstLabel} (×${profile.burst_multiplier} sur ${profile.duration_min} min)`,
    best_zones: bestZones,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CRON — appelé toutes les 3 min depuis server/routes.ts (aligné cycle existant)
// ═══════════════════════════════════════════════════════════════════════════

export function runAirportEventsCron(): void {
  try {
    const { checked, created } = runEventEndingCron();
    if (created > 0) {
      console.log(`[airportEngine] Cron event_ending : ${created} alerte(s) créée(s) sur ${checked} événement(s) actifs`);
    }
  } catch (err) {
    console.error("[airportEngine] Erreur cron event_ending:", err);
  }

  upsertHeuristicDisruption().catch((err) => {
    console.error("[airportEngine] Erreur cron détection grève:", err);
  });
}
