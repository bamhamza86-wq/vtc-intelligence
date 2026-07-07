/**
 * coachEngine.ts — Moteur IA conversationnel + Brief Matin/Soir (rapport.md §13)
 * ─────────────────────────────────────────────────────────────────────────────
 * Implémente :
 *   13.1 Questions vocales rapides pendant conduite ("combien j'ai fait",
 *        "où aller", "prochain gros") — étend voiceCommands.ts
 *   13.2 Brief matinal audio — texte à synthétiser côté client (SpeechSynthesis
 *        Web API native, zéro dépendance) — 5+ variantes de templates
 *   13.3 Débrief soir — réutilise computeEndShift (economicsEngine.ts)
 *   13.4 Assistant conversationnel étendu — enrichit answerCoachQuestion avec
 *        plus de patterns économiques (marge, break-even, dead-mileage, objectif)
 *
 * ZÉRO LLM, ZÉRO nouvelle dépendance npm. Réponses courtes (sécurité conduite,
 * cf. rapport.md §13.1 piège NHTSA "27 secondes de distraction résiduelle").
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { storage, getBestZoneNow, getNextPeakCountdown, getLastDriverGps } from "./storage";
import * as economicsEngine from "./economicsEngine";
import * as wowEngine from "./wowEngine";
import { getCachedWeather } from "./weatherService";
import { answerCoachQuestion as baseAnswerCoachQuestion, type CoachAnswer } from "./decisionEngine";
import { computeBusinessKpis, computePeerBenchmarkEcon } from "./healthMetrics";

const r1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function parisNow(): Date {
  return new Date();
}

function frDayName(d: Date = parisNow()): string {
  return ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"][d.getDay()];
}

// ═════════════════════════════════════════════════════════════════════════════
// 13.1 — Questions vocales rapides ("combien j'ai fait", "où aller", "prochain gros")
// ═════════════════════════════════════════════════════════════════════════════

export interface QuickVoiceQueryResult {
  ok: boolean;
  intent: string;
  spoken_text: string; // court, adapté à la synthèse vocale en conduite
  data?: Record<string, unknown>;
}

function normalizeQ(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Traite une question vocale rapide et renvoie une réponse COURTE (sécurité
 * conduite : jamais plus de 2 phrases, pas de saisie complexe demandée).
 */
export function answerQuickVoiceQuery(rawText: string): QuickVoiceQueryResult {
  const text = normalizeQ(rawText);

  if (!text) {
    return { ok: false, intent: "unknown", spoken_text: "Je n'ai pas compris la question." };
  }

  // Intent : "combien j'ai fait / gagné" aujourd'hui
  if (text.includes("combien") && (text.includes("fait") || text.includes("gagne") || text.includes("gagné") || text.includes("aujourd"))) {
    try {
      const summary = economicsEngine.computeEndShift();
      const spoken = summary.total_gross > 0
        ? `Aujourd'hui : ${summary.total_net} euros net pour ${summary.avg_hourly} euros par heure.`
        : "Pas encore de course enregistrée aujourd'hui.";
      return {
        ok: true,
        intent: "how_much_today",
        spoken_text: spoken,
        data: { total_net: summary.total_net, avg_hourly: summary.avg_hourly },
      };
    } catch {
      return { ok: false, intent: "how_much_today", spoken_text: "Impossible de calculer votre bilan pour le moment." };
    }
  }

  // Intent : "où aller" / "où je vais" / "prochaine zone"
  if (text.includes("ou aller") || text.includes("ou je vais") || text.includes("prochaine zone") || text.includes("ou partir")) {
    try {
      const pos = getLastDriverGps();
      const lat = pos?.lat ?? 48.8566;
      const lng = pos?.lng ?? 2.3522;
      const best = getBestZoneNow(lat, lng);
      const zoneName = best?.name ?? null;
      const spoken = zoneName
        ? `Direction ${zoneName}, c'est la zone la plus prometteuse actuellement.`
        : "Aucune zone particulièrement prometteuse détectée pour l'instant, restez disponible.";
      return { ok: true, intent: "where_to_go", spoken_text: spoken, data: { zone: zoneName } };
    } catch {
      return { ok: false, intent: "where_to_go", spoken_text: "Impossible de calculer une recommandation de zone pour le moment." };
    }
  }

  // Intent : "prochain gros" (prochaine grosse course / pic de demande)
  if (text.includes("prochain gros") || text.includes("prochain pic") || text.includes("gros creneau") || text.includes("quand ca va reprendre")) {
    try {
      const countdown = getNextPeakCountdown();
      if (countdown && countdown.minutes_until != null) {
        const spoken = `Prochain pic de demande dans environ ${countdown.minutes_until} minutes.`;
        return { ok: true, intent: "next_peak", spoken_text: spoken, data: countdown };
      }
      return { ok: true, intent: "next_peak", spoken_text: "Aucun pic de demande majeur détecté dans l'heure qui vient." };
    } catch {
      return { ok: false, intent: "next_peak", spoken_text: "Impossible de calculer le prochain pic pour le moment." };
    }
  }

  // Intent : "cette course est rentable" / "je prends"
  if (text.includes("rentable") || text.includes("je prends") || text.includes("j accepte")) {
    return {
      ok: true,
      intent: "profitability_hint_generic",
      spoken_text: "Utilisez le simulateur de course dans l'application pour une réponse précise, hors conduite.",
    };
  }

  // Intent : pause / fatigue rapide
  if (text.includes("pause") || text.includes("fatigue")) {
    return { ok: true, intent: "pause_reminder", spoken_text: "Pensez à faire une pause de 15 minutes toutes les deux heures." };
  }

  // Intent : objectif du jour
  if (text.includes("objectif")) {
    try {
      const profile: any = storage.getDriverProfile() || {};
      const target = profile.hourly_target_income ?? 35;
      return { ok: true, intent: "goal_hint", spoken_text: `Votre objectif horaire actuel est de ${target} euros par heure.` };
    } catch {
      return { ok: false, intent: "goal_hint", spoken_text: "Objectif non configuré." };
    }
  }

  return { ok: false, intent: "unknown", spoken_text: "Commande non reconnue. Essayez : combien j'ai fait, où aller, ou prochain gros." };
}

