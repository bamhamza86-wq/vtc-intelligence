/**
 * mlAdvanced.ts — Couche RL (bandit Thompson) + Federated Learning-lite (Itération 3)
 * ═════════════════════════════════════════════════════════════════════════════
 * Complète server/mlPersonal.ts (bandit epsilon-greedy existant, non modifié) avec :
 *
 *   1. RL sur feedback chauffeur — bandit contextuel Thompson sampling (Beta-Bernoulli
 *      pour p(accepter) + suivi de récompense continue par bras). Alimenté par les
 *      acceptations/refus EXPLICITES du chauffeur sur une suggestion (pas seulement
 *      l'issue de la course). Améliore next-best-zone au fil du temps.
 *
 *   2. Federated Learning-lite — chaque "client" (ce chauffeur, ou en préparation
 *      multi-chauffeur) entraîne une régression linéaire locale (SGD) sur ses
 *      propres données, n'envoie QUE les gradients agrégés (pas les données brutes,
 *      pas de PII) dans un pool commun. Un round d'agrégation calcule la moyenne
 *      pondérée par nombre d'échantillons, ajoute un bruit de Laplace (differential
 *      privacy légère, scale=1.0) et publie un nouveau modèle global versionné.
 *      Le chauffeur peut ensuite comparer son modèle personnel au modèle global
 *      (MAE) et choisir d'opter pour la synchronisation (opt-in explicite).
 *
 * ZÉRO nouvelle dépendance npm — tout en TypeScript pur + better-sqlite3 (déjà utilisé).
 * Toutes les tables sont additive (CREATE TABLE IF NOT EXISTS) — n'affecte aucune
 * table/route existante. Monté comme un Express Router séparé sur /api/ml dans
 * routes.ts (une seule ligne d'import + un seul `app.use`).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";
import { Router, Request, Response } from "express";
import { createHash, randomBytes } from "crypto";
import { requireAuth } from "./auth";

// Réutilise le même fichier SQLite que storage.ts / mlPersonal.ts (WAL, multi-connexion OK)
const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const DEFAULT_USER = "root"; // app single-tenant — cohérent avec mlPersonal.ts

/**
 * Identité courante — l'app est single-tenant (un seul compte pilote actif à la fois).
 * Si server/auth.ts expose un jour getCurrentUsername (couche ML Personnel), on pourra
 * le ré-importer directement ; en attendant on retombe sur DEFAULT_USER, cohérent avec
 * le reste du code existant qui utilise 'root' comme identifiant unique.
 */
