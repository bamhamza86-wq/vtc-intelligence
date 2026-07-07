/**
 * communityEngine.ts — Couche Communautaire musclée (Waze-like) — VTC Intelligence
 * ─────────────────────────────────────────────────────────────────────────────
 * Étend le signalement 1-tap existant (community_signals / community_impact)
 * avec : réputation contributeur, anti-troll, signaux enrichis (intensité +
 * contexte + commentaire court), decay temporel adaptatif par type, heatmap
 * H3-like en grille 500m, zones à éviter, alerte "zone en train de se vider",
 * et convergence anti-cannibalisation (plafond 8 chauffeurs/zone).
 *
 * Références rapport : sections 1 (signal surge communautaire), 6 (sociale /
 * communauté), 7 (aéroports/événements — contexte "event"), 13.5 (anti-fraude
 * signal communautaire).
 *
 * Design : réutilise la connexion SQLite unique exportée par storage.ts (WAL),
 * aucune nouvelle dépendance npm. Toute migration est additive (ALTER TABLE
 * ADD COLUMN en try/catch, déjà fait dans storage.ts).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sqlite, storage } from "./storage";

function getAllZones(): any[] {
  return storage.getAllZones();
}

// ── Types ─────────────────────────────────────────────────────────────────────
export type SignalContext = "surge" | "dead" | "traffic" | "event" | "safety" | "wc" | "charging";
export type TrustLevel = "novice" | "trusted" | "veteran";

export interface EnrichedSignalInput {
  zoneId: string;
  type: "positive" | "negative";
  userId: string;
  intensity?: number; // 1-3
  context?: SignalContext;
  commentShort?: string;
}

export interface ReputationRow {
  user_id: string;
  karma_score: number;
  signals_correct: number;
  signals_wrong: number;
  trust_level: TrustLevel;
  last_active_at: string;
}

// ── TTL adaptatif par contexte (millisecondes) — §1.4 du rapport ──────────────
// Un signal "surge" doit décliner vite (la demande évolue en minutes), un
// signal "wc"/"charging" est quasi-statique (infrastructure) → TTL long.
const TTL_BY_CONTEXT_MS: Record<SignalContext, number> = {
  surge: 30 * 60 * 1000,      // 30 min
  dead: 45 * 60 * 1000,       // 45 min
  traffic: 60 * 60 * 1000,    // 60 min
  event: 45 * 60 * 1000,      // aligné "dead" par défaut (durée d'un pic événementiel court)
  safety: 6 * 60 * 60 * 1000, // 6h
  wc: 24 * 60 * 60 * 1000,    // 24h
  charging: 24 * 60 * 60 * 1000, // 24h
};
const DEFAULT_TTL_MS = 30 * 60 * 1000; // fallback si pas de contexte (signal "brut" legacy)

export function ttlMsForContext(context?: string | null): number {
  if (context && context in TTL_BY_CONTEXT_MS) return TTL_BY_CONTEXT_MS[context as SignalContext];
  return DEFAULT_TTL_MS;
}

// ── Anti-troll : rate limiting 1 signal/zone/user/5min + cooldown karma bas ──
const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 min

/** Cooldown adaptatif : plus le karma est bas, plus l'attente entre 2 signaux est longue. */
function cooldownMsForKarma(karma: number): number {
  if (karma <= -5) return 20 * 60 * 1000; // 20 min — contributeur très peu fiable
  if (karma < 0) return 10 * 60 * 1000;   // 10 min
  return RATE_LIMIT_MS;                    // 5 min — cas nominal
}

export interface RateLimitCheck {
  allowed: boolean;
  retryAfterSec?: number;
  reason?: string;
}