// ═════════════════════════════════════════════════════════════════════════════
// 13.2 — Brief matinal audio (5+ variantes de templates déterministes)
// ═════════════════════════════════════════════════════════════════════════════

export interface MorningBriefResponse {
  text: string; // texte à passer à window.speechSynthesis côté client
  variant_used: number;
  generated_at: string;
}

function frWeatherPhrase(): { tempC: number | null; condition: string } {
  const w = getCachedWeather();
  if (!w) return { tempC: null, condition: "stable" };
  return { tempC: (w as any).temp_c ?? (w as any).temperature ?? null, condition: w.description ?? "stable" };
}

const MORNING_BRIEF_TEMPLATES: Array<(ctx: {
  day: string;
  tempC: number | null;
  condition: string;
  goalEur: number;
  goalHours: number;
  zone: string;
  streak: number;
}) => string> = [
  (c) =>
    `Bonjour. Aujourd'hui ${c.day}, météo ${c.tempC != null ? Math.round(c.tempC) + "°C" : ""} ${c.condition}. ` +
    `Objectif recommandé : ${c.goalEur}€ en ${c.goalHours}h. Zone à privilégier ce matin : ${c.zone}. Bonne journée.`,
  (c) =>
    `Salut ! On est ${c.day}. Il fait ${c.tempC != null ? Math.round(c.tempC) + "°C" : "doux"}, ${c.condition}. ` +
    `Visez ${c.goalEur} euros sur environ ${c.goalHours} heures aujourd'hui. Commencez plutôt vers ${c.zone}. Bonne route.`,
  (c) =>
    `Bonjour, voici votre brief du ${c.day}. Conditions météo : ${c.condition}${c.tempC != null ? `, ${Math.round(c.tempC)}°C` : ""}. ` +
    `Votre cap du jour : ${c.goalEur}€ net en ${c.goalHours} heures de conduite. ${c.zone} semble la zone la plus active. Bonne journée sur la route.`,
  (c) =>
    `${c.day.charAt(0).toUpperCase() + c.day.slice(1)}, c'est parti. ${c.condition}${c.tempC != null ? ` et ${Math.round(c.tempC)}°C` : ""} aujourd'hui. ` +
    `Objectif suggéré : ${c.goalEur}€ pour ${c.goalHours}h de route. Direction ${c.zone} pour bien démarrer.` +
    (c.streak > 0 ? ` Vous êtes à ${c.streak} jours de série active, continuez.` : ""),
  (c) =>
    `Bonjour et bonne route. Nous sommes ${c.day}, ${c.condition}${c.tempC != null ? ` avec ${Math.round(c.tempC)}°C` : ""}. ` +
    `Pour aujourd'hui, ${c.goalEur}€ en ${c.goalHours}h est un objectif réaliste. Pensez à ${c.zone} en début de service.`,
  (c) =>
    `Nouveau jour, nouvelle route : ${c.day}. Météo ${c.condition}${c.tempC != null ? `, ${Math.round(c.tempC)}°C` : ""}. ` +
    `Cap recommandé : ${c.goalEur} euros net sur ${c.goalHours} heures. ${c.zone} est la zone à privilégier pour démarrer. Bonne journée !`,
];