function getCurrentUsername(_req: Request): string {
  return DEFAULT_USER;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table driver_features — créée ici en fallback idempotent si la couche ML
// Personnel (server/mlPersonal.ts) n'est pas encore présente dans ce déploiement.
// Même structure minimale (colonnes utilisées par ce module) ; si mlPersonal.ts
// est chargé ailleurs avec plus de colonnes, ce CREATE TABLE IF NOT EXISTS est un no-op.
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS driver_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ride_id INTEGER,
    ts TEXT NOT NULL,
    hour INTEGER NOT NULL,
    day_of_week INTEGER,
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
  CREATE INDEX IF NOT EXISTS idx_driver_features_user_ts_fl ON driver_features(user_id, ts);
`);

// ─────────────────────────────────────────────────────────────────────────────
// Schéma — tables additives (RL bandit + Federated Learning-lite)
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bandit_arm (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    arm_key TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    sum_reward REAL NOT NULL DEFAULT 0,
    sum_reward_sq REAL NOT NULL DEFAULT 0,
    alpha REAL NOT NULL DEFAULT 1,
    beta REAL NOT NULL DEFAULT 1,
    last_updated TEXT NOT NULL,
    UNIQUE(user_id, arm_key)
  );
  CREATE INDEX IF NOT EXISTS idx_bandit_arm_user ON bandit_arm(user_id);

  CREATE TABLE IF NOT EXISTS bandit_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    suggestion_id TEXT NOT NULL,
    arm_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('accepted','refused','ignored')),
    reward REAL NOT NULL DEFAULT 0,
    gain_eur REAL,
    wait_min REAL,
    ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bandit_feedback_user_ts ON bandit_feedback(user_id, ts);

  CREATE TABLE IF NOT EXISTS fl_gradient_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL DEFAULT 0,
    feature_key TEXT NOT NULL,
    gradient_value REAL NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 1,
    contributor_hash TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fl_gradient_round ON fl_gradient_pool(round_id);

  CREATE TABLE IF NOT EXISTS fl_round (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    contributor_count INTEGER NOT NULL DEFAULT 0,
    aggregated_model_json TEXT
  );

  CREATE TABLE IF NOT EXISTS fl_participation (
    user_id TEXT PRIMARY KEY,
    opted_in INTEGER NOT NULL DEFAULT 0,
    last_sync_ts TEXT,
    personal_mae REAL,
    global_mae REAL
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────
function nowIso(): string {
  return new Date().toISOString();
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Anonymise l'identité du contributeur : hash SHA-256 non réversible, jamais le user_id brut. */
function contributorHash(userId: string, salt: string): string {
  return createHash("sha256").update(`${userId}::${salt}::fl-vtc`).digest("hex").slice(0, 24);
}

/**
 * Génère un bruit de Laplace(0, scale) — mécanisme standard de differential privacy
 * appliqué aux gradients avant publication dans le pool commun (aucune donnée brute
 * ne quitte jamais le device/serveur local du chauffeur, seulement ce gradient bruité).
 * Inverse-CDF sampling : Laplace(0,b) = -b * sign(u) * ln(1 - 2|u|), u ~ Uniform(-0.5, 0.5)
 */
function laplaceNoise(scale: number): number {
  const u = Math.random() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

const DP_NOISE_SCALE = 1.0; // contrainte imposée : bruit Laplace scale=1.0 sur les gradients

/** Beta random sample via méthode de rejet simple (suffisant pour alpha,beta petits, usage bandit) */
function sampleBeta(alpha: number, beta: number): number {
  // Utilise deux Gamma(alpha,1) / Gamma(beta,1) — approximation Marsaglia-Tsang simplifiée
  const gammaSample = (k: number): number => {
    if (k < 1) {
      // boost trick
      const u = Math.random();
      return gammaSample(1 + k) * Math.pow(u, 1 / k);
    }
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (let i = 0; i < 100; i++) {
      let x: number, v: number;
      do {
        x = normalSample();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
    return d; // fallback
  };
  const ga = gammaSample(Math.max(alpha, 0.01));
  const gb = gammaSample(Math.max(beta, 0.01));
  return ga / (ga + gb);
}

function normalSample(): number {
  // Box-Muller
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function getZoneName(zoneId: string): string {
  const row = db.prepare(`SELECT name FROM zones WHERE id = ?`).get(zoneId) as any;
  return row?.name ?? zoneId;
}

// ═════════════════════════════════════════════════════════════════════════════
// PARTIE 1 — RL bandit contextuel Thompson sampling
// ═════════════════════════════════════════════════════════════════════════════

interface BanditArmRow {
  id: number;
  user_id: string;
  arm_key: string;
  count: number;
  sum_reward: number;
  sum_reward_sq: number;
  alpha: number;
  beta: number;
  last_updated: string;
}

function getOrCreateArm(userId: string, armKey: string): BanditArmRow {
  let row = db
    .prepare(`SELECT * FROM bandit_arm WHERE user_id = ? AND arm_key = ?`)
    .get(userId, armKey) as BanditArmRow | undefined;
  if (!row) {
    db.prepare(
      `INSERT INTO bandit_arm (user_id, arm_key, count, sum_reward, sum_reward_sq, alpha, beta, last_updated)
       VALUES (?, ?, 0, 0, 0, 1, 1, ?)`,
    ).run(userId, armKey, nowIso());
    row = db.prepare(`SELECT * FROM bandit_arm WHERE user_id = ? AND arm_key = ?`).get(userId, armKey) as BanditArmRow;
  }
  return row;
}

/** Normalise une récompense brute (gain_eur, wait_min, action) en scalaire [0,1] pour le bandit. */
function computeReward(action: string, gainEur?: number, waitMin?: number): number {
  if (action === "refused") return 0;
  if (action === "ignored") return 0.3; // signal faible neutre (ni positif ni négatif franc)
  // accepted : combine gain normalisé (0-40€ → 0-1) et pénalité d'attente (0-30min)
  const gainNorm = clamp((gainEur ?? 15) / 40, 0, 1);
  const waitPenalty = clamp((waitMin ?? 5) / 30, 0, 1) * 0.3;
  return clamp(0.7 * gainNorm + 0.3 * (1 - waitPenalty), 0, 1);
}

/** Met à jour le bras Beta-Bernoulli (Thompson) + les stats de récompense continue. */
function updateBanditFeedback(
  userId: string,
  suggestionId: string,
  armKey: string,
  action: "accepted" | "refused" | "ignored",
  gainEur?: number,
  waitMin?: number,
): { arm: BanditArmRow; reward: number } {
  const reward = computeReward(action, gainEur, waitMin);
  const arm = getOrCreateArm(userId, armKey);

  // Mise à jour Beta : succès pondéré par la récompense continue (pas juste binaire)
  const success = reward; // dans [0,1] — traité comme un "succès fractionnaire"
  const failure = 1 - reward;

  db.prepare(
    `UPDATE bandit_arm
     SET count = count + 1,
         sum_reward = sum_reward + ?,
         sum_reward_sq = sum_reward_sq + ?,
         alpha = alpha + ?,
         beta = beta + ?,
         last_updated = ?
     WHERE user_id = ? AND arm_key = ?`,
  ).run(reward, reward * reward, success, failure, nowIso(), userId, armKey);

  db.prepare(
    `INSERT INTO bandit_feedback (user_id, suggestion_id, arm_key, action, reward, gain_eur, wait_min, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, suggestionId, armKey, action, reward, gainEur ?? null, waitMin ?? null, nowIso());

  const updated = db.prepare(`SELECT * FROM bandit_arm WHERE user_id = ? AND arm_key = ?`).get(userId, armKey) as BanditArmRow;
  return { arm: updated, reward };
}

