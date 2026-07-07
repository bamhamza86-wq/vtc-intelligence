/**
 * uxEngine.ts — Couche « UX Avancée & Benchmark » (rapport.md §10.3, §10.9,
 * §11.3, §11.7, §15 wow#13, §6.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Regroupe les mécaniques ajoutées par cette mission :
 *   1. Benchmark anonymisé peer ("chauffeurs comme vous") — wow#13, k-anonymat ≥5
 *   2. Onboarding progressif (table onboarding_progress) — §11.3
 *   3. Bornes de recharge — fallback IDF (§6.4), voir chargingStationsIDF.ts
 *   4. Web Push (résumé glancable via notification enrichie) — §10.9
 *   5. Widget résumé compact (quick-summary) — pour QuickSummaryPill
 *
 * RGPD : le benchmark n'agrège JAMAIS de données individuelles identifiables.
 * Il compare la période courante du chauffeur à la distribution statistique
 * de ses propres périodes historiques (driver_performance) — seule source de
 * "pairs" disponible dans cette instance mono-chauffeur — et applique un seuil
 * strict de k-anonymat (≥5 échantillons) avant de renvoyer un résultat. En
 * dessous du seuil, l'API renvoie explicitement `null` plutôt qu'une valeur
 * peu fiable ou ré-identifiable. Toujours masquable côté client (RGPD strict).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sqlite } from "./storage";

const K_ANONYMITY_MIN = 5;

// ─── Schéma DB additif ──────────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS onboarding_progress (
    user_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (user_id, step_key)
  );
`);

export const ONBOARDING_STEPS = [
  "welcome",
  "first_ride",
  "profile_setup",
  "discover_map",
  "try_focus",
  "try_bilan",
  "community_signal",
  "first_streak",
] as const;

export type OnboardingStepKey = typeof ONBOARDING_STEPS[number];

const DEFAULT_USER_ID = "driver_default";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Benchmark anonymisé peer — "Les chauffeurs comme vous..." (wow#13)
// ─────────────────────────────────────────────────────────────────────────────

export interface PeerBenchmark {
  my_stats: {
    hourly: number;
    rides_per_day: number;
    net_per_km: number;
  };
  peers_avg: {
    hourly: number;
    rides_per_day: number;
    net_per_km: number;
    k_anonymity: number;
  } | null;
  delta_pct: number | null;
  best_hour_peers: number | null;
  most_profitable_zone_peers: string | null;
  disclaimer: string;
}

/**
 * Agrège les périodes "daily" de driver_performance (hors la plus récente,
 * qui représente "mes stats" courantes) pour constituer la population de
 * référence ("les chauffeurs comme vous"). Renvoie `peers_avg: null` si moins
 * de K_ANONYMITY_MIN échantillons — jamais de valeur peu fiable exposée.
 */
