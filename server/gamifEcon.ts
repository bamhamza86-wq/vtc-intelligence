/**
 * gamifEcon.ts — Couche « Gamification Économique » (rapport.md §15)
 * ─────────────────────────────────────────────────────────────────────────────
 * Implémente :
 *   15.1 Défis rentabilité hebdo (table weekly_challenges) — génération auto
 *        déterministe (+10% marge, -5% km à vide, etc.)
 *   15.2 Leaderboard économique k-anonyme (réutilise le pattern k-anon ≥ 5
 *        déjà présent dans uxEngine.ts / healthMetrics.ts)
 *   15.3 Achievements financiers → délégués à wowEngine.checkEconAchievements
 *        (catalogue étendu directement dans wowEngine.ts, cf. ACHIEVEMENT_CATALOG)
 *   15.4 Barre de progression objectif journalier/hebdo/mensuel + projection
 *
 * ZÉRO nouvelle dépendance npm. Toutes les tables sont additive
 * (CREATE TABLE IF NOT EXISTS), cohérent avec le style de wowEngine.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sqlite, storage } from "./storage";
import * as economicsEngine from "./economicsEngine";
import * as wowEngine from "./wowEngine";
import { computeBusinessKpis, computePeerBenchmarkEcon } from "./healthMetrics";

const DEFAULT_USER_ID = "driver_default";
const r1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function parisNow(): Date {
  return new Date();
}

function dateIso(d: Date = parisNow()): string {
  return d.toISOString().slice(0, 10);
}

/** Numéro de semaine ISO au format "2026-W27" — identique à wowEngine.ts pour cohérence. */
function weekIso(d: Date = parisNow()): string {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target.getTime() - firstThursday.getTime();
  const week = 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));
  return `${target.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Schéma DB — additive uniquement
// ═════════════════════════════════════════════════════════════════════════════

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS weekly_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    challenge_key TEXT NOT NULL,
    label_fr TEXT NOT NULL,
    metric TEXT NOT NULL,
    target_value REAL NOT NULL,
    baseline_value REAL NOT NULL DEFAULT 0,
    current_value REAL NOT NULL DEFAULT 0,
    week_iso TEXT NOT NULL,
    completed_at TEXT,
    reward_icon TEXT NOT NULL DEFAULT '🏆',
    UNIQUE(user_id, challenge_key, week_iso)
  );
`);

// ═════════════════════════════════════════════════════════════════════════════
// 15.1 — Défis rentabilité hebdo
// ═════════════════════════════════════════════════════════════════════════════

interface ChallengeTemplate {
  key: string;
  metric: "margin_pct" | "dead_km_ratio_pct" | "net_per_hour" | "rides_count";
  direction: "increase" | "decrease";
  delta_pct: number; // ex: +10 ou -5
  label_fr: (delta: number) => string;
  reward_icon: string;
}

const CHALLENGE_POOL: ChallengeTemplate[] = [
  {
    key: "margin_up_10",
    metric: "net_per_hour",
    direction: "increase",
    delta_pct: 10,
    label_fr: (d) => `Augmenter votre €/h net de ${d}% par rapport à la semaine dernière`,
    reward_icon: "📈",
  },
  {
    key: "dead_km_down_5",
    metric: "dead_km_ratio_pct",
    direction: "decrease",
    delta_pct: 5,
    label_fr: (d) => `Réduire votre ratio de km à vide de ${d} points`,
    reward_icon: "🛣️",
  },
  {
    key: "rides_up_15",
    metric: "rides_count",
    direction: "increase",
    delta_pct: 15,
    label_fr: (d) => `Augmenter votre nombre de courses de ${d}% cette semaine`,
    reward_icon: "🚕",
  },
];

/** Choix déterministe (seedé par semaine ISO) d'un défi actif — cohérent avec wowEngine.pickWeeklyQuests. */
function pickWeeklyChallenge(week: string): ChallengeTemplate {
  let seed = 0;
  for (const c of week) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  return CHALLENGE_POOL[seed % CHALLENGE_POOL.length];
}