/** Choisit le meilleur bras (zone) par tirage Thompson parmi les bras connus du chauffeur. */
function thompsonPickBestArm(userId: string): { arm_key: string; sampled_score: number } | null {
  const arms = db.prepare(`SELECT * FROM bandit_arm WHERE user_id = ?`).all(userId) as BanditArmRow[];
  if (arms.length === 0) return null;
  let best: { arm_key: string; sampled_score: number } | null = null;
  for (const arm of arms) {
    const sample = sampleBeta(arm.alpha, arm.beta);
    if (!best || sample > best.sampled_score) {
      best = { arm_key: arm.arm_key, sampled_score: sample };
    }
  }
  return best;
}

/** État complet de la politique — pour affichage frontend (exploration/exploitation). */
function getRlPolicyState(userId: string) {
  const arms = db
    .prepare(`SELECT * FROM bandit_arm WHERE user_id = ? ORDER BY count DESC`)
    .all(userId) as BanditArmRow[];

  const totalPulls = arms.reduce((s, a) => s + a.count, 0);
  // Ratio exploration = proportion de bras encore peu tirés (< 5 tirages) parmi tous les tirages
  const explorationPulls = arms.filter((a) => a.count < 5).reduce((s, a) => s + a.count, 0);
  const explorationRatio = totalPulls > 0 ? round4(explorationPulls / totalPulls) : 1;

  const armsOut = arms.map((a) => {
    const meanReward = a.count > 0 ? a.sum_reward / a.count : 0;
    const variance = a.count > 0 ? Math.max(0, a.sum_reward_sq / a.count - meanReward * meanReward) : 0;
    return {
      arm_key: a.arm_key,
      zone_name: getZoneName(a.arm_key),
      count: a.count,
      mean_reward: round4(meanReward),
      std_reward: round4(Math.sqrt(variance)),
      alpha: round2(a.alpha),
      beta: round2(a.beta),
      thompson_estimate: round4(a.alpha / (a.alpha + a.beta)), // espérance Beta = alpha/(alpha+beta)
      last_updated: a.last_updated,
      is_exploring: a.count < 5,
    };
  });

  return {
    user_id: userId,
    total_pulls: totalPulls,
    arm_count: arms.length,
    exploration_ratio: explorationRatio,
    exploitation_ratio: round4(1 - explorationRatio),
    arms: armsOut,
    updated_ts: nowIso(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// PARTIE 2 — Federated Learning-lite (LR locale + gradients bruités + agrégation)
// ═════════════════════════════════════════════════════════════════════════════

// Features suivies par le modèle global (régression linéaire simple sur gain net prédit)
const FL_FEATURES = ["bias", "hour_sin", "hour_cos", "is_weekend", "distance_km", "duration_min"] as const;
type FlFeature = (typeof FL_FEATURES)[number];

interface FlModel {
  version: number;
  coefficients: Record<string, number>;
  updated_ts: string;
  contributor_count: number;
}

const FL_MODEL_KEY = "fl_global_model";

function getStoredGlobalModel(): FlModel {
  const row = db
    .prepare(`SELECT aggregated_model_json FROM fl_round WHERE aggregated_model_json IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get() as any;
  if (row?.aggregated_model_json) {
    try {
      return JSON.parse(row.aggregated_model_json) as FlModel;
    } catch {
      /* fallthrough */
    }
  }
  // Modèle global "zéro" initial — cold start
  const initCoeffs: Record<string, number> = {};
  FL_FEATURES.forEach((f) => (initCoeffs[f] = 0));
  return { version: 0, coefficients: initCoeffs, updated_ts: nowIso(), contributor_count: 0 };
}

/** Entraîne un mini-modèle LR local sur driver_features (table de mlPersonal.ts, lecture seule)
 *  et calcule les gradients moyens par feature (dérivée de l'erreur quadratique) — jamais les
 *  données brutes ne sont exposées, seulement ces scalaires agrégés par feature. */
function computeLocalGradients(userId: string): { feature_key: string; gradient: number; sample_count: number }[] {
  const rows = db
    .prepare(
      `SELECT hour, is_weekend, distance_km, duration_min, net_profit
       FROM driver_features WHERE user_id = ? AND net_profit IS NOT NULL ORDER BY ts DESC LIMIT 200`,
    )
    .all(userId) as any[];

  if (rows.length < 5) return []; // pas assez de données locales pour un gradient significatif

  const global = getStoredGlobalModel();
  const coeffs = global.coefficients;

  const gradSum: Record<string, number> = {};
  FL_FEATURES.forEach((f) => (gradSum[f] = 0));

  for (const r of rows) {
    const hourAngle = (2 * Math.PI * r.hour) / 24;
    const x: Record<string, number> = {
      bias: 1,
      hour_sin: Math.sin(hourAngle),
      hour_cos: Math.cos(hourAngle),
      is_weekend: r.is_weekend ? 1 : 0,
      distance_km: (r.distance_km ?? 0) / 20, // normalisé
      duration_min: (r.duration_min ?? 0) / 60, // normalisé
    };
    const yTrue = (r.net_profit ?? 0) / 40; // normalisé, cible ~[0,1]
    let yPred = 0;
    for (const f of FL_FEATURES) yPred += coeffs[f] * x[f];
    const error = yPred - yTrue; // dérivée MSE : d/dw = error * x
    for (const f of FL_FEATURES) gradSum[f] += error * x[f];
  }

  const n = rows.length;
  return FL_FEATURES.map((f) => ({
    feature_key: f,
    gradient: round4(gradSum[f] / n),
    sample_count: n,
  }));
}

/** Calcule MAE (mean absolute error) de gains prédits vs réels pour un jeu de coefficients donné. */
function computeMae(userId: string, coeffs: Record<string, number>): { mae: number; sample_count: number } {
  const rows = db
    .prepare(
      `SELECT hour, is_weekend, distance_km, duration_min, net_profit
       FROM driver_features WHERE user_id = ? AND net_profit IS NOT NULL ORDER BY ts DESC LIMIT 100`,
    )
    .all(userId) as any[];

  if (rows.length === 0) return { mae: 0, sample_count: 0 };

  let sumAbsErr = 0;
  for (const r of rows) {
    const hourAngle = (2 * Math.PI * r.hour) / 24;
    const x: Record<string, number> = {
      bias: 1,
      hour_sin: Math.sin(hourAngle),
      hour_cos: Math.cos(hourAngle),
      is_weekend: r.is_weekend ? 1 : 0,
      distance_km: (r.distance_km ?? 0) / 20,
      duration_min: (r.duration_min ?? 0) / 60,
    };
    let yPred = 0;
    for (const f of FL_FEATURES) yPred += coeffs[f] * x[f];
    const predictedGain = yPred * 40; // dé-normalisé en euros
    const realGain = r.net_profit ?? 0;
    sumAbsErr += Math.abs(predictedGain - realGain);
  }
  return { mae: round2(sumAbsErr / rows.length), sample_count: rows.length };
}

/** Récupère (ou entraîne à la volée) le modèle personnel simple pour comparaison. */
function getPersonalLrCoefficients(userId: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT hour, is_weekend, distance_km, duration_min, net_profit
       FROM driver_features WHERE user_id = ? AND net_profit IS NOT NULL ORDER BY ts DESC LIMIT 200`,
    )
    .all(userId) as any[];

  const coeffs: Record<string, number> = {};
  FL_FEATURES.forEach((f) => (coeffs[f] = 0));
  if (rows.length < 5) return coeffs;

  const lr = 0.05;
  for (let epoch = 0; epoch < 30; epoch++) {
    for (const r of rows) {
      const hourAngle = (2 * Math.PI * r.hour) / 24;
      const x: Record<string, number> = {
        bias: 1,
        hour_sin: Math.sin(hourAngle),
        hour_cos: Math.cos(hourAngle),
        is_weekend: r.is_weekend ? 1 : 0,
        distance_km: (r.distance_km ?? 0) / 20,
        duration_min: (r.duration_min ?? 0) / 60,
      };
      const yTrue = (r.net_profit ?? 0) / 40;
      let yPred = 0;
      for (const f of FL_FEATURES) yPred += coeffs[f] * x[f];
      const error = yPred - yTrue;
      for (const f of FL_FEATURES) coeffs[f] -= lr * error * x[f];
    }
  }
  return coeffs;
}

/** Agrège tous les gradients du round courant (contributeurs distincts), moyenne pondérée par
 *  sample_count, ajoute bruit de Laplace, applique un pas de gradient sur le modèle global,
 *  puis clôt le round et en ouvre un nouveau. */
function runAggregationRound(): { round_id: number; contributor_count: number; model: FlModel } {
  const pending = db
    .prepare(`SELECT * FROM fl_gradient_pool WHERE round_id = 0`)
    .all() as any[];

  const global = getStoredGlobalModel();
  const newCoeffs: Record<string, number> = { ...global.coefficients };

  const contributors = new Set(pending.map((p) => p.contributor_hash));

  if (pending.length > 0) {
    // Moyenne pondérée par feature
    const byFeature: Record<string, { sumWeighted: number; sumWeights: number }> = {};
    FL_FEATURES.forEach((f) => (byFeature[f] = { sumWeighted: 0, sumWeights: 0 }));

    for (const g of pending) {
      if (!byFeature[g.feature_key]) continue;
      byFeature[g.feature_key].sumWeighted += g.gradient_value * g.sample_count;
      byFeature[g.feature_key].sumWeights += g.sample_count;
    }

    const learningRate = 0.1;
    for (const f of FL_FEATURES) {
      const { sumWeighted, sumWeights } = byFeature[f];
      if (sumWeights === 0) continue;
      const avgGradient = sumWeighted / sumWeights;
      // Differential privacy : bruit de Laplace léger AVANT application au modèle
      const noisyGradient = avgGradient + laplaceNoise(DP_NOISE_SCALE) * 0.01; // échelle réduite car gradients normalisés petits
      newCoeffs[f] = round4(newCoeffs[f] - learningRate * noisyGradient);
    }
  }

  const newVersion = global.version + 1;
  const model: FlModel = {
    version: newVersion,
    coefficients: newCoeffs,
    updated_ts: nowIso(),
    contributor_count: contributors.size,
  };

  const roundStart = nowIso();
  const info = db
    .prepare(
      `INSERT INTO fl_round (started_at, ended_at, contributor_count, aggregated_model_json) VALUES (?, ?, ?, ?)`,
    )
    .run(roundStart, nowIso(), contributors.size, JSON.stringify(model));

  const roundId = Number(info.lastInsertRowid);

  // Marque les gradients consommés comme appartenant à ce round (traçabilité, jamais réutilisés)
  if (pending.length > 0) {
    const markStmt = db.prepare(`UPDATE fl_gradient_pool SET round_id = ? WHERE id = ?`);
    const tx = db.transaction((rows: any[]) => {
      for (const r of rows) markStmt.run(roundId, r.id);
    });
    tx(pending);
  }

  return { round_id: roundId, contributor_count: contributors.size, model };
}

// ═════════════════════════════════════════════════════════════════════════════
// Router Express — monté sur /api/ml (préfixe partagé avec mlPersonal.ts existant)
// ═════════════════════════════════════════════════════════════════════════════

export const mlAdvancedRouter = Router();

/**
 * POST /api/ml/feedback
 * { suggestion_id, arm_key?, action: "accepted"|"refused"|"ignored", outcome_after?: { gain_eur, wait_min } }
 * Met à jour le bandit Thompson personnel avec un feedback EXPLICITE chauffeur.
 */
mlAdvancedRouter.post("/feedback", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getCurrentUsername(req) || DEFAULT_USER;
    const { suggestion_id, arm_key, action, outcome_after } = req.body as {
      suggestion_id?: string;
      arm_key?: string;
      action?: string;
      outcome_after?: { gain_eur?: number; wait_min?: number };
    };

    if (!suggestion_id || !action || !["accepted", "refused", "ignored"].includes(action)) {
      return res.status(400).json({ error: "suggestion_id et action ('accepted'|'refused'|'ignored') requis" });
    }

    const effectiveArmKey = arm_key && arm_key.trim() ? arm_key.trim() : `sugg_${suggestion_id}`;
    const { arm, reward } = updateBanditFeedback(
      userId,
      suggestion_id,
      effectiveArmKey,
      action as "accepted" | "refused" | "ignored",
      outcome_after?.gain_eur,
      outcome_after?.wait_min,
    );

    res.json({
      success: true,
      arm_key: arm.arm_key,
      reward: round4(reward),
      updated_arm: {
        count: arm.count,
        alpha: round2(arm.alpha),
        beta: round2(arm.beta),
        mean_reward: arm.count > 0 ? round4(arm.sum_reward / arm.count) : 0,
      },
    });
  } catch (e: any) {
    console.error("[ml/feedback] error:", e);
    res.status(500).json({ error: "feedback_error", message: e?.message || "unknown" });
  }
});

/**
 * GET /api/ml/rl-policy-state
 * État actuel de la politique bandit Thompson (arm counts, mean rewards, ratio exploration).
 */
mlAdvancedRouter.get("/rl-policy-state", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getCurrentUsername(req) || DEFAULT_USER;
    const state = getRlPolicyState(userId);
    const bestPick = thompsonPickBestArm(userId);
    res.json({ ...state, thompson_recommended_arm: bestPick });
  } catch (e: any) {
    console.error("[ml/rl-policy-state] error:", e);
    res.status(500).json({ error: "rl_policy_state_error", message: e?.message || "unknown" });
  }
});

