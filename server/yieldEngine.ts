/**
 * yieldEngine.ts — Couche Yield Management (rapport.md §1 Optimisation économique fine
 * + §2 Yield management personnalisé)
 * ─────────────────────────────────────────────────────────────────────────────
 * Fonctions pures de calcul, appelées depuis routes.ts. Réutilise autant que possible
 * les fonctions déjà existantes dans economicsEngine.ts (computeEndShift,
 * computePlatformKpiComparison, computeWhichNow) plutôt que de dupliquer la logique.
 *
 * Leviers couverts :
 *   1.1  Arbitrage plateforme temps réel multi-critères  → computeOptimalPlatformMix
 *   1.2  Dead-mileage tracker                             → recordDeadMileage / getDeadMileageSummary
 *   1.5  Projection fin de journée live                   → computeDayProjection
 *   1.6  Alerte value/minute décroissante                 → computeMarginalValue
 *   1.10 Score qualité journée                            → computeDayQualityScore
 *   2.1  Taux d'acceptation optimal                       → computeOptimalAcceptanceRate
 *   2.2  Ratio courses courtes/longues                    → computeRideMix
 *   2.3  Prix de réserve dynamique                        → computeReservePrice
 *   2.4  Détection sur-sélectivité                        → computeOverSelectiveAlert
 *   2.6  Toujours actif vs sélectif                       → computeAlwaysOnSimulator
 *
 * ZÉRO nouvelle dépendance npm — utilise better-sqlite3 déjà présent (storage.sqlite).
 * Table créée en CREATE TABLE IF NOT EXISTS, totalement additive.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sqlite, storage } from "./storage";
import * as economicsEngine from "./economicsEngine";

const r1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ─────────────────────────────────────────────────────────────────────────────
// Schéma SQLite — dead_mileage_log (Levier 1.2)
// ─────────────────────────────────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS dead_mileage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    distance_km REAL NOT NULL,
    duration_min REAL NOT NULL DEFAULT 0,
    from_zone_id TEXT,
    to_zone_id TEXT,
    reason TEXT NOT NULL DEFAULT 'repositionnement'
  );
  CREATE INDEX IF NOT EXISTS idx_dead_mileage_user_ts ON dead_mileage_log(user_id, ts);
`);

const DEFAULT_USER = "root";

// ═════════════════════════════════════════════════════════════════════════════
// 1.1 — Arbitrage plateforme en temps réel multi-critères
// ═════════════════════════════════════════════════════════════════════════════
// Commissions de référence marché (rapport.md §1.1) — utilisées comme fallback
// si le chauffeur n'a pas encore d'historique personnel sur une plateforme.
const PLATFORM_REFERENCE: Record<string, { commission_pct: number; label: string }> = {
  uber: { commission_pct: 26, label: "Uber" },
  bolt: { commission_pct: 22, label: "Bolt" },
  heetch: { commission_pct: 16, label: "Heetch" },
  freenow: { commission_pct: 21, label: "FreeNow" },
};

export interface PlatformMixEntry {
  platform: string;
  label: string;
  score: number; // 0-100
  commission_pct: number;
  boost_pct: number;
  surge_multiplier: number;
  estimated_wait_min: number;
  net_hourly_historical: number;
  recommended: boolean;
  reason_fr: string;
}

export interface OptimalMixResult {
  best_platform: string;
  entries: PlatformMixEntry[];
  computed_at: string;
}

/**
 * Combine commission (historique ou référence marché), boost/surge courant (si fourni
 * par le client depuis platformDemand.ts côté carte), et temps d'attente estimé pour
 * calculer un score composite par plateforme et recommander la meilleure MAINTENANT.
 *
 * `liveSignals` est optionnel : passé depuis le client (radar temps réel), sinon on
 * retombe sur l'historique pur (computePlatformKpiComparison / computeWhichNow).
 */