export function getMorningBriefSpoken(userId?: string): MorningBriefResponse {
  const now = parisNow();
  const day = frDayName(now);
  const { tempC, condition } = frWeatherPhrase();

  let goalEur = 150;
  let goalHours = 8;
  try {
    const profile: any = storage.getDriverProfile() || {};
    goalHours = 8;
    goalEur = r1((profile.hourly_target_income ?? 35) * goalHours * 0.7); // objectif réaliste net, pas brut théorique
  } catch {
    /* défauts conservés */
  }

  let zone = "les zones habituelles";
  try {
    const hour = now.getHours();
    const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";
    const top = storage.getTopZones(hour, dayType, 1) ?? [];
    if (Array.isArray(top) && top.length > 0) {
      zone = (top[0] as any).name ?? (top[0] as any).zone_id ?? zone;
    }
  } catch {
    /* défaut conservé */
  }

  let streak = 0;
  try {
    streak = wowEngine.getStreakStatus().current;
  } catch {
    streak = 0;
  }

  // Sélection déterministe de variante (jour du mois → toujours la même variante un jour donné, mais tourne)
  const variantIdx = now.getDate() % MORNING_BRIEF_TEMPLATES.length;
  const text = MORNING_BRIEF_TEMPLATES[variantIdx]({ day, tempC, condition, goalEur, goalHours, zone, streak });

  return { text, variant_used: variantIdx, generated_at: now.toISOString() };
}

// ═════════════════════════════════════════════════════════════════════════════
// 13.3 — Débrief soir (réutilise computeEndShift)
// ═════════════════════════════════════════════════════════════════════════════

export interface EveningDebriefResponse {
  text: string;
  stats: economicsEngine.EndShiftSummary;
  generated_at: string;
}

const EVENING_DEBRIEF_TEMPLATES: Array<(ctx: {
  rides: number;
  gross: number;
  net: number;
  hourly: number;
  peerDeltaPct: number | null;
  restHours: number;
}) => string> = [
  (c) =>
    `Journée terminée. ${c.rides} courses, ${c.gross}€ brut, ${c.hourly}€/h net. ` +
    (c.peerDeltaPct != null ? `${c.peerDeltaPct >= 0 ? "Au-dessus" : "En dessous"} de votre moyenne habituelle de ${Math.abs(c.peerDeltaPct)}%. ` : "") +
    `Repos recommandé : ${c.restHours}h.`,
  (c) =>
    `Bilan du jour : ${c.rides} course${c.rides > 1 ? "s" : ""} pour ${c.net}€ net, soit ${c.hourly}€ par heure. ` +
    (c.peerDeltaPct != null ? `C'est ${c.peerDeltaPct >= 0 ? "mieux" : "moins bien"} que d'habitude (${c.peerDeltaPct}%). ` : "") +
    `Pensez à un repos d'au moins ${c.restHours} heures avant de reprendre.`,
  (c) =>
    `Fin de service. Vous avez fait ${c.rides} courses, ${c.gross}€ de chiffre d'affaires, ${c.net}€ net en poche. ` +
    `Rendement horaire : ${c.hourly}€/h. Reposez-vous ${c.restHours}h pour repartir en forme.`,
];

export function getEveningDebriefSpoken(dateStr?: string): EveningDebriefResponse {
  const stats = economicsEngine.computeEndShift(dateStr);

  let peerDeltaPct: number | null = null;
  try {
    const bench = computePeerBenchmarkEcon();
    if (bench.median_net_per_hour) {
      peerDeltaPct = bench.median_net_per_hour > 0 ? r1(((stats.avg_hourly - bench.median_net_per_hour) / bench.median_net_per_hour) * 100) : null;
    }
  } catch {
    peerDeltaPct = null;
  }

  // Heures de repos légal recommandées : proportionnel au temps roulé (proxy simple, cohérent fatigueCoach)
  const drivenHours = stats.total_gross > 0 ? Math.max(4, Math.min(11, stats.avg_hourly > 0 ? stats.total_net / stats.avg_hourly : 8)) : 0;
  const restHours = drivenHours >= 9 ? 11 : drivenHours >= 6 ? 9 : 8;

  const rideCountForVariant = Math.max(1, stats.total_gross > 0 ? Math.round(stats.total_net) : 0);
  const variantIdx = rideCountForVariant % EVENING_DEBRIEF_TEMPLATES.length;

  const text = stats.total_gross === 0
    ? "Aucune course enregistrée aujourd'hui. Reposez-vous bien, à demain sur la route."
    : EVENING_DEBRIEF_TEMPLATES[variantIdx]({
        rides: (stats as any).rides_count ?? 0,
        gross: stats.total_gross,
        net: stats.total_net,
        hourly: stats.avg_hourly,
        peerDeltaPct,
        restHours,
      });

  return { text, stats, generated_at: new Date().toISOString() };
}