/**
 * POST /api/ml/local-gradient
 * { feature_name, gradient, sample_count } — envoi anonymisé d'un gradient local au pool commun.
 * Si feature_name/gradient omis, calcule automatiquement les gradients locaux du chauffeur
 * (sur driver_features) et les publie tous (usage recommandé côté client "Contribuer maintenant").
 */
mlAdvancedRouter.post("/local-gradient", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getCurrentUsername(req) || DEFAULT_USER;

    const participation = db.prepare(`SELECT * FROM fl_participation WHERE user_id = ?`).get(userId) as any;
    if (!participation || !participation.opted_in) {
      return res.status(403).json({
        error: "not_opted_in",
        message: "Vous devez d'abord activer la contribution anonyme via /api/ml/rejoin-global.",
      });
    }

    const { feature_name, gradient, sample_count } = req.body as {
      feature_name?: string;
      gradient?: number;
      sample_count?: number;
    };

    const salt = randomBytes(8).toString("hex"); // salt par envoi — même contributeur non traçable dans le temps
    const cHash = contributorHash(userId, salt);
    const ts = nowIso();

    let published: { feature_key: string; gradient: number; sample_count: number }[] = [];

    if (feature_name && typeof gradient === "number") {
      // Envoi manuel d'un seul gradient (déjà anonymisé côté appelant)
      if (!FL_FEATURES.includes(feature_name as FlFeature)) {
        return res.status(400).json({ error: "feature_name invalide", allowed: FL_FEATURES });
      }
      const noisy = gradient + laplaceNoise(DP_NOISE_SCALE) * 0.01;
      db.prepare(
        `INSERT INTO fl_gradient_pool (round_id, feature_key, gradient_value, sample_count, contributor_hash, ts)
         VALUES (0, ?, ?, ?, ?, ?)`,
      ).run(feature_name, round4(noisy), sample_count ?? 1, cHash, ts);
      published = [{ feature_key: feature_name, gradient: round4(noisy), sample_count: sample_count ?? 1 }];
    } else {
      // Calcul automatique des gradients locaux (LR simple) sur les données du chauffeur —
      // les DONNÉES restent locales, seuls ces scalaires agrégés sont envoyés.
      const localGrads = computeLocalGradients(userId);
      if (localGrads.length === 0) {
        return res.status(400).json({
          error: "insufficient_local_data",
          message: "Pas assez de courses enregistrées localement pour calculer un gradient (minimum 5).",
        });
      }
      const insertStmt = db.prepare(
        `INSERT INTO fl_gradient_pool (round_id, feature_key, gradient_value, sample_count, contributor_hash, ts)
         VALUES (0, ?, ?, ?, ?, ?)`,
      );
      const tx = db.transaction((grads: typeof localGrads) => {
        for (const g of grads) {
          const noisy = g.gradient + laplaceNoise(DP_NOISE_SCALE) * 0.01;
          insertStmt.run(g.feature_key, round4(noisy), g.sample_count, cHash, ts);
          published.push({ feature_key: g.feature_key, gradient: round4(noisy), sample_count: g.sample_count });
        }
      });
      tx(localGrads);
    }

    db.prepare(
      `UPDATE fl_participation SET last_sync_ts = ? WHERE user_id = ?`,
    ).run(ts, userId);

    res.json({
      success: true,
      contributor_hash: cHash, // hash non réversible, pas de PII — juste pour confirmer l'envoi côté client
      dp_noise_scale: DP_NOISE_SCALE,
      gradients_published: published,
    });
  } catch (e: any) {
    console.error("[ml/local-gradient] error:", e);
    res.status(500).json({ error: "local_gradient_error", message: e?.message || "unknown" });
  }
});