export function checkRateLimit(zoneId: string, userId: string): RateLimitCheck {
  const rep = getOrCreateReputation(userId);
  const cooldown = cooldownMsForKarma(rep.karma_score);
  const last = sqlite.prepare(
    `SELECT timestamp FROM community_signals WHERE zone_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`
  ).get(zoneId, userId) as { timestamp: string } | undefined;

  if (!last) return { allowed: true };
  const lastMs = new Date(last.timestamp + (last.timestamp.endsWith("Z") ? "" : "Z")).getTime();
  const elapsed = Date.now() - (Number.isFinite(lastMs) ? lastMs : 0);
  if (elapsed < cooldown) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((cooldown - elapsed) / 1000),
      reason: rep.karma_score < 0
        ? "Cooldown prolongé (réputation basse) — merci de patienter avant un nouveau signalement sur cette zone."
        : "Un signalement a déjà été envoyé récemment sur cette zone — merci de patienter.",
    };
  }
  return { allowed: true };
}

// ── Réputation contributeur — §1.7 du rapport ────────────────────────────────
function trustLevelForKarma(karma: number): TrustLevel {
  if (karma >= 30) return "veteran";
  if (karma >= 10) return "trusted";
  return "novice";
}

export function getOrCreateReputation(userId: string): ReputationRow {
  let row = sqlite.prepare(`SELECT * FROM community_reputation WHERE user_id = ?`).get(userId) as ReputationRow | undefined;
  if (!row) {
    sqlite.prepare(
      `INSERT INTO community_reputation (user_id, karma_score, signals_correct, signals_wrong, trust_level, last_active_at)
       VALUES (?, 0, 0, 0, 'novice', CURRENT_TIMESTAMP)`
    ).run(userId);
    row = sqlite.prepare(`SELECT * FROM community_reputation WHERE user_id = ?`).get(userId) as ReputationRow;
  }
  return row;
}

