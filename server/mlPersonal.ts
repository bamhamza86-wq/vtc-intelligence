/**
 * mlPersonal.ts — Couche ML Personnel Driver (Sprint ML)
 * ═════════════════════════════════════════════════════════════════════════════
 * Implémente, en TypeScript pur (ZÉRO nouvelle dépendance npm) :
 *   1. Feature store personnel (table driver_features, remplie sur /api/rides/complete)
 *   2. Régression logistique en ligne (SGD) — accepter/refuser une course
 *   3. Arbre de régression simple (profondeur max 4) — rentabilité horaire
 *   4. Bandit contextuel epsilon-greedy — prochaine meilleure zone
 *   5. Détection de patterns récurrents (90 derniers jours)
 *   6. Détection d'anomalies personnelles
 *   7. XAI — explications en français, top-3 features
 *   8. Cold-start — fallback moyenne flotte si ride_count < 20
 *   9. Drift detector — MAE 7j vs 30j
 *  10. Auto-évaluation — accuracy / calibration / brier score
 *
 * Toutes les tables sont créées avec CREATE TABLE IF NOT EXISTS — aucune
 * modification des tables existantes (rides, profitability_scores, ...).
 * Rétro-compatible avec /api/predictions et /api/model/reliability (non touchés).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";

// On réutilise le même fichier data.db que storage.ts (connexion séparée : SQLite
// supporte plusieurs connexions en WAL sans conflit).
const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const DEFAULT_USER = "root"; // app single-tenant — pas de multi-compte réel

// ─────────────────────────────────────────────────────────────────────────────
// Schéma — feature store + modèles sérialisés
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS driver_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ride_id INTEGER,
    ts TEXT NOT NULL,
    hour INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    is_weekend INTEGER NOT NULL DEFAULT 0,
    is_holiday INTEGER NOT NULL DEFAULT 0,
    weather_code INTEGER,
    temp_c REAL,
    precip_mm REAL,
    zone_id TEXT,
    distance_km REAL,
    duration_min REAL,
    fare REAL,
    net_profit REAL,
    is_profitable INTEGER NOT NULL DEFAULT 0,
    weekday_bucket TEXT,
    event_nearby INTEGER NOT NULL DEFAULT 0,
    prev_ride_zone TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_driver_features_user_ts ON driver_features(user_id, ts);
  CREATE INDEX IF NOT EXISTS idx_driver_features_zone ON driver_features(zone_id);

  CREATE TABLE IF NOT EXISTS ml_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    params_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, model_name)
  );

  CREATE TABLE IF NOT EXISTS ml_predictions_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    predicted REAL NOT NULL,
    actual REAL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ml_ai_disabled_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    net_profit_that_day REAL,
    avg_net_profit_baseline REAL,
    delta_pct REAL,
    UNIQUE(user_id, date)
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires généraux
// ─────────────────────────────────────────────────────────────────────────────
function nowIso(): string {
  return new Date().toISOString();
}

function parisHourAndDay(d: Date = new Date()): { hour: number; dow: number; isWeekend: boolean } {
  const hour = (d.getUTCHours() + 2) % 24; // approx CEST, cohérent avec le reste du code (storage.ts)
  const dow = d.getDay();
  return { hour, dow, isWeekend: dow === 0 || dow === 6 };
}

function weekdayBucket(hour: number): string {
  if (hour >= 6 && hour <= 9) return "pointe_matin";
  if (hour >= 17 && hour <= 20) return "pointe_soir";
  if (hour >= 22 || hour <= 4) return "nuit";
  if (hour >= 11 && hour <= 14) return "midi";
  return "creux";
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) FEATURE STORE — appelé depuis routes.ts juste après storage.addRide()
// ═════════════════════════════════════════════════════════════════════════════
export interface RideForFeatures {
  ride_id?: number;
  pickup_zone_id: string;
  distance_km: number;
  duration_min: number;
  fare: number;
  net_profit: number;
  is_profitable: number | boolean;
  weather?: { code?: number; temp_c?: number; precip_mm?: number } | null;
}

let lastZoneByUser: Record<string, string> = {};

const stmtInsertFeature = db.prepare(`
  INSERT INTO driver_features
    (user_id, ride_id, ts, hour, day_of_week, is_weekend, is_holiday, weather_code,
     temp_c, precip_mm, zone_id, distance_km, duration_min, fare, net_profit,
     is_profitable, weekday_bucket, event_nearby, prev_ride_zone)
  VALUES (@user_id, @ride_id, @ts, @hour, @day_of_week, @is_weekend, @is_holiday, @weather_code,
     @temp_c, @precip_mm, @zone_id, @distance_km, @duration_min, @fare, @net_profit,
     @is_profitable, @weekday_bucket, @event_nearby, @prev_ride_zone)
`);

export function recordRideFeatures(ride: RideForFeatures, userId: string = DEFAULT_USER, eventNearby = false): void {
  const { hour, dow, isWeekend } = parisHourAndDay();
  const prevZone = lastZoneByUser[userId] ?? null;

  stmtInsertFeature.run({
    user_id: userId,
    ride_id: ride.ride_id ?? null,
    ts: nowIso(),
    hour,
    day_of_week: dow,
    is_weekend: isWeekend ? 1 : 0,
    is_holiday: 0,
    weather_code: ride.weather?.code ?? null,
    temp_c: ride.weather?.temp_c ?? null,
    precip_mm: ride.weather?.precip_mm ?? null,
    zone_id: ride.pickup_zone_id ?? null,
    distance_km: ride.distance_km,
    duration_min: ride.duration_min,
    fare: ride.fare,
    net_profit: ride.net_profit,
    is_profitable: ride.is_profitable ? 1 : 0,
    weekday_bucket: weekdayBucket(hour),
    event_nearby: eventNearby ? 1 : 0,
    prev_ride_zone: prevZone,
  });

  lastZoneByUser[userId] = ride.pickup_zone_id ?? prevZone ?? "unknown";

  // Mise à jour incrémentale des modèles à chaque nouvelle course (léger, edge-friendly).
  try {
    updateAcceptanceModelFromRide(ride, userId);
    updateBanditFromRide(ride, userId);
  } catch (e) {
    console.warn("[mlPersonal] mise à jour incrémentale échouée :", e);
  }
}

function getFeatureCount(userId: string = DEFAULT_USER): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM driver_features WHERE user_id = ?`).get(userId) as any;
  return row?.n ?? 0;
}

function getRecentFeatures(userId: string = DEFAULT_USER, days = 90): any[] {
  return db
    .prepare(
      `SELECT * FROM driver_features WHERE user_id = ? AND ts >= datetime('now', ?) ORDER BY ts ASC`,
    )
    .all(userId, `-${days} days`) as any[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Persistance générique des modèles (table ml_models)
// ═════════════════════════════════════════════════════════════════════════════
function saveModel(userId: string, modelName: string, params: unknown): void {
  db.prepare(
    `INSERT INTO ml_models (user_id, model_name, params_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, model_name) DO UPDATE SET params_json = excluded.params_json, updated_at = excluded.updated_at`,
  ).run(userId, modelName, JSON.stringify(params), nowIso());
}

function loadModel<T>(userId: string, modelName: string): T | null {
  const row = db
    .prepare(`SELECT params_json FROM ml_models WHERE user_id = ? AND model_name = ?`)
    .get(userId, modelName) as any;
  if (!row) return null;
  try {
    return JSON.parse(row.params_json) as T;
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2) RÉGRESSION LOGISTIQUE EN LIGNE — accepter / refuser une course
// ═════════════════════════════════════════════════════════════════════════════
// Features (normalisées à la volée) : biais, distance_km, duration_min, fare,
// hour_sin, hour_cos, is_zone_known (1 si la zone a déjà été vue).
// SGD avec petit learning rate pour éviter l'instabilité (piège rapport §2.2).

const LR_FEATURES = ["bias", "distance_km", "duration_min", "fare", "hour_sin", "hour_cos", "zone_known"] as const;
type LrFeatureName = (typeof LR_FEATURES)[number];

interface LogisticModel {
  weights: Record<LrFeatureName, number>;
  n_updates: number;
  learning_rate: number;
  zones_seen: string[];
}

function defaultLogisticModel(): LogisticModel {
  return {
    weights: { bias: 0, distance_km: 0.02, duration_min: -0.01, fare: 0.05, hour_sin: 0, hour_cos: 0, zone_known: 0.1 },
    n_updates: 0,
    learning_rate: 0.03,
    zones_seen: [],
  };
}

function getLogisticModel(userId: string): LogisticModel {
  return loadModel<LogisticModel>(userId, "acceptance_lr") ?? defaultLogisticModel();
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function lrFeatureVector(
  m: LogisticModel,
  input: { distance_km: number; duration_min: number; fare: number; hour: number; zone_id?: string },
): Record<LrFeatureName, number> {
  const angle = (input.hour / 24) * 2 * Math.PI;
  return {
    bias: 1,
    distance_km: input.distance_km / 20, // normalisation approx (20km ~ trajet long IDF)
    duration_min: input.duration_min / 60,
    fare: input.fare / 50,
    hour_sin: Math.sin(angle),
    hour_cos: Math.cos(angle),
    zone_known: input.zone_id && m.zones_seen.includes(input.zone_id) ? 1 : 0,
  };
}

function lrPredict(m: LogisticModel, fv: Record<LrFeatureName, number>): number {
  let z = 0;
  for (const f of LR_FEATURES) z += m.weights[f] * fv[f];
  return sigmoid(z);
}

/** Mise à jour SGD après une course réellement effectuée (label = is_profitable). */
function updateAcceptanceModelFromRide(ride: RideForFeatures, userId: string): void {
  const { hour } = parisHourAndDay();
  const m = getLogisticModel(userId);
  const fv = lrFeatureVector(m, {
    distance_km: ride.distance_km,
    duration_min: ride.duration_min,
    fare: ride.fare,
    hour,
    zone_id: ride.pickup_zone_id,
  });
  const label = ride.is_profitable ? 1 : 0;
  const pred = lrPredict(m, fv);
  const error = label - pred;

  // Learning rate décroissant pour éviter l'instabilité (piège rapport §2.2).
  const lr = m.learning_rate / (1 + m.n_updates * 0.002);
  for (const f of LR_FEATURES) {
    m.weights[f] = m.weights[f] + lr * error * fv[f];
  }
  m.n_updates += 1;
  if (ride.pickup_zone_id && !m.zones_seen.includes(ride.pickup_zone_id)) {
    m.zones_seen.push(ride.pickup_zone_id);
  }
  saveModel(userId, "acceptance_lr", m);

  db.prepare(
    `INSERT INTO ml_predictions_log (user_id, model_name, predicted, actual, created_at, resolved_at)
     VALUES (?, 'acceptance_lr', ?, ?, ?, ?)`,
  ).run(userId, pred, label, nowIso(), nowIso());
}