export function computePeerBenchmark(): PeerBenchmark {
  const dailyRows = sqlite
    .prepare(
      `SELECT period_date, total_rides, total_km, total_net_eur, avg_hourly_rate
       FROM driver_performance
       WHERE period = 'daily'
       ORDER BY period_date DESC`
    )
    .all() as Array<{
    period_date: string;
    total_rides: number;
    total_km: number;
    total_net_eur: number;
    avg_hourly_rate: number;
  }>;

  // "Mes stats" = la période la plus récente (aujourd'hui / dernier jour connu).
  const mine = dailyRows[0];
  const myHourly = mine?.avg_hourly_rate ?? 0;
  const myRidesPerDay = mine?.total_rides ?? 0;
  const myNetPerKm = mine && mine.total_km > 0 ? mine.total_net_eur / mine.total_km : 0;

  // Population de référence = le reste de l'historique (proxy "pairs" dans une
  // instance mono-chauffeur — cf. note RGPD en tête de fichier).
  const peerRows = dailyRows.slice(1).filter((r) => r.total_rides > 0);
  const kAnon = peerRows.length;

  let peersAvg: PeerBenchmark["peers_avg"] = null;
  let deltaPct: number | null = null;

  if (kAnon >= K_ANONYMITY_MIN) {
    const avgHourly = peerRows.reduce((s, r) => s + r.avg_hourly_rate, 0) / kAnon;
    const avgRidesPerDay = peerRows.reduce((s, r) => s + r.total_rides, 0) / kAnon;
    const totalKm = peerRows.reduce((s, r) => s + r.total_km, 0);
    const totalNet = peerRows.reduce((s, r) => s + r.total_net_eur, 0);
    const avgNetPerKm = totalKm > 0 ? totalNet / totalKm : 0;

    peersAvg = {
      hourly: Math.round(avgHourly * 100) / 100,
      rides_per_day: Math.round(avgRidesPerDay * 10) / 10,
      net_per_km: Math.round(avgNetPerKm * 100) / 100,
      k_anonymity: kAnon,
    };

    deltaPct = avgHourly > 0 ? Math.round(((myHourly - avgHourly) / avgHourly) * 1000) / 10 : null;
  }

  // Meilleure heure / zone constatées côté pairs — dérivées de profitability_scores
  // (agrégat structurel, pas de donnée individuelle) si k-anonymat suffisant.
  let bestHourPeers: number | null = null;
  let mostProfitableZonePeers: string | null = null;

  if (kAnon >= K_ANONYMITY_MIN) {
    const bestHourRow = sqlite
      .prepare(
        `SELECT hour, AVG(profitability_index) AS avg_pi
         FROM profitability_scores
         GROUP BY hour
         ORDER BY avg_pi DESC
         LIMIT 1`
      )
      .get() as { hour: number; avg_pi: number } | undefined;
    bestHourPeers = bestHourRow ? bestHourRow.hour : null;

    const bestZoneRow = sqlite
      .prepare(
        `SELECT z.name AS name, AVG(p.profitability_index) AS avg_pi
         FROM profitability_scores p
         JOIN zones z ON z.id = p.zone_id
         GROUP BY p.zone_id
         ORDER BY avg_pi DESC
         LIMIT 1`
      )
      .get() as { name: string; avg_pi: number } | undefined;
    mostProfitableZonePeers = bestZoneRow ? bestZoneRow.name : null;
  }

  return {
    my_stats: {
      hourly: Math.round(myHourly * 100) / 100,
      rides_per_day: myRidesPerDay,
      net_per_km: Math.round(myNetPerKm * 100) / 100,
    },
    peers_avg: peersAvg,
    delta_pct: deltaPct,
    best_hour_peers: bestHourPeers,
    most_profitable_zone_peers: mostProfitableZonePeers,
    disclaimer:
      "Agrégat statistique anonymisé — k-anonymat ≥ 5, aucune donnée individuelle identifiable n'est utilisée ou affichée.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Onboarding progressif (§11.3) — steps étalés, jamais tout d'un coup
// ─────────────────────────────────────────────────────────────────────────────

export interface OnboardingProgressResponse {
  steps: OnboardingStepKey[];
  completed: Record<string, string>; // step_key -> completed_at ISO
  next_step: OnboardingStepKey | null;
  is_complete: boolean;
}

export function getOnboardingProgress(userId: string = DEFAULT_USER_ID): OnboardingProgressResponse {
  const rows = sqlite
    .prepare(`SELECT step_key, completed_at FROM onboarding_progress WHERE user_id = ?`)
    .all(userId) as Array<{ step_key: string; completed_at: string }>;

  const completed: Record<string, string> = {};
  for (const r of rows) completed[r.step_key] = r.completed_at;

  const nextStep = ONBOARDING_STEPS.find((s) => !completed[s]) ?? null;

  return {
    steps: [...ONBOARDING_STEPS],
    completed,
    next_step: nextStep,
    is_complete: nextStep === null,
  };
}

export function markOnboardingStepDone(stepKey: string, userId: string = DEFAULT_USER_ID): OnboardingProgressResponse {
  if (!ONBOARDING_STEPS.includes(stepKey as OnboardingStepKey)) {
    throw new Error(`step_key invalide : ${stepKey}`);
  }
  sqlite
    .prepare(
      `INSERT INTO onboarding_progress (user_id, step_key, completed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, step_key) DO UPDATE SET completed_at = excluded.completed_at`
    )
    .run(userId, stepKey, new Date().toISOString());

  return getOnboardingProgress(userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Web Push — infos d'abonnement (placeholder VAPID, à remplir plus tard)
// ─────────────────────────────────────────────────────────────────────────────

export interface PushSubscribeInfo {
  vapid_public_key: string | null;
  push_supported_hint: boolean;
  endpoint_subscribe_url: string;
  note: string;
}

export function getPushSubscribeInfo(): PushSubscribeInfo {
  return {
    // Placeholder — à remplacer par une vraie clé VAPID publique générée côté
    // serveur (web-push) lorsque l'infra d'envoi sera branchée. Tant que cette
    // valeur est null, le client sait qu'il doit rester en mode notification
    // locale uniquement (Notification API), sans tenter de PushManager.subscribe().
    vapid_public_key: process.env.VAPID_PUBLIC_KEY || null,
    push_supported_hint: true,
    endpoint_subscribe_url: "/api/push/subscribe-info",
    note:
      "Clé VAPID non configurée pour l'instant — les notifications enrichies fonctionnent en local (Notification API) via le service worker. Le push serveur sera activé ultérieurement.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Widget résumé compact (quick-summary) — pour QuickSummaryPill
// ─────────────────────────────────────────────────────────────────────────────

export interface QuickSummary {
  net_today: number;
  rides_today: number;
  current_hourly: number;
  streak: number;
  next_event_hint: string | null;
}

export function computeQuickSummary(): QuickSummary {
  const todayIso = new Date().toISOString().slice(0, 10);

  const todayRow = sqlite
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(net_profit), 0) AS net_total
       FROM rides
       WHERE date(timestamp) = ?`
    )
    .get(todayIso) as { n: number; net_total: number };

  const avgHourlyRow = sqlite
    .prepare(
      `SELECT COALESCE(AVG(hourly_rate), 0) AS avg_hourly
       FROM rides
       WHERE date(timestamp) = ?`
    )
    .get(todayIso) as { avg_hourly: number };

  let streak = 0;
  try {
    const streakRow = sqlite
      .prepare(`SELECT current_streak FROM streaks WHERE user_id = ?`)
      .get(DEFAULT_USER_ID) as { current_streak: number } | undefined;
    streak = streakRow?.current_streak ?? 0;
  } catch {
    // table streaks pas encore initialisée (ordre de chargement des modules) — ignore
    streak = 0;
  }

  // Petit indice contextuel — prochain événement actif le plus proche, sans détail sensible.
  let nextEventHint: string | null = null;
  try {
    const evt = sqlite
      .prepare(
        `SELECT name FROM events WHERE is_active = 1 AND start_time > datetime('now') ORDER BY start_time ASC LIMIT 1`
      )
      .get() as { name: string } | undefined;
    nextEventHint = evt?.name ?? null;
  } catch {
    nextEventHint = null;
  }

  return {
    net_today: Math.round(todayRow.net_total * 100) / 100,
    rides_today: todayRow.n,
    current_hourly: Math.round(avgHourlyRow.avg_hourly * 100) / 100,
    streak,
    next_event_hint: nextEventHint,
  };
}