// ═════════════════════════════════════════════════════════════════════════════
// 13.4 — Assistant conversationnel étendu (plus de patterns économiques)
// ═════════════════════════════════════════════════════════════════════════════

export interface ExtendedCoachAnswer extends CoachAnswer {
  computed?: Record<string, number | string>;
}

/**
 * Étend answerCoachQuestion (decisionEngine.ts) avec des patterns économiques
 * supplémentaires calculés en direct (marge, break-even, dead-mileage,
 * objectif, comparaison peer) avant de retomber sur le matching FAQ existant.
 */
export function answerCoachQuestionExtended(question: string): ExtendedCoachAnswer {
  const q = normalizeQ(question);

  // Pattern : marge nette actuelle / rentabilité du jour
  if ((q.includes("marge") || q.includes("rentable")) && !q.includes("cette course")) {
    try {
      const breakEven = economicsEngine.computeBreakEven();
      return {
        answer_fr: `Votre rendement horaire actuel est de ${breakEven.current_hourly_this_shift}€/h, pour un seuil de rentabilité de ${breakEven.min_hourly_to_profit}€/h ` +
          `(écart : ${breakEven.delta >= 0 ? "+" : ""}${breakEven.delta}€/h). ${breakEven.status === "red" ? "Vous êtes sous le seuil, envisagez de changer de zone." : breakEven.status === "warning" ? "Vous êtes proche du seuil, restez attentif." : "Vous êtes au-dessus du seuil, continuez ainsi."}`,
        computed: { current_hourly: breakEven.current_hourly_this_shift, min_hourly: breakEven.min_hourly_to_profit, delta: breakEven.delta },
        sources: [],
        confidence: 0.85,
      };
    } catch {
      /* fallback générique plus bas */
    }
  }

  // Pattern : kilomètres à vide / dead mileage
  if (q.includes("km a vide") || q.includes("kilometre a vide") || q.includes("dead") || q.includes("retour a vide")) {
    try {
      const kpis = computeBusinessKpis();
      const w30 = kpis.windows["30j"];
      return {
        answer_fr: `Sur les 30 derniers jours, votre part de kilomètres à vide est estimée à ${w30.dead_km_ratio_pct}% de votre kilométrage total. ` +
          `Réduire ce ratio améliore directement votre €/km net.`,
        computed: { dead_km_ratio_pct: w30.dead_km_ratio_pct },
        sources: [],
        confidence: 0.7,
      };
    } catch {
      /* fallback générique plus bas */
    }
  }

  // Pattern : objectif du jour / de la semaine
  if (q.includes("objectif")) {
    try {
      const profile: any = storage.getDriverProfile() || {};
      const target = profile.hourly_target_income ?? 35;
      const stats = economicsEngine.computeEndShift();
      const remaining = Math.max(0, r2(target * 8 * 0.7 - stats.total_net));
      return {
        answer_fr: `Votre objectif horaire est de ${target}€/h. Aujourd'hui vous avez déjà réalisé ${stats.total_net}€ net — ` +
          `il vous reste environ ${remaining}€ pour atteindre un objectif journalier réaliste.`,
        computed: { target_hourly: target, net_today: stats.total_net, remaining_estimate: remaining },
        sources: [],
        confidence: 0.75,
      };
    } catch {
      /* fallback générique plus bas */
    }
  }

  // Pattern : comparaison aux autres / peer
  if (q.includes("autres chauffeurs") || q.includes("comparaison") || q.includes("moyenne")) {
    try {
      const bench = computePeerBenchmarkEcon();
      if (bench.median_net_per_hour == null) {
        return {
          answer_fr: "Pas encore assez d'historique personnel pour établir une comparaison fiable et anonyme.",
          sources: [],
          confidence: 0.4,
        };
      }
      return {
        answer_fr: `Votre rendement horaire (${bench.my_net_per_hour}€/h) se situe ${bench.percentile_estimate != null ? `au ${bench.percentile_estimate}e percentile` : ""} de votre historique. ` +
          `Médiane : ${bench.median_net_per_hour}€/h, top 25% : ${bench.top25_net_per_hour}€/h.`,
        computed: { my_net_per_hour: bench.my_net_per_hour, median: bench.median_net_per_hour ?? 0, top25: bench.top25_net_per_hour ?? 0 },
        sources: [],
        confidence: 0.8,
      };
    } catch {
      /* fallback générique plus bas */
    }
  }

  // Fallback : coach générique existant (decisionEngine.ts, FAQ fiscal/métier)
  return baseAnswerCoachQuestion(question);
}