function fleetAverageAcceptance(): number {
  // Cold-start : moyenne flotte = taux de profitabilité moyen des profitability_scores existants.
  try {
    const row = db
      .prepare(`SELECT AVG(profitability_index) AS avg_pi FROM profitability_scores`)
      .get() as any;
    const avgPi = row?.avg_pi ?? 55;
    return clamp(avgPi / 100, 0.05, 0.95);
  } catch {
    return 0.5;
  }
}

export interface AcceptancePrediction {
  p_accept: number;
  expected_gain: number;
  explanation: { feature: string; weight: number; label_fr: string }[];
  model: "cold_start" | "personal";
  ride_count: number;
}

const FEATURE_LABEL_FR: Record<LrFeatureName, (w: number) => string> = {
  bias: (w) => `Tendance générale ${w >= 0 ? "favorable" : "défavorable"}`,
  distance_km: (w) => `Distance de la course ${w >= 0 ? "+ favorable" : "- pénalisante"}`,
  duration_min: (w) => `Durée du trajet ${w >= 0 ? "+ favorable" : "- pénalisante"}`,
  fare: (w) => `Montant de la course ${w >= 0 ? "+ favorable" : "- pénalisant"}`,
  hour_sin: (w) => `Créneau horaire (cycle) ${w >= 0 ? "favorable" : "défavorable"}`,
  hour_cos: (w) => `Créneau horaire (cycle) ${w >= 0 ? "favorable" : "défavorable"}`,
  zone_known: (w) => `Historique de cette zone ${w >= 0 ? "+ rassurant" : "- incertain"}`,
};

