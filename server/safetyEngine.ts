/**
 * safetyEngine.ts — Couche Sécurité & Fatigue (feat/safety)
 * ─────────────────────────────────────────────────────────────────────────────
 * Regroupe toute la logique serveur de la couche sécurité :
 *   1. Timer légal de conduite continue (driving_sessions)
 *   2. Pauses actives suggérées (2h → medium, 4h30 → high)
 *   3. Score fatigue circadien (0-100, bandes vert/jaune/rouge)
 *   4. Mode "je me sens fatigué" 1-tap
 *   5. Détection micro-sommeil par patterns (statistique, honnête, sans capteur)
 *   6. Zones à éviter sécurité (signalements communautaires ≥3 <6h)
 *   7. Bouton urgence / SOS
 *
 * Principe : réutilise `sqlite` exporté par storage.ts (better-sqlite3), ne
 * recrée pas de connexion DB. Aucune nouvelle dépendance npm.
 *
 * HONNÊTETÉ RGPD / légal : toute estimation de fatigue ou de risque est
 * présentée comme une estimation statistique, jamais comme un diagnostic
 * médical ni une détection physiologique réelle (pas de capteur caméra/oculaire).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sqlite } from "./storage";

// ─────────────────────────────────────────────────────────────────────────────
// Schéma DB — driving_sessions + safety_reports
// ─────────────────────────────────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS driving_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'default',
    started_at TEXT NOT NULL,
    paused_periods_json TEXT NOT NULL DEFAULT '[]',
    ended_at TEXT,
    total_drive_minutes REAL NOT NULL DEFAULT 0,
    event_type TEXT NOT NULL DEFAULT 'session'
  );
  CREATE INDEX IF NOT EXISTS idx_driving_sessions_user ON driving_sessions(user_id, ended_at);

  CREATE TABLE IF NOT EXISTS safety_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id TEXT,
    lat REAL,
    lng REAL,
    category TEXT NOT NULL DEFAULT 'safety',
    user_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_safety_reports_zone ON safety_reports(zone_id, created_at);

  CREATE TABLE IF NOT EXISTS emergency_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'default',
    lat REAL,
    lng REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notification_response_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'default',
    responded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    response_ms INTEGER NOT NULL
  );
`);

const DEFAULT_USER = "default";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface PausedPeriod {
  start: string; // ISO
  end: string | null; // ISO — null si pause en cours
}

export interface DrivingSessionRow {
  id: number;
  user_id: string;
  started_at: string;
  paused_periods_json: string;
  ended_at: string | null;
  total_drive_minutes: number;
}

export interface CurrentSessionResponse {
  active: boolean;
  paused: boolean;
  drive_minutes_continuous: number;
  next_mandatory_break_in_min: number | null;
  total_today: number;
  session_id: number | null;
}

export interface FatigueFactor {
  name: string;
  weight: number;
}

export interface FatigueScoreResponse {
  score: number;
  band: "green" | "yellow" | "red";
  factors: FatigueFactor[];
  recommendation_fr: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes réglementaires / seuils métier
// ─────────────────────────────────────────────────────────────────────────────
const SUGGESTED_BREAK_AFTER_MIN = 120; // 2h → alerte medium
const HIGH_PRIORITY_BREAK_AFTER_MIN = 270; // 4h30 → alerte high
const LEGAL_MAX_CONTINUOUS_MIN = 270; // repère réglementaire VTC (4h30, non bloquant)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers session
// ─────────────────────────────────────────────────────────────────────────────

function getActiveSession(userId: string = DEFAULT_USER): DrivingSessionRow | null {
  const row = sqlite
    .prepare(
      `SELECT * FROM driving_sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(userId) as DrivingSessionRow | undefined;
  return row ?? null;
}

function parsePausedPeriods(json: string): PausedPeriod[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Minutes de conduite continue depuis started_at, en retirant les pauses terminées et en cours. */
function computeContinuousMinutes(session: DrivingSessionRow, now: Date = new Date()): number {
  const start = new Date(session.started_at).getTime();
  const nowMs = now.getTime();
  const totalElapsedMin = Math.max(0, (nowMs - start) / 60000);

  const periods = parsePausedPeriods(session.paused_periods_json);
  let pausedMin = 0;
  for (const p of periods) {
    const pStart = new Date(p.start).getTime();
    const pEnd = p.end ? new Date(p.end).getTime() : nowMs;
    pausedMin += Math.max(0, (pEnd - pStart) / 60000);
  }

  return Math.max(0, totalElapsedMin - pausedMin);
}