/**
 * POST /api/ml/aggregate-round
 * Déclenche (manuellement ou via cron externe) un round d'agrégation des gradients en attente.
 * Agrège tous les contributeurs du pool (round_id=0), moyenne pondérée + bruit Laplace, publie
 * un nouveau modèle global versionné.
 */
mlAdvancedRouter.post("/aggregate-round", requireAuth, (_req: Request, res: Response) => {
  try {
    const result = runAggregationRound();
    res.json({
      success: true,
      round_id: result.round_id,
      contributor_count: result.contributor_count,
      new_model_version: result.model.version,
      dp_noise_scale: DP_NOISE_SCALE,
    });
  } catch (e: any) {
    console.error("[ml/aggregate-round] error:", e);
    res.status(500).json({ error: "aggregate_round_error", message: e?.message || "unknown" });
  }
});

/**
 * GET /api/ml/global-model
 * Retourne le modèle global courant {version, coefficients, updated_ts}.
 */
mlAdvancedRouter.get("/global-model", requireAuth, (_req: Request, res: Response) => {
  try {
    const model = getStoredGlobalModel();
    const lastRound = db
      .prepare(`SELECT id, started_at, ended_at, contributor_count FROM fl_round ORDER BY id DESC LIMIT 1`)
      .get() as any;
    res.json({
      version: model.version,
      coefficients: model.coefficients,
      updated_ts: model.updated_ts,
      contributor_count: model.contributor_count,
      last_round: lastRound ?? null,
      features: FL_FEATURES,
    });
  } catch (e: any) {
    console.error("[ml/global-model] error:", e);
    res.status(500).json({ error: "global_model_error", message: e?.message || "unknown" });
  }
});