export function predictAcceptance(input: {
  zone_id: string;
  distance_km: number;
  duration_min: number;
  fare: number;
  hour: number;
}): AcceptancePrediction {
  const userId = DEFAULT_USER;
  const rideCount = getFeatureCount(userId);

  if (rideCount < 20) {
    const p = fleetAverageAcceptance();
    const expectedGain = round2(input.fare * p - (input.distance_km * 0.15 + input.duration_min * 0.05));
    return {
      p_accept: round2(p),
      expected_gain: expectedGain,
      explanation: [
        { feature: "fleet_avg", weight: 1, label_fr: "Moyenne de la flotte (pas encore assez d'historique personnel)" },
        { feature: "fare", weight: 0.3, label_fr: `Montant proposé ${input.fare}€` },
        { feature: "distance_km", weight: -0.2, label_fr: `Distance ${input.distance_km} km` },
      ],
      model: "cold_start",
      ride_count: rideCount,
    };
  }

  const m = getLogisticModel(userId);
  const fv = lrFeatureVector(m, input);
  const p = lrPredict(m, fv);

  const contributions = LR_FEATURES.map((f) => ({ feature: f, contrib: m.weights[f] * fv[f], weight: m.weights[f] }))
    .filter((c) => c.feature !== "bias")
    .sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib))
    .slice(0, 3)
    .map((c) => ({
      feature: c.feature,
      weight: round2(c.weight),
      label_fr: FEATURE_LABEL_FR[c.feature as LrFeatureName](c.weight),
    }));

  const expectedGain = round2(input.fare * p - (input.distance_km * 0.15 + input.duration_min * 0.05));

  return {
    p_accept: round2(p),
    expected_gain: expectedGain,
    explanation: contributions,
    model: "personal",
    ride_count: rideCount,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3) ARBRE DE RÉGRESSION SIMPLE — rentabilité horaire (profondeur max 4)
// ═════════════════════════════════════════════════════════════════════════════
// Splits successifs sur hour, zone_id (one-hot binaire "== zone cible"), weather_code.
// Implémentation CART simplifiée : à chaque nœud on choisit le split qui réduit le
// plus la variance de la variable cible (net_profit / duration_min * 60).

interface TreeNode {
  isLeaf: boolean;
  prediction?: number;
  nSamples?: number;
  splitFeature?: "hour" | "zone_match" | "weather_code";
  splitValue?: number | string;
  left?: TreeNode;
  right?: TreeNode;
}

interface RegressionTree {
  root: TreeNode;
  trainedAt: string;
  nSamples: number;
}

function hourlyRateFromFeature(f: any): number {
  if (!f.duration_min || f.duration_min <= 0) return 0;
  return (f.net_profit / f.duration_min) * 60;
}

function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}

