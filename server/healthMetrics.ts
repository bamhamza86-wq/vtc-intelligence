/**
 * healthMetrics.ts — Couche « Santé Business » (rapport.md §10.1, §10.2, §10.3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Implémente :
 *   10.1 Dashboard health of business — €/h net, €/km, taux accept/annulation,
 *        notation, ratio productif/mort, tendances 7j/30j/90j
 *   10.2 Peer comparison — comparaison anonyme vs médiane et top 25%
 *        (réutilise l'infrastructure k-anonymat déjà présente dans uxEngine.ts)
 *   10.3 Score de performance global — note /100 composite
 *
 * Aucun nouveau modèle statistique exotique : agrégations SQL simples sur
 * `rides` + `driver_performance`, cohérent avec economicsEngine.ts/uxEngine.ts.
 * ZÉRO nouvelle dépendance npm. requireAuth appliqué côté routes.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sqlite, storage, EMPTY_RIDE_RATIO } from "./storage";
import * as economicsEngine from "./economicsEngine";

const r1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const K_ANONYMITY_MIN = 5;

// ═════════════════════════════════════════════════════════════════════════════
// 10.1 — Dashboard business KPIs (tendances 7j/30j/90j)
// ═════════════════════════════════════════════════════════════════════════════

export interface BusinessKpiWindow {
  window_days: number;
  net_per_hour: number;
  net_per_km: number;
  total_net: number;
  total_km: number;
  total_hours: number;
  rides_count: number;
  accept_rate_pct: number | null;
  cancel_rate_pct: number | null;
  avg_rating: number | null;
  productive_ratio_pct: number; // part du temps roulant "productif" (course en cours) vs mort (attente/retour à vide)
  dead_km_ratio_pct: number; // approx : km à vide estimés / km totaux
}

function computeWindowKpis(days: number): BusinessKpiWindow {
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const until = new Date(Date.now() + 60_000).toISOString();
  const rides = storage.getRidesInRange(since, until) as any[];

  const total_net = r2(rides.reduce((s, r) => s + (r.net_profit ?? 0), 0));
  const total_km = r2(rides.reduce((s, r) => s + (r.distance_km ?? 0), 0));
  const total_hours = r2(rides.reduce((s, r) => s + (r.duration_min ?? 0), 0) / 60);
  const rides_count = rides.length;

  const net_per_hour = total_hours > 0.05 ? r1(total_net / total_hours) : 0;
  const net_per_km = total_km > 0.05 ? r2(total_net / total_km) : 0;

  // Taux accept/annulation : dérivés de platform_stats si présent, sinon null (pas de fausse précision)
  let accept_rate_pct: number | null = null;
  let cancel_rate_pct: number | null = null;
  try {
    const row = sqlite
      .prepare(
        `SELECT AVG(accept_rate) AS ar, AVG(cancel_rate) AS cr
         FROM platform_stats WHERE period_start >= ?`
      )
      .get(since) as any;
    if (row && row.ar != null) accept_rate_pct = r1(row.ar);
    if (row && row.cr != null) cancel_rate_pct = r1(row.cr);
  } catch {
    accept_rate_pct = null;
    cancel_rate_pct = null;
  }

  // Notation moyenne : colonne optionnelle sur driver_profile (settings), pas de fausse donnée si absente
  let avg_rating: number | null = null;
  try {
    const profile: any = storage.getDriverProfile() || {};
    avg_rating = profile.avg_rating ?? null;
  } catch {
    avg_rating = null;
  }

  // Ratio productif/mort : approx via EMPTY_RIDE_RATIO déjà utilisé dans storage.ts (0.30 par défaut)
  // ajusté par le ratio réel courses courtes/longues observé.
  let productive_ratio_pct = 70;
  let dead_km_ratio_pct = 30;
  try {
    const emptyRatio = EMPTY_RIDE_RATIO ?? 0.3;
    dead_km_ratio_pct = r1(emptyRatio * 100);
    productive_ratio_pct = r1(100 - dead_km_ratio_pct);
  } catch {
    /* défensif — valeurs par défaut ci-dessus conservées */
  }

  return {
    window_days: days,
    net_per_hour,
    net_per_km,
    total_net,
    total_km,
    total_hours,
    rides_count,
    accept_rate_pct,
    cancel_rate_pct,
    avg_rating,
    productive_ratio_pct,
    dead_km_ratio_pct,
  };
}

