/**
 * wowEngine.ts — Couche « Wow Factor » + Rétention + Brief vocal (rapport.md §11, §12, §15)
 * ─────────────────────────────────────────────────────────────────────────────
 * Regroupe toutes les mécaniques non-monétaires de rétention et les features
 * "contre-intuitives" listées dans rapport.md section 15 :
 *   1. Streaks quotidiens (avec freeze tokens, jamais culpabilisant)
 *   2. Quêtes hebdomadaires non-monétaires (badges uniquement)
 *   3. Records personnels + détection auto post-ride
 *   4. Alerte "vous êtes sur le point de battre votre record"
 *   5. Silence radio recommandé ("restez ici N minutes")
 *   6. Refus de course intelligent
 *   7. Détection d'auto-sabotage économique
 *   8. Simulation rétrospective "et si vous aviez suivi l'IA hier"
 *   9. Brief vocal matinal (template déterministe, zéro appel LLM)
 *  10. Résumé de shift narratif
 *  11. Achievements / easter eggs métier
 *
 * Toutes les tables sont créées ici (CREATE TABLE IF NOT EXISTS) et réutilisent
 * la connexion sqlite exportée par storage.ts — aucune nouvelle dépendance npm.
 * Gamification 100% désactivable (colonne driver_profile.gamification_enabled,
 * lue côté client — voir ProfilePage) : cette couche ne bloque jamais un
 * chauffeur qui désactive la fonctionnalité, elle continue simplement à
 * tourner en silence côté serveur (aucun impact revenu réel).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sqlite, storage } from "./storage";
import { getCachedWeather } from "./weatherService";

// Identifiant chauffeur unique par défaut — l'app est mono-utilisateur
// (auth root/12345678, cf CONTEXTE_PROJET.md). On garde un user_id fixe pour
// permettre une extension multi-chauffeur future sans migration de schéma.
const DEFAULT_USER_ID = "driver_default";

// Migration additive : toggle RGPD "Désactiver gamification" (driver_profile).
// SQLite ne supporte pas ADD COLUMN IF NOT EXISTS → try/catch, motif déjà utilisé ailleurs dans storage.ts.
try { sqlite.exec("ALTER TABLE driver_profile ADD COLUMN gamification_enabled INTEGER DEFAULT 1"); } catch { /* colonne déjà présente */ }

/** Bascule le toggle RGPD « Désactiver gamification » (100% facultatif, jamais bloquant). */
export function setGamificationEnabled(enabled: boolean): void {
  sqlite.prepare("UPDATE driver_profile SET gamification_enabled=? WHERE id=(SELECT id FROM driver_profile LIMIT 1)").run(enabled ? 1 : 0);
}

// ─── Schéma DB ──────────────────────────────────────────────────────────────

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS streaks (
    user_id TEXT PRIMARY KEY,
    current_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    last_active_date TEXT,
    freeze_tokens INTEGER NOT NULL DEFAULT 2
  );

  CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    quest_key TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_value REAL NOT NULL,
    current_value REAL NOT NULL DEFAULT 0,
    week_iso TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(user_id, quest_key, week_iso)
  );

  CREATE TABLE IF NOT EXISTS personal_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    date_achieved TEXT NOT NULL,
    UNIQUE(user_id, metric)
  );

  CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    achievement_key TEXT NOT NULL,
    label_fr TEXT NOT NULL,
    description_fr TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🏆',
    unlocked_at TEXT NOT NULL,
    UNIQUE(user_id, achievement_key)
  );

  -- Trace des recommandations Focus émises, pour la simulation "et si vous aviez suivi l'IA"
  CREATE TABLE IF NOT EXISTS reco_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date_iso TEXT NOT NULL,
    verb TEXT NOT NULL,
    zone_name TEXT,
    expected_gain_euros REAL,
    was_followed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- Journal des heures d'activité (pour le calcul de streak >= 1h/jour)
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date_iso TEXT NOT NULL,
    minutes_active REAL NOT NULL DEFAULT 0,
    UNIQUE(user_id, date_iso)
  );