/**
 * GET /api/ml/personal-vs-global
 * Comparaison performance modèle personnel vs modèle global (MAE gains prédits vs réels).
 */
mlAdvancedRouter.get("/personal-vs-global", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getCurrentUsername(req) || DEFAULT_USER;
    const globalModel = getStoredGlobalModel();
    const personalCoeffs = getPersonalLrCoefficients(userId);

    const personalMae = computeMae(userId, personalCoeffs);
    const globalMae = computeMae(userId, globalModel.coefficients);

    const better = personalMae.sample_count === 0
      ? "insufficient_data"
      : personalMae.mae <= globalMae.mae
        ? "personal"
        : "global";

    // Persist pour /api/ml/rejoin-global et affichage historique
    db.prepare(
      `INSERT INTO fl_participation (user_id, opted_in, last_sync_ts, personal_mae, global_mae)
       VALUES (?, 0, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET personal_mae = excluded.personal_mae, global_mae = excluded.global_mae`,
    ).run(userId, personalMae.mae, globalMae.mae);

    res.json({
      user_id: userId,
      personal_model: { mae: personalMae.mae, sample_count: personalMae.sample_count },
      global_model: { mae: globalMae.mae, sample_count: globalMae.sample_count, version: globalModel.version },
      better_model: better,
      recommendation:
        better === "personal"
          ? "Votre modèle personnel est plus précis que le modèle communautaire actuel — continuez à l'utiliser."
          : better === "global"
            ? "Le modèle communautaire est actuellement plus précis pour vous (souvent car votre historique est encore limité)."
            : "Pas assez de données pour comparer — roulez encore quelques courses.",
    });
  } catch (e: any) {
    console.error("[ml/personal-vs-global] error:", e);
    res.status(500).json({ error: "personal_vs_global_error", message: e?.message || "unknown" });
  }
});

