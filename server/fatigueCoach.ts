/**
 * fatigueCoach.ts — Fatigue Coach avancé + détection micro-sommeil (Itération 3)
 * ═════════════════════════════════════════════════════════════════════════════
 * Rapport §5 (Sécurité et fatigue) + §2 (ML personnel driver) :
 *   - §5.2 Détection de micro-sommeil par proxys comportementaux (SANS caméra)
 *   - §5.3 Pauses actives suggérées intelligemment
 *   - §5.7 Alerte fatigue basée sur horloge circadienne (calibrable par individu)
 *   - §5.9 Mode "je me sens fatigué" (ici : coach conversationnel proactif)
 *   - §2.1 Feature store personnel / §2.12 Patterns récurrents personnels
 *
 * IMPORTANT — honnêteté technique (piège identifié §5.2) : ceci N'EST PAS une
 * détection physiologique réelle de somnolence (pas de caméra, pas de capteur
 * oculaire). C'est un SCORE DE RISQUE STATISTIQUE basé sur des proxys
 * comportementaux (latence de tap, jerk de swipe, variance gyro/accéléro du
 * téléphone posé sur le support, temps de décision, heure du cycle
 * nycthéméral, durée de shift). Le message utilisateur reflète toujours cette
 * limite ("estimation", "indices", jamais "on a détecté que vous dormez").
 *
 * ZÉRO nouvelle dépendance npm — utilise better-sqlite3 déjà présent (comme
 * mlPersonal.ts, safetyEngine.ts). Tables créées en CREATE TABLE IF NOT EXISTS,
 * complètement additionnelles (aucune modification de tables existantes).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";

// Connexion séparée au même fichier data.db (WAL supporte le multi-connexion),
// même pattern que mlPersonal.ts.
const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const DEFAULT_USER = "root"; // app single-tenant

// ─────────────────────────────────────────────────────────────────────────────
// Schéma
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS fatigue_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL,
    tap_latency_ms REAL,
    swipe_jerk REAL,
    accel_variance REAL,
    gyro_variance REAL,
    decision_time_ms REAL,
    correction_ratio REAL,
    shift_minute INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_fatigue_telemetry_user_ts ON fatigue_telemetry(user_id, ts);

  CREATE TABLE IF NOT EXISTS fatigue_break (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    start_ts TEXT NOT NULL,
    duration_min REAL NOT NULL,
    break_type TEXT NOT NULL DEFAULT 'courte'
  );
  CREATE INDEX IF NOT EXISTS idx_fatigue_break_user_ts ON fatigue_break(user_id, start_ts);

  CREATE TABLE IF NOT EXISTS fatigue_reaction_test (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL,
    latency_ms REAL NOT NULL,
    latency_std_ms REAL,
    hits INTEGER NOT NULL DEFAULT 0,
    misses INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_fatigue_reaction_user_ts ON fatigue_reaction_test(user_id, ts);
`);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface TelemetryPoint {
  ts?: string;
  tap_latency_ms?: number;
  swipe_jerk?: number;
  accel_variance?: number;
  gyro_variance?: number;
  decision_time_ms?: number;
  correction_ratio?: number;
}

export interface MicrosleepRisk {
  risk: number; // 0-1
  indicators: string[];
  confidence: number; // 0-1
  next_break_recommended_min: number;
}

export interface CoachMessage {
  message_fr: string;
  urgency: "info" | "attention" | "urgent";
  action_fr: string;
  expected_gain_fr: string;
}

export interface PersonalCurvePoint {
  hour: number;
  avg_tap_latency_ms: number | null;
  avg_decision_time_ms: number | null;
  sample_count: number;
  vigilance_score: number; // 0-1, 1 = très lucide
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function nowIso(): string {
  return new Date().toISOString();
}

function currentHourParis(): number {
  // Approximation Europe/Paris déjà utilisée ailleurs dans le code (UTC+2 été).
  // On garde cohérence avec le reste du repo (mlPersonal.ts utilise +2 fixe).
  return (new Date().getUTCHours() + 2) % 24;
}

/** Récupère la baseline personnelle de latence de tap (médiane sur 14j) pour établir un seuil individuel plutôt qu'un seuil universel (évite le piège §5.7 : rythme individuel). */
function getPersonalTapBaseline(userId: string): { median: number; count: number } {
  const rows = db
    .prepare(
      `SELECT tap_latency_ms FROM fatigue_telemetry
       WHERE user_id = ? AND tap_latency_ms IS NOT NULL
       AND ts >= datetime('now', '-14 days')
       ORDER BY tap_latency_ms ASC`
    )
    .all(userId) as { tap_latency_ms: number }[];
  if (rows.length === 0) return { median: 280, count: 0 }; // valeur générique cold-start
  const vals = rows.map((r) => r.tap_latency_ms);
  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
  return { median, count: vals.length };
}