function ensureWeeklyChallenge(userId: string = DEFAULT_USER_ID): void {
  const week = weekIso();
  const existing = sqlite
    .prepare("SELECT id FROM weekly_challenges WHERE user_id=? AND week_iso=?")
    .get(userId, week);
  if (existing) return;

  const tmpl = pickWeeklyChallenge(week);
  // Baseline = valeur de la semaine précédente (issue des KPI business déjà calculés)
  let baseline = 0;
  try {
    const kpis = computeBusinessKpis();
    const w7 = kpis.windows["7j"];
    if (tmpl.metric === "net_per_hour") baseline = w7.net_per_hour;
    else if (tmpl.metric === "dead_km_ratio_pct") baseline = w7.dead_km_ratio_pct;
    else if (tmpl.metric === "rides_count") baseline = w7.rides_count;
  } catch {
    baseline = 0;
  }

  const targetValue =
    tmpl.direction === "increase"
      ? r2(baseline * (1 + tmpl.delta_pct / 100))
      : r2(Math.max(0, baseline - tmpl.delta_pct));

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO weekly_challenges
       (user_id, challenge_key, label_fr, metric, target_value, baseline_value, current_value, week_iso, completed_at, reward_icon)
       VALUES (?,?,?,?,?,?,0,?,NULL,?)`
    )
    .run(userId, tmpl.key, tmpl.label_fr(tmpl.delta_pct), tmpl.metric, targetValue, baseline, week, tmpl.reward_icon);
}

export interface WeeklyChallengeResponse {
  challenge_key: string;
  label_fr: string;
  metric: string;
  baseline_value: number;
  target_value: number;
  current_value: number;
  progress_pct: number;
  completed: boolean;
  week_iso: string;
  reward_icon: string;
}

export function getWeeklyChallenge(userId: string = DEFAULT_USER_ID): WeeklyChallengeResponse | null {
  ensureWeeklyChallenge(userId);
  const week = weekIso();
  const row = sqlite
    .prepare("SELECT * FROM weekly_challenges WHERE user_id=? AND week_iso=?")
    .get(userId, week) as any;
  if (!row) return null;

  // Mise à jour dynamique de current_value à partir des KPI courants (7j glissant = semaine en cours)
  let current = row.current_value;
  try {
    const kpis = computeBusinessKpis();
    const w7 = kpis.windows["7j"];
    if (row.metric === "net_per_hour") current = w7.net_per_hour;
    else if (row.metric === "dead_km_ratio_pct") current = w7.dead_km_ratio_pct;
    else if (row.metric === "rides_count") current = w7.rides_count;
    sqlite.prepare("UPDATE weekly_challenges SET current_value=? WHERE id=?").run(current, row.id);
  } catch {
    /* garde la valeur stockée si le calcul échoue */
  }

  const isDecrease = row.challenge_key.includes("down");
  const completed = isDecrease ? current <= row.target_value : current >= row.target_value;
  if (completed && !row.completed_at) {
    sqlite.prepare("UPDATE weekly_challenges SET completed_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    wowEngine.unlockAchievement(
      `challenge_${row.challenge_key}_${week}`,
      "Défi rentabilité relevé",
      `Défi hebdo complété : ${row.label_fr}`,
      row.reward_icon,
      userId
    );
  }

  const progressRaw = isDecrease
    ? row.baseline_value > row.target_value
      ? ((row.baseline_value - current) / (row.baseline_value - row.target_value)) * 100
      : 100
    : row.target_value > row.baseline_value
    ? ((current - row.baseline_value) / (row.target_value - row.baseline_value)) * 100
    : 100;

  return {
    challenge_key: row.challenge_key,
    label_fr: row.label_fr,
    metric: row.metric,
    baseline_value: row.baseline_value,
    target_value: row.target_value,
    current_value: r2(current),
    progress_pct: Math.max(0, Math.min(100, Math.round(progressRaw))),
    completed: completed || !!row.completed_at,
    week_iso: row.week_iso,
    reward_icon: row.reward_icon,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 15.2 — Leaderboard économique k-anonyme (≥ 5 périodes, mono-chauffeur)
// ═════════════════════════════════════════════════════════════════════════════

export interface EconLeaderboardResponse {
  my_rank_estimate: number | null; // 1 = meilleur
  total_peers: number;
  k_anonymity: number;
  bands: { label_fr: string; net_per_hour_range: [number, number]; is_mine: boolean }[];
  disclaimer: string;
}

/**
 * Réutilise directement l'agrégat k-anonyme de healthMetrics.computePeerBenchmarkEcon
 * (population de référence = historique journalier propre au chauffeur, seule
 * source de "pairs" disponible en instance mono-chauffeur — jamais de données
 * d'un tiers). Restitué sous forme de bandes anonymisées façon leaderboard.
 */
export function getEconLeaderboard(): EconLeaderboardResponse {
  const peer = computePeerBenchmarkEcon();

  if (peer.k_anonymity < 5) {
    return {
      my_rank_estimate: null,
      total_peers: peer.k_anonymity,
      k_anonymity: peer.k_anonymity,
      bands: [],
      disclaimer: peer.disclaimer,
    };
  }

  const med = peer.median_net_per_hour ?? 0;
  const top25 = peer.top25_net_per_hour ?? 0;
  const mine = peer.my_net_per_hour;

  const bands = [
    { label_fr: "Top 25%", net_per_hour_range: [top25, Math.max(top25, mine, top25 * 1.5)] as [number, number], is_mine: mine >= top25 },
    { label_fr: "Au-dessus de la médiane", net_per_hour_range: [med, top25] as [number, number], is_mine: mine >= med && mine < top25 },
    { label_fr: "En dessous de la médiane", net_per_hour_range: [0, med] as [number, number], is_mine: mine < med },
  ];

  const rankEstimate = mine >= top25 ? 1 : mine >= med ? 2 : 3;

  return {
    my_rank_estimate: rankEstimate,
    total_peers: peer.k_anonymity,
    k_anonymity: peer.k_anonymity,
    bands,
    disclaimer: peer.disclaimer,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 15.4 — Barre de progression objectif (jour / semaine / mois) + projection
// ═════════════════════════════════════════════════════════════════════════════

export interface GoalProgress {
  period: "daily" | "weekly" | "monthly";
  goal_eur: number;
  current_eur: number;
  progress_pct: number;
  hours_elapsed: number;
  projected_final_eur: number;
  on_track: boolean;
  message_fr: string;
}

function getHourlyTarget(): number {
  try {
    const profile: any = storage.getDriverProfile() || {};
    return profile.hourly_target_income ?? 35;
  } catch {
    return 35;
  }
}

function sumNetSince(since: Date): { net: number; hours: number } {
  const rides = storage.getRidesInRange(since.toISOString(), new Date(Date.now() + 60_000).toISOString()) as any[];
  const net = r2(rides.reduce((s, r) => s + (r.net_profit ?? 0), 0));
  const hours = r2(rides.reduce((s, r) => s + (r.duration_min ?? 0), 0) / 60);
  return { net, hours };
}

export function getGoalProgress(period: "daily" | "weekly" | "monthly" = "daily"): GoalProgress {
  const hourlyTarget = getHourlyTarget();
  const now = parisNow();

  let since: Date;
  let assumedHours: number; // hypothèse d'heures travaillées sur la période pour fixer l'objectif
  if (period === "daily") {
    since = new Date(now);
    since.setHours(0, 0, 0, 0);
    assumedHours = 8;
  } else if (period === "weekly") {
    const dayNr = (now.getDay() + 6) % 7; // lundi = 0
    since = new Date(now);
    since.setDate(now.getDate() - dayNr);
    since.setHours(0, 0, 0, 0);
    assumedHours = 40;
  } else {
    since = new Date(now.getFullYear(), now.getMonth(), 1);
    assumedHours = 160;
  }

  const goal_eur = r2(hourlyTarget * assumedHours);
  const { net: current_eur, hours: hours_elapsed } = sumNetSince(since);

  const totalPeriodHours =
    period === "daily" ? 24 : period === "weekly" ? 24 * 7 : 24 * new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsedRealMs = now.getTime() - since.getTime();
  const elapsedRealHours = Math.max(0.5, elapsedRealMs / 3_600_000);
  const fractionElapsed = Math.min(1, elapsedRealHours / totalPeriodHours);

  const projected_final_eur = fractionElapsed > 0.02 ? r2(current_eur / fractionElapsed) : current_eur;
  const progress_pct = goal_eur > 0 ? Math.round((current_eur / goal_eur) * 100) : 0;
  const on_track = projected_final_eur >= goal_eur * 0.9;

  const periodLabel = period === "daily" ? "aujourd'hui" : period === "weekly" ? "cette semaine" : "ce mois-ci";
  let message_fr: string;
  if (progress_pct >= 100) {
    message_fr = `Objectif ${periodLabel} atteint ! ${current_eur}€ sur ${goal_eur}€ visés.`;
  } else if (on_track) {
    message_fr = `Vous êtes sur la bonne voie pour ${periodLabel} — projection : ${projected_final_eur}€ pour un objectif de ${goal_eur}€.`;
  } else {
    const missing = r2(Math.max(0, goal_eur - projected_final_eur));
    message_fr = `Rythme actuel un peu en dessous de l'objectif ${periodLabel} — il manquerait environ ${missing}€ au rythme actuel (objectif : ${goal_eur}€).`;
  }

  return {
    period,
    goal_eur,
    current_eur,
    progress_pct: Math.max(0, Math.min(999, progress_pct)),
    hours_elapsed,
    projected_final_eur,
    on_track,
    message_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Hook — à appeler périodiquement (ou post-ride) pour évaluer les achievements
// financiers (15.3), délégués au catalogue étendu de wowEngine.ts.
// ═════════════════════════════════════════════════════════════════════════════

export function refreshEconAchievements(userId: string = DEFAULT_USER_ID): void {
  try {
    const now = parisNow();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const { net: monthlyNet } = sumNetSince(monthStart);

    // Jours consécutifs au-dessus du seuil de rentabilité (30 derniers jours, approx via rides quotidiens)
    let consecutiveBreakEvenDays = 0;
    try {
      const breakEven = economicsEngine.computeBreakEven();
      const cutoff = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const rides = storage.getRidesInRange(cutoff, new Date(Date.now() + 60_000).toISOString()) as any[];
      const byDay: Record<string, { net: number; min: number }> = {};
      for (const r of rides) {
        const d = (r.timestamp ?? "").slice(0, 10);
        if (!d) continue;
        byDay[d] ??= { net: 0, min: 0 };
        byDay[d].net += r.net_profit ?? 0;
        byDay[d].min += r.duration_min ?? 0;
      }
      const days = Object.keys(byDay).sort();
      let streak = 0;
      for (const d of days) {
        const hrs = byDay[d].min / 60;
        const hourly = hrs > 0.05 ? byDay[d].net / hrs : 0;
        if (hourly >= breakEven.min_hourly_to_profit) streak += 1;
        else streak = 0;
      }
      consecutiveBreakEvenDays = streak;
    } catch {
      consecutiveBreakEvenDays = 0;
    }

    // Grosses courses = marge nette >= 15€ (seuil simple, cohérent avec les autres heuristiques du projet)
    let bigRidesCount = 0;
    try {
      const row = sqlite.prepare("SELECT COUNT(*) as n FROM rides WHERE net_profit >= 15").get() as any;
      bigRidesCount = row?.n ?? 0;
    } catch {
      bigRidesCount = 0;
    }

    wowEngine.checkEconAchievements(
      { monthlyNetEur: monthlyNet, consecutiveBreakEvenDays, bigRidesCount },
      userId
    );
  } catch {
    /* défensif — jamais bloquant */
  }
}