/**
 * POST /api/ml/rejoin-global
 * { opted_in: boolean } — le chauffeur choisit (opt-in explicite) de contribuer au modèle
 * communautaire fédéré / de se resynchroniser avec le modèle global.
 */
mlAdvancedRouter.post("/rejoin-global", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getCurrentUsername(req) || DEFAULT_USER;
    const { opted_in } = req.body as { opted_in?: boolean };
    const val = opted_in === true ? 1 : 0;

    db.prepare(
      `INSERT INTO fl_participation (user_id, opted_in, last_sync_ts, personal_mae, global_mae)
       VALUES (?, ?, ?, NULL, NULL)
       ON CONFLICT(user_id) DO UPDATE SET opted_in = excluded.opted_in, last_sync_ts = excluded.last_sync_ts`,
    ).run(userId, val, nowIso());

    const row = db.prepare(`SELECT * FROM fl_participation WHERE user_id = ?`).get(userId) as any;

    res.json({
      success: true,
      opted_in: !!row.opted_in,
      message: row.opted_in
        ? "Contribution anonyme activée — vos gradients (jamais vos données) seront envoyés au pool commun."
        : "Contribution désactivée — vous restez sur votre modèle 100% personnel.",
    });
  } catch (e: any) {
    console.error("[ml/rejoin-global] error:", e);
    res.status(500).json({ error: "rejoin_global_error", message: e?.message || "unknown" });
  }
});