/** Durée du shift en cours (minutes), estimée depuis la première télémétrie du shift courant (gap > 90 min = nouveau shift). */
function getShiftMinutes(userId: string): number {
  const rows = db
    .prepare(
      `SELECT ts FROM fatigue_telemetry WHERE user_id = ? ORDER BY ts DESC LIMIT 200`
    )
    .all(userId) as { ts: string }[];
  if (rows.length === 0) return 0;
  let shiftStart = new Date(rows[0].ts).getTime();
  for (let i = 0; i < rows.length - 1; i++) {
    const cur = new Date(rows[i].ts).getTime();
    const prev = new Date(rows[i + 1].ts).getTime();
    if (cur - prev > 90 * 60 * 1000) break; // trou > 90min = fin du shift précédent
    shiftStart = prev;
  }
  return Math.max(0, (Date.now() - shiftStart) / 60000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /api/fatigue/telemetry — ingestion mini-batch
// ─────────────────────────────────────────────────────────────────────────────
export function ingestTelemetry(userId: string, points: TelemetryPoint[]): { inserted: number } {
  const shiftMinutes = Math.round(getShiftMinutes(userId));
  const stmt = db.prepare(`
    INSERT INTO fatigue_telemetry
      (user_id, ts, tap_latency_ms, swipe_jerk, accel_variance, gyro_variance, decision_time_ms, correction_ratio, shift_minute)
    VALUES (@user_id, @ts, @tap_latency_ms, @swipe_jerk, @accel_variance, @gyro_variance, @decision_time_ms, @correction_ratio, @shift_minute)
  `);
  const tx = db.transaction((pts: TelemetryPoint[]) => {
    let n = 0;
    for (const p of pts) {
      stmt.run({
        user_id: userId,
        ts: p.ts || nowIso(),
        tap_latency_ms: p.tap_latency_ms ?? null,
        swipe_jerk: p.swipe_jerk ?? null,
        accel_variance: p.accel_variance ?? null,
        gyro_variance: p.gyro_variance ?? null,
        decision_time_ms: p.decision_time_ms ?? null,
        correction_ratio: p.correction_ratio ?? null,
        shift_minute: shiftMinutes,
      });
      n++;
    }
    return n;
  });
  const inserted = tx(points);
  return { inserted };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/fatigue/microsleep-risk — score composite
// ─────────────────────────────────────────────────────────────────────────────
export function computeMicrosleepRisk(userId: string): MicrosleepRisk {
  const baseline = getPersonalTapBaseline(userId);
  const shiftMinutes = getShiftMinutes(userId);
  const hour = currentHourParis();

  // Fenêtre récente (15 dernières minutes de télémétrie)
  const recent = db
    .prepare(
      `SELECT tap_latency_ms, decision_time_ms, correction_ratio, accel_variance, gyro_variance, swipe_jerk
       FROM fatigue_telemetry
       WHERE user_id = ? AND ts >= datetime('now', '-15 minutes')`
    )
    .all(userId) as {
    tap_latency_ms: number | null;
    decision_time_ms: number | null;
    correction_ratio: number | null;
    accel_variance: number | null;
    gyro_variance: number | null;
    swipe_jerk: number | null;
  }[];

  const indicators: string[] = [];
  let score = 0;
  let signalsAvailable = 0;

  // ── Indicateur 1 : latence de tap > seuil personnel (+150% médiane) ──
  const taps = recent.map((r) => r.tap_latency_ms).filter((v): v is number => v != null);
  if (taps.length >= 3) {
    signalsAvailable++;
    const avgTap = taps.reduce((a, b) => a + b, 0) / taps.length;
    const ratio = baseline.median > 0 ? avgTap / baseline.median : 1;
    if (ratio > 1.5) {
      score += 0.3;
      indicators.push("Temps de réaction au tap nettement plus lent que d'habitude");
    } else if (ratio > 1.2) {
      score += 0.15;
      indicators.push("Léger ralentissement du temps de réaction");
    }
  }

  // ── Indicateur 2 : temps de décision > 2s ──
  const decisions = recent.map((r) => r.decision_time_ms).filter((v): v is number => v != null);
  if (decisions.length >= 2) {
    signalsAvailable++;
    const avgDecision = decisions.reduce((a, b) => a + b, 0) / decisions.length;
    if (avgDecision > 2000) {
      score += 0.25;
      indicators.push("Décisions plus longues à prendre (> 2s)");
    } else if (avgDecision > 1200) {
      score += 0.1;
      indicators.push("Décisions un peu plus lentes que la normale");
    }
  }

  // ── Indicateur 3 : ratio de correction élevé (swipe raté, retap) ──
  const corrections = recent.map((r) => r.correction_ratio).filter((v): v is number => v != null);
  if (corrections.length >= 2) {
    signalsAvailable++;
    const avgCorr = corrections.reduce((a, b) => a + b, 0) / corrections.length;
    if (avgCorr > 0.3) {
      score += 0.15;
      indicators.push("Plus d'erreurs de manipulation (retouches fréquentes)");
    }
  }

  // ── Indicateur 4 : variance gyro/accéléro (téléphone posé, micro-mouvements erratiques du support) ──
  const gyroVals = recent.map((r) => r.gyro_variance).filter((v): v is number => v != null);
  const accelVals = recent.map((r) => r.accel_variance).filter((v): v is number => v != null);
  if (gyroVals.length >= 2 || accelVals.length >= 2) {
    signalsAvailable++;
    const avgGyro = gyroVals.length ? gyroVals.reduce((a, b) => a + b, 0) / gyroVals.length : 0;
    const avgAccel = accelVals.length ? accelVals.reduce((a, b) => a + b, 0) / accelVals.length : 0;
    // Variance anormalement basse = micro-relâchement / immobilité suspecte ;
    // variance anormalement haute et saccadée = micro-corrections de trajectoire (fatigue).
    if (avgGyro > 2.5 || avgAccel > 2.5) {
      score += 0.15;
      indicators.push("Micro-corrections de direction plus fréquentes (variance gyroscope)");
    }
  }

  // ── Indicateur 5 : cycle nycthéméral personnel (creux circadien 2h-6h, 13h-15h) ──
  signalsAvailable++;
  if (hour >= 2 && hour < 6) {
    score += 0.25;
    indicators.push("Creux circadien profond (2h-6h) — vigilance naturellement basse");
  } else if (hour >= 13 && hour < 15) {
    score += 0.1;
    indicators.push("Creux circadien de l'après-midi (13h-15h)");
  }

  // ── Indicateur 6 : heures continues de conduite ──
  signalsAvailable++;
  if (shiftMinutes >= 300) {
    score += 0.2;
    indicators.push(`Shift long en cours (${(shiftMinutes / 60).toFixed(1)}h sans pause détectée)`);
  } else if (shiftMinutes >= 210) {
    score += 0.1;
    indicators.push(`Plus de 3h30 de conduite continue`);
  }

  const risk = Math.max(0, Math.min(1, score));
  // Confiance = proportion de signaux disponibles sur les 6 catégories, pondérée
  // par le volume total de points télémétrie de la fenêtre.
  const confidence = Math.min(1, signalsAvailable / 6) * (recent.length >= 5 ? 1 : 0.5 + recent.length * 0.1);

  let nextBreakMin: number;
  if (risk >= 0.7) nextBreakMin = 0;
  else if (risk >= 0.5) nextBreakMin = 15;
  else if (risk >= 0.3) nextBreakMin = 30;
  else nextBreakMin = 60;

  if (indicators.length === 0) {
    indicators.push("Aucun signe de fatigue détecté pour le moment");
  }

  return {
    risk: Math.round(risk * 100) / 100,
    indicators,
    confidence: Math.round(confidence * 100) / 100,
    next_break_recommended_min: nextBreakMin,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/fatigue/coach-message — message contextuel empathique
// ─────────────────────────────────────────────────────────────────────────────
export function getCoachMessage(userId: string): CoachMessage {
  const { risk, indicators, next_break_recommended_min } = computeMicrosleepRisk(userId);
  const shiftMinutes = getShiftMinutes(userId);
  const shiftH = (shiftMinutes / 60).toFixed(1);

  if (risk >= 0.7) {
    return {
      message_fr:
        `Là, je sens que tu fatigues vraiment. Tu es sur la route depuis ${shiftH}h et plusieurs signes ` +
        `(réaction plus lente, décisions qui traînent) pointent vers un vrai coup de fatigue. Ta sécurité passe avant tout.`,
      urgency: "urgent",
      action_fr: "Arrête-toi dès que possible, 15-20 minutes, coupe le moteur et ferme les yeux si tu peux.",
      expected_gain_fr: "Une vraie coupure maintenant réduit fortement le risque d'accident et tu repars bien plus efficace.",
    };
  }

  if (risk >= 0.45) {
    return {
      message_fr:
        `Petit signal de fatigue de mon côté — rien d'alarmant, mais après ${shiftH}h ça commence à se sentir. ` +
        (indicators[0] ? `J'ai remarqué : ${indicators[0].toLowerCase()}.` : ""),
      urgency: "attention",
      action_fr: `Prends une pause de 10-15 minutes dans les ${next_break_recommended_min} prochaines minutes.`,
      expected_gain_fr: "Une courte pause maintenant t'évite une chute de vigilance plus dure dans 1h.",
    };
  }

  if (risk >= 0.25) {
    return {
      message_fr: `Tu tiens bien la route pour l'instant. Petite vigilance recommandée sur ce créneau.`,
      urgency: "info",
      action_fr: "Pense à boire de l'eau et à faire une pause naturelle avant la prochaine course longue.",
      expected_gain_fr: "Anticiper évite d'arriver fatigué en fin de journée.",
    };
  }

  return {
    message_fr: `Tu as l'air bien réveillé et concentré, continue comme ça !`,
    urgency: "info",
    action_fr: "Rien à faire de spécial, garde juste un œil sur l'heure si tu roules tard.",
    expected_gain_fr: "Un bon rythme aujourd'hui = une meilleure récupération ce soir.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /api/fatigue/rest-taken — journalisation pause
// ─────────────────────────────────────────────────────────────────────────────
export function recordRestTaken(
  userId: string,
  durationMin: number,
  breakType: string
): { id: number } {
  const info = db
    .prepare(
      `INSERT INTO fatigue_break (user_id, start_ts, duration_min, break_type) VALUES (?, ?, ?, ?)`
    )
    .run(userId, nowIso(), durationMin, breakType || "courte");
  return { id: Number(info.lastInsertRowid) };
}

export function getRestHistory(userId: string, limit = 30) {
  return db
    .prepare(
      `SELECT id, start_ts, duration_min, break_type FROM fatigue_break
       WHERE user_id = ? ORDER BY start_ts DESC LIMIT ?`
    )
    .all(userId, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET /api/fatigue/personal-curve — courbe apprise par heure de la journée
// ─────────────────────────────────────────────────────────────────────────────
export function getPersonalCurve(userId: string): { curve: PersonalCurvePoint[]; insight_fr: string; sample_days: number } {
  const rows = db
    .prepare(
      `SELECT
         CAST(strftime('%H', ts) AS INTEGER) AS hour,
         tap_latency_ms, decision_time_ms
       FROM fatigue_telemetry
       WHERE user_id = ? AND ts >= datetime('now', '-60 days')`
    )
    .all(userId) as { hour: number; tap_latency_ms: number | null; decision_time_ms: number | null }[];

  const buckets: Record<number, { taps: number[]; decisions: number[] }> = {};
  for (let h = 0; h < 24; h++) buckets[h] = { taps: [], decisions: [] };
  for (const r of rows) {
    const h = ((r.hour + 2) % 24); // stocké en UTC (strftime), on ajuste vers Paris comme le reste du repo
    if (r.tap_latency_ms != null) buckets[h].taps.push(r.tap_latency_ms);
    if (r.decision_time_ms != null) buckets[h].decisions.push(r.decision_time_ms);
  }

  // Baseline globale pour normaliser le score de vigilance (moins la latence est haute, plus la vigilance est haute)
  const allTaps = rows.map((r) => r.tap_latency_ms).filter((v): v is number => v != null);
  const globalAvg = allTaps.length ? allTaps.reduce((a, b) => a + b, 0) / allTaps.length : 300;
  const globalMax = allTaps.length ? Math.max(...allTaps) : 600;

  const curve: PersonalCurvePoint[] = [];
  for (let h = 0; h < 24; h++) {
    const taps = buckets[h].taps;
    const decisions = buckets[h].decisions;
    const avgTap = taps.length ? taps.reduce((a, b) => a + b, 0) / taps.length : null;
    const avgDecision = decisions.length ? decisions.reduce((a, b) => a + b, 0) / decisions.length : null;
    let vigilance = 0.5; // valeur neutre si pas de données
    if (avgTap != null && globalMax > globalAvg) {
      vigilance = Math.max(0, Math.min(1, 1 - (avgTap - globalAvg) / (globalMax - globalAvg + 1)));
    }
    curve.push({
      hour: h,
      avg_tap_latency_ms: avgTap != null ? Math.round(avgTap) : null,
      avg_decision_time_ms: avgDecision != null ? Math.round(avgDecision) : null,
      sample_count: taps.length,
      vigilance_score: Math.round(vigilance * 100) / 100,
    });
  }

  // Exiger un minimum d'échantillons pour un insight fiable (piège §2.12 : éviter fausse causalité sur peu de données)
  const wellSampled = curve.filter((c) => c.sample_count >= 5);
  let insight = "Pas encore assez de données pour dégager une tendance fiable — continue à utiliser l'app, ta courbe se précisera.";
  if (wellSampled.length >= 4) {
    const best = wellSampled.reduce((a, b) => (b.vigilance_score > a.vigilance_score ? b : a));
    const worst = wellSampled.reduce((a, b) => (b.vigilance_score < a.vigilance_score ? b : a));
    if (best.vigilance_score - worst.vigilance_score > 0.15) {
      insight = `Tu es généralement plus lucide vers ${best.hour}h, mais ta vigilance chute nettement après ${worst.hour}h. Anticipe tes pauses sur ce créneau.`;
    } else {
      insight = "Ta vigilance reste assez stable sur la journée, pas de chute marquée détectée pour l'instant.";
    }
  }

  const distinctDays = db
    .prepare(`SELECT COUNT(DISTINCT date(ts)) as n FROM fatigue_telemetry WHERE user_id = ?`)
    .get(userId) as { n: number };

  return { curve, insight_fr: insight, sample_days: distinctDays?.n ?? 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. POST /api/fatigue/reaction-test — test de réaction 5s
// ─────────────────────────────────────────────────────────────────────────────
export function recordReactionTest(
  userId: string,
  latencyMs: number,
  latencyStdMs: number | undefined,
  hits: number,
  misses: number
) {
  db.prepare(
    `INSERT INTO fatigue_reaction_test (user_id, ts, latency_ms, latency_std_ms, hits, misses)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, nowIso(), latencyMs, latencyStdMs ?? null, hits, misses);

  // Baseline personnelle = moyenne des 10 derniers tests (hors celui qu'on vient d'insérer, sur 30j)
  const baselineRows = db
    .prepare(
      `SELECT latency_ms FROM fatigue_reaction_test
       WHERE user_id = ? AND ts >= datetime('now', '-30 days')
       ORDER BY ts DESC LIMIT 11`
    )
    .all(userId) as { latency_ms: number }[];

  const history = baselineRows.slice(1); // exclut le test courant
  const baselineAvg = history.length
    ? history.reduce((a, b) => a + b.latency_ms, 0) / history.length
    : latencyMs;

  const deltaPct = baselineAvg > 0 ? ((latencyMs - baselineAvg) / baselineAvg) * 100 : 0;

  let verdict_fr: string;
  if (deltaPct > 30) {
    verdict_fr = "Ton temps de réaction est nettement plus lent que ta moyenne habituelle — signe de fatigue à prendre au sérieux.";
  } else if (deltaPct > 12) {
    verdict_fr = "Légèrement plus lent que d'habitude, reste vigilant.";
  } else if (deltaPct < -12) {
    verdict_fr = "Très bon temps de réaction, tu es en forme !";
  } else {
    verdict_fr = "Dans la moyenne de tes performances habituelles.";
  }

  return {
    latency_ms: latencyMs,
    baseline_avg_ms: Math.round(baselineAvg),
    delta_pct: Math.round(deltaPct),
    hits,
    misses,
    verdict_fr,
  };
}

export function getReactionHistory(userId: string, limit = 20) {
  return db
    .prepare(
      `SELECT id, ts, latency_ms, latency_std_ms, hits, misses FROM fatigue_reaction_test
       WHERE user_id = ? ORDER BY ts DESC LIMIT ?`
    )
    .all(userId, limit);
}

export { DEFAULT_USER };
