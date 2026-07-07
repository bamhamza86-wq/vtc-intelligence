/**
 * decisionEngine.ts — Couche Décision Avancée (Trip-chaining, What-If, Coach)
 * ─────────────────────────────────────────────────────────────────────────────
 * Implémente rapport.md §3.2 (chaînage multi-courses), §3.3 (simulateur What-If),
 * §3.6 (alerte contre-intuition), §12.2/§12.4 (coach conversationnel + assistant
 * fiscal templates), et l'auto-tips proactif.
 *
 * Principe (comme focusEngine.ts / economicsEngine.ts) : AUCUN nouveau modèle de
 * scoring — on réutilise storage.ts (profitability, événements, zones, rides,
 * community) et economicsEngine.ts (coût réel au km). Le coach est 100% template
 * (pas de LLM), cf. contrainte dure "ZÉRO nouvelle dépendance npm".
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { storage, getNextPeakCountdown } from "./storage";
import * as economicsEngine from "./economicsEngine";
import { TVA, URSSAF } from "./taxConstants";
import { getAvoidZones } from "./communityEngine";
import { matchCoachTemplate, COACH_FALLBACK_ANSWER, type CoachSource } from "./coachTemplates";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

function estimateEtaMin(distanceKm: number): number {
  const AVG_SPEED_KMH = 28; // moyenne urbaine IDF, cohérent avec focusEngine (30) et economicsEngine (22 dense)
  return Math.max(2, Math.round((distanceKm / AVG_SPEED_KMH) * 60));
}

function currentHourAndDayType(hourOverride?: number): { hour: number; dayType: string } {
  const now = new Date();
  const hour = hourOverride ?? (now.getUTCHours() + 2) % 24;
  const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";
  return { hour, dayType };
}

function estimateGainLowEuros(score: number, longRideProbability: number): number {
  const BASE_FARE = 5;
  const PRICE_PER_KM = 1.4;
  const avgDistanceKm = 5;
  const longRideBonus = longRideProbability > 0.4 ? longRideProbability * 6 : 0;
  const surgeFactor = Math.max(1, score / 60);
  const gross = (BASE_FARE + PRICE_PER_KM * avgDistanceKm + longRideBonus) * Math.min(surgeFactor, 1.3);
  return Math.round(gross);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. TRIP-CHAINING — rapport.md §3.2
// ═════════════════════════════════════════════════════════════════════════════

export interface TripChainStep {
  zone_id: string | null;
  zone_name: string;
  distance_km: number;
  eta_min: number;
  expected_net_eur: number;
  score: number;
}

export interface TripChain {
  zone_a: TripChainStep; // destination probable n°1 (première étape depuis l'origine)
  zone_b: TripChainStep; // 2e étape (next-best depuis A)
  zone_c: TripChainStep | null; // 3e étape optionnelle (next-best depuis B)
  total_expected_net: number;
  total_duration_min: number;
  confidence: number;
  reasoning_fr: string;
}

interface ScoredZone {
  zoneId: string;
  zoneName: string;
  lat: number;
  lng: number;
  score: number;
  longRideProbability: number;
  isCommunityHot: boolean;
  hasEvent: boolean;
}

/** Calcule les zones scorées pour une heure/jour donnés, enrichies communauté + événements. */
function computeScoredZones(hour: number, dayType: string): ScoredZone[] {
  const scores = (storage.getProfitabilityByHour(hour, dayType) as any[]) || [];
  const zones = (storage.getAllZones() as any[]) || [];
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const activeEvents = (storage.getActiveEvents() as any[]) || [];
  const avoid = new Set(getAvoidZones(20).map((a) => a.zone_id));

  return scores
    .map((s) => {
      const zone = zoneById.get(s.zone_id);
      const hasEvent = activeEvents.some((e) => e.zone_id === s.zone_id && (e.demand_boost ?? 1) > 1.1);
      const isCommunityHot = !avoid.has(s.zone_id);
      let score = s.profitability_index ?? 0;
      if (hasEvent) score *= 1.15;
      if (!isCommunityHot) score *= 0.5; // pénalité zone signalée "à éviter"
      return {
        zoneId: s.zone_id as string,
        zoneName: (s.zone_name ?? zone?.name ?? s.zone_id) as string,
        lat: zone?.lat ?? s.lat ?? 48.8566,
        lng: zone?.lng ?? s.lng ?? 2.3522,
        score,
        longRideProbability: s.long_ride_probability ?? 0,
        isCommunityHot,
        hasEvent,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function toStep(from: { lat: number; lng: number }, z: ScoredZone): TripChainStep {
  const distanceKm = haversineKm(from.lat, from.lng, z.lat, z.lng);
  return {
    zone_id: z.zoneId,
    zone_name: z.zoneName,
    distance_km: distanceKm,
    eta_min: estimateEtaMin(distanceKm),
    expected_net_eur: estimateGainLowEuros(z.score, z.longRideProbability),
    score: Math.round(z.score),
  };
}

export interface TripChainResult {
  chains: TripChain[];
  best_chain_index: number;
}

/**
 * Construit jusqu'à 3 chaînes de courses (A → B → C optionnel) à partir d'une
 * zone d'origine. Étape 1 : top-3 destinations probables depuis l'origine
 * (profitability + communauté + événements). Étape 2 : pour chaque destination,
 * top-2 next-steps (on ne garde que le meilleur pour C afin de limiter à 3 chaînes
 * lisibles, cf. piège rapport.md §3.3 : "limiter à 3 comparaisons max").
 */
export function computeTripChains(
  originLat: number,
  originLng: number,
  hour?: number,
  horizonMin = 90,
): TripChainResult {
  const { hour: h, dayType } = currentHourAndDayType(hour);
  const scored = computeScoredZones(h, dayType);

  if (scored.length === 0) {
    return { chains: [], best_chain_index: -1 };
  }

  const top3FromOrigin = scored.slice(0, 3);
  const chains: TripChain[] = [];

  for (const destA of top3FromOrigin) {
    const stepA = toStep({ lat: originLat, lng: originLng }, destA);

    // Top-2 next steps depuis A (hors A elle-même)
    const candidatesFromA = scored.filter((z) => z.zoneId !== destA.zoneId).slice(0, 2);
    if (candidatesFromA.length === 0) continue;
    const destB = candidatesFromA[0];
    const stepB = toStep({ lat: destA.lat, lng: destA.lng }, destB);

    // Étape C optionnelle si le budget horizon_min le permet encore
    let stepC: TripChainStep | null = null;
    const elapsedAfterB = stepA.eta_min + 15 /* durée course A estimée */ + stepB.eta_min + 15;
    if (elapsedAfterB < horizonMin) {
      const candidatesFromB = scored.filter((z) => z.zoneId !== destA.zoneId && z.zoneId !== destB.zoneId).slice(0, 1);
      if (candidatesFromB.length > 0) {
        stepC = toStep({ lat: destB.lat, lng: destB.lng }, candidatesFromB[0]);
      }
    }

    const total_expected_net = r2(stepA.expected_net_eur + stepB.expected_net_eur + (stepC?.expected_net_eur ?? 0));
    const RIDE_DURATION_ESTIMATE_MIN = 15; // durée moyenne d'une course une fois le client à bord
    const total_duration_min =
      stepA.eta_min + RIDE_DURATION_ESTIMATE_MIN + stepB.eta_min + RIDE_DURATION_ESTIMATE_MIN + (stepC ? stepC.eta_min + RIDE_DURATION_ESTIMATE_MIN : 0);

    const reasonParts: string[] = [];
    if (destA.hasEvent) reasonParts.push(`événement actif à ${destA.zoneName}`);
    if (destB.score > destA.score * 0.8) reasonParts.push(`${destB.zoneName} reste rentable en enchaînement`);
    if (!reasonParts.length) reasonParts.push(`meilleure rentabilité disponible dans un rayon de ${stepA.distance_km} km`);

    const confidence = Math.min(
      0.92,
      0.4 + (destA.hasEvent ? 0.15 : 0) + Math.min(destA.score, 100) / 300 + Math.min(destB.score, 100) / 400,
    );

    chains.push({
      zone_a: stepA,
      zone_b: stepB,
      zone_c: stepC,
      total_expected_net,
      total_duration_min,
      confidence: r2(confidence),
      reasoning_fr:
        `Enchaînement ${stepA.zone_name} → ${stepB.zone_name}` +
        (stepC ? ` → ${stepC.zone_name}` : "") +
        ` : ${reasonParts.join(", ")}. Net total estimé ${total_expected_net}€ sur environ ${total_duration_min} min.`,
    });
  }

  if (chains.length === 0) return { chains: [], best_chain_index: -1 };

  // Meilleure chaîne = meilleur rendement net/minute (pas juste le net brut, pour privilégier l'efficacité)
  let bestIdx = 0;
  let bestRate = -Infinity;
  chains.forEach((c, i) => {
    const rate = c.total_duration_min > 0 ? c.total_expected_net / c.total_duration_min : 0;
    if (rate > bestRate) {
      bestRate = rate;
      bestIdx = i;
    }
  });

  return { chains: chains.slice(0, 3), best_chain_index: bestIdx };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. SIMULATEUR WHAT-IF — rapport.md §3.3
// ═════════════════════════════════════════════════════════════════════════════

export interface WhatIfAction {
  type: "goto_zone" | "wait" | "take_ride";
  zone_id?: string;
  zone_name?: string;
  wait_min?: number;
  fare?: number;
  distance_km?: number;
  duration_min?: number;
  origin_lat?: number;
  origin_lng?: number;
}

export interface WhatIfScenario {
  label: string;
  action: WhatIfAction;
}

export interface WhatIfResult {
  label: string;
  expected_net_eur: number;
  expected_duration_min: number;
  delta_vs_current: number;
  factors_fr: string[];
  confidence: number;
}

/** Estime le résultat net € et la durée d'un scénario donné, en réutilisant le scoring existant. */
function evaluateScenario(scenario: WhatIfScenario, hour: number, dayType: string): WhatIfResult {
  const { action, label } = scenario;
  const factors: string[] = [];
  let expected_net_eur = 0;
  let expected_duration_min = 0;
  let confidence = 0.5;

  if (action.type === "wait") {
    const waitMin = action.wait_min ?? 10;
    // Attendre ne rapporte rien directement mais peut préserver l'accès à un pic proche.
    const nextPeak = (() => {
      try {
        return getNextPeakCountdown();
      } catch {
        return null;
      }
    })();
    expected_duration_min = waitMin;
    expected_net_eur = 0;
    confidence = 0.6;
    factors.push(`Immobilisation ${waitMin} min sans revenu direct`);
    if (nextPeak && nextPeak.minutes_until != null && nextPeak.minutes_until <= waitMin + 15) {
      factors.push(`Un pic de demande arrive dans ${nextPeak.minutes_until} min — attendre peut se justifier`);
      confidence = 0.7;
    } else {
      factors.push(`Aucun pic de demande imminent détecté — attendre est rarement optimal`);
    }
  } else if (action.type === "goto_zone") {
    const scored = computeScoredZones(hour, dayType);
    const target = action.zone_id
      ? scored.find((z) => z.zoneId === action.zone_id)
      : scored.find((z) => z.zoneName?.toLowerCase() === (action.zone_name ?? "").toLowerCase());

    if (!target) {
      factors.push("Zone inconnue ou pas de données de rentabilité disponibles");
      confidence = 0.2;
    } else {
      const originLat = action.origin_lat ?? 48.8566;
      const originLng = action.origin_lng ?? 2.3522;
      const distanceKm = haversineKm(originLat, originLng, target.lat, target.lng);
      const etaMin = estimateEtaMin(distanceKm);
      const RIDE_DURATION_ESTIMATE_MIN = 15;
      expected_duration_min = etaMin + RIDE_DURATION_ESTIMATE_MIN;
      expected_net_eur = estimateGainLowEuros(target.score, target.longRideProbability);
      // Coût du trajet à vide vers la zone (carburant/usure) déduit du gain net
      try {
        const costPerKm = economicsEngine.computeCostPerKm();
        expected_net_eur = r2(expected_net_eur - distanceKm * costPerKm.total_per_km);
      } catch {
        /* défensif */
      }
      confidence = Math.min(0.9, 0.4 + Math.min(target.score, 100) / 250);
      factors.push(`${etaMin} min de trajet vers ${target.zoneName} (${distanceKm} km)`);
      if (target.hasEvent) factors.push("Événement actif détecté dans cette zone");
      if (!target.isCommunityHot) factors.push("⚠️ Zone signalée par la communauté — rentabilité incertaine");
    }
  } else if (action.type === "take_ride") {
    const fare = action.fare ?? 0;
    const distanceKm = action.distance_km ?? 5;
    const durationMin = action.duration_min ?? estimateEtaMin(distanceKm) + 10;
    try {
      const margin = economicsEngine.computeRideMargin(fare, distanceKm);
      expected_net_eur = margin.net_final;
      factors.push(`Course ${fare}€ / ${distanceKm} km → net après coûts réels ${margin.net_final}€ (marge ${margin.margin_pct}%)`);
      confidence = 0.85;
    } catch {
      expected_net_eur = r2(fare * 0.75);
      factors.push("Estimation simplifiée (profil chauffeur non configuré)");
      confidence = 0.4;
    }
    expected_duration_min = durationMin;
  }

  return {
    label,
    expected_net_eur: r2(expected_net_eur),
    expected_duration_min: Math.round(expected_duration_min),
    delta_vs_current: 0, // rempli après coup par rapport au meilleur/à la baseline
    factors_fr: factors,
    confidence: r2(confidence),
  };
}

export function computeWhatIf(scenarios: WhatIfScenario[], hourOverride?: number): WhatIfResult[] {
  const { hour, dayType } = currentHourAndDayType(hourOverride);
  const limited = scenarios.slice(0, 3); // piège rapport.md §3.3 : max 3 scénarios pour rester lisible sur mobile
  const results = limited.map((s) => evaluateScenario(s, hour, dayType));

  // Calcule le "net par minute" pour comparer équitablement des scénarios de durées différentes,
  // puis dérive le delta par rapport au meilleur taux (rendement).
  const rates = results.map((r) => (r.expected_duration_min > 0 ? r.expected_net_eur / r.expected_duration_min : r.expected_net_eur));
  const bestRate = Math.max(...rates, 0);
  return results.map((r, i) => ({
    ...r,
    delta_vs_current: r2((rates[i] - bestRate) * (r.expected_duration_min || 1)),
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. ALERTE CONTRE-INTUITION — rapport.md §3.6
// ═════════════════════════════════════════════════════════════════════════════

export interface CounterIntuitionResult {
  verdict: "accept" | "refuse" | "careful";
  hidden_cost_eur: number;
  reason_fr: string;
  alternative_hint_fr: string;
}

export function computeCounterIntuition(
  fare: number,
  distanceKm: number,
  durationMin: number,
  dropoffZoneId?: string,
): CounterIntuitionResult {
  const zones = (storage.getAllZones() as any[]) || [];
  const dropoffZone = zones.find((z) => z.id === dropoffZoneId);
  const avoidZones = getAvoidZones(20);
  const isDropoffAvoided = dropoffZone ? avoidZones.some((a) => a.zone_id === dropoffZone.id) : false;

  // Coût réel au km + estimation trajet retour vers une zone chaude
  let costPerKm = 0.35;
  try {
    costPerKm = economicsEngine.computeCostPerKm().total_per_km;
  } catch {
    /* profil non configuré, valeur par défaut IDF conservatrice */
  }

  // Distance de retour estimée vers le centre de gravité de la demande (Paris intra-muros ~48.8566, 2.3522)
  // si la zone de dépose n'a pas de zone chaude proche connue.
  const hour = currentHourAndDayType().hour;
  const scored = computeScoredZones(hour, currentHourAndDayType().dayType);
  const nearestHotZone = dropoffZone
    ? scored
        .map((z) => ({ ...z, distToDropoff: haversineKm(dropoffZone.lat, dropoffZone.lng, z.lat, z.lng) }))
        .sort((a, b) => a.distToDropoff - b.distToDropoff)[0]
    : null;

  const returnDistanceKm = nearestHotZone ? nearestHotZone.distToDropoff : 8; // 8km par défaut si zone inconnue
  const returnCostEur = r2(returnDistanceKm * costPerKm);
  const returnTimeMin = estimateEtaMin(returnDistanceKm);
  const timeLostOpportunityEur = r2((returnTimeMin / 60) * 15); // 15€/h de manque à gagner pendant le retour à vide

  const hidden_cost_eur = r2(returnCostEur + timeLostOpportunityEur);
  const netAfterHiddenCost = r2(fare - hidden_cost_eur);
  const farePerKm = distanceKm > 0 ? fare / distanceKm : 0;

  // Alternative disponible dans les 5 min : on regarde si une zone à forte score est proche du point de départ
  // (proxy simple : le nearestHotZone est-il proche du dropoff, càd retour rapide possible)
  const alternativeAvailableSoon = returnTimeMin <= 15 && (nearestHotZone?.score ?? 0) > 40;

  let verdict: CounterIntuitionResult["verdict"] = "accept";
  const reasonParts: string[] = [];

  if (isDropoffAvoided) {
    verdict = "refuse";
    reasonParts.push(`la zone de dépose (${dropoffZone?.name ?? dropoffZoneId}) est signalée par la communauté comme peu rentable ou à risque`);
  } else if (distanceKm < 3 && durationMin < 10 && fare < 10) {
    verdict = "careful";
    reasonParts.push("course courte à faible tarif — le retour à vide peut annuler le bénéfice");
  } else if (netAfterHiddenCost < fare * 0.5) {
    verdict = "careful";
    reasonParts.push(`le coût caché du retour (${hidden_cost_eur}€) réduit fortement le gain net réel`);
  } else if (farePerKm < 1.0 && distanceKm > 15) {
    verdict = "careful";
    reasonParts.push("aller simple long à faible tarif au km — risque de zone isolée à l'arrivée");
  }

  if (nearestHotZone && returnDistanceKm > 10) {
    reasonParts.push(`la zone rentable la plus proche est à ${returnDistanceKm} km (${nearestHotZone.zoneName})`);
  }

  if (reasonParts.length === 0) {
    reasonParts.push("aucun piège détecté — course cohérente avec un retour raisonnable vers une zone active");
  }

  const alternative_hint_fr = alternativeAvailableSoon
    ? `Une alternative plus rentable existe à ${returnTimeMin} min (${nearestHotZone?.zoneName}) — envisagez de vous y repositionner après cette course.`
    : verdict !== "accept"
    ? "Aucune alternative immédiate détectée — évaluez si le repos ou l'attente sur place serait préférable."
    : "Pas d'alternative nécessaire, la position d'arrivée reste favorable.";

  return {
    verdict,
    hidden_cost_eur,
    reason_fr: `Cette course ${verdict === "refuse" ? "présente un risque net" : verdict === "careful" ? "mérite prudence" : "semble correcte"} : ${reasonParts.join("; ")}.`,
    alternative_hint_fr,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. COACH CONVERSATIONNEL — rapport.md §12.2 / §12.4
// ═════════════════════════════════════════════════════════════════════════════

export interface CoachAnswer {
  answer_fr: string;
  sources: CoachSource[];
  confidence: number;
}

export function answerCoachQuestion(question: string): CoachAnswer {
  const match = matchCoachTemplate(question);
  if (!match) {
    return { answer_fr: COACH_FALLBACK_ANSWER, sources: [], confidence: 0.1 };
  }
  const { template, score } = match;
  const confidence = Math.min(0.95, 0.5 + score * 0.15);
  return {
    answer_fr: template.render(),
    sources: template.sources,
    confidence: r2(confidence),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. ASSISTANT FISCAL CONTEXTUEL — rapport.md §12.4
// ═════════════════════════════════════════════════════════════════════════════

export interface TaxCoachContext {
  ca_annuel?: number;
  activite_debut?: string; // ISO date
}

export interface TaxCoachAnswer {
  answer_fr: string;
  computed?: Record<string, number | string>;
  sources: CoachSource[];
  confidence: number;
}

export function answerTaxQuestion(question: string, context?: TaxCoachContext): TaxCoachAnswer {
  const q = question.toLowerCase();

  // Détecte la question sur la franchise TVA — utilise le CA réel des rides + seuil réglementaire.
  if (q.includes("franchise") || q.includes("tva")) {
    const year = new Date().getFullYear();
    let caAnnuel = context?.ca_annuel;
    if (caAnnuel == null) {
      try {
        const summary = economicsEngine.computeUrssafSummary(year);
        caAnnuel = summary.total_ca;
      } catch {
        caAnnuel = 0;
      }
    }
    const threshold = TVA.FRANCHISE_SEUIL_BASE_EUR;
    const thresholdMajore = TVA.FRANCHISE_SEUIL_MAJORE_EUR;
    const remaining = r2(Math.max(0, threshold - caAnnuel));
    const pct = threshold > 0 ? r1((caAnnuel / threshold) * 100) : 0;

    let statusMsg: string;
    if (caAnnuel >= thresholdMajore) {
      statusMsg = `Vous avez dépassé le seuil majoré de ${thresholdMajore.toLocaleString("fr-FR")}€ — vous êtes déjà assujetti à la TVA.`;
    } else if (caAnnuel >= threshold * 0.85) {
      statusMsg = `Vous êtes proche du seuil de franchise (${pct}% du seuil de ${threshold.toLocaleString("fr-FR")}€ atteint). ` +
        `Il vous reste ${remaining.toLocaleString("fr-FR")}€ de marge avant de devenir assujetti à la TVA.`;
    } else {
      statusMsg = `Vous êtes à ${pct}% du seuil de franchise TVA (${threshold.toLocaleString("fr-FR")}€). ` +
        `Il vous reste ${remaining.toLocaleString("fr-FR")}€ de chiffre d'affaires avant d'atteindre ce seuil pour ${year}.`;
    }

    return {
      answer_fr:
        `Avec un chiffre d'affaires cumulé de ${caAnnuel.toLocaleString("fr-FR")}€ sur ${year}, ${statusMsg} ` +
        `Rappel : le seuil de base est ${threshold.toLocaleString("fr-FR")}€ et le seuil majoré (perte immédiate de la franchise) est ${thresholdMajore.toLocaleString("fr-FR")}€.`,
      computed: { ca_annuel: caAnnuel, seuil_franchise: threshold, seuil_majore: thresholdMajore, restant_avant_tva: remaining, pourcentage_seuil: pct },
      sources: [{ label: "Seuils franchise TVA — LegalPlace", url_or_data_ref: TVA.SOURCE_URL }],
      confidence: 0.9,
    };
  }

  if (q.includes("urssaf") || q.includes("cotisation")) {
    const year = new Date().getFullYear();
    let caAnnuel = context?.ca_annuel;
    if (caAnnuel == null) {
      try {
        caAnnuel = economicsEngine.computeUrssafSummary(year).total_ca;
      } catch {
        caAnnuel = 0;
      }
    }
    const cvo = r2(caAnnuel * (URSSAF.TAUX_COTISATIONS_PCT / 100));
    const cfp = r2(caAnnuel * (URSSAF.TAUX_CFP_PCT / 100));
    return {
      answer_fr:
        `Sur votre chiffre d'affaires ${year} de ${caAnnuel.toLocaleString("fr-FR")}€, vous devez environ ${cvo.toLocaleString("fr-FR")}€ ` +
        `de cotisations sociales (${URSSAF.TAUX_COTISATIONS_PCT}%) et ${cfp.toLocaleString("fr-FR")}€ de CFP (${URSSAF.TAUX_CFP_PCT}%), ` +
        `soit un total de ${(cvo + cfp).toLocaleString("fr-FR")}€.`,
      computed: { ca_annuel: caAnnuel, cotisations_dues: cvo, cfp_due: cfp, total_du: r2(cvo + cfp) },
      sources: [{ label: "URSSAF Auto-entrepreneur", url_or_data_ref: URSSAF.SOURCE_URL }],
      confidence: 0.9,
    };
  }

  // Fallback → coach générique
  const generic = answerCoachQuestion(question);
  return { answer_fr: generic.answer_fr, sources: generic.sources, confidence: generic.confidence };
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. AUTO-TIPS PROACTIFS
// ═════════════════════════════════════════════════════════════════════════════

export interface ProactiveTip {
  id: string;
  text_fr: string;
  category: "zone" | "timing" | "meteo" | "economie";
  confidence: number;
}

export function computeProactiveTips(): ProactiveTip[] {
  const tips: ProactiveTip[] = [];
  const now = new Date();
  const hour = (now.getUTCHours() + 2) % 24;
  const dayOfWeek = now.getDay(); // 0=dimanche

  // Tip 1 : comparaison historique de deux zones à cette heure/jour (rides personnels)
  try {
    const cutoff = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    const rides = storage.getRidesInRange(cutoff, new Date().toISOString());
    const sameSlot = rides.filter((r: any) => {
      const d = new Date(r.timestamp);
      return d.getDay() === dayOfWeek && Math.abs(d.getHours() - hour) <= 1;
    });
    const byZone: Record<string, { net: number; n: number }> = {};
    sameSlot.forEach((r: any) => {
      const z = r.pickup_zone_id ?? "?";
      if (!byZone[z]) byZone[z] = { net: 0, n: 0 };
      byZone[z].net += r.net_profit ?? 0;
      byZone[z].n += 1;
    });
    const entries = Object.entries(byZone).filter(([, v]) => v.n >= 2);
    if (entries.length >= 2) {
      entries.sort((a, b) => b[1].net / b[1].n - a[1].net / a[1].n);
      const [bestZone, bestV] = entries[0];
      const [worstZone, worstV] = entries[entries.length - 1];
      const bestAvg = bestV.net / bestV.n;
      const worstAvg = worstV.net / worstV.n || 1;
      const ratio = worstAvg > 0 ? bestAvg / worstAvg : 3;
      if (ratio >= 1.5 && bestZone !== worstZone) {
        const dayLabel = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"][dayOfWeek];
        tips.push({
          id: "tip-historique-zone",
          text_fr: `${dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)} vers ${hour}h, ${bestZone} a été ${r1(ratio)}x plus rentable pour vous que ${worstZone} — pensez-y aujourd'hui.`,
          category: "zone",
          confidence: Math.min(0.85, 0.5 + Math.min(bestV.n, 10) / 20),
        });
      }
    }
  } catch {
    /* défensif */
  }

  // Tip 2 : événement actif à venir dans les 2h
  try {
    const activeEvents = (storage.getActiveEvents() as any[]) || [];
    const soon = activeEvents.find((e) => (e.demand_boost ?? 1) > 1.2);
    if (soon) {
      tips.push({
        id: "tip-evenement",
        text_fr: `Un événement (${soon.name}) booste la demande près de la zone concernée — anticipez votre positionnement.`,
        category: "timing",
        confidence: 0.7,
      });
    }
  } catch {
    /* défensif */
  }

  // Tip 3 : seuil de rentabilité / économie
  try {
    const breakEven = economicsEngine.computeBreakEven();
    if (breakEven.status === "warning" || breakEven.status === "red") {
      tips.push({
        id: "tip-rentabilite",
        text_fr: `Votre rendement horaire actuel (${breakEven.current_hourly_this_shift}€/h) est sous votre seuil de rentabilité (${breakEven.min_hourly_to_profit}€/h) — envisagez de changer de zone ou de faire une pause stratégique.`,
        category: "economie",
        confidence: 0.75,
      });
    }
  } catch {
    /* défensif */
  }

  // Tip 4 générique de secours si rien de personnalisé n'a pu être calculé
  if (tips.length === 0) {
    tips.push({
      id: "tip-generique-1",
      text_fr: "Roulez encore quelques jours pour que l'app apprenne vos habitudes et vous propose des conseils personnalisés.",
      category: "timing",
      confidence: 0.3,
    });
  }

  return tips.slice(0, 3);
}
