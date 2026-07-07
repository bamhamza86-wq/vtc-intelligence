/**
 * taxConstants.ts — Barèmes fiscaux & sociaux FR versionnés (millésime 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Objectif : centraliser TOUTES les valeurs réglementaires (taux URSSAF, seuils
 * TVA, barème indemnités kilométriques) pour ne JAMAIS les hardcoder dans les
 * routes. Chaque export est annoté avec sa source et sa date de vérification.
 *
 * Statut retenu pour l'activité VTC : micro-entrepreneur, prestations de
 * services commerciales (BIC) — PAS le régime "vente de marchandises" ni BNC.
 *
 * Sources (consultées 07/07/2026) :
 * - Barème IK 2026 (voitures) : https://www.legisocial.fr/reperes-sociaux/bareme-kilometrique-2026.html
 *   et https://www.service-public.gouv.fr/particuliers/actualites/A14686
 * - Taux URSSAF micro-entrepreneur prestations de services (BIC) 2026 = 21,2 % :
 *   https://vtc-planner.fr/blog/urssaf-chauffeur-vtc
 *   https://www.portail-autoentrepreneur.fr/academie/statut-auto-entrepreneur/cotisations
 *   https://drivepalapp.com/blog/auto-entrepreneur-vtc-2026/
 * - Seuils franchise TVA 2026 (prestations de services) : 37 500 € (base) / 41 250 € (majoré) —
 *   réforme d'abaissement à 25 000 € votée mais SUSPENDUE pour 2026 :
 *   https://www.legalplace.fr/guides/plafond-auto-entrepreneur/
 *   https://www.legifiscal.fr/actualites-fiscales/4111-tva-nouveau-report-franchise-base-25000-plf-2026.html
 * - Plafond CA micro-entrepreneur prestations de services 2026 = 83 600 € (188 700 € vente) :
 *   https://urssafavocat.fr/blog/urssaf-auto-entrepreneur-fr-guide-2026-pour-eviter-un-redressement
 * - Contribution formation professionnelle (CFP) prestations de services = 0,2 % :
 *   https://www.portail-autoentrepreneur.fr/academie/statut-auto-entrepreneur/cotisations
 * - Versement libératoire prestations de services BIC = 1,7 % : idem
 *
 * ⚠️ Ces barèmes évoluent chaque année (LFSS/PLF). Mettre à jour le champ
 * `TAX_CONSTANTS_VERSION` et re-vérifier les sources à chaque changement d'année.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const TAX_CONSTANTS_VERSION = "2026.1";
export const TAX_CONSTANTS_LAST_CHECKED = "2026-07-07";

// ─── URSSAF / cotisations sociales micro-entrepreneur ──────────────────────
// Régime retenu : prestations de services commerciales (BIC) — cas des VTC.
export const URSSAF = {
  /** Taux global de cotisations sociales 2026 (BIC prestations de services) */
  TAUX_COTISATIONS_PCT: 21.2,
  /** Contribution formation professionnelle (CFP) — prestations de services */
  TAUX_CFP_PCT: 0.2,
  /** Taux ACRE (première année, réduction 50% jusqu'à 4 trimestres civils) */
  TAUX_ACRE_REDUCTION_PCT: 50,
  /** Taux du versement libératoire optionnel (impôt sur le revenu), BIC services */
  TAUX_VERSEMENT_LIBERATOIRE_PCT: 1.7,
  /** Plafond de chiffre d'affaires annuel micro-entrepreneur (prestations de services) */
  PLAFOND_CA_ANNUEL_EUR: 83_600,
  SOURCE_URL: "https://vtc-planner.fr/blog/urssaf-chauffeur-vtc",
};

// ─── Franchise en base de TVA ────────────────────────────────────────────────
export const TVA = {
  /** Seuil de base : franchise applicable si CA N-1 ne dépasse pas ce montant */
  FRANCHISE_SEUIL_BASE_EUR: 37_500,
  /** Seuil majoré (tolérance) : perte immédiate de la franchise si dépassé en cours d'année */
  FRANCHISE_SEUIL_MAJORE_EUR: 41_250,
  /** Taux de TVA applicable au transport de voyageurs (VTC) si assujetti */
  TAUX_TVA_TRANSPORT_PCT: 10,
  SOURCE_URL: "https://www.legalplace.fr/guides/plafond-auto-entrepreneur/",
};