export function touchReputationActivity(userId: string): void {
  getOrCreateReputation(userId);
  sqlite.prepare(`UPDATE community_reputation SET last_active_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(userId);
}

/** +1 karma si un signal est confirmé par >=2 autres contributeurs (même zone+context, fenêtre TTL). */
function maybeRewardConfirmation(zoneId: string, context: string | null, excludeUserId: string): void {
  const rows = sqlite.prepare(
    `SELECT DISTINCT user_id FROM community_signals
     WHERE zone_id = ? AND COALESCE(context,'') = COALESCE(?, '') AND expires_at > datetime('now') AND user_id IS NOT NULL`
  ).all(zoneId, context) as { user_id: string }[];
  if (rows.length < 2) return; // besoin d'au moins 2 CONFIRMATEURS (donc >=3 signaux au total en général)
  // Récompense chaque contributeur distinct impliqué (hors le tout dernier, déjà compté ailleurs si besoin).
  for (const r of rows) {
    if (!r.user_id || r.user_id === "anon") continue;
    rewardKarma(r.user_id, 1, "signal_confirmed");
  }
}

export function rewardKarma(userId: string, delta: number, reason: string): ReputationRow {
  const rep = getOrCreateReputation(userId);
  const newKarma = rep.karma_score + delta;
  const newCorrect = rep.signals_correct + (delta > 0 ? 1 : 0);
  const newWrong = rep.signals_wrong + (delta < 0 ? 1 : 0);
  const newLevel = trustLevelForKarma(newKarma);
  sqlite.prepare(
    `UPDATE community_reputation SET karma_score = ?, signals_correct = ?, signals_wrong = ?, trust_level = ?, last_active_at = CURRENT_TIMESTAMP WHERE user_id = ?`
  ).run(newKarma, newCorrect, newWrong, newLevel, userId);
  return getOrCreateReputation(userId);
}

/** -2 karma si un signal est contredit rapidement par un signal opposé sur la même zone (<5min). */
function maybeePenalizeContradiction(zoneId: string, type: "positive" | "negative", userId: string): void {
  const opposite = type === "positive" ? "negative" : "positive";
  const recentOpposite = sqlite.prepare(
    `SELECT id FROM community_signals
     WHERE zone_id = ? AND signal_type = ? AND user_id != ? AND user_id IS NOT NULL
       AND timestamp > datetime('now', '-5 minutes')
     ORDER BY id DESC LIMIT 1`
  ).get(zoneId, opposite, userId) as { id: number } | undefined;
  if (recentOpposite) {
    rewardKarma(userId, -2, "signal_contradicted");
  }
}

export function getReputationSummary(userId: string): ReputationRow & { next_level_at: number | null } {
  const rep = getOrCreateReputation(userId);
  const next = rep.trust_level === "novice" ? 10 : rep.trust_level === "trusted" ? 30 : null;
  return { ...rep, next_level_at: next };
}

// ── Enregistrement d'un signal enrichi ───────────────────────────────────────
export interface RecordSignalResult {
  ok: true;
  impact: { positive: number; negative: number; boost_pct: number };
  fresh_ratio: number;
  reputation: ReputationRow;
}
export interface RecordSignalError {
  ok: false;
  status: number;
  error: string;
  retryAfterSec?: number;
}

export function recordEnrichedSignal(input: EnrichedSignalInput): RecordSignalResult | RecordSignalError {
  const { zoneId, type, userId } = input;
  const intensity = Math.min(3, Math.max(1, Math.round(input.intensity ?? 2)));
  const context = input.context && input.context in TTL_BY_CONTEXT_MS ? input.context : null;
  const commentShort = (input.commentShort ?? "").slice(0, 60);

  const rl = checkRateLimit(zoneId, userId);
  if (!rl.allowed) {
    return { ok: false, status: 429, error: rl.reason || "Trop de signalements — réessayez plus tard.", retryAfterSec: rl.retryAfterSec };
  }

  const ttlMs = ttlMsForContext(context);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  sqlite.prepare(
    `INSERT INTO community_signals (zone_id, signal_type, user_id, expires_at, intensity, context, comment_short)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(zoneId, type, userId, expiresAt, intensity, context ?? "", commentShort);

  touchReputationActivity(userId);
  maybeePenalizeContradiction(zoneId, type, userId);
  maybeRewardConfirmation(zoneId, context, userId);
  maybeTriggerEmptyingAlert(zoneId);

  const impact = computeImpactForZone(zoneId);
  const fresh = computeFreshRatio(zoneId);
  const reputation = getOrCreateReputation(userId);

  return { ok: true, impact, fresh_ratio: fresh, reputation };
}

// ── Impact agrégé (compatible avec l'ancien format positive/negative/boost_pct) ─
export function computeImpactForZone(zoneId: string): { positive: number; negative: number; boost_pct: number } {
  const rows = sqlite.prepare(
    `SELECT signal_type, COUNT(*) as cnt FROM community_signals
     WHERE zone_id = ? AND expires_at > datetime('now') GROUP BY signal_type`
  ).all(zoneId) as { signal_type: string; cnt: number }[];
  let positive = 0, negative = 0;
  for (const r of rows) {
    if (r.signal_type === "positive") positive = r.cnt;
    else negative = r.cnt;
  }
  const boost_pct = Math.max(-8, Math.min(8, (positive - negative) * 2));
  return { positive, negative, boost_pct };
}

/** fresh_ratio (0-1) : proportion du TTL restant en moyenne pour les signaux actifs de la zone. */
export function computeFreshRatio(zoneId: string): number {
  const rows = sqlite.prepare(
    `SELECT timestamp, expires_at, COALESCE(context,'') as context FROM community_signals
     WHERE zone_id = ? AND expires_at > datetime('now')`
  ).all(zoneId) as { timestamp: string; expires_at: string; context: string }[];
  if (!rows.length) return 0;
  const now = Date.now();
  let sum = 0;
  for (const r of rows) {
    const ttl = ttlMsForContext(r.context || null);
    const expiresMs = new Date(r.expires_at + (r.expires_at.endsWith("Z") ? "" : "Z")).getTime();
    const remaining = Math.max(0, expiresMs - now);
    sum += Math.min(1, remaining / ttl);
  }
  return Math.round((sum / rows.length) * 100) / 100;
}

// ── Heatmap H3-like : grille 500m × 500m sur Île-de-France ──────────────────
// bbox par défaut : 48.6-49.1 lat, 2.0-2.7 lng (Île-de-France)
const IDF_BBOX = { latMin: 48.6, latMax: 49.1, lngMin: 2.0, lngMax: 2.7 };
const CELL_METERS = 500;
const LAT_DEG_PER_METER = 1 / 111_320; // approximation standard
function lngDegPerMeter(lat: number): number {
  return 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
}

export interface HeatmapCell {
  lat: number;
  lng: number;
  count: number;
  intensity: number; // moyenne pondérée 1-3
  dominant_context: string;
  freshness: number; // 0-1
}

export function getHeatmap(bbox?: { latMin: number; latMax: number; lngMin: number; lngMax: number }): HeatmapCell[] {
  const box = bbox ?? IDF_BBOX;
  const zones = getAllZones();
  const zoneById = new Map<string, any>(zones.map((z: any) => [z.id, z]));

  const rows = sqlite.prepare(
    `SELECT zone_id, signal_type, intensity, COALESCE(context,'') as context, timestamp, expires_at
     FROM community_signals WHERE expires_at > datetime('now')`
  ).all() as { zone_id: string; signal_type: string; intensity: number; context: string; timestamp: string; expires_at: string }[];

  const latStep = CELL_METERS * LAT_DEG_PER_METER;
  const cellMap = new Map<string, { lat: number; lng: number; count: number; intensitySum: number; contexts: Record<string, number>; freshSum: number }>();

  for (const r of rows) {
    const zone = zoneById.get(r.zone_id);
    if (!zone) continue;
    const lat = zone.lat, lng = zone.lng;
    if (lat < box.latMin || lat > box.latMax || lng < box.lngMin || lng > box.lngMax) continue;

    const lngStep = CELL_METERS * lngDegPerMeter(lat);
    const cellLatIdx = Math.floor((lat - box.latMin) / latStep);
    const cellLngIdx = Math.floor((lng - box.lngMin) / lngStep);
    const cellLat = box.latMin + (cellLatIdx + 0.5) * latStep;
    const cellLng = box.lngMin + (cellLngIdx + 0.5) * lngStep;
    const key = `${cellLatIdx}_${cellLngIdx}`;

    if (!cellMap.has(key)) {
      cellMap.set(key, { lat: cellLat, lng: cellLng, count: 0, intensitySum: 0, contexts: {}, freshSum: 0 });
    }
    const cell = cellMap.get(key)!;
    cell.count += 1;
    cell.intensitySum += r.intensity || 2;
    const ctxKey = r.context || (r.signal_type === "positive" ? "surge" : "dead");
    cell.contexts[ctxKey] = (cell.contexts[ctxKey] || 0) + 1;

    const ttl = ttlMsForContext(r.context || null);
    const expiresMs = new Date(r.expires_at + (r.expires_at.endsWith("Z") ? "" : "Z")).getTime();
    const remaining = Math.max(0, expiresMs - Date.now());
    cell.freshSum += Math.min(1, remaining / ttl);
  }

  const cells: HeatmapCell[] = [];
  cellMap.forEach((c) => {
    let dominant = "surge";
    let maxCount = -1;
    for (const [ctx, cnt] of Object.entries(c.contexts)) {
      if (cnt > maxCount) { maxCount = cnt; dominant = ctx; }
    }
    cells.push({
      lat: Math.round(c.lat * 1e5) / 1e5,
      lng: Math.round(c.lng * 1e5) / 1e5,
      count: c.count,
      intensity: Math.round((c.intensitySum / c.count) * 100) / 100,
      dominant_context: dominant,
      freshness: Math.round((c.freshSum / c.count) * 100) / 100,
    });
  });

  return cells.sort((a, b) => b.count - a.count);
}

// ── Zones à éviter — agrège safety + dead ────────────────────────────────────
export interface AvoidZone {
  zone_id: string;
  zone_name: string;
  reason: string;
  signal_count: number;
  freshness: number;
  expires_at: string;
}

export function getAvoidZones(topN = 5): AvoidZone[] {
  const zones = getAllZones();
  const zoneById = new Map<string, any>(zones.map((z: any) => [z.id, z]));

  const rows = sqlite.prepare(
    `SELECT zone_id, COALESCE(context,'') as context, signal_type, COUNT(*) as cnt, MAX(expires_at) as max_expires
     FROM community_signals
     WHERE expires_at > datetime('now')
       AND (context IN ('safety','dead') OR (COALESCE(context,'') = '' AND signal_type = 'negative'))
     GROUP BY zone_id, context, signal_type`
  ).all() as { zone_id: string; context: string; signal_type: string; cnt: number; max_expires: string }[];

  const byZone = new Map<string, { safety: number; dead: number; negative: number; maxExpires: string }>();
  for (const r of rows) {
    if (!byZone.has(r.zone_id)) byZone.set(r.zone_id, { safety: 0, dead: 0, negative: 0, maxExpires: r.max_expires });
    const z = byZone.get(r.zone_id)!;
    if (r.context === "safety") z.safety += r.cnt;
    else if (r.context === "dead") z.dead += r.cnt;
    else z.negative += r.cnt;
    if (r.max_expires > z.maxExpires) z.maxExpires = r.max_expires;
  }

  const results: AvoidZone[] = [];
  byZone.forEach((v, zoneId) => {
    const zone = zoneById.get(zoneId);
    if (!zone) return;
    const total = v.safety + v.dead + v.negative;
    if (total < 1) return;
    let reason = "Zone désertée signalée par la communauté";
    if (v.safety > 0 && v.safety >= v.dead) reason = "Signalement sécurité — prudence recommandée";
    else if (v.dead > 0) reason = "Zone signalée sans demande (offre >> demande)";
    results.push({
      zone_id: zoneId,
      zone_name: zone.name,
      reason,
      signal_count: total,
      freshness: computeFreshRatio(zoneId),
      expires_at: v.maxExpires,
    });
  });

  return results.sort((a, b) => b.signal_count - a.signal_count).slice(0, topN);
}

// ── Alerte "zone en train de se vider" — §1.18 du rapport ───────────────────
// Détecte une séquence de signaux négative/dead dans une zone en <15 min et
// crée une entrée dans `alerts` (table déjà utilisée par AlertsPage/toasts).
const EMPTYING_WINDOW_MIN = 15;
const EMPTYING_THRESHOLD = 3; // >=3 signaux négatifs/dead concordants
const EMPTYING_ALERT_COOLDOWN_MIN = 20; // anti-spam : 1 alerte / zone / 20 min

export function maybeTriggerEmptyingAlert(zoneId: string): boolean {
  const row = sqlite.prepare(
    `SELECT COUNT(*) as cnt FROM community_signals
     WHERE zone_id = ?
       AND (signal_type = 'negative' OR context = 'dead')
       AND timestamp > datetime('now', '-${EMPTYING_WINDOW_MIN} minutes')`
  ).get(zoneId) as { cnt: number };

  if (row.cnt < EMPTYING_THRESHOLD) return false;

  const lastAlert = sqlite.prepare(
    `SELECT created_at FROM community_alerts_log WHERE zone_id = ? AND alert_type = 'zone_emptying' ORDER BY id DESC LIMIT 1`
  ).get(zoneId) as { created_at: string } | undefined;
  if (lastAlert) {
    const lastMs = new Date(lastAlert.created_at + (lastAlert.created_at.endsWith("Z") ? "" : "Z")).getTime();
    if (Date.now() - lastMs < EMPTYING_ALERT_COOLDOWN_MIN * 60 * 1000) return false;
  }

  const zones = getAllZones();
  const zone = zones.find((z: any) => z.id === zoneId);
  const zoneName = zone?.name ?? zoneId;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 20 * 60 * 1000).toISOString();
  sqlite.prepare(
    `INSERT INTO alerts (type,title,message,zone_id,priority,estimated_revenue,expires_at,created_at,is_read) VALUES (?,?,?,?,?,?,?,?,0)`
  ).run(
    "zone_emptying",
    `⚠️ ${zoneName} se vide`,
    `Plusieurs chauffeurs signalent une baisse d'activité à ${zoneName} — envisagez de vous repositionner.`,
    zoneId,
    "high",
    null,
    expiresAt,
    now.toISOString(),
  );
  sqlite.prepare(`INSERT INTO community_alerts_log (zone_id, alert_type) VALUES (?, 'zone_emptying')`).run(zoneId);
  return true;
}

