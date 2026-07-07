/**
 * financeEngine.ts — Couche FINANCE PERSO chauffeur (Itération Santé & Finance)
 * ═════════════════════════════════════════════════════════════════════════════
 * Inspiré du rapport §6 (Fiscalité/finance du chauffeur), §11 (Écosystème
 * services chauffeur), §19 et gaps benchmark identifiés :
 *   - inDrive Money   : microcrédit / avance chauffeur intégrée
 *   - Uber Pro Card   : cashout instantané, épargne automatique par course
 *   - Everlance       : garantie audit fiscal, rigueur de suivi des dépenses
 *   - Hurdlr          : réconciliation bancaire multi-plateformes automatique
 *
 * ZÉRO nouvelle dépendance npm — connexion better-sqlite3 dédiée (comme
 * fatigueCoach.ts / healthEngine.ts). Tables additionnelles uniquement.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";
import { URSSAF } from "./taxConstants";

const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

export const DEFAULT_USER = "root";

// ─────────────────────────────────────────────────────────────────────────────
// Schéma
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS monthly_budget (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    mois INTEGER NOT NULL,
    annee INTEGER NOT NULL,
    revenu_brut REAL NOT NULL DEFAULT 0,
    charges REAL NOT NULL DEFAULT 0,
    provision_impot REAL NOT NULL DEFAULT 0,
    epargne_target REAL NOT NULL DEFAULT 0,
    disponible REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, mois, annee)
  );

  CREATE TABLE IF NOT EXISTS annual_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    annee INTEGER NOT NULL,
    ca_target REAL NOT NULL DEFAULT 0,
    net_target REAL NOT NULL DEFAULT 0,
    epargne_target REAL NOT NULL DEFAULT 0,
    projet_vacances REAL NOT NULL DEFAULT 0,
    projet_voiture REAL NOT NULL DEFAULT 0,
    projet_immo REAL NOT NULL DEFAULT 0,
    projet_retraite REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, annee)
  );

  CREATE TABLE IF NOT EXISTS auto_save_settings (
    user_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    percent REAL NOT NULL DEFAULT 10,
    total_saved REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS auto_save_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    ride_amount REAL NOT NULL,
    saved_amount REAL NOT NULL,
    percent REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS platform_income_manual (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    platform TEXT NOT NULL,
    period TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bank_statement_manual (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    period TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface BudgetInput {
  mois: number;
  annee: number;
  revenu_brut: number;
  charges: number;
  provision_impot?: number;
  epargne_target?: number;
}

export interface LoanSimInput {
  montant: number;
  taux: number; // % annuel
  duree: number; // mois
  apport?: number;
}

export interface AnnualGoalInput {
  annee: number;
  ca_target: number;
  net_target: number;
  epargne_target: number;
  projet?: {
    vacances?: number;
    voiture?: number;
    immo?: number;
    retraite?: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Budget mensuel chauffeur — GET/POST /api/finance/budget
// ─────────────────────────────────────────────────────────────────────────────
export function upsertBudget(userId: string, input: BudgetInput) {
  const provisionImpot = input.provision_impot ?? Math.round(input.revenu_brut * (URSSAF.TAUX_COTISATIONS_PCT / 100) * 100) / 100;
  const epargneTarget = input.epargne_target ?? 0;
  const disponible = Math.round((input.revenu_brut - input.charges - provisionImpot - epargneTarget) * 100) / 100;

  db.prepare(`
    INSERT INTO monthly_budget (user_id, mois, annee, revenu_brut, charges, provision_impot, epargne_target, disponible, updated_at)
    VALUES (@user_id, @mois, @annee, @revenu_brut, @charges, @provision_impot, @epargne_target, @disponible, datetime('now'))
    ON CONFLICT(user_id, mois, annee) DO UPDATE SET
      revenu_brut = excluded.revenu_brut,
      charges = excluded.charges,
      provision_impot = excluded.provision_impot,
      epargne_target = excluded.epargne_target,
      disponible = excluded.disponible,
      updated_at = datetime('now')
  `).run({
    user_id: userId,
    mois: input.mois,
    annee: input.annee,
    revenu_brut: input.revenu_brut,
    charges: input.charges,
    provision_impot: provisionImpot,
    epargne_target: epargneTarget,
    disponible,
  });

  return getBudget(userId, input.mois, input.annee);
}

export function getBudget(userId: string, mois: number, annee: number) {
  const row = db
    .prepare(`SELECT * FROM monthly_budget WHERE user_id = ? AND mois = ? AND annee = ?`)
    .get(userId, mois, annee) as any;
  if (!row) return null;

  const categories = [
    { nom: "Revenu brut", montant: row.revenu_brut, type: "revenu" },
    { nom: "Charges", montant: row.charges, type: "depense" },
    { nom: "Provision impôt/URSSAF", montant: row.provision_impot, type: "depense" },
    { nom: "Épargne", montant: row.epargne_target, type: "depense" },
  ];
  const totalDepenses = row.charges + row.provision_impot + row.epargne_target;
  const pctUtilise = row.revenu_brut > 0 ? Math.round((totalDepenses / row.revenu_brut) * 100) : 0;

  return { ...row, categories, pct_utilise: pctUtilise };
}

export function getBudgetHistory(userId: string, limit = 12) {
  return db
    .prepare(`SELECT * FROM monthly_budget WHERE user_id = ? ORDER BY annee DESC, mois DESC LIMIT ?`)
    .all(userId, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Épargne automatique % — GET/POST /api/finance/auto-save
// ─────────────────────────────────────────────────────────────────────────────
export function getAutoSaveSettings(userId: string) {
  let row = db.prepare(`SELECT * FROM auto_save_settings WHERE user_id = ?`).get(userId) as any;
  if (!row) {
    db.prepare(`INSERT INTO auto_save_settings (user_id, enabled, percent, total_saved) VALUES (?, 0, 10, 0)`).run(userId);
    row = db.prepare(`SELECT * FROM auto_save_settings WHERE user_id = ?`).get(userId);
  }
  return row;
}

export function setAutoSaveSettings(userId: string, enabled: boolean, percent: number) {
  getAutoSaveSettings(userId); // s'assure que la ligne existe
  db.prepare(`
    UPDATE auto_save_settings SET enabled = ?, percent = ?, updated_at = datetime('now') WHERE user_id = ?
  `).run(enabled ? 1 : 0, Math.max(0, Math.min(50, percent)), userId);
  return getAutoSaveSettings(userId);
}

/** Simule l'application de la règle d'épargne automatique sur une course donnée. */
export function applyAutoSave(userId: string, rideAmount: number) {
  const settings = getAutoSaveSettings(userId);
  if (!settings.enabled) {
    return { applied: false, saved_amount: 0, message_fr: "Épargne automatique désactivée." };
  }
  const savedAmount = Math.round(rideAmount * (settings.percent / 100) * 100) / 100;
  db.prepare(`INSERT INTO auto_save_log (user_id, ts, ride_amount, saved_amount, percent) VALUES (?, datetime('now'), ?, ?, ?)`).run(
    userId,
    rideAmount,
    savedAmount,
    settings.percent
  );
  db.prepare(`UPDATE auto_save_settings SET total_saved = total_saved + ?, updated_at = datetime('now') WHERE user_id = ?`).run(
    savedAmount,
    userId
  );
  const updated = getAutoSaveSettings(userId);
  return {
    applied: true,
    saved_amount: savedAmount,
    total_saved: updated.total_saved,
    message_fr: `${savedAmount.toFixed(2)} € mis de côté automatiquement (${settings.percent}% de la course).`,
  };
}