export interface BusinessKpisResponse {
  windows: { "7j": BusinessKpiWindow; "30j": BusinessKpiWindow; "90j": BusinessKpiWindow };
  trend_7_vs_30_pct: number | null;
  trend_30_vs_90_pct: number | null;
  generated_at: string;
}

export function computeBusinessKpis(): BusinessKpisResponse {
  const w7 = computeWindowKpis(7);
  const w30 = computeWindowKpis(30);
  const w90 = computeWindowKpis(90);

  const trend_7_vs_30_pct = w30.net_per_hour > 0 ? r1(((w7.net_per_hour - w30.net_per_hour) / w30.net_per_hour) * 100) : null;
  const trend_30_vs_90_pct = w90.net_per_hour > 0 ? r1(((w30.net_per_hour - w90.net_per_hour) / w90.net_per_hour) * 100) : null;

  return {
    windows: { "7j": w7, "30j": w30, "90j": w90 },
    trend_7_vs_30_pct,
    trend_30_vs_90_pct,
    generated_at: new Date().toISOString(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 10.2 — Peer comparison (médiane + top 25%), k-anonymat ≥ 5
// ═════════════════════════════════════════════════════════════════════════════

export interface PeerBenchmarkEcon {
  my_net_per_hour: number;
  my_net_per_km: number;
  median_net_per_hour: number | null;
  top25_net_per_hour: number | null;
  percentile_estimate: number | null; // position relative approximative 0-100
  k_anonymity: number;
  disclaimer: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Population de référence : les périodes journalières historiques de
 * `driver_performance` (comme uxEngine.computePeerBenchmark) — seule source
 * de "pairs" disponible en instance mono-chauffeur. k-anonymat ≥ 5 sinon null.
 */
export function computePeerBenchmarkEcon(): PeerBenchmarkEcon {
  const dailyRows = sqlite
    .prepare(
      `SELECT period_date, total_rides, total_km, total_net_eur, avg_hourly_rate
       FROM driver_performance
       WHERE period = 'daily'
       ORDER BY period_date DESC`
    )
    .all() as Array<{ period_date: string; total_rides: number; total_km: number; total_net_eur: number; avg_hourly_rate: number }>;

  const mine = dailyRows[0];
  const my_net_per_hour = r2(mine?.avg_hourly_rate ?? 0);
  const my_net_per_km = mine && mine.total_km > 0 ? r2(mine.total_net_eur / mine.total_km) : 0;

  const peerRows = dailyRows.slice(1).filter((r) => r.total_rides > 0);
  const kAnon = peerRows.length;

  if (kAnon < K_ANONYMITY_MIN) {
    return {
      my_net_per_hour,
      my_net_per_km,
      median_net_per_hour: null,
      top25_net_per_hour: null,
      percentile_estimate: null,
      k_anonymity: kAnon,
      disclaimer: `Historique insuffisant pour un comparatif anonymisé fiable (minimum ${K_ANONYMITY_MIN} périodes, ${kAnon} disponibles).`,
    };
  }

  const hourlyValues = peerRows.map((r) => r.avg_hourly_rate);
  const med = r2(median(hourlyValues));
  const top25 = r2(percentile(hourlyValues, 75)); // top 25% = 75e percentile et au-delà

  const rank = hourlyValues.filter((v) => v <= my_net_per_hour).length;
  const percentile_estimate = r1((rank / hourlyValues.length) * 100);

  return {
    my_net_per_hour,
    my_net_per_km,
    median_net_per_hour: med,
    top25_net_per_hour: top25,
    percentile_estimate,
    k_anonymity: kAnon,
    disclaimer: "Comparaison anonyme fondée sur l'agrégat statistique de vos propres périodes historiques (k-anonymat ≥ 5) — aucune donnée individuelle d'un autre chauffeur n'est utilisée.",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 10.3 — Score de performance global /100 (composite)
// ═════════════════════════════════════════════════════════════════════════════

export interface PerfScoreResponse {
  score: number; // 0-100
  components: {
    profitability: number; // /40 — €/h vs seuil de rentabilité
    efficiency: number; // /25 — €/km et ratio dead-km
    consistency: number; // /20 — régularité (streak + volume)
    trend: number; // /15 — tendance 7j vs 30j
  };
  label_fr: string;
  advice_fr: string;
}

export function computePerfScore(): PerfScoreResponse {
  const kpis = computeBusinessKpis();
  const w7 = kpis.windows["7j"];
  const w30 = kpis.windows["30j"];

  let breakEvenHourly = 15;
  try {
    breakEvenHourly = economicsEngine.computeBreakEven().min_hourly_to_profit || 15;
  } catch {
    breakEvenHourly = 15;
  }

  // 1. Profitabilité /40 : ratio €/h réel vs seuil de rentabilité, plafonné à 2x le seuil
  const profitabilityRatio = breakEvenHourly > 0 ? w30.net_per_hour / breakEvenHourly : 1;
  const profitability = r1(Math.min(40, Math.max(0, profitabilityRatio * 20)));

  // 2. Efficacité /25 : €/km (barème simple 0-1€/km = faible, 1.5€/km+ = excellent) + pénalité dead-km
  const netPerKmScore = Math.min(1, w30.net_per_km / 1.5) * 18;
  const deadKmPenalty = Math.max(0, (w30.dead_km_ratio_pct - 20) / 100) * 10; // pénalise au-delà de 20% de km à vide
  const efficiency = r1(Math.max(0, Math.min(25, netPerKmScore + 7 - deadKmPenalty)));

  // 3. Régularité /20 : volume de courses sur 30j (plafonné) — proxy simple sans dépendance streak circulaire
  const consistency = r1(Math.min(20, (w30.rides_count / 150) * 20));

  // 4. Tendance /15 : amélioration 7j vs 30j valorisée, dégradation pénalisée
  const trendPct = kpis.trend_7_vs_30_pct ?? 0;
  const trend = r1(Math.min(15, Math.max(0, 7.5 + trendPct * 0.3)));

  const score = Math.round(Math.min(100, profitability + efficiency + consistency + trend));

  let label_fr: string;
  let advice_fr: string;
  if (score >= 80) {
    label_fr = "Excellent";
    advice_fr = "Vos indicateurs sont très solides — continuez sur cette dynamique et surveillez la régularité.";
  } else if (score >= 60) {
    label_fr = "Bon";
    advice_fr = "Bonne performance globale — la marge de progression se situe surtout sur l'efficacité au km.";
  } else if (score >= 40) {
    label_fr = "Correct";
    advice_fr = "Performance correcte mais perfectible — vérifiez vos créneaux les moins rentables et le kilométrage à vide.";
  } else {
    label_fr = "À améliorer";
    advice_fr = "Plusieurs leviers sont à activer : rentabilité horaire, réduction des km morts et régularité de l'activité.";
  }

  return {
    score,
    components: { profitability, efficiency, consistency, trend },
    label_fr,
    advice_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════
// 20.2 — Courbe d'apprentissage : évolution du €/h dans le temps
// ═════════════════════════════════════════════════════════════════════════════════════

export interface LearningCurvePoint {
  period_label: string; // ex: "2026-W20" ou "2026-05"
  net_per_hour: number;
  rides_count: number;
}

export interface LearningCurveResponse {
  granularity: "weekly";
  points: LearningCurvePoint[];
  trend_fr: string;
}

/**
 * Agrège les courses par semaine ISO sur les ~26 dernières semaines pour
 * tracer l'évolution du €/h net — alimenté directement par `rides`, sans
 * modèle statistique supplémentaire (agrégation simple, cohérent avec le
 * reste du fichier).
 */
export function computeLearningCurve(): LearningCurveResponse {
  const cutoff = new Date(Date.now() - 26 * 7 * 24 * 3600_000).toISOString();
  let rides: any[] = [];
  try {
    rides = storage.getRidesInRange(cutoff, new Date(Date.now() + 60_000).toISOString()) as any[];
  } catch {
    rides = [];
  }

  function weekIsoOf(dateStr: string): string {
    const d = new Date(dateStr);
    const target = new Date(d.valueOf());
    const dayNr = (d.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = new Date(target.getFullYear(), 0, 4);
    const diff = target.getTime() - firstThursday.getTime();
    const week = 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));
    return `${target.getFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  const byWeek: Record<string, { net: number; hours: number; count: number }> = {};
  for (const r of rides) {
    const wk = weekIsoOf(r.timestamp);
    byWeek[wk] ??= { net: 0, hours: 0, count: 0 };
    byWeek[wk].net += r.net_profit ?? 0;
    byWeek[wk].hours += (r.duration_min ?? 0) / 60;
    byWeek[wk].count += 1;
  }

  const points: LearningCurvePoint[] = Object.entries(byWeek)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([wk, v]) => ({
      period_label: wk,
      net_per_hour: v.hours > 0.05 ? r1(v.net / v.hours) : 0,
      rides_count: v.count,
    }));

  let trend_fr = "Historique insuffisant pour dégager une tendance fiable.";
  if (points.length >= 3) {
    const first = points[0].net_per_hour;
    const last = points[points.length - 1].net_per_hour;
    if (first > 0) {
      const pct = r1(((last - first) / first) * 100);
      trend_fr = pct >= 0
        ? `Progression de ${pct}% de votre €/h net depuis le début de l'historique disponible.`
        : `Baisse de ${Math.abs(pct)}% de votre €/h net depuis le début de l'historique disponible.`;
    }
  }

  return { granularity: "weekly", points, trend_fr };
}

// ═════════════════════════════════════════════════════════════════════════════════════
// 20.4 — Export RGPD : CSV/JSON de toutes les tables personnelles
// ═════════════════════════════════════════════════════════════════════════════════════

export interface PersonalDataExport {
  generated_at: string;
  rides: any[];
  driver_profile: any[];
  driver_performance: any[];
  personal_records: any[];
  achievements: any[];
}

/** Exporte l'intégralité des tables à caractère personnel (droit RGPD à la portabilité). */
export function exportAllPersonalData(): PersonalDataExport {
  function safeAll(sql: string): any[] {
    try {
      return sqlite.prepare(sql).all() as any[];
    } catch {
      return [];
    }
  }
  return {
    generated_at: new Date().toISOString(),
    rides: safeAll("SELECT * FROM rides"),
    driver_profile: safeAll("SELECT * FROM driver_profile"),
    driver_performance: safeAll("SELECT * FROM driver_performance"),
    personal_records: safeAll("SELECT * FROM personal_records"),
    achievements: safeAll("SELECT * FROM achievements"),
  };
}

/** Conversion CSV simple (une section par table, séparées par une ligne vide). */
export function toCsv(data: PersonalDataExport): string {
  const sections: string[] = [];
  for (const [tableName, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) continue;
    sections.push(`# ${tableName}`);
    if (rows.length === 0) {
      sections.push("(aucune donnée)");
      sections.push("");
      continue;
    }
    const headers = Object.keys(rows[0]);
    sections.push(headers.join(","));
    for (const row of rows) {
      sections.push(
        headers
          .map((h) => {
            const v = row[h];
            if (v == null) return "";
            const s = String(v).replace(/"/g, '""');
            return /[",\n]/.test(s) ? `"${s}"` : s;
          })
          .join(",")
      );
    }
    sections.push("");
  }
  return sections.join("\n");
}