// ── Convergence anti-cannibalisation — §1.10 du rapport ──────────────────────
// Plafonne à 8 le nombre de chauffeurs "recommandés" simultanément vers une
// même zone chaude ; au-delà, renvoie une position de file d'attente.
const CONVERGENCE_CAP = 8;
const CONVERGENCE_WINDOW_MIN = 10; // fenêtre de comptage des convergences actives

interface ConvergenceEntry {
  driverId: string;
  ts: number;
}
const convergenceByZone = new Map<string, ConvergenceEntry[]>();

export interface ConvergenceResult {
  accepted: boolean;
  queue_position: number;
  cap: number;
  current_count: number;
}

export function requestConvergenceSlot(zoneId: string, driverId: string): ConvergenceResult {
  const now = Date.now();
  const windowMs = CONVERGENCE_WINDOW_MIN * 60 * 1000;
  let list = convergenceByZone.get(zoneId) ?? [];
  list = list.filter((e) => now - e.ts < windowMs);

  const existingIdx = list.findIndex((e) => e.driverId === driverId);
  if (existingIdx >= 0) {
    list[existingIdx].ts = now; // rafraîchit
    convergenceByZone.set(zoneId, list);
    return { accepted: existingIdx < CONVERGENCE_CAP, queue_position: existingIdx + 1, cap: CONVERGENCE_CAP, current_count: list.length };
  }

  list.push({ driverId, ts: now });
  convergenceByZone.set(zoneId, list);
  const position = list.length;
  return {
    accepted: position <= CONVERGENCE_CAP,
    queue_position: position,
    cap: CONVERGENCE_CAP,
    current_count: list.length,
  };
}

// ── Historique des 5 derniers signaux (pour ZoneChat) ────────────────────────
export interface RecentSignalRow {
  id: number;
  signal_type: string;
  context: string;
  intensity: number;
  comment_short: string;
  timestamp: string;
  user_id: string;
  trust_level: TrustLevel;
}

export function getRecentSignals(zoneId: string, limit = 5): RecentSignalRow[] {
  const rows = sqlite.prepare(
    `SELECT cs.id, cs.signal_type, COALESCE(cs.context,'') as context, COALESCE(cs.intensity,2) as intensity,
            COALESCE(cs.comment_short,'') as comment_short, cs.timestamp, COALESCE(cs.user_id,'anon') as user_id
     FROM community_signals cs
     WHERE cs.zone_id = ?
     ORDER BY cs.id DESC LIMIT ?`
  ).all(zoneId, limit) as any[];

  return rows.map((r) => {
    const rep = sqlite.prepare(`SELECT trust_level FROM community_reputation WHERE user_id = ?`).get(r.user_id) as { trust_level: TrustLevel } | undefined;
    return { ...r, trust_level: rep?.trust_level ?? "novice" };
  });
}