function buildTree(rows: any[], targetZone: string | null, depth: number, maxDepth: number): TreeNode {
  const targets = rows.map(hourlyRateFromFeature);
  const meanTarget = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : 0;

  if (depth >= maxDepth || rows.length < 6) {
    return { isLeaf: true, prediction: round2(meanTarget), nSamples: rows.length };
  }

  // Candidats de split : heure (médiane), correspondance de zone, code météo (pluie oui/non)
  type Candidate = { feature: TreeNode["splitFeature"]; value: number | string; leftRows: any[]; rightRows: any[] };
  const candidates: Candidate[] = [];

  const hours = Array.from(new Set(rows.map((r) => r.hour))).sort((a, b) => a - b);
  for (const h of hours) {
    const left = rows.filter((r) => r.hour <= h);
    const right = rows.filter((r) => r.hour > h);
    if (left.length >= 3 && right.length >= 3) candidates.push({ feature: "hour", value: h, leftRows: left, rightRows: right });
  }

  if (targetZone) {
    const left = rows.filter((r) => r.zone_id === targetZone);
    const right = rows.filter((r) => r.zone_id !== targetZone);
    if (left.length >= 3 && right.length >= 3) candidates.push({ feature: "zone_match", value: targetZone, leftRows: left, rightRows: right });
  }

  const rainy = rows.filter((r) => (r.weather_code ?? 0) >= 51);
  const dry = rows.filter((r) => (r.weather_code ?? 0) < 51);
  if (rainy.length >= 3 && dry.length >= 3) {
    candidates.push({ feature: "weather_code", value: 51, leftRows: rainy, rightRows: dry });
  }

  if (candidates.length === 0) {
    return { isLeaf: true, prediction: round2(meanTarget), nSamples: rows.length };
  }

  // Choisir le split qui minimise la variance pondérée totale
  let best = candidates[0];
  let bestScore = Infinity;
  for (const c of candidates) {
    const vL = variance(c.leftRows.map(hourlyRateFromFeature));
    const vR = variance(c.rightRows.map(hourlyRateFromFeature));
    const score = (vL * c.leftRows.length + vR * c.rightRows.length) / rows.length;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return {
    isLeaf: false,
    splitFeature: best.feature,
    splitValue: best.value,
    nSamples: rows.length,
    left: buildTree(best.leftRows, targetZone, depth + 1, maxDepth),
    right: buildTree(best.rightRows, targetZone, depth + 1, maxDepth),
  };
}

function treePredict(node: TreeNode, input: { hour: number; zone_id: string; weather_code: number }): { pred: number; n: number } {
  if (node.isLeaf) return { pred: node.prediction ?? 0, n: node.nSamples ?? 0 };
  if (node.splitFeature === "hour") {
    return input.hour <= (node.splitValue as number) ? treePredict(node.left!, input) : treePredict(node.right!, input);
  }
  if (node.splitFeature === "zone_match") {
    return input.zone_id === node.splitValue ? treePredict(node.left!, input) : treePredict(node.right!, input);
  }
  if (node.splitFeature === "weather_code") {
    return input.weather_code >= 51 ? treePredict(node.left!, input) : treePredict(node.right!, input);
  }
  return { pred: 0, n: 0 };
}

export interface HourlyForecast {
  predicted_hourly: number;
  confidence: number;
  sample_size: number;
  model: "cold_start" | "personal";
}

export function forecastHourlyRate(hour: number, zoneId: string, weatherCode: number): HourlyForecast {
  const userId = DEFAULT_USER;
  const rows = getRecentFeatures(userId, 90).filter((r) => r.net_profit !== null && r.duration_min);
  const rideCount = getFeatureCount(userId);

  if (rideCount < 20 || rows.length < 10) {
    // Cold-start : moyenne flotte via profitability_scores (avg_fare / avg_duration_min * 60)
    const row = db
      .prepare(
        `SELECT AVG(avg_fare) AS fare, AVG(avg_duration_min) AS dur FROM profitability_scores WHERE zone_id = ? AND hour = ?`,
      )
      .get(zoneId, hour) as any;
    const fare = row?.fare ?? 18;
    const dur = row?.dur ?? 20;
    const predicted = round2((fare * 0.72 / Math.max(dur, 5)) * 60); // ~72% après charges, approx
    return { predicted_hourly: predicted, confidence: 0.3, sample_size: 0, model: "cold_start" };
  }

  const tree = buildTree(rows, zoneId, 0, 4);
  const { pred, n } = treePredict(tree, { hour, zone_id: zoneId, weather_code: weatherCode });
  const confidence = clamp(n / 40, 0.15, 0.95);

  saveModel(userId, "hourly_tree", { trainedAt: nowIso(), nSamples: rows.length });

  return { predicted_hourly: round2(Math.max(0, pred)), confidence: round2(confidence), sample_size: n, model: "personal" };
}

// ═════════════════════════════════════════════════════════════════════════════
// 4) BANDIT CONTEXTUEL EPSILON-GREEDY — prochaine meilleure zone
// ═════════════════════════════════════════════════════════════════════════════
interface BanditArm {
  zone_id: string;
  n_pulls: number;
  total_reward: number;
}

interface BanditModel {
  arms: Record<string, BanditArm>;
  n_total: number;
}

function defaultBandit(): BanditModel {
  return { arms: {}, n_total: 0 };
}

function getBandit(userId: string): BanditModel {
  return loadModel<BanditModel>(userId, "zone_bandit") ?? defaultBandit();
}

function updateBanditFromRide(ride: RideForFeatures, userId: string): void {
  const b = getBandit(userId);
  const zoneId = ride.pickup_zone_id ?? "unknown";
  if (!b.arms[zoneId]) b.arms[zoneId] = { zone_id: zoneId, n_pulls: 0, total_reward: 0 };
  b.arms[zoneId].n_pulls += 1;
  b.arms[zoneId].total_reward += ride.net_profit;
  b.n_total += 1;
  saveModel(userId, "zone_bandit", b);
}

function epsilonFor(nTotal: number): number {
  // Décroissant avec le nombre d'échantillons, plancher à 0.03
  const eps = 0.15 / (1 + nTotal * 0.01);
  return clamp(eps, 0.03, 0.15);
}

export interface NextZoneRecommendation {
  zone_id: string;
  name: string;
  expected_gain: number;
  exploration: boolean;
  reason: string;
  model: "cold_start" | "personal";
}

function getZoneName(zoneId: string): string {
  const row = db.prepare(`SELECT name FROM zones WHERE id = ?`).get(zoneId) as any;
  return row?.name ?? zoneId;
}

export function nextBestZone(hour: number, dayType: string): NextZoneRecommendation {
  const userId = DEFAULT_USER;
  const rideCount = getFeatureCount(userId);
  const bandit = getBandit(userId);
  const armList = Object.values(bandit.arms);

  if (rideCount < 20 || armList.length < 2) {
    // Cold-start : meilleure zone selon profitability_scores agrégés (flotte)
    const rows = db
      .prepare(
        `SELECT zone_id, AVG(profitability_index) AS score FROM profitability_scores WHERE hour = ? AND day_type = ? GROUP BY zone_id ORDER BY score DESC LIMIT 1`,
      )
      .all(hour, dayType) as any[];
    const top = rows[0];
    if (!top) {
      return {
        zone_id: "z_cdg",
        name: getZoneName("z_cdg"),
        expected_gain: 0,
        exploration: false,
        reason: "Pas encore assez de données — recommandation par défaut (aéroport CDG).",
        model: "cold_start",
      };
    }
    return {
      zone_id: top.zone_id,
      name: getZoneName(top.zone_id),
      expected_gain: round2(top.score * 0.3),
      exploration: false,
      reason: `Moyenne flotte : cette zone est la plus rentable à ${hour}h (pas assez d'historique personnel — mode découverte).`,
      model: "cold_start",
    };
  }

  const eps = epsilonFor(bandit.n_total);
  const explore = Math.random() < eps;

  if (explore) {
    // Zone jamais/peu explorée par ce chauffeur, choisie parmi les zones connues du système
    const allZones = db.prepare(`SELECT id, name FROM zones`).all() as any[];
    const unexplored = allZones.filter((z) => !bandit.arms[z.id] || bandit.arms[z.id].n_pulls < 3);
    const pick = unexplored.length ? unexplored[Math.floor(Math.random() * unexplored.length)] : allZones[0];
    return {
      zone_id: pick.id,
      name: pick.name,
      expected_gain: 0,
      exploration: true,
      reason: `Exploration : vous n'avez pas assez testé cette zone (epsilon=${round2(eps)}). Cela affine votre modèle personnel.`,
      model: "personal",
    };
  }

  // Exploitation : meilleure zone connue (gain moyen par course)
  const best = armList
    .map((a) => ({ ...a, avg: a.total_reward / Math.max(a.n_pulls, 1) }))
    .sort((a, b) => b.avg - a.avg)[0];

  return {
    zone_id: best.zone_id,
    name: getZoneName(best.zone_id),
    expected_gain: round2(best.avg),
    exploration: false,
    reason: `Historique zone ${getZoneName(best.zone_id)} : gain net moyen +${round2(best.avg)}€/course sur ${best.n_pulls} courses.`,
    model: "personal",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 5) DÉTECTION DE PATTERNS RÉCURRENTS (90 derniers jours)
// ═════════════════════════════════════════════════════════════════════════════
export interface PatternResult {
  pattern_type: "weekday_hour_hotspot" | "weather_boost" | "event_hotspot";
  description_fr: string;
  confidence: number;
  action_hint: string;
}

const DOW_LABEL_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

export function detectPatterns(): PatternResult[] {
  const userId = DEFAULT_USER;
  const rows = getRecentFeatures(userId, 90);
  const patterns: PatternResult[] = [];
  if (rows.length < 15) {
    return [
      {
        pattern_type: "weekday_hour_hotspot",
        description_fr: "Pas encore assez de courses enregistrées pour détecter des motifs fiables (minimum 15).",
        confidence: 0.1,
        action_hint: "Continuez à enregistrer vos courses via /api/rides/complete.",
      },
    ];
  }

  // Pattern 1 : jour de semaine × heure × zone récurrent (min 3 occurrences — piège rapport §2.12)
  const groups: Record<string, any[]> = {};
  for (const r of rows) {
    const key = `${r.day_of_week}_${r.hour}_${r.zone_id}`;
    groups[key] = groups[key] || [];
    groups[key].push(r);
  }
  const hotspots = Object.entries(groups)
    .filter(([, g]) => g.length >= 3)
    .map(([key, g]) => {
      const [dow, hour] = key.split("_");
      const avgProfit = g.reduce((a, r) => a + (r.net_profit ?? 0), 0) / g.length;
      return { dow: Number(dow), hour: Number(hour), zoneId: g[0].zone_id, n: g.length, avgProfit };
    })
    .sort((a, b) => b.avgProfit - a.avgProfit)
    .slice(0, 3);

  for (const h of hotspots) {
    const zoneName = getZoneName(h.zoneId);
    const isGood = h.avgProfit > 0;
    patterns.push({
      pattern_type: "weekday_hour_hotspot",
      description_fr: isGood
        ? `Les ${DOW_LABEL_FR[h.dow]}s à ${h.hour}h, la zone ${zoneName} vous rapporte en moyenne +${round2(h.avgProfit)}€ net (${h.n} courses observées).`
        : `Les ${DOW_LABEL_FR[h.dow]}s à ${h.hour}h, votre zone habituelle ${zoneName} est peu rentable (${round2(h.avgProfit)}€ net en moyenne sur ${h.n} courses).`,
      confidence: clamp(h.n / 10, 0.3, 0.9),
      action_hint: isGood ? `Privilégiez ${zoneName} ce créneau.` : `Évitez ${zoneName} ce créneau, explorez une zone alternative.`,
    });
  }

  // Pattern 2 : boost météo personnalisé (corrélation pluie/gain — rapport §2.16)
  const rainy = rows.filter((r) => (r.weather_code ?? 0) >= 51 && r.net_profit !== null);
  const dry = rows.filter((r) => (r.weather_code ?? 0) < 51 && r.net_profit !== null);
  if (rainy.length >= 5 && dry.length >= 5) {
    const avgRainy = rainy.reduce((a, r) => a + r.net_profit, 0) / rainy.length;
    const avgDry = dry.reduce((a, r) => a + r.net_profit, 0) / dry.length;
    const deltaPct = avgDry !== 0 ? ((avgRainy - avgDry) / Math.abs(avgDry)) * 100 : 0;
    if (Math.abs(deltaPct) >= 8) {
      patterns.push({
        pattern_type: "weather_boost",
        description_fr:
          deltaPct > 0
            ? `Chez vous, la pluie augmente vos gains de ${round2(deltaPct)}% en moyenne (${rainy.length} courses sous la pluie).`
            : `Chez vous, la pluie réduit vos gains de ${round2(Math.abs(deltaPct))}% en moyenne — contrairement à la tendance générale.`,
        confidence: clamp(Math.min(rainy.length, dry.length) / 15, 0.3, 0.85),
        action_hint: deltaPct > 0 ? "Sortez davantage les jours de pluie." : "Ne comptez pas sur la pluie pour booster vos gains dans votre secteur.",
      });
    }
  }

  // Pattern 3 : proximité événement (event_nearby)
  const withEvent = rows.filter((r) => r.event_nearby === 1 && r.net_profit !== null);
  const withoutEvent = rows.filter((r) => r.event_nearby === 0 && r.net_profit !== null);
  if (withEvent.length >= 3 && withoutEvent.length >= 5) {
    const avgWith = withEvent.reduce((a, r) => a + r.net_profit, 0) / withEvent.length;
    const avgWithout = withoutEvent.reduce((a, r) => a + r.net_profit, 0) / withoutEvent.length;
    if (avgWith > avgWithout * 1.1) {
      patterns.push({
        pattern_type: "event_hotspot",
        description_fr: `Vos courses proches d'un événement rapportent en moyenne +${round2(avgWith - avgWithout)}€ net de plus que d'habitude.`,
        confidence: clamp(withEvent.length / 10, 0.3, 0.8),
        action_hint: "Consultez la page Événements avant vos créneaux pour anticiper ces pics.",
      });
    }
  }

  if (patterns.length === 0) {
    patterns.push({
      pattern_type: "weekday_hour_hotspot",
      description_fr: "Aucun motif net ne se dégage encore de vos 90 derniers jours — poursuivez l'enregistrement de vos courses.",
      confidence: 0.2,
      action_hint: "Revenez consulter cette page après quelques jours de plus.",
    });
  }

  return patterns;
}

// ═════════════════════════════════════════════════════════════════════════════
// 6) DÉTECTION D'ANOMALIES PERSONNELLES
// ═════════════════════════════════════════════════════════════════════════════
export interface AnomalyResult {
  type: "time_loss" | "expected_vs_real_gap" | "route_suboptimal" | "self_sabotage";
  where: string;
  when: string;
  magnitude: number;
  description_fr: string;
  suggested_action: string;
}

export function detectAnomalies(): AnomalyResult[] {
  const userId = DEFAULT_USER;
  const rows = getRecentFeatures(userId, 30);
  const anomalies: AnomalyResult[] = [];

  if (rows.length < 8) {
    return [];
  }

  // 13.6 : itinéraires sous-optimaux — durée anormalement longue vs distance (proxy sans GPS fin)
  const speedRatios = rows
    .filter((r) => r.distance_km > 1 && r.duration_min > 0)
    .map((r) => ({ r, kmPerMin: r.distance_km / r.duration_min }));
  if (speedRatios.length >= 5) {
    const mean = speedRatios.reduce((a, s) => a + s.kmPerMin, 0) / speedRatios.length;
    const sd = Math.sqrt(variance(speedRatios.map((s) => s.kmPerMin)));
    const slow = speedRatios.filter((s) => sd > 0 && s.kmPerMin < mean - 1.3 * sd);
    if (slow.length >= 2) {
      const worst = slow.sort((a, b) => a.kmPerMin - b.kmPerMin)[0];
      anomalies.push({
        type: "route_suboptimal",
        where: getZoneName(worst.r.zone_id ?? "zone inconnue"),
        when: worst.r.ts,
        magnitude: round2(mean - worst.kmPerMin),
        description_fr: `Trajet anormalement lent détecté (${round2(worst.kmPerMin)} km/min vs ${round2(mean)} km/min en moyenne) — ${slow.length} cas similaires sur 30 jours.`,
        suggested_action: "Comparez avec l'itinéraire Best-Route recommandé sur ce trajet.",
      });
    }
  }

  // 13.2 : écart gain attendu vs réel (via ml_predictions_log)
  const logRows = db
    .prepare(
      `SELECT predicted, actual FROM ml_predictions_log WHERE user_id = ? AND model_name = 'acceptance_lr' AND actual IS NOT NULL AND created_at >= datetime('now', '-30 days')`,
    )
    .all(userId) as any[];
  if (logRows.length >= 8) {
    const gaps = logRows.map((r) => Math.abs(r.actual - r.predicted));
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (avgGap > 0.35) {
      anomalies.push({
        type: "expected_vs_real_gap",
        where: "modèle d'acceptation",
        when: nowIso(),
        magnitude: round2(avgGap),
        description_fr: `Écart moyen de ${round2(avgGap * 100)}% entre vos prédictions et la réalité sur 30 jours — le contexte a peut-être changé.`,
        suggested_action: "Consultez la page Détecteur de dérive (drift) pour un ré-entraînement.",
      });
    }
  }

  // 15.11 : auto-sabotage — rentrer systématiquement avant la fin du pic
  const eveningRows = rows.filter((r) => r.hour >= 17 && r.hour <= 20);
  const lateRows = rows.filter((r) => r.hour >= 20 && r.hour <= 22);
  if (eveningRows.length >= 5 && lateRows.length <= Math.max(1, Math.floor(eveningRows.length * 0.15))) {
    anomalies.push({
      type: "self_sabotage",
      where: "fin de journée",
      when: nowIso(),
      magnitude: round2(eveningRows.length - lateRows.length),
      description_fr: `Vous arrêtez systématiquement autour de 20h alors que le pic du soir se prolonge souvent au-delà — ${eveningRows.length} courses en pointe soir contre seulement ${lateRows.length} après 20h.`,
      suggested_action: "Essayez de prolonger votre session de 30 minutes un soir pour comparer le gain réel.",
    });
  }

  // 13.1 : perte de temps récurrente (zone + heure avec durée anormalement élevée répétée)
  const zoneHourGroups: Record<string, any[]> = {};
  for (const r of rows) {
    const key = `${r.zone_id}_${r.hour}`;
    zoneHourGroups[key] = zoneHourGroups[key] || [];
    zoneHourGroups[key].push(r);
  }
  for (const [key, g] of Object.entries(zoneHourGroups)) {
    if (g.length >= 3) {
      const avgDur = g.reduce((a, r) => a + (r.duration_min ?? 0), 0) / g.length;
      const globalAvgDur = rows.reduce((a, r) => a + (r.duration_min ?? 0), 0) / rows.length;
      if (avgDur > globalAvgDur * 1.4) {
        const [zoneId, hour] = key.split("_");
        anomalies.push({
          type: "time_loss",
          where: getZoneName(zoneId),
          when: `${hour}h`,
          magnitude: round2(avgDur - globalAvgDur),
          description_fr: `Vous perdez en moyenne ${round2(avgDur - globalAvgDur)} min de plus que d'habitude à ${hour}h en zone ${getZoneName(zoneId)} (${g.length} occurrences).`,
          suggested_action: "Testez un créneau ou un itinéraire différent pour ce point récurrent.",
        });
        break; // un seul suffit pour ne pas noyer l'utilisateur
      }
    }
  }

  return anomalies;
}

// ═════════════════════════════════════════════════════════════════════════════
// 9) DRIFT DETECTOR — MAE 7j récents vs 30j
// ═════════════════════════════════════════════════════════════════════════════
export interface DriftResult {
  drift_detected: boolean;
  mae_recent: number;
  mae_baseline: number;
  action: "retrain" | "ok";
}

function maeForWindow(userId: string, days: number): number | null {
  const rows = db
    .prepare(
      `SELECT predicted, actual FROM ml_predictions_log WHERE user_id = ? AND model_name = 'acceptance_lr' AND actual IS NOT NULL AND created_at >= datetime('now', ?)`,
    )
    .all(userId, `-${days} days`) as any[];
  if (rows.length === 0) return null;
  const errs = rows.map((r) => Math.abs(r.actual - r.predicted));
  return errs.reduce((a, b) => a + b, 0) / errs.length;
}

export function getDrift(): DriftResult {
  const userId = DEFAULT_USER;
  const maeRecent = maeForWindow(userId, 7);
  const maeBaseline = maeForWindow(userId, 30);

  if (maeRecent === null || maeBaseline === null) {
    return { drift_detected: false, mae_recent: 0, mae_baseline: 0, action: "ok" };
  }

  // Drift si le MAE récent dépasse de 30% le MAE de référence
  const drift = maeRecent > maeBaseline * 1.3 && maeRecent - maeBaseline > 0.05;

  return {
    drift_detected: drift,
    mae_recent: round2(maeRecent),
    mae_baseline: round2(maeBaseline),
    action: drift ? "retrain" : "ok",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 10) AUTO-ÉVALUATION — accuracy, calibration, brier score
// ═════════════════════════════════════════════════════════════════════════════
export interface SelfEval {
  accuracy_7d: number;
  calibration_score: number;
  brier_score: number;
  honest_confidence: string;
}

export function getSelfEval(): SelfEval {
  const userId = DEFAULT_USER;
  const rows = db
    .prepare(
      `SELECT predicted, actual FROM ml_predictions_log WHERE user_id = ? AND model_name = 'acceptance_lr' AND actual IS NOT NULL AND created_at >= datetime('now', '-7 days')`,
    )
    .all(userId) as any[];

  if (rows.length < 5) {
    return {
      accuracy_7d: 0,
      calibration_score: 0,
      brier_score: 0,
      honest_confidence: "Pas assez de prédictions résolues cette semaine pour évaluer la fiabilité du modèle.",
    };
  }

  const correct = rows.filter((r) => (r.predicted >= 0.5 ? 1 : 0) === r.actual).length;
  const accuracy = correct / rows.length;

  const brier = rows.reduce((a, r) => a + (r.predicted - r.actual) ** 2, 0) / rows.length;

  // Calibration simplifiée : écart moyen entre confiance prédite et fréquence réelle observée
  const avgPred = rows.reduce((a, r) => a + r.predicted, 0) / rows.length;
  const avgActual = rows.reduce((a, r) => a + r.actual, 0) / rows.length;
  const calibration = clamp(1 - Math.abs(avgPred - avgActual), 0, 1);

  let honest: string;
  if (accuracy >= 0.75) honest = `Modèle fiable cette semaine (${round2(accuracy * 100)}% de précision sur ${rows.length} prédictions).`;
  else if (accuracy >= 0.55) honest = `Fiabilité moyenne cette semaine (${round2(accuracy * 100)}%) — à prendre avec recul.`;
  else honest = `Fiabilité faible cette semaine (${round2(accuracy * 100)}%) — fiez-vous davantage à votre expérience.`;

  return {
    accuracy_7d: round2(accuracy),
    calibration_score: round2(calibration),
    brier_score: round2(brier),
    honest_confidence: honest,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Mode "pas d'IA aujourd'hui" — comparaison a posteriori
// ═════════════════════════════════════════════════════════════════════════════
export function recordAiDisabledDay(dateStr: string, netProfitThatDay: number): { delta_pct: number; baseline: number } {
  const userId = DEFAULT_USER;
  const baselineRow = db
    .prepare(
      `SELECT AVG(daily) AS avg_daily FROM (
        SELECT date(ts) AS d, SUM(net_profit) AS daily FROM driver_features
        WHERE user_id = ? AND net_profit IS NOT NULL AND date(ts) != ?
        GROUP BY date(ts)
      )`,
    )
    .get(userId, dateStr) as any;
  const baseline = baselineRow?.avg_daily ?? 0;
  const deltaPct = baseline !== 0 ? ((netProfitThatDay - baseline) / Math.abs(baseline)) * 100 : 0;

  db.prepare(
    `INSERT INTO ml_ai_disabled_log (user_id, date, net_profit_that_day, avg_net_profit_baseline, delta_pct)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET net_profit_that_day = excluded.net_profit_that_day,
       avg_net_profit_baseline = excluded.avg_net_profit_baseline, delta_pct = excluded.delta_pct`,
  ).run(userId, dateStr, netProfitThatDay, baseline, deltaPct);

  return { delta_pct: round2(deltaPct), baseline: round2(baseline) };
}

export function getAiDisabledHistory(): any[] {
  return db
    .prepare(`SELECT * FROM ml_ai_disabled_log WHERE user_id = ? ORDER BY date DESC LIMIT 30`)
    .all(DEFAULT_USER) as any[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Export de la latence — util debug/tests
// ═════════════════════════════════════════════════════════════════════════════
export function getMlModelSummary(): { ride_count: number; models: string[] } {
  const models = db.prepare(`SELECT model_name FROM ml_models WHERE user_id = ?`).all(DEFAULT_USER) as any[];
  return { ride_count: getFeatureCount(DEFAULT_USER), models: models.map((m) => m.model_name) };
}