`);

// ─── Helpers dates ──────────────────────────────────────────────────────────

function parisNow(): Date {
  // Cohérent avec le reste du backend (storage.ts / focusEngine.ts) : UTC+2 approx.
  return new Date();
}

function dateIso(d: Date = parisNow()): string {
  return d.toISOString().slice(0, 10);
}

function yesterdayIso(): string {
  const d = parisNow();
  d.setDate(d.getDate() - 1);
  return dateIso(d);
}

/** Numéro de semaine ISO au format "2026-W27". */
function weekIso(d: Date = parisNow()): string {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target.getTime() - firstThursday.getTime();
  const week = 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));
  return `${target.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function frDayName(d: Date = parisNow()): string {
  return ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"][d.getDay()];
}

// ══════════════════════════════════════════════════════════════════════════
// 1. STREAKS QUOTIDIENS
// ══════════════════════════════════════════════════════════════════════════

function getOrCreateStreak(userId: string = DEFAULT_USER_ID): any {
  let row = sqlite.prepare("SELECT * FROM streaks WHERE user_id=?").get(userId) as any;
  if (!row) {
    sqlite.prepare(
      "INSERT INTO streaks (user_id, current_streak, best_streak, last_active_date, freeze_tokens) VALUES (?,0,0,NULL,2)"
    ).run(userId);
    row = sqlite.prepare("SELECT * FROM streaks WHERE user_id=?").get(userId) as any;
  }
  return row;
}

/** Enregistre de l'activité (appelé à chaque course complétée) — cumule les minutes du jour. */
export function logActivityMinutes(minutes: number, userId: string = DEFAULT_USER_ID): void {
  const today = dateIso();
  const existing = sqlite.prepare("SELECT * FROM activity_log WHERE user_id=? AND date_iso=?").get(userId, today) as any;
  if (existing) {
    sqlite.prepare("UPDATE activity_log SET minutes_active = minutes_active + ? WHERE user_id=? AND date_iso=?")
      .run(minutes, userId, today);
  } else {
    sqlite.prepare("INSERT INTO activity_log (user_id, date_iso, minutes_active) VALUES (?,?,?)")
      .run(userId, today, minutes);
  }
}

/**
 * Cron 3h du matin : évalue la journée d'hier.
 * - Si >= 60 minutes d'activité hier → incrémente le streak.
 * - Sinon, si un freeze_token est disponible → le consomme, streak préservé (pas de culpabilisation).
 * - Sinon → reset à 0 (le message côté client reste neutre, jamais punitif).
 */
export function runStreakCron(userId: string = DEFAULT_USER_ID): void {
  const streak = getOrCreateStreak(userId);
  const y = yesterdayIso();
  const yLog = sqlite.prepare("SELECT minutes_active FROM activity_log WHERE user_id=? AND date_iso=?").get(userId, y) as any;
  const minutesYesterday = yLog?.minutes_active ?? 0;

  // Déjà traité pour cette date (évite double incrément si le cron tourne 2x)
  if (streak.last_active_date === y) return;

  let newCurrent = streak.current_streak;
  let newFreeze = streak.freeze_tokens;

  if (minutesYesterday >= 60) {
    newCurrent = streak.current_streak + 1;
  } else if (newFreeze > 0) {
    // Gel de streak — préserve la série sans culpabiliser (rapport.md §11.1 piège Duolingo)
    newFreeze -= 1;
  } else {
    newCurrent = 0;
  }

  const newBest = Math.max(streak.best_streak, newCurrent);
  sqlite.prepare(
    "UPDATE streaks SET current_streak=?, best_streak=?, last_active_date=?, freeze_tokens=? WHERE user_id=?"
  ).run(newCurrent, newBest, y, newFreeze, userId);
}

const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 365];