// ─── Barème indemnités kilométriques (IK) 2026 — voitures ──────────────────
// Formule par tranche de puissance fiscale (CV) et de distance annuelle (d en km).
// Retourne le montant total IK pour une distance donnée (pas un €/km unique,
// car le barème est dégressif par palier).
export interface BaremeIKTranche {
  cv: string;
  jusqua5000: (d: number) => number;
  de5001a20000: (d: number) => number;
  audela20000: (d: number) => number;
}

export const BAREME_IK_2026: BaremeIKTranche[] = [
  { cv: "3 CV et moins", jusqua5000: d => d * 0.529, de5001a20000: d => d * 0.316 + 1065, audela20000: d => d * 0.370 },
  { cv: "4 CV",          jusqua5000: d => d * 0.606, de5001a20000: d => d * 0.340 + 1330, audela20000: d => d * 0.407 },
  { cv: "5 CV",          jusqua5000: d => d * 0.636, de5001a20000: d => d * 0.357 + 1395, audela20000: d => d * 0.427 },
  { cv: "6 CV",          jusqua5000: d => d * 0.665, de5001a20000: d => d * 0.374 + 1457, audela20000: d => d * 0.447 },
  { cv: "7 CV et plus",  jusqua5000: d => d * 0.697, de5001a20000: d => d * 0.394 + 1515, audela20000: d => d * 0.470 },
];

/** Majoration barème IK pour véhicule 100% électrique (appliquée sur le thermique) */
export const IK_MAJORATION_ELECTRIQUE_PCT = 20;

/**
 * Calcule l'indemnité kilométrique annuelle estimée pour une puissance fiscale
 * (en CV, string libre mappé sur les tranches ci-dessus) et une distance annuelle.
 * Par défaut, utilise la tranche "5 CV" (berline VTC standard) si non reconnue.
 */
export function calculerIKAnnuel(distanceAnnuelleKm: number, cvFiscaux: number, isElectrique = false): number {
  const tranche =
    cvFiscaux <= 3 ? BAREME_IK_2026[0] :
    cvFiscaux === 4 ? BAREME_IK_2026[1] :
    cvFiscaux === 5 ? BAREME_IK_2026[2] :
    cvFiscaux === 6 ? BAREME_IK_2026[3] :
    BAREME_IK_2026[4];

  let montant: number;
  if (distanceAnnuelleKm <= 5000) montant = tranche.jusqua5000(distanceAnnuelleKm);
  else if (distanceAnnuelleKm <= 20000) montant = tranche.de5001a20000(distanceAnnuelleKm);
  else montant = tranche.audela20000(distanceAnnuelleKm);

  if (isElectrique) montant *= 1 + IK_MAJORATION_ELECTRIQUE_PCT / 100;
  return Math.round(montant * 100) / 100;
}

// ─── Valeurs par défaut "IDF" (Île-de-France) — coût réel véhicule VTC ─────
// Utilisées par le bouton "Réinitialiser avec valeurs par défaut IDF" côté
// ProfilePage. Ordres de grandeur réalistes pour une berline VTC en IDF.
export const DEFAULTS_IDF = {
  insurance_annual_eur: 1800,          // assurance VTC pro annuelle (IDF)
  maintenance_yearly_eur: 1200,        // entretien courant (vidange, freins, etc.)
  vehicle_amortization_yearly_eur: 4800, // amortissement véhicule (~24 000€/5 ans)
  tire_yearly_eur: 600,                 // pneus (usure élevée VTC)
  cvo_urssaf_pct: URSSAF.TAUX_COTISATIONS_PCT, // 21.2%
  tva_regime: "franchise" as const,
  electric_mode: false,
  kwh_per_100km: 18,
  kwh_price: 0.25,
};

// ─── Diviseurs d'amortissement du coût "tout compris" au km ────────────────
// cost_per_km_all_in = fuel + wear + insurance/12000 + maintenance/12000
//                       + amortization/24000 + tire/60000
// Ces diviseurs représentent un kilométrage annuel de référence par poste
// (12 000 km/an pour assurance/entretien, 24 000 km sur 2 ans pour l'amort.
// véhicule, 60 000 km pour un train de pneus VTC).
export const COST_PER_KM_DIVISORS = {
  INSURANCE_KM: 12_000,
  MAINTENANCE_KM: 12_000,
  AMORTIZATION_KM: 24_000,
  TIRE_KM: 60_000,
};