export function computeOptimalPlatformMix(
  hour: number,
  liveSignals?: Record<string, { boost_pct?: number; surge_multiplier?: number; estimated_wait_min?: number }>
): OptimalMixResult {
  const kpis = economicsEngine.computePlatformKpiComparison(30);
  const whichNow = economicsEngine.computeWhichNow(hour);
  const kpiByPlatform: Record<string, any> = {};
  kpis.forEach((k) => (kpiByPlatform[k.platform] = k));

  const platforms = Object.keys(PLATFORM_REFERENCE);
  const entries: PlatformMixEntry[] = platforms.map((platform) => {
    const ref = PLATFORM_REFERENCE[platform];
    const kpi = kpiByPlatform[platform];
    const live = liveSignals?.[platform] ?? {};

    const commission_pct = kpi?.commission_pct && kpi.commission_pct > 0 ? kpi.commission_pct : ref.commission_pct;
    const boost_pct = live.boost_pct ?? 0;
    const surge_multiplier = live.surge_multiplier ?? 1;
    const estimated_wait_min = live.estimated_wait_min ?? (platform === "uber" || platform === "bolt" ? 4 : 7);
    const net_hourly_historical = kpi?.net_hourly ?? 0;

    // Score composite pondéré (0-100) :
    //  - 40% commission (inversée : moins de commission = meilleur score)
    //  - 25% surge/boost courant
    //  - 20% €/h historique net
    //  - 15% temps d'attente estimé (inversé : moins d'attente = meilleur score)
    const commissionScore = clamp(100 - (commission_pct - 15) * 4, 0, 100); // 15%→100, 30%→40
    const surgeBoostScore = clamp(((surge_multiplier - 1) * 100 + boost_pct) * 1.5, 0, 100);
    const historicalScore = net_hourly_historical > 0 ? clamp((net_hourly_historical / 35) * 100, 0, 100) : 40;
    const waitScore = clamp(100 - estimated_wait_min * 8, 0, 100);

    const score = r1(
      commissionScore * 0.4 + surgeBoostScore * 0.25 + historicalScore * 0.2 + waitScore * 0.15
    );

    return {
      platform,
      label: ref.label,
      score,
      commission_pct: r1(commission_pct),
      boost_pct: r1(boost_pct),
      surge_multiplier: r1(surge_multiplier),
      estimated_wait_min: r1(estimated_wait_min),
      net_hourly_historical: r1(net_hourly_historical),
      recommended: false,
      reason_fr: "",
    };
  }).sort((a, b) => b.score - a.score);

  entries.forEach((e, i) => {
    e.recommended = i === 0;
    if (i === 0) {
      const parts: string[] = [];
      parts.push(`commission ${e.commission_pct}%`);
      if (e.surge_multiplier > 1.05) parts.push(`surge x${e.surge_multiplier}`);
      if (e.boost_pct > 0) parts.push(`boost +${e.boost_pct}%`);
      parts.push(`attente ~${e.estimated_wait_min} min`);
      e.reason_fr = `${e.label} recommandé maintenant : ${parts.join(", ")}. ${whichNow.reason_fr}`;
    } else {
      e.reason_fr = `Score ${e.score}/100 — commission ${e.commission_pct}%, attente ~${e.estimated_wait_min} min.`;
    }
  });

  return {
    best_platform: entries[0]?.platform ?? "uber",
    entries,
    computed_at: new Date().toISOString(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1.2 — Dead-mileage tracker
// ═════════════════════════════════════════════════════════════════════════════
export interface DeadMileageEntry {
  id: number;
  ts: string;
  distance_km: number;
  duration_min: number;
  from_zone_id: string | null;
  to_zone_id: string | null;
  reason: string;
}

export function recordDeadMileage(input: {
  userId?: string;
  distanceKm: number;
  durationMin?: number;
  fromZoneId?: string;
  toZoneId?: string;
  reason?: string;
}): DeadMileageEntry {
  const userId = input.userId || DEFAULT_USER;
  const stmt = sqlite.prepare(
    `INSERT INTO dead_mileage_log (user_id, ts, distance_km, duration_min, from_zone_id, to_zone_id, reason)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    userId,
    r2(input.distanceKm),
    r1(input.durationMin ?? 0),
    input.fromZoneId ?? null,
    input.toZoneId ?? null,
    input.reason ?? "repositionnement"
  );
  return sqlite.prepare(`SELECT * FROM dead_mileage_log WHERE id = ?`).get(info.lastInsertRowid) as DeadMileageEntry;
}

export interface DeadMileageSummary {
  period_days: number;
  total_km: number;
  total_cost_eur: number;
  avg_km_per_day: number;
  entries_count: number;
  recent_entries: DeadMileageEntry[];
  advice_fr: string;
}

export function getDeadMileageSummary(userId: string = DEFAULT_USER, periodDays: number = 7): DeadMileageSummary {
  const sinceIso = new Date(Date.now() - periodDays * 24 * 3600_000).toISOString();
  const rows = sqlite
    .prepare(`SELECT * FROM dead_mileage_log WHERE user_id = ? AND ts >= ? ORDER BY ts DESC`)
    .all(userId, sinceIso) as DeadMileageEntry[];

  const costPerKm = economicsEngine.computeCostPerKm();
  const total_km = r2(rows.reduce((s, r) => s + r.distance_km, 0));
  const total_cost_eur = r2(total_km * costPerKm.total_per_km);
  const avg_km_per_day = r1(total_km / Math.max(1, periodDays));

  let advice_fr: string;
  if (rows.length === 0) {
    advice_fr = "Aucun trajet à vide enregistré sur la période — continuez à noter vos repositionnements pour affiner ce suivi.";
  } else if (avg_km_per_day > 15) {
    advice_fr = `Vous parcourez en moyenne ${avg_km_per_day} km à vide/jour (${total_cost_eur}€ de coût réel sur ${periodDays}j) — envisagez de rester plus statique en zone dense entre deux courses.`;
  } else {
    advice_fr = `Kilométrage à vide maîtrisé (${avg_km_per_day} km/jour en moyenne, ${total_cost_eur}€ sur ${periodDays}j).`;
  }

  return {
    period_days: periodDays,
    total_km,
    total_cost_eur,
    avg_km_per_day,
    entries_count: rows.length,
    recent_entries: rows.slice(0, 20),
    advice_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1.5 — Projection fin de journée en temps réel
// ═════════════════════════════════════════════════════════════════════════════
export interface DayProjection {
  elapsed_hours: number;
  target_hours: number;
  progress_pct: number;
  current_net_eur: number;
  current_hourly_rate: number;
  projected_final_net_eur: number;
  projected_vs_target_pct: number;
  message_fr: string;
}

export function computeDayProjection(targetHours: number = 8, targetIncomeEur?: number): DayProjection {
  const summary = economicsEngine.computeEndShift();
  const profile: any = storage.getDriverProfile() || {};
  const target = targetIncomeEur ?? (profile.hourly_target_income ?? 35) * targetHours;

  // Heures écoulées depuis le début de la journée (première course) jusqu'à maintenant.
  const day = new Date().toISOString().slice(0, 10);
  const start = `${day}T00:00:00.000Z`;
  const rides = storage.getRidesInRange(start, new Date(Date.now() + 60_000).toISOString());
  let elapsed_hours = 0;
  if (rides.length > 0) {
    const firstTs = new Date(rides[0].timestamp).getTime();
    elapsed_hours = r1((Date.now() - firstTs) / 3_600_000);
  }
  elapsed_hours = Math.max(elapsed_hours, 0.05);

  const current_net_eur = summary.total_net;
  const current_hourly_rate = summary.avg_hourly;

  // Extrapolation linéaire simple sur le rythme actuel (€/h glissant), plafonnée
  // à target_hours pour éviter une projection déraisonnable si le shift continue.
  const remaining_hours = Math.max(0, targetHours - elapsed_hours);
  const projected_final_net_eur = r2(current_net_eur + current_hourly_rate * remaining_hours);
  const progress_pct = r1(clamp((elapsed_hours / targetHours) * 100, 0, 100));
  const projected_vs_target_pct = target > 0 ? r1((projected_final_net_eur / target) * 100) : 0;

  let message_fr: string;
  if (rides.length === 0) {
    message_fr = "Aucune course enregistrée aujourd'hui — la projection démarrera dès votre première course.";
  } else if (projected_vs_target_pct >= 100) {
    message_fr = `À ce rythme (${current_hourly_rate}€/h), vous devriez terminer à ${projected_final_net_eur}€, au-delà de votre objectif de ${r2(target)}€. Continuez ainsi !`;
  } else if (projected_vs_target_pct >= 80) {
    message_fr = `À ce rythme, vous devriez atteindre ${projected_final_net_eur}€ en fin de journée (${projected_vs_target_pct}% de l'objectif de ${r2(target)}€) — encore un effort.`;
  } else {
    message_fr = `Au rythme actuel (${current_hourly_rate}€/h), la projection de fin de journée est de ${projected_final_net_eur}€, loin de l'objectif de ${r2(target)}€ — envisagez de changer de zone ou de plateforme.`;
  }

  return {
    elapsed_hours,
    target_hours: targetHours,
    progress_pct,
    current_net_eur,
    current_hourly_rate,
    projected_final_net_eur,
    projected_vs_target_pct,
    message_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1.6 — Alerte "value per minute" décroissante
// ═════════════════════════════════════════════════════════════════════════════
export interface MarginalValueResult {
  last_60min_hourly_rate: number;
  shift_avg_hourly_rate: number;
  delta_pct: number;
  is_declining: boolean;
  alert_fr: string | null;
}

export function computeMarginalValue(): MarginalValueResult {
  const now = Date.now();
  const last60 = storage.getRidesInRange(new Date(now - 60 * 60_000).toISOString(), new Date(now + 60_000).toISOString());
  const shiftSummary = economicsEngine.computeEndShift();

  const netLast60 = last60.reduce((s: number, r: any) => s + (r.net_profit ?? 0), 0);
  const durLast60H = last60.reduce((s: number, r: any) => s + (r.duration_min ?? 0), 0) / 60;
  const last_60min_hourly_rate = durLast60H > 0.05 ? r1(netLast60 / durLast60H) : 0;
  const shift_avg_hourly_rate = shiftSummary.avg_hourly;

  const delta_pct = shift_avg_hourly_rate > 0
    ? r1(((last_60min_hourly_rate - shift_avg_hourly_rate) / shift_avg_hourly_rate) * 100)
    : 0;

  const is_declining = shift_avg_hourly_rate > 0 && delta_pct <= -25 && last60.length > 0;

  let alert_fr: string | null = null;
  if (is_declining) {
    alert_fr = `Votre rendement horaire a chuté de ${Math.abs(delta_pct)}% sur les 60 dernières minutes (${last_60min_hourly_rate}€/h) par rapport à votre moyenne de shift (${shift_avg_hourly_rate}€/h). Il est peut-être temps de changer de zone, de plateforme ou de faire une pause.`;
  }

  return { last_60min_hourly_rate, shift_avg_hourly_rate, delta_pct, is_declining, alert_fr };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1.10 — Score de qualité de journée agrégé
// ═════════════════════════════════════════════════════════════════════════════
export interface DayQualityScore {
  score_global: number; // 0-100
  components: {
    hourly_rate: { value: number; score: number };
    dead_mileage: { value_km: number; score: number };
    fatigue: { value_risk: number; score: number };
    stress: { value: number; score: number };
  };
  qualification_fr: "excellente" | "bonne" | "correcte" | "difficile";
  message_fr: string;
}

export function computeDayQualityScore(userId: string = DEFAULT_USER): DayQualityScore {
  const shiftSummary = economicsEngine.computeEndShift();
  const deadMileage = getDeadMileageSummary(userId, 1);

  // €/h : score linéaire, 40€/h = 100, 0€/h = 0
  const hourlyScore = clamp((shiftSummary.avg_hourly / 40) * 100, 0, 100);

  // Dead-mileage du jour : 0km = 100, 30km+ = 0
  const deadMileageScore = clamp(100 - (deadMileage.total_km / 30) * 100, 0, 100);

  // Fatigue : tente de lire le risque de micro-sommeil si le module fatigueCoach existe déjà.
  let fatigueRisk = 0.2; // valeur par défaut prudente si indisponible
  try {
    // Import dynamique tardif pour éviter une dépendance circulaire au chargement du module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fatigueCoach = require("./fatigueCoach");
    if (typeof fatigueCoach.computeMicrosleepRisk === "function") {
      const risk = fatigueCoach.computeMicrosleepRisk(userId);
      fatigueRisk = typeof risk?.risk === "number" ? risk.risk : fatigueRisk;
    }
  } catch {
    // module non disponible ou erreur interne : on garde la valeur par défaut
  }
  const fatigueScore = clamp(100 - fatigueRisk * 100, 0, 100);

  // Stress (proxy) : nombre de courses non-rentables du jour rapporté au total de courses.
  const day = new Date().toISOString().slice(0, 10);
  const start = `${day}T00:00:00.000Z`;
  const todayRides = storage.getRidesInRange(start, new Date(Date.now() + 60_000).toISOString());
  const unprofitableRatio = todayRides.length > 0 ? shiftSummary.unprofitable_count / todayRides.length : 0;
  const stressScore = clamp(100 - unprofitableRatio * 150, 0, 100);

  const score_global = r1(
    hourlyScore * 0.4 + deadMileageScore * 0.25 + fatigueScore * 0.2 + stressScore * 0.15
  );

  let qualification_fr: DayQualityScore["qualification_fr"];
  if (score_global >= 80) qualification_fr = "excellente";
  else if (score_global >= 60) qualification_fr = "bonne";
  else if (score_global >= 40) qualification_fr = "correcte";
  else qualification_fr = "difficile";

  const message_fr = `Journée ${qualification_fr} (score ${score_global}/100) : ${shiftSummary.avg_hourly}€/h, ${deadMileage.total_km} km à vide, risque de fatigue estimé à ${r1(fatigueRisk * 100)}%.`;

  return {
    score_global,
    components: {
      hourly_rate: { value: shiftSummary.avg_hourly, score: r1(hourlyScore) },
      dead_mileage: { value_km: deadMileage.total_km, score: r1(deadMileageScore) },
      fatigue: { value_risk: r1(fatigueRisk), score: r1(fatigueScore) },
      stress: { value: r1(unprofitableRatio * 100), score: r1(stressScore) },
    },
    qualification_fr,
    message_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2.1 — Taux d'acceptation optimal par plateforme
// ═════════════════════════════════════════════════════════════════════════════
// Modèle simplifié aligné sur les pondérations documentées (rapport.md §2.1) :
// Bolt priorise 50% proximité / 30% temps de réponse / 20% note passager.
// Un taux d'acceptation trop bas dégrade le matching futur, mais 100% n'est pas
// optimal non plus (accepte aussi les courses très peu rentables).
const ACCEPTANCE_MODEL: Record<string, { optimal_min_pct: number; optimal_max_pct: number; note_fr: string }> = {
  uber: { optimal_min_pct: 80, optimal_max_pct: 92, note_fr: "Uber dégrade le matching en dessous de ~80% d'acceptation." },
  bolt: { optimal_min_pct: 75, optimal_max_pct: 90, note_fr: "Bolt pondère 50% proximité / 30% réactivité (<8s) / 20% note passager — l'acceptation pure compte moins que la vitesse de réponse." },
  heetch: { optimal_min_pct: 70, optimal_max_pct: 88, note_fr: "Heetch tolère un taux d'acceptation plus bas sans forte pénalité de matching." },
  freenow: { optimal_min_pct: 78, optimal_max_pct: 90, note_fr: "FreeNow suit une logique proche d'Uber sur la pénalisation du matching." },
};

export interface OptimalAcceptanceRate {
  platform: string;
  optimal_min_pct: number;
  optimal_max_pct: number;
  current_estimated_pct: number | null;
  status: "trop_bas" | "optimal" | "trop_haut" | "inconnu";
  recommendation_fr: string;
}

export function computeOptimalAcceptanceRate(platform: string, currentAcceptancePct?: number): OptimalAcceptanceRate {
  const key = platform.toLowerCase();
  const model = ACCEPTANCE_MODEL[key] ?? ACCEPTANCE_MODEL.uber;

  let status: OptimalAcceptanceRate["status"] = "inconnu";
  let recommendation_fr: string;

  if (typeof currentAcceptancePct === "number") {
    if (currentAcceptancePct < model.optimal_min_pct) {
      status = "trop_bas";
      recommendation_fr = `Votre taux d'acceptation (${currentAcceptancePct}%) est en dessous de la zone optimale (${model.optimal_min_pct}-${model.optimal_max_pct}%). ${model.note_fr} Acceptez davantage de courses, même moyennes, pour préserver votre matching.`;
    } else if (currentAcceptancePct > model.optimal_max_pct) {
      status = "trop_haut";
      recommendation_fr = `Votre taux d'acceptation (${currentAcceptancePct}%) dépasse la zone optimale (${model.optimal_min_pct}-${model.optimal_max_pct}%) — vous acceptez probablement trop de courses peu rentables. Soyez un peu plus sélectif sans descendre sous ${model.optimal_min_pct}%.`;
    } else {
      status = "optimal";
      recommendation_fr = `Votre taux d'acceptation (${currentAcceptancePct}%) est dans la zone optimale (${model.optimal_min_pct}-${model.optimal_max_pct}%). Continuez ainsi.`;
    }
  } else {
    recommendation_fr = `Visez un taux d'acceptation entre ${model.optimal_min_pct}% et ${model.optimal_max_pct}% sur ${PLATFORM_REFERENCE[key]?.label ?? platform}. ${model.note_fr}`;
  }

  return {
    platform: key,
    optimal_min_pct: model.optimal_min_pct,
    optimal_max_pct: model.optimal_max_pct,
    current_estimated_pct: currentAcceptancePct ?? null,
    status,
    recommendation_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2.2 — Ratio courses courtes/longues
// ═════════════════════════════════════════════════════════════════════════════
export interface RideMixResult {
  period_days: number;
  short_count: number;
  medium_count: number;
  long_count: number;
  short_pct: number;
  medium_pct: number;
  long_pct: number;
  recommended_long_pct_by_hour: number;
  recommendation_fr: string;
}

export function computeRideMix(periodDays: number = 7, currentHour?: number): RideMixResult {
  const sinceIso = new Date(Date.now() - periodDays * 24 * 3600_000).toISOString();
  const rides = storage.getRidesInRange(sinceIso, new Date(Date.now() + 60_000).toISOString());

  // Classification : < 10 min = courte, 10-20 min = moyenne, > 20 min = longue (rapport.md §2.2)
  let short_count = 0, medium_count = 0, long_count = 0;
  rides.forEach((r: any) => {
    const dur = r.duration_min ?? 0;
    if (dur < 10) short_count++;
    else if (dur <= 20) medium_count++;
    else long_count++;
  });
  const total = Math.max(1, rides.length);
  const short_pct = r1((short_count / total) * 100);
  const medium_pct = r1((medium_count / total) * 100);
  const long_pct = r1((long_count / total) * 100);

  // Cible par heure : plus de courses longues recommandées en heures de pointe
  // (rentabilité €/h supérieure sur trajets longs aux heures denses), plus de
  // courses courtes acceptées en heures creuses pour maximiser le taux d'occupation.
  const h = currentHour ?? new Date().getHours();
  const isRush = (h >= 6 && h <= 9) || (h >= 17 && h <= 20);
  const recommended_long_pct_by_hour = isRush ? 45 : 25;

  let recommendation_fr: string;
  if (rides.length === 0) {
    recommendation_fr = "Pas encore assez de courses enregistrées pour établir une recommandation de mix.";
  } else if (long_pct < recommended_long_pct_by_hour - 10) {
    recommendation_fr = `Votre part de courses longues (${long_pct}%) est inférieure à la cible recommandée pour ce créneau (${recommended_long_pct_by_hour}%). Privilégiez les zones à forte proportion de longues distances (aéroports, gares) sur ce créneau.`;
  } else if (long_pct > recommended_long_pct_by_hour + 15) {
    recommendation_fr = `Votre part de courses longues (${long_pct}%) dépasse largement la cible (${recommended_long_pct_by_hour}%) — attention au dead-mileage de retour, pensez à enchaîner via trip-chaining.`;
  } else {
    recommendation_fr = `Votre mix courses courtes/longues (${long_pct}% longues) est aligné avec la cible recommandée (${recommended_long_pct_by_hour}%) pour ce créneau.`;
  }

  return {
    period_days: periodDays,
    short_count, medium_count, long_count,
    short_pct, medium_pct, long_pct,
    recommended_long_pct_by_hour,
    recommendation_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2.3 — Prix de réserve dynamique
// ═════════════════════════════════════════════════════════════════════════════
export interface ReservePriceResult {
  reserve_price_eur_per_hour: number;
  base_break_even: number;
  fatigue_adjustment_eur: number;
  fill_rate_adjustment_eur: number;
  hour_adjustment_eur: number;
  explanation_fr: string;
}

/**
 * Étend computeRideMargin/computeBreakEven avec un seuil configurable évoluant
 * selon l'heure, la fatigue estimée, et le remplissage du shift (rapport.md §2.3).
 */
export function computeReservePrice(userId: string = DEFAULT_USER, currentHour?: number): ReservePriceResult {
  const breakEven = economicsEngine.computeBreakEven();
  const base_break_even = breakEven.min_hourly_to_profit;

  // Ajustement fatigue : plus le risque est élevé, plus le seuil minimum doit monter
  // (on ne veut accepter que des courses très rentables si l'on est fatigué).
  let fatigueRisk = 0.2;
  try {
    const fatigueCoach = require("./fatigueCoach");
    if (typeof fatigueCoach.computeMicrosleepRisk === "function") {
      const risk = fatigueCoach.computeMicrosleepRisk(userId);
      fatigueRisk = typeof risk?.risk === "number" ? risk.risk : fatigueRisk;
    }
  } catch {
    // ignore
  }
  const fatigue_adjustment_eur = r1(fatigueRisk * 8); // jusqu'à +8€/h si fatigue max

  // Ajustement remplissage : plus le shift est déjà bien rempli (objectif proche
  // d'être atteint), plus on peut se permettre d'être sélectif (seuil qui monte).
  const projection = computeDayProjection();
  const fill_rate_adjustment_eur = r1(clamp((projection.projected_vs_target_pct - 100) / 20, -3, 5));

  // Ajustement horaire : heures de pointe → seuil plus élevé (la demande le permet),
  // heures creuses → seuil plus bas (mieux vaut rouler à un tarif modeste que rien).
  const h = currentHour ?? new Date().getHours();
  const isRush = (h >= 6 && h <= 9) || (h >= 17 && h <= 20);
  const isNight = h >= 0 && h <= 5;
  const hour_adjustment_eur = isRush ? 4 : isNight ? -3 : 0;

  const reserve_price_eur_per_hour = r1(
    Math.max(5, base_break_even + fatigue_adjustment_eur + fill_rate_adjustment_eur + hour_adjustment_eur)
  );

  const explanation_fr =
    `Seuil de base (rentabilité) : ${base_break_even}€/h. ` +
    `Ajustement fatigue : ${fatigue_adjustment_eur >= 0 ? "+" : ""}${fatigue_adjustment_eur}€/h. ` +
    `Ajustement remplissage du shift : ${fill_rate_adjustment_eur >= 0 ? "+" : ""}${fill_rate_adjustment_eur}€/h. ` +
    `Ajustement créneau horaire : ${hour_adjustment_eur >= 0 ? "+" : ""}${hour_adjustment_eur}€/h. ` +
    `→ N'acceptez pas de course sous ${reserve_price_eur_per_hour}€/h équivalent en ce moment.`;

  return {
    reserve_price_eur_per_hour,
    base_break_even,
    fatigue_adjustment_eur,
    fill_rate_adjustment_eur,
    hour_adjustment_eur,
    explanation_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2.4 — Détection de sur-sélectivité
// ═════════════════════════════════════════════════════════════════════════════
export interface OverSelectiveAlert {
  is_over_selective: boolean;
  todays_accepted_count: number;
  estimated_refused_good_count: number;
  estimated_lost_revenue_eur: number;
  alert_fr: string | null;
}

/**
 * Analyse rétrospective simplifiée : sans journal explicite des refus (non modélisé
 * dans le schéma existant), on utilise un proxy — un rythme d'acceptation anormalement
 * bas par rapport à la moyenne historique de la même tranche horaire suggère une
 * sur-sélectivité, avec un coût d'opportunité estimé sur le rendement horaire moyen.
 */
export function computeOverSelectiveAlert(userId: string = DEFAULT_USER): OverSelectiveAlert {
  const day = new Date().toISOString().slice(0, 10);
  const start = `${day}T00:00:00.000Z`;
  const todayRides = storage.getRidesInRange(start, new Date(Date.now() + 60_000).toISOString());

  const last30dRides = storage.getRidesInRange(
    new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString()
  );

  const hoursElapsedToday = Math.max(
    0.5,
    todayRides.length > 0 ? (Date.now() - new Date(todayRides[0].timestamp).getTime()) / 3_600_000 : 1
  );
  const todaysRidesPerHour = todayRides.length / hoursElapsedToday;

  // Moyenne historique de courses/heure sur les 30 derniers jours (fenêtre glissante)
  const totalHistDays = 30;
  const histRidesPerHour = last30dRides.length / (totalHistDays * 8); // hypothèse ~8h de shift moyen/jour

  const is_over_selective = histRidesPerHour > 0 && todaysRidesPerHour < histRidesPerHour * 0.5 && todayRides.length >= 1;

  const estimated_refused_good_count = is_over_selective
    ? Math.max(0, Math.round((histRidesPerHour - todaysRidesPerHour) * hoursElapsedToday))
    : 0;

  const avgNetPerRide = last30dRides.length > 0
    ? last30dRides.reduce((s: number, r: any) => s + (r.net_profit ?? 0), 0) / last30dRides.length
    : 0;
  const estimated_lost_revenue_eur = r2(estimated_refused_good_count * Math.max(0, avgNetPerRide));

  const alert_fr = is_over_selective
    ? `Votre rythme de courses aujourd'hui (${r1(todaysRidesPerHour)}/h) est bien en dessous de votre moyenne habituelle (${r1(histRidesPerHour)}/h) — vous refusez peut-être trop de courses correctes. Perte estimée : ${estimated_lost_revenue_eur}€.`
    : null;

  return {
    is_over_selective,
    todays_accepted_count: todayRides.length,
    estimated_refused_good_count,
    estimated_lost_revenue_eur,
    alert_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2.6 — Simulateur "always on" vs sélectif
// ═════════════════════════════════════════════════════════════════════════════
export interface AlwaysOnSimulatorResult {
  mode_always_on: { expected_net_eur: number; expected_rides: number; expected_hours: number; fatigue_cost_eur: number };
  mode_selective: { expected_net_eur: number; expected_rides: number; expected_hours: number; fatigue_cost_eur: number };
  recommendation_fr: string;
  delta_eur: number;
}

export function computeAlwaysOnSimulator(hoursAvailable: number = 8): AlwaysOnSimulatorResult {
  const kpis = economicsEngine.computePlatformKpiComparison(30);
  const avgNetHourly = kpis.length > 0
    ? kpis.reduce((s, k) => s + k.net_hourly, 0) / kpis.length
    : 20;

  // Mode "always on" : accepte quasi tout → plus de courses/heure mais rendement
  // horaire net plus faible (mix incluant des courses peu rentables) + fatigue accrue.
  const alwaysOnHourly = avgNetHourly * 0.85;
  const alwaysOnRidesPerHour = 2.2;
  const alwaysOnFatigueCost = hoursAvailable * 0.6; // coût de fatigue additionnel estimé (€/h équivalent)

  // Mode sélectif : refuse les courses sous le prix de réserve → rendement horaire
  // net plus élevé mais moins de courses acceptées (temps d'attente supplémentaire).
  const reserve = computeReservePrice();
  const selectiveHourly = Math.max(avgNetHourly * 1.15, reserve.reserve_price_eur_per_hour);
  const selectiveRidesPerHour = 1.5;
  const selectiveFatigueCost = hoursAvailable * 0.25;

  const mode_always_on = {
    expected_net_eur: r2(alwaysOnHourly * hoursAvailable - alwaysOnFatigueCost),
    expected_rides: Math.round(alwaysOnRidesPerHour * hoursAvailable),
    expected_hours: hoursAvailable,
    fatigue_cost_eur: r2(alwaysOnFatigueCost),
  };
  const mode_selective = {
    expected_net_eur: r2(selectiveHourly * hoursAvailable - selectiveFatigueCost),
    expected_rides: Math.round(selectiveRidesPerHour * hoursAvailable),
    expected_hours: hoursAvailable,
    fatigue_cost_eur: r2(selectiveFatigueCost),
  };

  const delta_eur = r2(mode_selective.expected_net_eur - mode_always_on.expected_net_eur);
  const recommendation_fr = delta_eur > 0
    ? `Sur ${hoursAvailable}h, le mode sélectif rapporterait ${delta_eur}€ de plus que le mode "always on" (${mode_selective.expected_net_eur}€ vs ${mode_always_on.expected_net_eur}€), avec moins de fatigue accumulée.`
    : `Sur ${hoursAvailable}h, le mode "always on" rapporterait ${Math.abs(delta_eur)}€ de plus que le mode sélectif — pertinent si vous visez le volume plutôt que la marge, mais surveillez la fatigue.`;

  return { mode_always_on, mode_selective, recommendation_fr, delta_eur };
}