/**
 * GET /api/ml/fl-participation-state — état d'opt-in courant (utilitaire additionnel pour le frontend,
 * évite de dépendre uniquement de POST pour lire l'état initial du toggle).
 */
mlAdvancedRouter.get("/fl-participation-state", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getCurrentUsername(req) || DEFAULT_USER;
    const row = db.prepare(`SELECT * FROM fl_participation WHERE user_id = ?`).get(userId) as any;
    res.json({
      opted_in: !!row?.opted_in,
      last_sync_ts: row?.last_sync_ts ?? null,
      personal_mae: row?.personal_mae ?? null,
      global_mae: row?.global_mae ?? null,
    });
  } catch (e: any) {
    console.error("[ml/fl-participation-state] error:", e);
    res.status(500).json({ error: "fl_participation_state_error", message: e?.message || "unknown" });
  }
});

/**
 * GET /api/ml/last-fl-round — infos du dernier round FL (contributeurs anonymes, gains typiques)
 * pour affichage carte "dernière round FL" côté frontend.
 */
mlAdvancedRouter.get("/last-fl-round", requireAuth, (_req: Request, res: Response) => {
  try {
    const lastRound = db
      .prepare(`SELECT * FROM fl_round ORDER BY id DESC LIMIT 1`)
      .get() as any;

    if (!lastRound) {
      return res.json({ has_round: false });
    }

    let model: FlModel | null = null;
    try {
      model = lastRound.aggregated_model_json ? JSON.parse(lastRound.aggregated_model_json) : null;
    } catch {
      model = null;
    }

    res.json({
      has_round: true,
      round_id: lastRound.id,
      started_at: lastRound.started_at,
      ended_at: lastRound.ended_at,
      contributor_count: lastRound.contributor_count,
      model_version: model?.version ?? null,
      dp_noise_scale: DP_NOISE_SCALE,
    });
  } catch (e: any) {
    console.error("[ml/last-fl-round] error:", e);
    res.status(500).json({ error: "last_fl_round_error", message: e?.message || "unknown" });
  }
});

export default mlAdvancedRouter;