export function getStreakStatus(userId: string = DEFAULT_USER_ID) {
  const s = getOrCreateStreak(userId);
  const next = STREAK_MILESTONES.find((m) => m > s.current_streak) ?? null;
  return {
    current: s.current_streak,
    best: s.best_streak,
    next_milestone: next,
    freeze_available: s.freeze_tokens,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 2. QUÊTES HEBDOMADAIRES NON-MONÉTAIRES
// ══════════════════════════════════════════════════════════════════════════

const QUEST_POOL: { key: string; target_type: string; target_value: number; label_fr: string; badge_icon: string }[] = [
  { key: "rides_in_zone",     target_type: "rides_in_recommended_zone", target_value: 5, label_fr: "Faire 5 courses en zone recommandée", badge_icon: "🎯" },
  { key: "focus_mode_5x",     target_type: "focus_mode_used",           target_value: 5, label_fr: "Utiliser le mode Focus 5 fois",         badge_icon: "🧭" },
  { key: "explore_3_zones",   target_type: "new_zones_explored",        target_value: 3, label_fr: "Explorer 3 nouvelles zones",             badge_icon: "🗺️" },
  { key: "follow_3_ai_recos", target_type: "ai_recos_followed",         target_value: 3, label_fr: "Suivre 3 alternatives proposées par l'IA", badge_icon: "🤖" },
];

/** Tire 3 quêtes déterministes pour la semaine courante (seedées par semaine ISO, stables). */
function pickWeeklyQuests(week: string): typeof QUEST_POOL {
  // Hash simple déterministe de la semaine pour choisir un ordre stable (pas de Math.random pour reproductibilité)
  let seed = 0;
  for (const c of week) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const shuffled = [...QUEST_POOL].sort((a, b) => {
    const ha = (seed + a.key.length * 7) % 97;
    const hb = (seed + b.key.length * 7) % 97;
    return ha - hb;
  });
  return shuffled.slice(0, 3);
}

function ensureWeeklyQuests(userId: string = DEFAULT_USER_ID): void {
  const week = weekIso();
  const chosen = pickWeeklyQuests(week);
  for (const q of chosen) {
    const existing = sqlite.prepare(
      "SELECT id FROM quests WHERE user_id=? AND quest_key=? AND week_iso=?"
    ).get(userId, q.key, week);
    if (!existing) {
      sqlite.prepare(
        "INSERT INTO quests (user_id, quest_key, target_type, target_value, current_value, week_iso, completed_at) VALUES (?,?,?,?,0,?,NULL)"
      ).run(userId, q.key, q.target_type, q.target_value, week);
    }
  }
}

export function getWeeklyQuests(userId: string = DEFAULT_USER_ID) {
  ensureWeeklyQuests(userId);
  const week = weekIso();
  const rows = sqlite.prepare(
    "SELECT * FROM quests WHERE user_id=? AND week_iso=? ORDER BY id ASC"
  ).all(userId, week) as any[];
  return rows.map((r) => {
    const meta = QUEST_POOL.find((q) => q.key === r.quest_key);
    return {
      quest_key: r.quest_key,
      label_fr: meta?.label_fr ?? r.quest_key,
      badge_icon: meta?.badge_icon ?? "🏅",
      target_value: r.target_value,
      current_value: r.current_value,
      progress_pct: Math.min(100, Math.round((r.current_value / r.target_value) * 100)),
      completed: !!r.completed_at,
      week_iso: r.week_iso,
    };
  });
}

/** Incrémente la progression d'une quête (appelable depuis d'autres modules, ex: rides/complete). */
export function progressQuest(questKey: string, delta = 1, userId: string = DEFAULT_USER_ID): any {
  ensureWeeklyQuests(userId);
  const week = weekIso();
  const row = sqlite.prepare(
    "SELECT * FROM quests WHERE user_id=? AND quest_key=? AND week_iso=?"
  ).get(userId, questKey, week) as any;
  if (!row) return null;
  if (row.completed_at) return row; // déjà complétée cette semaine

  const newValue = Math.min(row.target_value, row.current_value + delta);
  const justCompleted = newValue >= row.target_value;
  sqlite.prepare(
    "UPDATE quests SET current_value=?, completed_at=? WHERE id=?"
  ).run(newValue, justCompleted ? new Date().toISOString() : null, row.id);

  if (justCompleted) {
    unlockAchievement(
      `quest_${questKey}_${week}`,
      "Quête accomplie",
      `Quête hebdomadaire complétée : ${QUEST_POOL.find((q) => q.key === questKey)?.label_fr ?? questKey}`,
      "🏅",
      userId
    );
  }
  return sqlite.prepare("SELECT * FROM quests WHERE id=?").get(row.id);
}

// ══════════════════════════════════════════════════════════════════════════
// 3. RECORDS PERSONNELS
// ══════════════════════════════════════════════════════════════════════════

export type RecordMetric = "best_daily_net" | "best_hourly" | "longest_streak" | "most_rides_shift" | "fastest_first_ride";

const RECORD_LABELS: Record<RecordMetric, string> = {
  best_daily_net: "Meilleur revenu net journalier",
  best_hourly: "Meilleur taux horaire",
  longest_streak: "Plus longue série de jours actifs",
  most_rides_shift: "Plus de courses en un shift",
  fastest_first_ride: "Première course la plus rapide",
};

function getRecord(metric: RecordMetric, userId: string = DEFAULT_USER_ID): any {
  return sqlite.prepare("SELECT * FROM personal_records WHERE user_id=? AND metric=?").get(userId, metric);
}

/** Compare une nouvelle valeur au record existant ; met à jour si battu. Retourne { beaten, previous, value }. */
export function checkAndUpdateRecord(metric: RecordMetric, value: number, userId: string = DEFAULT_USER_ID): { beaten: boolean; previous: number | null; value: number } {
  const existing = getRecord(metric, userId);
  const today = dateIso();
  if (!existing) {
    sqlite.prepare(
      "INSERT INTO personal_records (user_id, metric, value, date_achieved) VALUES (?,?,?,?)"
    ).run(userId, metric, value, today);
    return { beaten: true, previous: null, value };
  }
  if (value > existing.value) {
    sqlite.prepare(
      "UPDATE personal_records SET value=?, date_achieved=? WHERE user_id=? AND metric=?"
    ).run(value, today, userId, metric);
    unlockAchievement(
      `record_${metric}_${today}`,
      "Nouveau record personnel !",
      `${RECORD_LABELS[metric]} : ${value}`,
      "🏆",
      userId
    );
    return { beaten: true, previous: existing.value, value };
  }
  return { beaten: false, previous: existing.value, value };
}

export function getAllRecords(userId: string = DEFAULT_USER_ID) {
  const rows = sqlite.prepare("SELECT * FROM personal_records WHERE user_id=?").all(userId) as any[];
  return rows.map((r) => ({
    metric: r.metric,
    label_fr: RECORD_LABELS[r.metric as RecordMetric] ?? r.metric,
    value: r.value,
    date_achieved: r.date_achieved,
  }));
}

/** Retourne la progression du jour vers le record en % (utilisé pour l'événement "près du record"). */
export function nearRecordPct(metric: RecordMetric, currentValue: number, userId: string = DEFAULT_USER_ID): number {
  const rec = getRecord(metric, userId);
  if (!rec || rec.value <= 0) return 0;
  return Math.round((currentValue / rec.value) * 100);
}

// ══════════════════════════════════════════════════════════════════════════
// 4. ALERTE "VOUS ÊTES SUR LE POINT DE BATTRE VOTRE RECORD"
// ══════════════════════════════════════════════════════════════════════════

/**
 * À appeler après chaque course complétée. Si le net du jour atteint >= 90%
 * du record ET qu'il reste >= 1h dans la fenêtre de service estimée,
 * génère une alerte type='record_hunt' priority='medium' (persistée via storage.createAlert).
 */
export function maybeCreateRecordHuntAlert(dailyNetSoFar: number, hoursRemaining: number, userId: string = DEFAULT_USER_ID): any | null {
  const rec = getRecord("best_daily_net", userId);
  if (!rec || rec.value <= 0) return null;
  if (hoursRemaining < 1) return null;
  const pct = dailyNetSoFar / rec.value;
  if (pct < 0.9) return null;

  const missing = Math.max(0, Math.round((rec.value - dailyNetSoFar) * 100) / 100);
  const alert = storage.createAlert({
    type: "record_hunt",
    title: "Vous êtes sur le point de battre votre record !",
    message: missing > 0
      ? `Plus que ${missing}€ pour dépasser votre record de revenu journalier (${rec.value}€). Vous y êtes presque !`
      : `Record déjà égalé ou dépassé aujourd'hui — bravo !`,
    zoneId: null,
    priority: "medium",
    estimatedRevenue: missing,
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return alert;
}

// ══════════════════════════════════════════════════════════════════════════
// 5. SILENCE RADIO RECOMMANDÉ ("Attendez ici N minutes")
// ══════════════════════════════════════════════════════════════════════════

/**
 * Analyse un pattern historique simplifié (score de rentabilité horaire déjà
 * calculé par storage.ts) + un léger boost communautaire pour déterminer si
 * rester immobile est préférable à bouger. Réutilise getProfitability existant.
 */
export function getWaitHereRecommendation(zoneId: string, hour: number) {
  let demandScore = 50;
  let supplyScore = 50;
  try {
    const dayType = [0, 6].includes(new Date().getDay()) ? "weekend" : "weekday";
    const rows = sqlite.prepare(
      "SELECT demand_score, supply_score, profitability_index FROM profitability_scores WHERE zone_id=? AND hour=? AND day_type=?"
    ).get(zoneId, hour, dayType) as any;
    if (rows) {
      demandScore = rows.demand_score;
      supplyScore = rows.supply_score;
    }
  } catch {
    // valeurs neutres par défaut
  }

  // Communauté : signal actif proche = plus de confiance dans le "reste ici"
  let communityBoost = 0;
  try {
    const impactMap = storage.getCommunityImpact(zoneId) as Map<string, { positive: number; negative: number; boost_pct: number }>;
    const impact = impactMap?.get?.(zoneId);
    communityBoost = impact ? Math.min(0.15, Math.max(0, impact.boost_pct) * 0.01) : 0;
  } catch {
    communityBoost = 0;
  }

  // Ratio demande/offre élevé + faible volatilité horaire → rester est optimal.
  const ratio = supplyScore > 0 ? demandScore / supplyScore : 1;
  const shouldWait = ratio >= 1.15 || communityBoost >= 0.09;

  const waitMinutes = shouldWait ? Math.min(8, Math.max(3, Math.round(ratio * 3))) : 0;
  const confidence = Math.min(0.95, 0.5 + (ratio - 1) * 0.3 + communityBoost);

  const reason = shouldWait
    ? `La demande dépasse l'offre dans cette zone en ce moment (ratio ${ratio.toFixed(2)}) — bouger risquerait de vous faire rater la prochaine course qui arrive ici.`
    : `Aucun signal fort ne justifie de rester immobile — vous pouvez vous positionner librement.`;

  return {
    should_wait: shouldWait,
    wait_minutes: waitMinutes,
    reason_fr: reason,
    confidence: Math.round(confidence * 100) / 100,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 6. REFUS DE COURSE INTELLIGENT
// ══════════════════════════════════════════════════════════════════════════

export function evaluateShouldRefuse(input: { fare: number; distance: number; duration: number; dropoff_zone: string }) {
  const { fare, distance, duration } = input;
  const perKm = distance > 0 ? fare / distance : fare;
  const perMin = duration > 0 ? fare / duration : fare;

  // Recherche du score de rentabilité de la zone de dépose à l'heure actuelle —
  // une dépose en zone "morte" (faible demand_score) implique un retour à vide coûteux.
  let dropoffDemand = 50;
  let dropoffName = input.dropoff_zone;
  try {
    const zone = sqlite.prepare("SELECT id, name FROM zones WHERE id=? OR name=?").get(input.dropoff_zone, input.dropoff_zone) as any;
    if (zone) {
      dropoffName = zone.name;
      const hour = new Date().getHours();
      const dayType = [0, 6].includes(new Date().getDay()) ? "weekend" : "weekday";
      const row = sqlite.prepare(
        "SELECT demand_score FROM profitability_scores WHERE zone_id=? AND hour=? AND day_type=?"
      ).get(zone.id, hour, dayType) as any;
      if (row) dropoffDemand = row.demand_score;
    }
  } catch {
    // zone inconnue → score neutre
  }

  const lowFarePerKm = perKm < 1.0;
  const lowFarePerMin = perMin < 0.35;
  const deadDropoff = dropoffDemand < 30;

  const refuse = deadDropoff && (lowFarePerKm || lowFarePerMin);
  const estimatedHourlyLoss = refuse ? Math.round((0.35 - perMin) * 60 * 10) / 10 : 0;

  const hiddenCost = refuse
    ? `Dépose en zone à faible demande (${dropoffName}) — retour à vide probable. Perte estimée : ${Math.max(5, estimatedHourlyLoss)}€/h pendant le repositionnement.`
    : `Course cohérente avec votre seuil de rentabilité — pas de piège détecté.`;

  const alternativeZone = refuse
    ? "Privilégiez une course qui vous rapproche d'une zone chaude plutôt que celle-ci."
    : "";

  const confidence = deadDropoff ? 0.8 : 0.55;

  return {
    refuse,
    hidden_cost_fr: hiddenCost,
    alternative_zone_fr: alternativeZone,
    confidence,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 7. DÉTECTION AUTO-SABOTAGE ÉCONOMIQUE
// ══════════════════════════════════════════════════════════════════════════

/**
 * Analyse les 30 derniers jours de courses pour repérer un pattern récurrent
 * de fin de session prématurée (ex : dernière course systématiquement avant
 * 20h le vendredi alors que la demande pique à 20h30).
 * Confrontation bienveillante, jamais punitive (rapport.md §15.11).
 */
export function detectSelfSabotage(userId: string = DEFAULT_USER_ID) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let rides: any[] = [];
  try {
    rides = sqlite.prepare(
      "SELECT timestamp, net_profit FROM rides WHERE timestamp >= ? ORDER BY timestamp ASC"
    ).all(cutoff) as any[];
  } catch {
    rides = [];
  }

  if (rides.length < 8) {
    return { detected: false, message_fr: null, estimated_monthly_loss_eur: 0 };
  }

  // Groupe par jour de la semaine → heure de dernière course du jour
  const lastRideHourByDow: Record<number, number[]> = {};
  const byDay: Record<string, any[]> = {};
  for (const r of rides) {
    const day = r.timestamp.slice(0, 10);
    (byDay[day] ??= []).push(r);
  }
  for (const [day, dayRides] of Object.entries(byDay)) {
    const d = new Date(day);
    const dow = d.getDay();
    const lastRide = dayRides[dayRides.length - 1];
    const hour = new Date(lastRide.timestamp).getHours() + new Date(lastRide.timestamp).getMinutes() / 60;
    (lastRideHourByDow[dow] ??= []).push(hour);
  }

  // Vendredi = 5. On vérifie si la dernière course du vendredi est systématiquement avant 20h.
  const fridayHours = lastRideHourByDow[5] ?? [];
  const earlyFridayCount = fridayHours.filter((h) => h < 20).length;

  if (fridayHours.length >= 2 && earlyFridayCount / fridayHours.length >= 0.6) {
    // Estimation grossière du manque à gagner : demande pique généralement +25% entre 20h et 22h30
    const avgNet = rides.reduce((s, r) => s + (r.net_profit ?? 0), 0) / rides.length;
    const estimatedLossPerFriday = Math.round(avgNet * 2 * 0.25 * 10) / 10; // ~2 courses manquées à +25%
    const weeksObserved = Math.max(1, Math.round(fridayHours.length));
    const monthlyLoss = Math.round(estimatedLossPerFriday * (4.3) * 10) / 10;

    return {
      detected: true,
      message_fr: `Vous rentrez souvent trop tôt (avant 20h les vendredi) — la demande pique généralement vers 20h30 dans votre secteur. Manque à gagner estimé : ${monthlyLoss}€/mois. C'est votre choix, mais voici l'information pour décider en connaissance de cause.`,
      estimated_monthly_loss_eur: monthlyLoss,
    };
  }

  return { detected: false, message_fr: null, estimated_monthly_loss_eur: 0 };
}

// ══════════════════════════════════════════════════════════════════════════
// 8. SIMULATION RÉTROSPECTIVE "ET SI VOUS AVIEZ SUIVI L'IA HIER"
// ══════════════════════════════════════════════════════════════════════════

/** Enregistre une recommandation émise pour permettre la comparaison a posteriori. */
export function trackRecommendation(verb: string, zoneName: string | null, expectedGainEuros: number | null, wasFollowed: boolean, userId: string = DEFAULT_USER_ID): void {
  sqlite.prepare(
    "INSERT INTO reco_tracking (user_id, date_iso, verb, zone_name, expected_gain_euros, was_followed, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(userId, dateIso(), verb, zoneName, expectedGainEuros, wasFollowed ? 1 : 0, new Date().toISOString());
}

export function getWhatIfYesterday(userId: string = DEFAULT_USER_ID) {
  const y = yesterdayIso();
  let rides: any[] = [];
  try {
    rides = sqlite.prepare(
      "SELECT net_profit FROM rides WHERE timestamp LIKE ?"
    ).all(`${y}%`) as any[];
  } catch {
    rides = [];
  }
  const realNet = Math.round(rides.reduce((s, r) => s + (r.net_profit ?? 0), 0) * 100) / 100;

  const recos = sqlite.prepare(
    "SELECT * FROM reco_tracking WHERE user_id=? AND date_iso=? ORDER BY created_at ASC"
  ).all(userId, y) as any[];

  if (recos.length === 0) {
    return {
      real_net: realNet,
      ai_projected_net: realNet,
      delta: 0,
      top_missed_reco: null,
      has_data: false,
    };
  }

  const missedRecos = recos.filter((r) => !r.was_followed && (r.expected_gain_euros ?? 0) > 0);
  const missedGain = missedRecos.reduce((s, r) => s + (r.expected_gain_euros ?? 0), 0);
  const aiProjectedNet = Math.round((realNet + missedGain) * 100) / 100;
  const topMissed = missedRecos.sort((a, b) => (b.expected_gain_euros ?? 0) - (a.expected_gain_euros ?? 0))[0];

  return {
    real_net: realNet,
    ai_projected_net: aiProjectedNet,
    delta: Math.round((aiProjectedNet - realNet) * 100) / 100,
    top_missed_reco: topMissed
      ? { verb: topMissed.verb, zone_name: topMissed.zone_name, expected_gain_euros: topMissed.expected_gain_euros }
      : null,
    has_data: true,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 9. BRIEF VOCAL MATINAL — génération déterministe (template + variables)
// ══════════════════════════════════════════════════════════════════════════

function frWeatherPhrase(): string {
  const w = getCachedWeather();
  if (!w) return "la météo est stable aujourd'hui";
  if (w.demand_boost >= 0.2) return `${w.description.toLowerCase()} est prévu — cela booste généralement la demande de ${Math.round(w.demand_boost * 100)}%`;
  if (w.demand_boost > 0) return `${w.description.toLowerCase()} pourrait légèrement augmenter la demande`;
  return `${w.description.toLowerCase()} aujourd'hui, sans effet particulier sur la demande`;
}

export function getMorningBrief(userId: string = DEFAULT_USER_ID) {
  const now = parisNow();
  const day = frDayName(now);

  // Événements actifs / à venir aujourd'hui
  let events: any[] = [];
  try {
    events = (storage.getActiveEvents() as any[]).filter((e) => {
      const start = new Date(e.start_time);
      return start.toDateString() === now.toDateString();
    });
  } catch {
    events = [];
  }
  const eventPhrase = events.length > 0
    ? `Aujourd'hui, ${events.slice(0, 2).map((e) => `${e.name} (${e.zone_id.replace("z_", "").replace(/_/g, " ")})`).join(" et ")} — attendez-vous à un pic de demande localisé.`
    : "Pas d'événement majeur signalé aujourd'hui.";

  // Zones chaudes du moment (top-zones déjà calculé par storage)
  let topZonesPhrase = "";
  try {
    const hour = now.getHours();
    const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";
    const top = storage.getTopZones(hour, dayType, 3) ?? [];
    if (Array.isArray(top) && top.length > 0) {
      const names = top.slice(0, 2).map((z: any) => z.name ?? z.zone_id).filter(Boolean);
      if (names.length > 0) topZonesPhrase = `Les zones les plus prometteuses sont ${names.join(" et ")}.`;
    }
  } catch {
    topZonesPhrase = "";
  }

  const streak = getStreakStatus(userId);
  const streakPhrase = streak.current > 0
    ? `Vous en êtes à ${streak.current} jour${streak.current > 1 ? "s" : ""} de série active, continuez comme ça.`
    : "";

  const weatherPhrase = frWeatherPhrase();

  const advices = [
    "Pensez à faire une pause toutes les 2 heures pour rester concentré.",
    "Gardez un œil sur votre autonomie avant de partir en zone excentrée.",
    "Une petite course vers une zone chaude vaut souvent mieux qu'une longue attente.",
    "Hydratez-vous régulièrement, surtout en cette saison.",
  ];
  const advice = advices[now.getDate() % advices.length];

  const text = [
    `Bonjour ! On est ${day}, voici votre brief du jour.`,
    `Côté météo, ${weatherPhrase}.`,
    eventPhrase,
    topZonesPhrase,
    streakPhrase,
    `Conseil du jour : ${advice}`,
    "Bonne route !",
  ].filter(Boolean).join(" ");

  // Garde-fou 150 mots max
  const words = text.split(/\s+/);
  const trimmed = words.length > 150 ? words.slice(0, 150).join(" ") + "…" : text;

  return { text: trimmed, generated_at: new Date().toISOString(), word_count: Math.min(words.length, 150) };
}

// ══════════════════════════════════════════════════════════════════════════
// 10. RÉSUMÉ DE SHIFT NARRATIF
// ══════════════════════════════════════════════════════════════════════════

export function getShiftSummary(startIso: string, endIso: string) {
  let rides: any[] = [];
  try {
    rides = sqlite.prepare(
      "SELECT * FROM rides WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC"
    ).all(startIso, endIso) as any[];
  } catch {
    rides = [];
  }

  if (rides.length === 0) {
    return { text: "Aucune course enregistrée sur cette période — à bientôt sur la route !" };
  }

  const totalNet = Math.round(rides.reduce((s, r) => s + (r.net_profit ?? 0), 0) * 100) / 100;
  const totalRides = rides.length;

  // Pic horaire : zone/heure avec le net_profit cumulé le plus élevé
  const byHourZone: Record<string, number> = {};
  for (const r of rides) {
    const h = new Date(r.timestamp).getHours();
    const key = `${h}h|${r.pickup_zone_id}`;
    byHourZone[key] = (byHourZone[key] ?? 0) + (r.net_profit ?? 0);
  }
  const peakEntry = Object.entries(byHourZone).sort((a, b) => b[1] - a[1])[0];
  let peakPhrase = "";
  if (peakEntry) {
    const [key] = peakEntry;
    const [hour, zoneId] = key.split("|");
    let zoneName = zoneId;
    try {
      const z = sqlite.prepare("SELECT name FROM zones WHERE id=?").get(zoneId) as any;
      if (z) zoneName = z.name;
    } catch { /* zone inconnue */ }
    peakPhrase = `, avec un pic à ${hour} à ${zoneName}`;
  }

  // Comparaison à la moyenne historique par course
  let avgHistorical = 0;
  try {
    const row = sqlite.prepare("SELECT AVG(net_profit) as avg FROM rides").get() as any;
    avgHistorical = row?.avg ?? 0;
  } catch {
    avgHistorical = 0;
  }
  const avgToday = totalNet / totalRides;
  const deltaPct = avgHistorical > 0 ? Math.round(((avgToday - avgHistorical) / avgHistorical) * 100) : 0;
  const comparisonPhrase = avgHistorical > 0
    ? deltaPct >= 0
      ? ` Vous avez fait mieux que votre moyenne (+${deltaPct}%).`
      : ` Un peu en dessous de votre moyenne habituelle (${deltaPct}%) — chaque jour est différent.`
    : "";

  const qualifier = totalNet >= 100 ? "Belle journée" : totalNet >= 50 ? "Bonne journée" : "Journée tranquille";

  const text = `${qualifier} ! ${totalRides} course${totalRides > 1 ? "s" : ""}, ${totalNet}€ net${peakPhrase}.${comparisonPhrase}`;

  return { text, total_net: totalNet, total_rides: totalRides };
}

// ══════════════════════════════════════════════════════════════════════════
// 11. EASTER EGGS MÉTIER / ACHIEVEMENTS
// ══════════════════════════════════════════════════════════════════════════

export function unlockAchievement(key: string, label: string, description: string, icon = "🏆", userId: string = DEFAULT_USER_ID): boolean {
  const existing = sqlite.prepare("SELECT id FROM achievements WHERE user_id=? AND achievement_key=?").get(userId, key);
  if (existing) return false;
  sqlite.prepare(
    "INSERT INTO achievements (user_id, achievement_key, label_fr, description_fr, icon, unlocked_at) VALUES (?,?,?,?,?,?)"
  ).run(userId, key, label, description, icon, new Date().toISOString());
  return true;
}

// Achievements "catalogue" — inclut les verrouillés pour affichage en silhouette côté client.
const ACHIEVEMENT_CATALOG: { key: string; label_fr: string; description_fr: string; icon: string }[] = [
  { key: "km_10000",        label_fr: "10 000 km parcourus",        description_fr: "Vous avez parcouru 10 000 km avec l'app.",        icon: "🚗" },
  { key: "rides_100",       label_fr: "100 courses",                description_fr: "100 courses complétées, une belle régularité.",   icon: "💯" },
  { key: "rides_1000",      label_fr: "1000 courses",                description_fr: "1000 courses complétées — un vrai vétéran.",      icon: "🎖️" },
  { key: "bastille_day",    label_fr: "14 juillet",                  description_fr: "Une course pendant le feu d'artifice du 14 juillet.", icon: "🎆" },
  { key: "christmas",       label_fr: "Noël au volant",              description_fr: "Une course le jour de Noël.",                     icon: "🎄" },
  { key: "new_year",        label_fr: "Nouvel An",                   description_fr: "Une course au Nouvel An.",                        icon: "🎉" },
  { key: "first_community", label_fr: "Premier signalement accepté", description_fr: "Votre premier signalement communautaire a été validé.", icon: "🤝" },
];

/** Détection auto d'easter eggs métier — à appeler post-ride. */
export function checkEasterEggs(totalKm: number, totalRides: number, rideTimestamp: string, userId: string = DEFAULT_USER_ID): void {
  if (totalKm >= 10000) unlockAchievement("km_10000", "10 000 km parcourus", "Vous avez parcouru 10 000 km avec l'app.", "🚗", userId);
  if (totalRides >= 100) unlockAchievement("rides_100", "100 courses", "100 courses complétées, une belle régularité.", "💯", userId);
  if (totalRides >= 1000) unlockAchievement("rides_1000", "1000 courses", "1000 courses complétées — un vrai vétéran.", "🎖️", userId);

  const d = new Date(rideTimestamp);
  const md = `${d.getMonth() + 1}-${d.getDate()}`;
  if (md === "7-14") unlockAchievement("bastille_day", "14 juillet", "Une course pendant le feu d'artifice du 14 juillet.", "🎆", userId);
  if (md === "12-25") unlockAchievement("christmas", "Noël au volant", "Une course le jour de Noël.", "🎄", userId);
  if (md === "1-1") unlockAchievement("new_year", "Nouvel An", "Une course au Nouvel An.", "🎉", userId);
}

export function unlockFirstCommunitySignalAchievement(userId: string = DEFAULT_USER_ID): void {
  unlockAchievement("first_community", "Premier signalement accepté", "Votre premier signalement communautaire a été validé.", "🤝", userId);
}

export function getAchievements(userId: string = DEFAULT_USER_ID) {
  const unlocked = sqlite.prepare("SELECT * FROM achievements WHERE user_id=?").all(userId) as any[];
  const unlockedKeys = new Set(unlocked.map((a) => a.achievement_key));
  return ACHIEVEMENT_CATALOG.map((a) => {
    const found = unlocked.find((u) => u.achievement_key === a.key);
    return {
      key: a.key,
      label_fr: a.label_fr,
      description_fr: a.description_fr,
      icon: a.icon,
      unlocked: unlockedKeys.has(a.key),
      unlocked_at: found?.unlocked_at ?? null,
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Hook principal post-ride — à appeler depuis routes.ts /api/rides/complete
// ══════════════════════════════════════════════════════════════════════════

export function onRideCompleted(params: {
  netProfit: number;
  hourlyRate: number;
  durationMin: number;
  totalKmDriven: number;
  totalRides: number;
  timestamp: string;
}, userId: string = DEFAULT_USER_ID) {
  logActivityMinutes(params.durationMin, userId);

  // Records auto
  const dailyRow = sqlite.prepare(
    "SELECT COALESCE(SUM(net_profit),0) as net, COUNT(*) as n FROM rides WHERE timestamp LIKE ?"
  ).get(`${dateIso()}%`) as any;
  const dailyNet = dailyRow?.net ?? 0;
  const dailyRides = dailyRow?.n ?? 0;

  checkAndUpdateRecord("best_daily_net", dailyNet, userId);
  checkAndUpdateRecord("best_hourly", params.hourlyRate, userId);
  checkAndUpdateRecord("most_rides_shift", dailyRides, userId);

  checkEasterEggs(params.totalKmDriven, params.totalRides, params.timestamp, userId);

  // Alerte "près du record" — on suppose ~2h restantes par défaut si non renseigné ailleurs.
  maybeCreateRecordHuntAlert(dailyNet, 2, userId);

  return { dailyNet, dailyRides };
}