function isSessionPaused(session: DrivingSessionRow): boolean {
  const periods = parsePausedPeriods(session.paused_periods_json);
  return periods.length > 0 && periods[periods.length - 1].end === null;
}

/** Total de minutes conduites aujourd'hui, toutes sessions confondues (terminées + active). */
function computeTotalMinutesToday(userId: string = DEFAULT_USER, now: Date = new Date()): number {
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const rows = sqlite
    .prepare(`SELECT * FROM driving_sessions WHERE user_id = ? AND started_at LIKE ?`)
    .all(userId, `${todayStr}%`) as DrivingSessionRow[];

  let total = 0;
  for (const s of rows) {
    if (s.ended_at) {
      total += s.total_drive_minutes;
    } else {
      total += computeContinuousMinutes(s, now);
    }
  }
  return Math.round(total);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Timer légal — start / pause / resume / end / current
// ─────────────────────────────────────────────────────────────────────────────

export function startSession(userId: string = DEFAULT_USER): DrivingSessionRow {
  // Ferme toute session active orpheline avant d'en démarrer une nouvelle.
  const existing = getActiveSession(userId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const info = sqlite
    .prepare(
      `INSERT INTO driving_sessions (user_id, started_at, paused_periods_json, ended_at, total_drive_minutes) VALUES (?, ?, '[]', NULL, 0)`,
    )
    .run(userId, now);
  return getActiveSession(userId) ?? (sqlite
    .prepare(`SELECT * FROM driving_sessions WHERE id = ?`)
    .get(info.lastInsertRowid) as DrivingSessionRow);
}

export function pauseSession(userId: string = DEFAULT_USER): DrivingSessionRow | null {
  const session = getActiveSession(userId);
  if (!session) return null;
  if (isSessionPaused(session)) return session;

  const periods = parsePausedPeriods(session.paused_periods_json);
  periods.push({ start: new Date().toISOString(), end: null });
  sqlite
    .prepare(`UPDATE driving_sessions SET paused_periods_json = ? WHERE id = ?`)
    .run(JSON.stringify(periods), session.id);
  return getActiveSession(userId);
}

export function resumeSession(userId: string = DEFAULT_USER): DrivingSessionRow | null {
  const session = getActiveSession(userId);
  if (!session) return null;
  const periods = parsePausedPeriods(session.paused_periods_json);
  if (periods.length === 0 || periods[periods.length - 1].end !== null) return session;

  periods[periods.length - 1].end = new Date().toISOString();
  sqlite
    .prepare(`UPDATE driving_sessions SET paused_periods_json = ? WHERE id = ?`)
    .run(JSON.stringify(periods), session.id);
  return getActiveSession(userId);
}

export function endSession(userId: string = DEFAULT_USER): DrivingSessionRow | null {
  const session = getActiveSession(userId);
  if (!session) return null;

  // Si en pause, on clôt la dernière pause avant de terminer.
  const periods = parsePausedPeriods(session.paused_periods_json);
  if (periods.length > 0 && periods[periods.length - 1].end === null) {
    periods[periods.length - 1].end = new Date().toISOString();
  }

  const now = new Date();
  const driveMinutes = computeContinuousMinutes(
    { ...session, paused_periods_json: JSON.stringify(periods) },
    now,
  );

  sqlite
    .prepare(
      `UPDATE driving_sessions SET ended_at = ?, paused_periods_json = ?, total_drive_minutes = ? WHERE id = ?`,
    )
    .run(now.toISOString(), JSON.stringify(periods), driveMinutes, session.id);

  return sqlite.prepare(`SELECT * FROM driving_sessions WHERE id = ?`).get(session.id) as DrivingSessionRow;
}

export function getCurrentSession(userId: string = DEFAULT_USER): CurrentSessionResponse {
  const session = getActiveSession(userId);
  const now = new Date();

  if (!session) {
    return {
      active: false,
      paused: false,
      drive_minutes_continuous: 0,
      next_mandatory_break_in_min: null,
      total_today: computeTotalMinutesToday(userId, now),
      session_id: null,
    };
  }

  const paused = isSessionPaused(session);
  const continuousMin = computeContinuousMinutes(session, now);
  const nextBreakIn = paused ? null : Math.max(0, Math.round(LEGAL_MAX_CONTINUOUS_MIN - continuousMin));

  // Génère automatiquement les alertes de pause suggérée si seuils franchis.
  maybeGenerateBreakAlert(continuousMin);

  return {
    active: true,
    paused,
    drive_minutes_continuous: Math.round(continuousMin),
    next_mandatory_break_in_min: nextBreakIn,
    total_today: computeTotalMinutesToday(userId, now),
    session_id: session.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pauses actives suggérées — génère une alerte dans la table `alerts`
//    existante (réutilisée, pas de nouvelle table). Anti-spam : 1 alerte par
//    palier par session (marquée via un flag en mémoire par session id).
// ─────────────────────────────────────────────────────────────────────────────

const alertedSessions = new Set<string>(); // clé = `${sessionId}:${priority}`

function maybeGenerateBreakAlert(continuousMin: number): void {
  const session = getActiveSession(DEFAULT_USER);
  if (!session) return;

  let priority: "medium" | "high" | null = null;
  if (continuousMin >= HIGH_PRIORITY_BREAK_AFTER_MIN) {
    priority = "high";
  } else if (continuousMin >= SUGGESTED_BREAK_AFTER_MIN) {
    priority = "medium";
  }
  if (!priority) return;

  const key = `${session.id}:${priority}`;
  if (alertedSessions.has(key)) return;
  alertedSessions.add(key);

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const title = priority === "high" ? "Pause obligatoire" : "Pause conseillée";
  const message =
    priority === "high"
      ? `${(continuousMin / 60).toFixed(1)}h de conduite continue — pause fortement recommandée maintenant`
      : `${(continuousMin / 60).toFixed(1)}h de conduite continue — pensez à une pause courte`;

  sqlite
    .prepare(
      `INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES ('suggested_break',?,?,NULL,?,NULL,?,?,0)`,
    )
    .run(title, message, priority, expiresAt, nowIso);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Score fatigue circadien
// ─────────────────────────────────────────────────────────────────────────────

/** Estime la durée d'éveil en heures — approximation : réveil supposé 2h avant
 *  le début du travail habituel (6h) sauf si session de conduite plus ancienne. */
function estimateAwakeHours(now: Date, session: DrivingSessionRow | null): number {
  const hour = now.getHours() + now.getMinutes() / 60;
  // Hypothèse par défaut : réveil à 6h. Si l'heure actuelle < 6h, on considère
  // un réveil la veille vers 14h (chauffeur de nuit) — reste une estimation.
  let assumedWakeHour = 6;
  if (hour < 6) assumedWakeHour = 22; // conduite de nuit → réveil probable en soirée précédente
  let awake = hour >= assumedWakeHour ? hour - assumedWakeHour : hour + (24 - assumedWakeHour);

  // Si une session de conduite est active depuis plus longtemps que l'estimation,
  // on aligne l'éveil sur le début de session (plus fiable).
  if (session) {
    const startHour =
      (now.getTime() - new Date(session.started_at).getTime()) / 3_600_000;
    awake = Math.max(awake, startHour);
  }
  return Math.max(0, awake);
}

export function computeFatigueScore(userId: string = DEFAULT_USER): FatigueScoreResponse {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  const session = getActiveSession(userId);
  const continuousMin = session ? computeContinuousMinutes(session, now) : 0;
  const totalTodayMin = computeTotalMinutesToday(userId, now);
  const awakeHours = estimateAwakeHours(now, session);

  const factors: FatigueFactor[] = [];
  let score = 0;

  // ── Facteur 1 : creux circadien (2h-6h très marqué, 14h-16h modéré) ──────
  let circadianWeight = 0;
  if (hour >= 2 && hour < 6) {
    circadianWeight = 40;
  } else if (hour >= 14 && hour < 16) {
    circadianWeight = 20;
  }
  if (circadianWeight > 0) {
    factors.push({ name: "Creux circadien (horloge biologique)", weight: circadianWeight });
    score += circadianWeight;
  }

  // ── Facteur 2 : durée d'éveil estimée (au-delà de 12h, risque croissant) ──
  let awakeWeight = 0;
  if (awakeHours >= 17) {
    awakeWeight = 30;
  } else if (awakeHours >= 12) {
    awakeWeight = 15;
  }
  if (awakeWeight > 0) {
    factors.push({ name: `Éveil estimé depuis ~${awakeHours.toFixed(1)}h`, weight: awakeWeight });
    score += awakeWeight;
  }

  // ── Facteur 3 : heures de conduite cumulées aujourd'hui ──────────────────
  const drivenHoursToday = totalTodayMin / 60;
  let drivingWeight = 0;
  if (drivenHoursToday >= 8) {
    drivingWeight = 30;
  } else if (drivenHoursToday >= 5) {
    drivingWeight = 15;
  } else if (drivenHoursToday >= 3) {
    drivingWeight = 5;
  }
  if (drivingWeight > 0) {
    factors.push({ name: `Conduite cumulée aujourd'hui (${drivenHoursToday.toFixed(1)}h)`, weight: drivingWeight });
    score += drivingWeight;
  }

  // ── Facteur 4 : session continue actuelle ────────────────────────────────
  let continuousWeight = 0;
  if (continuousMin >= HIGH_PRIORITY_BREAK_AFTER_MIN) {
    continuousWeight = 20;
  } else if (continuousMin >= SUGGESTED_BREAK_AFTER_MIN) {
    continuousWeight = 10;
  }
  if (continuousWeight > 0) {
    factors.push({ name: "Conduite continue sans pause", weight: continuousWeight });
    score += continuousWeight;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const band: FatigueScoreResponse["band"] = score >= 60 ? "red" : score >= 30 ? "yellow" : "green";

  const recommendation_fr =
    band === "red"
      ? "Fatigue élevée estimée — une pause de 20 min ou l'arrêt de la conduite est fortement recommandé."
      : band === "yellow"
      ? "Vigilance réduite estimée — envisagez une courte pause dans les prochaines minutes."
      : "Aucun signe de fatigue marqué détecté pour le moment.";

  return { score, band, factors, recommendation_fr };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Mode "je me sens fatigué" 1-tap
// ─────────────────────────────────────────────────────────────────────────────

export interface RestSpot {
  name: string;
  type: "aire_repos" | "wc" | "cafe";
  distance_km: number;
}

export interface TiredNowResponse {
  rest_spots: RestSpot[];
  break_duration_min: number;
  estimated_revenue_impact_eur: number;
  message_fr: string;
}

/** Estimation grossière de manque à gagner pour une pause de 20 min, basée sur
 *  un objectif horaire par défaut (35 €/h) — ne fait pas d'appel réseau. */
export function tiredNow(
  lat: number | null,
  lng: number | null,
  hourlyTargetIncome: number = 35,
  userId: string = DEFAULT_USER,
): TiredNowResponse {
  const breakDurationMin = 20;
  const estimatedRevenueImpact = Math.round((hourlyTargetIncome / 60) * breakDurationMin);

  // Zones de repos génériques — dans une vraie implémentation on croiserait
  // avec la couche communauté POI (WC/aires de repos), ici on renvoie un
  // gabarit générique à proximité (pas de nouvelle dépendance API cartographie).
  const rest_spots: RestSpot[] = [
    { name: "Aire de repos la plus proche", type: "aire_repos", distance_km: 2.1 },
    { name: "Station-service avec WC", type: "wc", distance_km: 1.4 },
    { name: "Café ouvert à proximité", type: "cafe", distance_km: 0.8 },
  ];

  // Log l'événement dans driving_sessions (sans créer de nouvelle session —
  // on marque l'événement dans une ligne dédiée pour traçabilité).
  sqlite
    .prepare(
      `INSERT INTO driving_sessions (user_id, started_at, paused_periods_json, ended_at, total_drive_minutes, event_type) VALUES (?, ?, '[]', ?, 0, 'tired_now')`,
    )
    .run(userId, new Date().toISOString(), new Date().toISOString());

  return {
    rest_spots,
    break_duration_min: breakDurationMin,
    estimated_revenue_impact_eur: estimatedRevenueImpact,
    message_fr: `Pause de 20 min conseillée — impact estimé ~${estimatedRevenueImpact}€ de manque à gagner, largement compensé par la sécurité.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Détection micro-sommeil par patterns (statistique, honnête)
// ─────────────────────────────────────────────────────────────────────────────

export interface MicrosleepRiskResponse {
  risk_score: number; // 0-100
  factors: FatigueFactor[];
  honest_disclaimer_fr: string;
}

export function logNotificationResponse(responseMs: number, userId: string = DEFAULT_USER): void {
  sqlite
    .prepare(
      `INSERT INTO notification_response_log (user_id, responded_at, response_ms) VALUES (?, ?, ?)`,
    )
    .run(userId, new Date().toISOString(), Math.round(responseMs));
}

export function computeMicrosleepRisk(userId: string = DEFAULT_USER): MicrosleepRiskResponse {
  const now = new Date();
  const hour = now.getHours();

  const factors: FatigueFactor[] = [];
  let risk = 0;

  // ── Proxy 1 : temps de réponse moyen aux notifications (dernières 2h) ────
  const recentResponses = sqlite
    .prepare(
      `SELECT response_ms FROM notification_response_log WHERE user_id = ? AND responded_at > datetime('now', '-2 hours')`,
    )
    .all(userId) as { response_ms: number }[];

  if (recentResponses.length >= 3) {
    const avgMs = recentResponses.reduce((s, r) => s + r.response_ms, 0) / recentResponses.length;
    if (avgMs > 8000) {
      factors.push({ name: "Temps de réponse aux notifications élevé", weight: 25 });
      risk += 25;
    } else if (avgMs > 4000) {
      factors.push({ name: "Temps de réponse aux notifications modéré", weight: 10 });
      risk += 10;
    }
  }

  // ── Proxy 2 : durée entre courses (rides.timestamp) — variance & longueur ─
  const recentRides = sqlite
    .prepare(
      `SELECT timestamp FROM rides ORDER BY id DESC LIMIT 10`,
    )
    .all() as { timestamp: string }[];

  if (recentRides.length >= 3) {
    const times = recentRides.map((r) => new Date(r.timestamp).getTime()).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 60000);
    if (gaps.length > 0) {
      const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const variance = gaps.reduce((a, b) => a + (b - meanGap) ** 2, 0) / gaps.length;
      const stdDev = Math.sqrt(variance);
      // Variance élevée entre courses peut indiquer irrégularité de rythme.
      if (stdDev > 45) {
        factors.push({ name: "Variance élevée entre courses", weight: 15 });
        risk += 15;
      }
    }
  }

  // ── Proxy 3 : heure de la nuit (creux circadien renforce le proxy) ────────
  if (hour >= 1 && hour < 5) {
    factors.push({ name: "Conduite nocturne (01h-05h)", weight: 30 });
    risk += 30;
  } else if (hour >= 22 || hour < 1) {
    factors.push({ name: "Conduite en soirée tardive", weight: 15 });
    risk += 15;
  }

  // ── Proxy 4 : session de conduite continue longue ────────────────────────
  const session = getActiveSession(userId);
  if (session) {
    const continuousMin = computeContinuousMinutes(session, now);
    if (continuousMin >= HIGH_PRIORITY_BREAK_AFTER_MIN) {
      factors.push({ name: "Session de conduite continue longue", weight: 20 });
      risk += 20;
    }
  }

  risk = Math.max(0, Math.min(100, Math.round(risk)));

  return {
    risk_score: risk,
    factors,
    honest_disclaimer_fr:
      "Estimation statistique basée sur des proxys indirects (rythme, horaire, temps de réaction) — ce n'est PAS un diagnostic médical ni une détection physiologique réelle de somnolence (aucun capteur caméra/oculaire). En cas de doute, arrêtez-vous.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Zones à éviter (sécurité) — signalements ≥3 en <6h
// ─────────────────────────────────────────────────────────────────────────────

export interface AvoidZone {
  zone_id: string | null;
  lat: number | null;
  lng: number | null;
  report_count: number;
  last_report_at: string;
}

export function reportSafetyIncident(
  zoneId: string | null,
  lat: number | null,
  lng: number | null,
  category: string = "safety",
  userId: string = DEFAULT_USER,
): void {
  sqlite
    .prepare(
      `INSERT INTO safety_reports (zone_id, lat, lng, category, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(zoneId, lat, lng, category, userId, new Date().toISOString());
}

export function getAvoidZones(): AvoidZone[] {
  const rows = sqlite
    .prepare(
      `SELECT zone_id, lat, lng, COUNT(*) as report_count, MAX(created_at) as last_report_at
       FROM safety_reports
       WHERE category = 'safety' AND created_at > datetime('now', '-6 hours')
       GROUP BY zone_id
       HAVING COUNT(*) >= 3
       ORDER BY report_count DESC`,
    )
    .all() as AvoidZone[];
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Bouton urgence / SOS
// ─────────────────────────────────────────────────────────────────────────────

export interface EmergencyResponse {
  ok: true;
  alert_id: number | bigint;
  useful_numbers: { label: string; number: string }[];
}

const USEFUL_NUMBERS = [
  { label: "Police secours", number: "17" },
  { label: "Numéro d'urgence européen", number: "112" },
  { label: "SAMU social (sans-abris / détresse)", number: "115" },
  { label: "Numéro national violences (écoute)", number: "3919" },
];

export function triggerEmergency(
  lat: number | null,
  lng: number | null,
  userId: string = DEFAULT_USER,
): EmergencyResponse {
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  sqlite
    .prepare(`INSERT INTO emergency_events (user_id, lat, lng, created_at) VALUES (?, ?, ?, ?)`)
    .run(userId, lat, lng, nowIso);

  const info = sqlite
    .prepare(
      `INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES ('sos','Urgence déclenchée','Bouton urgence activé par le chauffeur',NULL,'critical',NULL,?,?,0)`,
    )
    .run(expiresAt, nowIso);

  return {
    ok: true,
    alert_id: info.lastInsertRowid,
    useful_numbers: USEFUL_NUMBERS,
  };
}