export function getAutoSaveHistory(userId: string, limit = 30) {
  return db
    .prepare(`SELECT id, ts, ride_amount, saved_amount, percent FROM auto_save_log WHERE user_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(userId, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Objectifs financiers annuels — GET/POST /api/finance/goals
// ─────────────────────────────────────────────────────────────────────────────
export function upsertAnnualGoal(userId: string, input: AnnualGoalInput) {
  db.prepare(`
    INSERT INTO annual_goals (user_id, annee, ca_target, net_target, epargne_target, projet_vacances, projet_voiture, projet_immo, projet_retraite)
    VALUES (@user_id, @annee, @ca_target, @net_target, @epargne_target, @projet_vacances, @projet_voiture, @projet_immo, @projet_retraite)
    ON CONFLICT(user_id, annee) DO UPDATE SET
      ca_target = excluded.ca_target,
      net_target = excluded.net_target,
      epargne_target = excluded.epargne_target,
      projet_vacances = excluded.projet_vacances,
      projet_voiture = excluded.projet_voiture,
      projet_immo = excluded.projet_immo,
      projet_retraite = excluded.projet_retraite
  `).run({
    user_id: userId,
    annee: input.annee,
    ca_target: input.ca_target,
    net_target: input.net_target,
    epargne_target: input.epargne_target,
    projet_vacances: input.projet?.vacances ?? 0,
    projet_voiture: input.projet?.voiture ?? 0,
    projet_immo: input.projet?.immo ?? 0,
    projet_retraite: input.projet?.retraite ?? 0,
  });
  return getAnnualGoal(userId, input.annee);
}

export function getAnnualGoal(userId: string, annee: number) {
  const row = db.prepare(`SELECT * FROM annual_goals WHERE user_id = ? AND annee = ?`).get(userId, annee) as any;
  if (!row) return null;

  // Progression réelle = somme des revenus bruts déjà budgétés cette année
  const progress = db
    .prepare(`SELECT COALESCE(SUM(revenu_brut),0) as ca, COALESCE(SUM(disponible),0) as net FROM monthly_budget WHERE user_id = ? AND annee = ?`)
    .get(userId, annee) as { ca: number; net: number };

  const autoSave = getAutoSaveSettings(userId);

  return {
    ...row,
    projet: {
      vacances: row.projet_vacances,
      voiture: row.projet_voiture,
      immo: row.projet_immo,
      retraite: row.projet_retraite,
    },
    progress: {
      ca_realise: progress.ca,
      ca_pct: row.ca_target > 0 ? Math.round((progress.ca / row.ca_target) * 100) : 0,
      net_realise: progress.net,
      net_pct: row.net_target > 0 ? Math.round((progress.net / row.net_target) * 100) : 0,
      epargne_realisee: autoSave.total_saved,
      epargne_pct: row.epargne_target > 0 ? Math.round((autoSave.total_saved / row.epargne_target) * 100) : 0,
    },
  };
}

export function listAnnualGoals(userId: string) {
  const rows = db.prepare(`SELECT annee FROM annual_goals WHERE user_id = ? ORDER BY annee DESC`).all(userId) as { annee: number }[];
  return rows.map((r) => getAnnualGoal(userId, r.annee));
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Simulateur crédit véhicule — POST /api/finance/loan-simulator
// ─────────────────────────────────────────────────────────────────────────────
export function simulateLoan(input: LoanSimInput) {
  const apport = Math.max(0, input.apport ?? 0);
  const principal = Math.max(0, input.montant - apport);
  const tauxMensuel = input.taux / 100 / 12;
  const n = Math.max(1, Math.round(input.duree));

  let mensualite: number;
  if (tauxMensuel === 0) {
    mensualite = principal / n;
  } else {
    mensualite = (principal * tauxMensuel) / (1 - Math.pow(1 + tauxMensuel, -n));
  }
  mensualite = Math.round(mensualite * 100) / 100;
  const coutTotal = Math.round((mensualite * n + apport) * 100) / 100;
  const coutCredit = Math.round((mensualite * n - principal) * 100) / 100;

  return {
    montant_finance: principal,
    apport,
    duree_mois: n,
    taux_annuel_pct: input.taux,
    mensualite,
    cout_total: coutTotal,
    cout_credit: coutCredit,
    conseil_fr:
      coutCredit > principal * 0.15
        ? "Le coût du crédit dépasse 15% du montant financé — compare avec une LOA/LLD ou négocie le taux."
        : "Coût de crédit raisonnable au regard du montant financé.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Simulateur retraite indépendant — GET /api/finance/retirement-forecast
// ─────────────────────────────────────────────────────────────────────────────
export interface RetirementInput {
  age_actuel: number;
  age_depart: number;
  revenu_annuel_moyen: number;
  versement_liberatoire: boolean;
  per_mensuel?: number;
}

export function forecastRetirement(input: RetirementInput) {
  const anneesRestantes = Math.max(0, input.age_depart - input.age_actuel);

  // CIPAV (caisse historique VTC / professions libérales) — approximation simplifiée
  // basée sur un taux de conversion de points indicatif (pédagogique, pas un calcul officiel).
  const tauxCotisationRetraiteApprox = 0.145; // ~14.5% du revenu part assurance vieillesse (base+complémentaire, ordre de grandeur)
  const cotisationAnnuelle = input.revenu_annuel_moyen * tauxCotisationRetraiteApprox;
  const pointsParAn = cotisationAnnuelle / 15; // valeur d'achat du point approximative
  const totalPoints = pointsParAn * anneesRestantes;
  const valeurPoint = 0.6; // valeur de service approximative indicative
  const pensionAnnuelleCipav = Math.round(totalPoints * valeurPoint);
  const pensionMensuelleCipav = Math.round(pensionAnnuelleCipav / 12);

  // Versement libératoire : impact sur le revenu net immédiat, pas sur les droits retraite eux-mêmes
  // (les cotisations sociales sont les mêmes ; le VL ne concerne que l'impôt sur le revenu).
  const impotVLAnnuel = input.versement_liberatoire
    ? Math.round(input.revenu_annuel_moyen * (URSSAF.TAUX_VERSEMENT_LIBERATOIRE_PCT / 100))
    : null;

  // PER (Plan Épargne Retraite) : capital accumulé si versement mensuel volontaire
  const perMensuel = input.per_mensuel ?? 0;
  const tauxRendementAnnuelPer = 0.03; // hypothèse prudente 3%/an
  const moisRestants = anneesRestantes * 12;
  let capitalPer = 0;
  const tauxMensuel = tauxRendementAnnuelPer / 12;
  for (let i = 0; i < moisRestants; i++) {
    capitalPer = (capitalPer + perMensuel) * (1 + tauxMensuel);
  }
  capitalPer = Math.round(capitalPer);
  // Rente mensuelle indicative sur 20 ans après le départ (hors fiscalité de sortie)
  const rentePerMensuelle = Math.round(capitalPer / (20 * 12));

  return {
    annees_restantes: anneesRestantes,
    cipav: {
      pension_mensuelle_estimee: pensionMensuelleCipav,
      note_fr: "Estimation pédagogique très simplifiée (taux de cotisation et valeur du point approximatifs) — ne remplace pas un relevé de carrière officiel CIPAV/CNAV.",
    },
    versement_liberatoire: {
      actif: input.versement_liberatoire,
      impot_annuel_estime: impotVLAnnuel,
      note_fr: input.versement_liberatoire
        ? "Le versement libératoire fixe l'impôt sur le revenu à un taux forfaitaire, mais n'augmente ni ne diminue tes droits à la retraite (cotisations sociales inchangées)."
        : "Sans versement libératoire, l'impôt suit le barème progressif classique selon tes revenus totaux du foyer.",
    },
    per: {
      versement_mensuel: perMensuel,
      capital_estime_depart: capitalPer,
      rente_mensuelle_indicative: rentePerMensuelle,
      note_fr: "Hypothèse de rendement 3%/an, hors fiscalité de sortie et hors inflation — à affiner avec un conseiller.",
    },
    comparatif_fr:
      "La CIPAV seule couvre rarement plus de 40-50% du revenu d'activité : un PER ou une épargne complémentaire est recommandé pour les indépendants VTC.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Réconciliation revenus multi-plateformes — POST /api/finance/multi-platform-reconciliation
// ─────────────────────────────────────────────────────────────────────────────
export interface ReconciliationInput {
  period: string; // "2026-07"
  uber?: number;
  bolt?: number;
  heetch?: number;
  freenow?: number;
  bank_statement_amount: number;
}

export function reconcileMultiPlatform(userId: string, input: ReconciliationInput) {
  const platforms = {
    uber: input.uber ?? 0,
    bolt: input.bolt ?? 0,
    heetch: input.heetch ?? 0,
    freenow: input.freenow ?? 0,
  };
  const totalPlatforms = Math.round((platforms.uber + platforms.bolt + platforms.heetch + platforms.freenow) * 100) / 100;
  const ecart = Math.round((input.bank_statement_amount - totalPlatforms) * 100) / 100;
  const ecartPct = totalPlatforms > 0 ? Math.round((Math.abs(ecart) / totalPlatforms) * 1000) / 10 : 0;

  // Journalisation pour historique
  const tx = db.transaction(() => {
    for (const [platform, amount] of Object.entries(platforms)) {
      if (amount > 0) {
        db.prepare(`INSERT INTO platform_income_manual (user_id, platform, period, amount) VALUES (?, ?, ?, ?)`).run(
          userId,
          platform,
          input.period,
          amount
        );
      }
    }
    db.prepare(`INSERT INTO bank_statement_manual (user_id, period, amount) VALUES (?, ?, ?)`).run(
      userId,
      input.period,
      input.bank_statement_amount
    );
  });
  tx();

  let verdict_fr: string;
  let status: "ok" | "attention" | "ecart_important";
  if (ecartPct <= 2) {
    verdict_fr = "Cohérence excellente entre les plateformes et le relevé bancaire.";
    status = "ok";
  } else if (ecartPct <= 8) {
    verdict_fr = "Petit écart possible (délais de versement, frais bancaires) — à surveiller.";
    status = "attention";
  } else {
    verdict_fr = "Écart important détecté — vérifie les versements en attente, doublons ou paiement manquant d'une plateforme.";
    status = "ecart_important";
  }

  return {
    period: input.period,
    platforms,
    total_plateformes: totalPlatforms,
    releve_bancaire: input.bank_statement_amount,
    ecart,
    ecart_pct: ecartPct,
    status,
    verdict_fr,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Alertes financières intelligentes — GET /api/finance/smart-alerts
// ─────────────────────────────────────────────────────────────────────────────
export function getSmartAlerts(userId: string) {
  const alerts: { type: string; severity: "info" | "warning" | "critical"; message_fr: string }[] = [];

  const now = new Date();
  const mois = now.getMonth() + 1;
  const annee = now.getFullYear();
  const budget = getBudget(userId, mois, annee);

  if (budget) {
    if (budget.disponible < 0) {
      alerts.push({
        type: "budget_negatif",
        severity: "critical",
        message_fr: `Ton budget de ${String(mois).padStart(2, "0")}/${annee} est en négatif de ${Math.abs(budget.disponible).toFixed(2)} € une fois charges, impôt et épargne déduits.`,
      });
    }
    if (budget.pct_utilise > 90) {
      alerts.push({
        type: "budget_tendu",
        severity: "warning",
        message_fr: `${budget.pct_utilise}% de ton revenu brut est déjà engagé en charges/impôt/épargne ce mois-ci.`,
      });
    }
  } else {
    alerts.push({
      type: "budget_manquant",
      severity: "info",
      message_fr: "Aucun budget renseigné pour ce mois — ajoute tes revenus et charges pour un suivi précis.",
    });
  }

  // Provision impôt en retard : dernier mois budgété sans provision suffisante
  const lastBudgets = getBudgetHistory(userId, 3) as any[];
  const lateProvision = lastBudgets.find((b) => b.provision_impot < b.revenu_brut * (URSSAF.TAUX_COTISATIONS_PCT / 100) * 0.8);
  if (lateProvision) {
    alerts.push({
      type: "provision_impot_retard",
      severity: "warning",
      message_fr: `Ta provision impôt/URSSAF de ${String(lateProvision.mois).padStart(2, "0")}/${lateProvision.annee} semble insuffisante par rapport à ton revenu brut — vérifie avant l'échéance.`,
    });
  }

  const autoSave = getAutoSaveSettings(userId);
  if (!autoSave.enabled) {
    alerts.push({
      type: "epargne_desactivee",
      severity: "info",
      message_fr: "L'épargne automatique est désactivée — active-la pour mettre de côté un % de chaque course sans y penser.",
    });
  }

  if (alerts.length === 0) {
    alerts.push({ type: "rien_a_signaler", severity: "info", message_fr: "Aucune alerte financière pour le moment, tout est sous contrôle." });
  }

  return { alerts, checked_at: new Date().toISOString() };
}
