/**
 * economicsEngine.ts — Couche Économie & Fiscalité (moteur de calcul)
 * ─────────────────────────────────────────────────────────────────────────────
 * Fonctions pures de calcul économique/fiscal, appelées depuis routes.ts.
 * Aucun accès direct à Express (req/res) ici : uniquement storage + taxConstants.
 * Les barèmes réglementaires viennent EXCLUSIVEMENT de taxConstants.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { storage } from "./storage";
import {
  URSSAF, TVA, DEFAULTS_IDF, COST_PER_KM_DIVISORS,
  calculerIKAnnuel,
} from "./taxConstants";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;

// ─── 1. Coût réel au km "tout compris" ─────────────────────────────────────
export interface CostPerKmBreakdown {
  fuel_per_km: number;
  wear_per_km: number;
  insurance_per_km: number;
  maintenance_per_km: number;
  amortization_per_km: number;
  tire_per_km: number;
  total_per_km: number;
  break_even_hourly: number;
  break_even_per_km: number;
}

export function computeCostPerKm(): CostPerKmBreakdown {
  const profile: any = storage.getDriverProfile() || {};

  const isElectric = Boolean(profile.electric_mode);
  const fuel_per_km = isElectric
    ? ((profile.kwh_per_100km ?? DEFAULTS_IDF.kwh_per_100km) / 100) * (profile.kwh_price ?? DEFAULTS_IDF.kwh_price)
    : ((profile.fuel_consumption_per100km ?? 7.5) / 100) * (profile.fuel_price_per_liter ?? 1.92);

  const wear_per_km = profile.wear_cost_per_km ?? 0.08;

  const insurance_per_km = (profile.insurance_annual_eur ?? DEFAULTS_IDF.insurance_annual_eur) / COST_PER_KM_DIVISORS.INSURANCE_KM;
  const maintenance_per_km = (profile.maintenance_yearly_eur ?? DEFAULTS_IDF.maintenance_yearly_eur) / COST_PER_KM_DIVISORS.MAINTENANCE_KM;
  const amortization_per_km = (profile.vehicle_amortization_yearly_eur ?? DEFAULTS_IDF.vehicle_amortization_yearly_eur) / COST_PER_KM_DIVISORS.AMORTIZATION_KM;
  const tire_per_km = (profile.tire_yearly_eur ?? DEFAULTS_IDF.tire_yearly_eur) / COST_PER_KM_DIVISORS.TIRE_KM;

  const total_per_km = fuel_per_km + wear_per_km + insurance_per_km + maintenance_per_km + amortization_per_km + tire_per_km;

  // Seuil de rentabilité horaire : km/h moyen urbain estimé à 22 km/h (IDF dense)
  const AVG_URBAN_KMH = 22;
  const break_even_hourly = total_per_km * AVG_URBAN_KMH;

  return {
    fuel_per_km: r2(fuel_per_km),
    wear_per_km: r2(wear_per_km),
    insurance_per_km: r2(insurance_per_km),
    maintenance_per_km: r2(maintenance_per_km),
    amortization_per_km: r2(amortization_per_km),
    tire_per_km: r2(tire_per_km),
    total_per_km: r2(total_per_km),
    break_even_hourly: r2(break_even_hourly),
    break_even_per_km: r2(total_per_km),
  };
}

// ─── 3. Marge nette par course en direct ───────────────────────────────────
export interface RideMargin {
  gross: number;
  commission: number;
  fuel_cost: number;
  wear_cost: number;
  insurance_cost: number;
  urssaf_cost: number;
  tva_cost: number;
  net_final: number;
  margin_pct: number;
}

export function computeRideMargin(fare: number, distanceKm: number): RideMargin {
  const profile: any = storage.getDriverProfile() || {};
  const costPerKm = computeCostPerKm();

  const commPct = profile.platform_commission_pct ?? 25;
  const commission = r2(fare * (commPct / 100));
  const fuel_cost = r2(distanceKm * costPerKm.fuel_per_km);
  const wear_cost = r2(distanceKm * costPerKm.wear_per_km);
  const insurance_cost = r2(distanceKm * (costPerKm.insurance_per_km + costPerKm.maintenance_per_km + costPerKm.amortization_per_km + costPerKm.tire_per_km));

  const cvoUrssafPct = profile.cvo_urssaf_pct ?? URSSAF.TAUX_COTISATIONS_PCT;
  const urssaf_cost = r2(fare * (cvoUrssafPct / 100));

  const tvaRegime = profile.tva_regime ?? "franchise";
  const tva_cost = tvaRegime === "reel" ? r2(fare * (TVA.TAUX_TVA_TRANSPORT_PCT / 100) / (1 + TVA.TAUX_TVA_TRANSPORT_PCT / 100)) : 0;

  const net_final = r2(fare - commission - fuel_cost - wear_cost - insurance_cost - urssaf_cost - tva_cost);
  const margin_pct = fare > 0 ? r1((net_final / fare) * 100) : 0;

  return { gross: r2(fare), commission, fuel_cost, wear_cost, insurance_cost, urssaf_cost, tva_cost, net_final, margin_pct };
}

// ─── 4. Seuil de rentabilité horaire ────────────────────────────────────────
export interface BreakEvenStatus {
  min_hourly_to_profit: number;
  current_hourly_this_shift: number;
  delta: number;
  status: "ok" | "warning" | "red";
}

export function computeBreakEven(): BreakEvenStatus {
  const costPerKm = computeCostPerKm();
  const profile: any = storage.getDriverProfile() || {};
  const target = profile.hourly_target_income ?? 35;
  const min_hourly_to_profit = Math.max(costPerKm.break_even_hourly, target * 0.4); // plancher réaliste

  // €/h courant : moyenne des courses des 4 dernières heures
  const cutoff = new Date(Date.now() - 4 * 3600_000).toISOString();
  const recentRides = storage.getRidesInRange(cutoff, new Date(Date.now() + 60_000).toISOString());
  const totalNet = recentRides.reduce((s: number, r: any) => s + (r.net_profit ?? 0), 0);
  const totalDurH = recentRides.reduce((s: number, r: any) => s + (r.duration_min ?? 0), 0) / 60;
  const current_hourly_this_shift = totalDurH > 0.05 ? r1(totalNet / totalDurH) : 0;

  const delta = r1(current_hourly_this_shift - min_hourly_to_profit);
  let status: BreakEvenStatus["status"] = "ok";
  if (current_hourly_this_shift <= 0 && recentRides.length > 0) status = "red";
  else if (delta < 0) status = recentRides.length === 0 ? "ok" : "warning";
  if (delta < -10) status = "red";

  return {
    min_hourly_to_profit: r1(min_hourly_to_profit),
    current_hourly_this_shift,
    delta,
    status,
  };
}

// ─── 5. Alerte rentabilité temps réel ───────────────────────────────────────
// Appelée après chaque /api/rides/complete : si margin_pct < 0, insère une alerte.
export function maybeCreateUnprofitableAlert(margin: RideMargin, pickupZoneId?: string): void {
  if (margin.margin_pct >= 0) return;
  try {
    storage.createAlert({
      type: "unprofitable_ride",
      title: "Course non rentable détectée",
      message: `Marge nette négative (${margin.margin_pct}%) — net final ${margin.net_final}€ sur une course à ${margin.gross}€. Vérifiez vos coûts réels ou évitez ce type de course.`,
      zoneId: pickupZoneId ?? null,
      priority: "high",
      estimatedRevenue: margin.net_final,
      expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[economicsEngine] maybeCreateUnprofitableAlert échoué:", e);
  }
}

// ─── 6. Bilan de fin de shift ────────────────────────────────────────────────
export interface EndShiftSummary {
  total_gross: number;
  total_net: number;
  avg_hourly: number;
  best_hour: number;
  worst_hour: number;
  unprofitable_count: number;
  top_zone: string;
  message_fr_narratif: string;
}

export function computeEndShift(dateStr?: string): EndShiftSummary {
  const day = dateStr || new Date().toISOString().slice(0, 10);
  const start = `${day}T00:00:00.000Z`;
  const end = new Date(new Date(start).getTime() + 24 * 3600_000).toISOString();
  const rides = storage.getRidesInRange(start, end);

  const total_gross = r2(rides.reduce((s: number, r: any) => s + (r.fare ?? 0), 0));
  const total_net = r2(rides.reduce((s: number, r: any) => s + (r.net_profit ?? 0), 0));
  const totalDurH = rides.reduce((s: number, r: any) => s + (r.duration_min ?? 0), 0) / 60;
  const avg_hourly = totalDurH > 0.05 ? r1(total_net / totalDurH) : 0;

  const byHour: Record<number, { net: number; n: number }> = {};
  rides.forEach((r: any) => {
    const h = new Date(r.timestamp).getHours();
    if (!byHour[h]) byHour[h] = { net: 0, n: 0 };
    byHour[h].net += r.net_profit ?? 0;
    byHour[h].n += 1;
  });
  let best_hour = -1, worst_hour = -1, bestRate = -Infinity, worstRate = Infinity;
  Object.entries(byHour).forEach(([hStr, v]) => {
    const rate = v.n > 0 ? v.net / v.n : 0;
    const h = Number(hStr);
    if (rate > bestRate) { bestRate = rate; best_hour = h; }
    if (rate < worstRate) { worstRate = rate; worst_hour = h; }
  });

  const unprofitable_count = rides.filter((r: any) => (r.net_profit ?? 0) < 0 || (r.margin_pct ?? 0) < 0).length;

  const byZone: Record<string, number> = {};
  rides.forEach((r: any) => {
    const z = r.pickup_zone_id ?? "?";
    byZone[z] = (byZone[z] ?? 0) + 1;
  });
  let top_zone = "—", topCount = -1;
  Object.entries(byZone).forEach(([z, c]) => { if (c > topCount) { topCount = c; top_zone = z; } });

  let message_fr_narratif: string;
  if (rides.length === 0) {
    message_fr_narratif = "Aucune course enregistrée aujourd'hui. Bonne route pour votre prochain shift !";
  } else {
    const qualif = avg_hourly >= 25 ? "excellente" : avg_hourly >= 15 ? "correcte" : "difficile";
    message_fr_narratif = `Journée ${qualif} : ${rides.length} course(s) pour ${total_net}€ net, soit ${avg_hourly}€/h en moyenne. ` +
      (unprofitable_count > 0 ? `Attention, ${unprofitable_count} course(s) non rentable(s) détectée(s). ` : "Aucune course à perte. ") +
      (top_zone !== "—" ? `Votre zone la plus active : ${top_zone}.` : "");
  }

  return {
    total_gross, total_net, avg_hourly,
    best_hour: best_hour === -1 ? 0 : best_hour,
    worst_hour: worst_hour === -1 ? 0 : worst_hour,
    unprofitable_count, top_zone, message_fr_narratif,
  };
}

// ─── 7. Détection de courses structurellement non-rentables (30j) ─────────
export interface ToxicPattern {
  pattern_desc_fr: string;
  occurrences: number;
  total_loss: number;
  suggested_avoidance: string;
}

export function computeToxicPatterns(): ToxicPattern[] {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const rides = storage.getRidesInRange(cutoff, new Date(Date.now() + 60_000).toISOString());
  const patterns: ToxicPattern[] = [];

  // Pattern A : courses courtes non rentables (< 3km, net négatif)
  const shortLoss = rides.filter((r: any) => (r.distance_km ?? 0) < 3 && (r.net_profit ?? 0) < 0);
  if (shortLoss.length >= 2) {
    patterns.push({
      pattern_desc_fr: "Courses très courtes (< 3 km) systématiquement à perte",
      occurrences: shortLoss.length,
      total_loss: r2(shortLoss.reduce((s: number, r: any) => s + Math.abs(r.net_profit ?? 0), 0)),
      suggested_avoidance: "Refuser les courses < 3 km hors zone dense ou fixer un tarif minimum via les règles maison.",
    });
  }

  // Pattern B : zone de prise en charge récurrente déficitaire
  const byZone: Record<string, { n: number; loss: number }> = {};
  rides.forEach((r: any) => {
    if ((r.net_profit ?? 0) < 0) {
      const z = r.pickup_zone_id ?? "?";
      if (!byZone[z]) byZone[z] = { n: 0, loss: 0 };
      byZone[z].n += 1;
      byZone[z].loss += Math.abs(r.net_profit ?? 0);
    }
  });
  Object.entries(byZone).forEach(([zone, v]) => {
    if (v.n >= 3) {
      patterns.push({
        pattern_desc_fr: `Zone "${zone}" génère des courses à perte de façon répétée`,
        occurrences: v.n,
        total_loss: r2(v.loss),
        suggested_avoidance: `Éviter de stationner en attente dans la zone "${zone}" ou ajouter une règle de blacklist zone.`,
      });
    }
  });

  // Pattern C : heures creuses à faible rendement horaire (< 10€/h) mais volume élevé
  const byHour: Record<number, { n: number; net: number; durH: number }> = {};
  rides.forEach((r: any) => {
    const h = new Date(r.timestamp).getHours();
    if (!byHour[h]) byHour[h] = { n: 0, net: 0, durH: 0 };
    byHour[h].n += 1;
    byHour[h].net += r.net_profit ?? 0;
    byHour[h].durH += (r.duration_min ?? 0) / 60;
  });
  Object.entries(byHour).forEach(([hStr, v]) => {
    const rate = v.durH > 0.05 ? v.net / v.durH : 0;
    if (rate < 10 && v.n >= 3) {
      patterns.push({
        pattern_desc_fr: `Créneau ${hStr}h-${Number(hStr) + 1}h structurellement peu rentable (${r1(rate)}€/h)`,
        occurrences: v.n,
        total_loss: r2(Math.max(0, (15 - rate)) * v.durH),
        suggested_avoidance: `Éviter de rester actif entre ${hStr}h et ${Number(hStr) + 1}h, ou couper l'app sur ce créneau.`,
      });
    }
  });

  return patterns.sort((a, b) => b.total_loss - a.total_loss).slice(0, 8);
}

// ─── 8. URSSAF / TVA — synthèse annuelle ────────────────────────────────────
export interface UrssafSummary {
  total_ca: number;
  cvo_due: number;
  tva_franchise_threshold: number;
  tva_status: "franchise" | "assujetti" | "proche_seuil";
  remaining_before_tva: number;
  ik_estimated: number;
}

export function computeUrssafSummary(year: number): UrssafSummary {
  const start = `${year}-01-01T00:00:00.000Z`;
  const end = `${year + 1}-01-01T00:00:00.000Z`;
  const rides = storage.getRidesInRange(start, end);
  const total_ca = r2(rides.reduce((s: number, r: any) => s + (r.fare ?? 0), 0));

  const profile: any = storage.getDriverProfile() || {};
  const cvoPct = profile.cvo_urssaf_pct ?? URSSAF.TAUX_COTISATIONS_PCT;
  const cvo_due = r2(total_ca * (cvoPct / 100));

  const threshold = TVA.FRANCHISE_SEUIL_BASE_EUR;
  const thresholdMajore = TVA.FRANCHISE_SEUIL_MAJORE_EUR;
  let tva_status: UrssafSummary["tva_status"] = "franchise";
  if (total_ca >= thresholdMajore) tva_status = "assujetti";
  else if (total_ca >= threshold * 0.85) tva_status = "proche_seuil";

  const remaining_before_tva = r2(Math.max(0, threshold - total_ca));

  const totalKm = rides.reduce((s: number, r: any) => s + (r.distance_km ?? 0), 0);
  const cvFiscaux = Number(profile.vehicle_cv_fiscaux ?? 5);
  const ik_estimated = calculerIKAnnuel(totalKm, cvFiscaux, Boolean(profile.electric_mode));

  return {
    total_ca, cvo_due,
    tva_franchise_threshold: threshold,
    tva_status, remaining_before_tva,
    ik_estimated,
  };
}

// ─── 9. Simulateur d'impact statut ──────────────────────────────────────────
export interface StatusSimulation {
  estimated_savings_or_cost: number;
  break_even_ca: number;
  recommendation_fr: string;
}

export function simulateStatusChange(newRegime: "micro_bnc" | "ei_reel" | "sasu", annualCa: number): StatusSimulation {
  // Micro-BIC actuel (régime de référence) : cotisations 21.2% + CFP 0.2% = 21.4%, pas de charges déductibles.
  const currentCost = annualCa * ((URSSAF.TAUX_COTISATIONS_PCT + URSSAF.TAUX_CFP_PCT) / 100);

  let newCost: number;
  let recommendation_fr: string;
  let break_even_ca: number;

  if (newRegime === "micro_bnc") {
    // Micro-BNC (prestations libérales) : taux 2026 ≈ 25.6% + 0.2% CFP — plus cher pour un VTC (activité commerciale BIC).
    newCost = annualCa * ((25.6 + 0.2) / 100);
    break_even_ca = 0; // toujours plus cher, pas de seuil favorable
    recommendation_fr = "Le régime micro-BNC est réservé aux professions libérales et taxé à un taux plus élevé (25,6% vs 21,2%) — non pertinent pour une activité VTC classée en prestations de services commerciales (BIC). À éviter.";
  } else if (newRegime === "ei_reel") {
    // EI au réel : charges réelles déductibles (~35% du CA estimé pour un VTC : carburant, assurance, entretien, amortissement)
    // puis cotisations sociales SSI (~30% du bénéfice net estimé) + IR.
    const chargesReelles = annualCa * 0.35;
    const beneficeNet = annualCa - chargesReelles;
    newCost = beneficeNet * 0.30; // cotisations sociales approx. sur bénéfice réel
    break_even_ca = 50_000; // à partir de ce CA, les charges réelles déductibles dépassent l'abattement forfaitaire micro (50%)
    recommendation_fr = annualCa >= break_even_ca
      ? `Au-delà de ${break_even_ca}€ de CA annuel, le régime réel (charges déductibles) devient souvent plus avantageux que le micro-BIC si vos charges réelles (carburant, entretien, assurance) dépassent l'abattement forfaitaire de 50%. À étudier avec un expert-comptable.`
      : `En dessous de ${break_even_ca}€ de CA, le micro-BIC reste généralement plus simple et souvent plus avantageux (abattement forfaitaire de 50% déjà généreux).`;
  } else {
    // SASU : IS + rémunération dirigeant, pertinent seulement à partir d'un CA élevé.
    newCost = annualCa * 0.45; // approximation charges sociales + IS combinés à un CA modeste
    break_even_ca = 80_000;
    recommendation_fr = annualCa >= break_even_ca
      ? `La SASU devient intéressante au-delà de ${break_even_ca}€ de CA annuel, notamment pour optimiser la rémunération (dividendes) et la protection sociale, mais implique une comptabilité complète et des coûts de gestion. Consultez un expert-comptable avant de basculer.`
      : `À ${annualCa}€ de CA, la SASU est probablement prématurée : les coûts de structure (comptabilité, formalités) dépassent les gains fiscaux potentiels tant que le CA reste sous ${break_even_ca}€.`;
  }

  const estimated_savings_or_cost = r2(currentCost - newCost); // positif = économie en changeant

  return { estimated_savings_or_cost, break_even_ca, recommendation_fr };
}

// ─── 10-12. Multi-plateforme ────────────────────────────────────────────────
export interface PlatformKpi {
  platform: string;
  hours: number;
  ca: number;
  rides: number;
  avg_fare: number;
  commission_pct: number;
  net_hourly: number;
}

export function computePlatformKpiComparison(periodDays: number): PlatformKpi[] {
  const sinceIso = new Date(Date.now() - periodDays * 24 * 3600_000).toISOString();
  const rows = storage.getPlatformStats("default", sinceIso);

  const byPlatform: Record<string, { hours: number; ca: number; rides: number; fareSum: number; commSum: number; netSum: number }> = {};
  rows.forEach((r: any) => {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = { hours: 0, ca: 0, rides: 0, fareSum: 0, commSum: 0, netSum: 0 };
    const b = byPlatform[r.platform];
    b.hours += r.hours ?? 0;
    b.ca += r.ca ?? 0;
    b.rides += r.rides ?? 0;
    b.fareSum += (r.avg_fare ?? 0) * (r.rides ?? 0);
    b.commSum += r.commission_pct ?? 0;
    b.netSum += (r.net_hourly ?? 0) * (r.hours ?? 0);
  });

  return Object.entries(byPlatform).map(([platform, b]) => ({
    platform,
    hours: r1(b.hours),
    ca: r2(b.ca),
    rides: b.rides,
    avg_fare: b.rides > 0 ? r2(b.fareSum / b.rides) : 0,
    commission_pct: r1(b.commSum),
    net_hourly: b.hours > 0 ? r2(b.netSum / b.hours) : 0,
  })).sort((a, b) => b.net_hourly - a.net_hourly);
}

export interface WhichNowRecommendation {
  platform: string;
  reason_fr: string;
  expected_hourly: number;
}

export function computeWhichNow(hour: number): WhichNowRecommendation {
  const kpis = computePlatformKpiComparison(30);
  if (kpis.length === 0) {
    return {
      platform: "uber",
      reason_fr: "Pas encore assez de données pour comparer vos plateformes — Uber recommandé par défaut (plus forte densité de demande en Île-de-France).",
      expected_hourly: 0,
    };
  }

  // Heuristique simple : privilégier la plateforme au meilleur net_hourly historique,
  // avec un bonus horaire pour Uber/Bolt en heures de pointe (6-9h, 17-20h) — forte demande.
  const isRush = (hour >= 6 && hour <= 9) || (hour >= 17 && hour <= 20);
  const scored = kpis.map(k => ({
    ...k,
    score: k.net_hourly * (isRush && (k.platform === "uber" || k.platform === "bolt") ? 1.1 : 1),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const reason_fr = isRush
    ? `${best.platform} affiche le meilleur rendement horaire historique (${best.net_hourly}€/h) et bénéficie d'un pic de demande à cette heure.`
    : `${best.platform} affiche le meilleur rendement horaire net sur vos 30 derniers jours (${best.net_hourly}€/h).`;

  return { platform: best.platform, reason_fr, expected_hourly: best.net_hourly };
}
