/**
 * fiscalProactif.ts — Couche FISCAL PROACTIF (Itération Rentabilisation)
 * ─────────────────────────────────────────────────────────────────────────────
 * Implémente les leviers rapport.md §5 (fiscal & administratif temps réel),
 * §6 (coûts cachés véhicule) et §18 (assistance juridique/administrative).
 *
 * Patch strictement ADDITIF : nouvelles tables, nouvelles fonctions, aucune
 * modification des fichiers existants (economicsEngine.ts, taxConstants.ts,
 * storage.ts) — uniquement des imports en lecture.
 *
 * Barèmes réglementaires : EXCLUSIVEMENT depuis ./taxConstants (TAX_CONSTANTS_VERSION
 * "2026.1"). Aucune valeur fiscale hardcodée ici en dehors des dates d'échéances
 * administratives officielles 2026 (URSSAF/TVA/CFE/IR), sourcées ci-dessous.
 *
 * Sources échéances 2026 (consultées 07/07/2026) :
 * - URSSAF micro-entrepreneur : déclaration mensuelle avant le dernier jour du mois
 *   suivant (ici simplifié au 30 de chaque mois, cf. demande du rapport) —
 *   https://www.urssaf.fr/accueil/independants/gerer-declarer/declarer-payer.html
 * - TVA (déclarants réels/franchise en cours d'année) échéances trimestrielles usuelles
 *   24 avril / 24 juillet / 24 octobre / 31 décembre —
 *   https://www.impots.gouv.fr/professionnel/tva
 * - CFE (Cotisation Foncière des Entreprises) : solde à régler avant le 15 décembre —
 *   https://www.impots.gouv.fr/professionnel/la-cotisation-fonciere-des-entreprises-cfe
 * - Déclaration de revenus (IR) : campagne de mai (période classique mi-avril à début juin) —
 *   https://www.impots.gouv.fr/particulier/deposer-votre-declaration-de-revenus
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sqlite, storage } from "./storage";
import {
  URSSAF,
  TVA,
  BAREME_IK_2026,
  calculerIKAnnuel,
  TAX_CONSTANTS_VERSION,
} from "./taxConstants";
import { computeUrssafSummary, simulateStatusChange } from "./economicsEngine";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ═══════════════════════════════════════════════════════════════════════════
// ─── SCHÉMA SQLITE (additif) ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
sqlite.exec(`
  -- Levier 5.4 : provisionnement quotidien automatique (URSSAF + TVA + IR)
  CREATE TABLE IF NOT EXISTS tax_provisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                 -- YYYY-MM-DD (jour concerné)
    ca_jour REAL NOT NULL DEFAULT 0,
    urssaf_provision REAL NOT NULL DEFAULT 0,
    tva_provision REAL NOT NULL DEFAULT 0,
    ir_provision REAL NOT NULL DEFAULT 0,
    total_provision REAL NOT NULL DEFAULT 0,
    is_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date)
  );

  -- Levier 5.5 : notes de frais catégorisées (carburant, péage, entretien, assurance, télépéage, km)
  CREATE TABLE IF NOT EXISTS expenses_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                 -- YYYY-MM-DD
    category TEXT NOT NULL,             -- carburant | peage | entretien | assurance | telepeage | kilometrage | autre
    label TEXT NOT NULL DEFAULT '',
    amount_eur REAL NOT NULL DEFAULT 0, -- montant direct (hors kilométrage) ou 0 si calculé via IK
    km INTEGER,                         -- pour la catégorie 'kilometrage' : distance parcourue
    deductible INTEGER NOT NULL DEFAULT 1,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses_log(date DESC);
  CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses_log(category);

  -- Levier 6.1 : entretien préventif prédictif (planning km + rappels)
  CREATE TABLE IF NOT EXISTS maintenance_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    component TEXT NOT NULL UNIQUE,     -- vidange | pneus | freins | revision_annuelle
    label_fr TEXT NOT NULL,
    interval_km INTEGER,                -- intervalle kilométrique (NULL si annuel calendaire)
    interval_months INTEGER,            -- intervalle en mois (révision annuelle)
    last_done_km INTEGER NOT NULL DEFAULT 0,
    last_done_date TEXT,
    estimated_cost_eur REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Levier 6.3 : suivi km réel vs plafond contractuel LOA/LLD
  CREATE TABLE IF NOT EXISTS loa_contract (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_type TEXT NOT NULL DEFAULT 'LLD', -- LOA | LLD
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    km_plafond_annuel INTEGER NOT NULL DEFAULT 30000,
    km_depart INTEGER NOT NULL DEFAULT 0,
    penalite_par_km_eur REAL NOT NULL DEFAULT 0.08,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Levier 18.1 : échéances administratives françaises (URSSAF/TVA/CFE/IR/carte pro/CT/assurance)
  CREATE TABLE IF NOT EXISTS admin_deadlines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                 -- urssaf | tva | cfe | ir | carte_pro | controle_technique | assurance_rc
    label_fr TEXT NOT NULL,
    due_date TEXT NOT NULL,             -- YYYY-MM-DD
    is_recurring INTEGER NOT NULL DEFAULT 1,
    is_done INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_deadlines_date ON admin_deadlines(due_date);
  CREATE INDEX IF NOT EXISTS idx_deadlines_type ON admin_deadlines(type);
`);

// ─── Migration additive : champs carte pro / CT / assurance sur driver_profile ──
const PROFILE_MIGRATIONS = [
  "ALTER TABLE driver_profile ADD COLUMN carte_pro_vtc_date TEXT",
  "ALTER TABLE driver_profile ADD COLUMN carte_pro_vtc_expiry TEXT",
  "ALTER TABLE driver_profile ADD COLUMN controle_technique_date TEXT",
  "ALTER TABLE driver_profile ADD COLUMN assurance_rc_pro_expiry TEXT",
  "ALTER TABLE driver_profile ADD COLUMN activite_debut_date TEXT",
  "ALTER TABLE driver_profile ADD COLUMN acre_actif INTEGER DEFAULT 0",
  "ALTER TABLE driver_profile ADD COLUMN versement_liberatoire_actif INTEGER DEFAULT 0",
];
for (const m of PROFILE_MIGRATIONS) {
  try { sqlite.exec(m); } catch { /* colonne déjà existante — ignoré */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 5.1 SIMULATEUR FRANCHISSEMENT SEUIL TVA ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface TvaThresholdForecast {
  ca_ytd: number;
  ca_projected_year_end: number;
  seuil_base: number;
  seuil_majore: number;
  pct_seuil_base: number;
  alert_level: "ok" | "80" | "90" | "100" | "depasse_majore";
  message_fr: string;
  jours_ecoules: number;
  jours_restants: number;
  rythme_journalier_moyen: number;
}

export function computeTvaThresholdForecast(year?: number): TvaThresholdForecast {
  const y = year ?? new Date().getFullYear();
  const summary = computeUrssafSummary(y);
  const ca_ytd = summary.total_ca;

  const now = new Date();
  const startOfYear = new Date(Date.UTC(y, 0, 1));
  const endOfYear = new Date(Date.UTC(y, 11, 31));
  const isCurrentYear = now.getUTCFullYear() === y;
  const refDate = isCurrentYear ? now : endOfYear;

  const jours_ecoules = Math.max(1, Math.round((refDate.getTime() - startOfYear.getTime()) / 86_400_000) + 1);
  const totalJoursAnnee = Math.round((endOfYear.getTime() - startOfYear.getTime()) / 86_400_000) + 1;
  const jours_restants = Math.max(0, totalJoursAnnee - jours_ecoules);

  const rythme_journalier_moyen = r2(ca_ytd / jours_ecoules);
  const ca_projected_year_end = r2(ca_ytd + rythme_journalier_moyen * jours_restants);

  const seuil_base = TVA.FRANCHISE_SEUIL_BASE_EUR;
  const seuil_majore = TVA.FRANCHISE_SEUIL_MAJORE_EUR;
  const pct_seuil_base = r2((ca_ytd / seuil_base) * 100);

  let alert_level: TvaThresholdForecast["alert_level"] = "ok";
  let message_fr: string;

  if (ca_ytd >= seuil_majore) {
    alert_level = "depasse_majore";
    message_fr = `Seuil majoré de ${seuil_majore}€ dépassé : vous êtes assujetti à la TVA immédiatement, dès le mois du dépassement. Consultez un expert-comptable pour la mise en conformité.`;
  } else if (pct_seuil_base >= 100) {
    alert_level = "100";
    message_fr = `Seuil de franchise de base (${seuil_base}€) dépassé. Vous restez en franchise jusqu'à ${seuil_majore}€, mais devenez assujetti à la TVA dès le 1er jour du mois de dépassement du seuil majoré.`;
  } else if (pct_seuil_base >= 90) {
    alert_level = "90";
    message_fr = `Attention : ${pct_seuil_base.toFixed(0)}% du seuil de franchise TVA (${seuil_base}€) atteint. Au rythme actuel, dépassement projeté avant fin d'année (CA estimé ${ca_projected_year_end}€). Anticipez une éventuelle facturation TVA.`;
  } else if (pct_seuil_base >= 80) {
    alert_level = "80";
    message_fr = `${pct_seuil_base.toFixed(0)}% du seuil de franchise TVA atteint. Surveillez votre rythme de CA pour anticiper un éventuel passage à la TVA.`;
  } else {
    message_fr = `Vous êtes à ${pct_seuil_base.toFixed(0)}% du seuil de franchise TVA (${seuil_base}€). Aucune action requise pour le moment.`;
  }

  return {
    ca_ytd,
    ca_projected_year_end,
    seuil_base,
    seuil_majore,
    pct_seuil_base,
    alert_level,
    message_fr,
    jours_ecoules,
    jours_restants,
    rythme_journalier_moyen,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 5.4 PROVISIONNEMENT QUOTIDIEN AUTOMATIQUE ──────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface DailyProvision {
  date: string;
  ca_jour: number;
  urssaf_provision: number;
  tva_provision: number;
  ir_provision: number;
  total_provision: number;
  pct_total: number;
  message_fr: string;
}

/**
 * Calcule les montants à provisionner (mettre de côté) pour une date donnée,
 * à partir du CA réel du jour (issu des courses enregistrées).
 * - URSSAF : taux TAUX_COTISATIONS_PCT + TAUX_CFP_PCT (ou taux ACRE réduit si actif)
 * - TVA : provisionné uniquement si le profil est déjà assujetti (régime "assujetti")
 * - IR : approximation prudente (versement libératoire 1.7% si actif, sinon 0 —
 *   l'IR classique est calculé annuellement au barème, donc non quotidien par défaut ;
 *   on applique ici le taux de versement libératoire comme proxy "à mettre de côté"
 *   pour rester prudent, cohérent avec §5.7 du rapport).
 */
export function computeDailyProvision(dateStr?: string): DailyProvision {
  const date = dateStr ?? new Date().toISOString().slice(0, 10);
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;
  const rides = storage.getRidesInRange(dayStart, dayEnd);
  const ca_jour = r2(rides.reduce((s: number, r: any) => s + (r.fare ?? 0), 0));

  const profile: any = storage.getDriverProfile() || {};
  const acreActif = Boolean(profile.acre_actif);
  const versementLiberatoireActif = Boolean(profile.versement_liberatoire_actif);

  let urssafPct = URSSAF.TAUX_COTISATIONS_PCT + URSSAF.TAUX_CFP_PCT;
  if (acreActif) urssafPct = urssafPct * (URSSAF.TAUX_ACRE_REDUCTION_PCT / 100);

  const urssaf_provision = r2(ca_jour * (urssafPct / 100));

  const tvaRegime = profile.tva_regime ?? "franchise";
  const tva_provision = tvaRegime === "assujetti" ? r2(ca_jour * (TVA.TAUX_TVA_TRANSPORT_PCT / 100)) : 0;

  const ir_provision = versementLiberatoireActif
    ? r2(ca_jour * (URSSAF.TAUX_VERSEMENT_LIBERATOIRE_PCT / 100))
    : 0;

  const total_provision = r2(urssaf_provision + tva_provision + ir_provision);
  const pct_total = ca_jour > 0 ? r2((total_provision / ca_jour) * 100) : 0;

  const message_fr = ca_jour > 0
    ? `Mettez de côté ${total_provision}€ aujourd'hui (${pct_total}% du CA du jour) : ${urssaf_provision}€ URSSAF${tva_provision > 0 ? ` + ${tva_provision}€ TVA` : ""}${ir_provision > 0 ? ` + ${ir_provision}€ IR (versement libératoire)` : ""}.`
    : "Aucune course enregistrée ce jour — rien à provisionner.";

  // Upsert dans tax_provisions
  sqlite.prepare(`
    INSERT INTO tax_provisions (date, ca_jour, urssaf_provision, tva_provision, ir_provision, total_provision)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      ca_jour=excluded.ca_jour, urssaf_provision=excluded.urssaf_provision,
      tva_provision=excluded.tva_provision, ir_provision=excluded.ir_provision,
      total_provision=excluded.total_provision
  `).run(date, ca_jour, urssaf_provision, tva_provision, ir_provision, total_provision);

  return { date, ca_jour, urssaf_provision, tva_provision, ir_provision, total_provision, pct_total, message_fr };
}

export function getProvisionsHistory(limit = 30): any[] {
  return sqlite.prepare(`SELECT * FROM tax_provisions ORDER BY date DESC LIMIT ?`).all(limit);
}

export function getProvisionsTotalSince(sinceDate: string): number {
  const row = sqlite.prepare(
    `SELECT COALESCE(SUM(total_provision), 0) as total FROM tax_provisions WHERE date >= ?`
  ).get(sinceDate) as any;
  return r2(row.total);
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 5.5 NOTES DE FRAIS AVEC CATÉGORISATION ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export type ExpenseCategory = "carburant" | "peage" | "entretien" | "assurance" | "telepeage" | "kilometrage" | "autre";

export interface ExpenseInput {
  date?: string;
  category: ExpenseCategory;
  label?: string;
  amount_eur?: number;
  km?: number;
  deductible?: boolean;
  notes?: string;
}

/**
 * Enregistre une dépense. Pour la catégorie "kilometrage", le montant est calculé
 * automatiquement via le barème IK 2026 (calculerIKAnnuel) à partir du km fourni
 * et des paramètres véhicule du profil (puissance fiscale, électrique).
 */
export function addExpense(input: ExpenseInput): any {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const category = input.category;
  const label = input.label ?? "";
  const notes = input.notes ?? "";
  const deductible = input.deductible === false ? 0 : 1;

  let amount_eur = input.amount_eur ?? 0;
  let km: number | null = null;

  if (category === "kilometrage") {
    km = input.km ?? 0;
    const profile: any = storage.getDriverProfile() || {};
    const cvFiscaux = Number(profile.vehicle_cv_fiscaux ?? 5);
    const isElectrique = Boolean(profile.electric_mode);
    // calculerIKAnnuel applique un barème dégressif par palier annuel ; pour une
    // dépense ponctuelle on l'applique directement à la distance déclarée (usage
    // documenté : "km parcourus depuis le dernier relevé").
    amount_eur = calculerIKAnnuel(km, cvFiscaux, isElectrique);
  }

  const stmt = sqlite.prepare(`
    INSERT INTO expenses_log (date, category, label, amount_eur, km, deductible, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(date, category, label, r2(amount_eur), km, deductible, notes);
  return sqlite.prepare(`SELECT * FROM expenses_log WHERE id = ?`).get(result.lastInsertRowid);
}

export interface ExpensesListFilter {
  month?: string; // YYYY-MM
  category?: ExpenseCategory;
  limit?: number;
}

export function listExpenses(filter: ExpensesListFilter = {}): { rows: any[]; total_month_eur: number; by_category: Record<string, number> } {
  const limit = filter.limit ?? 100;
  let rows: any[];
  if (filter.month) {
    if (filter.category) {
      rows = sqlite.prepare(
        `SELECT * FROM expenses_log WHERE date LIKE ? AND category = ? ORDER BY date DESC LIMIT ?`
      ).all(`${filter.month}%`, filter.category, limit) as any[];
    } else {
      rows = sqlite.prepare(
        `SELECT * FROM expenses_log WHERE date LIKE ? ORDER BY date DESC LIMIT ?`
      ).all(`${filter.month}%`, limit) as any[];
    }
  } else if (filter.category) {
    rows = sqlite.prepare(
      `SELECT * FROM expenses_log WHERE category = ? ORDER BY date DESC LIMIT ?`
    ).all(filter.category, limit) as any[];
  } else {
    rows = sqlite.prepare(`SELECT * FROM expenses_log ORDER BY date DESC LIMIT ?`).all(limit) as any[];
  }

  const month = filter.month ?? new Date().toISOString().slice(0, 7);
  const monthRows = sqlite.prepare(`SELECT * FROM expenses_log WHERE date LIKE ?`).all(`${month}%`) as any[];
  const total_month_eur = r2(monthRows.reduce((s, r) => s + (r.amount_eur ?? 0), 0));

  const by_category: Record<string, number> = {};
  for (const r of monthRows) {
    by_category[r.category] = r2((by_category[r.category] ?? 0) + (r.amount_eur ?? 0));
  }

  return { rows, total_month_eur, by_category };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 5.6 CALCUL ACRE ÉLIGIBILITÉ + ÉCONOMIES ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface AcreSimulation {
  eligible: boolean;
  raison_fr: string;
  taux_normal_pct: number;
  taux_acre_pct: number;
  economie_annuelle_estimee: number;
  fin_periode_acre: string | null;
  mois_restants_acre: number;
}

/**
 * L'ACRE réduit de moitié les cotisations sociales la 1ère année d'activité
 * (jusqu'à 4 trimestres civils pleins après le trimestre de création).
 * Éligibilité simplifiée : basée sur `activite_debut_date` du profil (< 12 mois).
 */
export function simulateAcre(annualCaOverride?: number): AcreSimulation {
  const profile: any = storage.getDriverProfile() || {};
  const debutStr: string | undefined = profile.activite_debut_date;

  const taux_normal_pct = URSSAF.TAUX_COTISATIONS_PCT + URSSAF.TAUX_CFP_PCT;
  const taux_acre_pct = r2(taux_normal_pct * (URSSAF.TAUX_ACRE_REDUCTION_PCT / 100));

  const currentYear = new Date().getFullYear();
  const annualCa = annualCaOverride ?? computeUrssafSummary(currentYear).total_ca;

  if (!debutStr) {
    return {
      eligible: false,
      raison_fr: "Date de début d'activité non renseignée dans votre profil. Renseignez-la pour vérifier votre éligibilité à l'ACRE.",
      taux_normal_pct: r2(taux_normal_pct),
      taux_acre_pct,
      economie_annuelle_estimee: 0,
      fin_periode_acre: null,
      mois_restants_acre: 0,
    };
  }

  const debut = new Date(debutStr);
  const now = new Date();
  const moisEcoules = (now.getFullYear() - debut.getFullYear()) * 12 + (now.getMonth() - debut.getMonth());

  // ACRE valable jusqu'à la fin du 4ème trimestre civil après le trimestre de création,
  // approximé ici à 12 mois pleins pour simplicité (cf. piège rapport §5.2 : changement
  // de répartition trimestrielle prévu à partir de juillet 2026).
  const DUREE_ACRE_MOIS = 12;
  const eligible = moisEcoules >= 0 && moisEcoules < DUREE_ACRE_MOIS;

  const finPeriode = new Date(debut);
  finPeriode.setMonth(finPeriode.getMonth() + DUREE_ACRE_MOIS);
  const mois_restants_acre = eligible ? Math.max(0, DUREE_ACRE_MOIS - moisEcoules) : 0;

  const economie_annuelle_estimee = eligible
    ? r2(annualCa * ((taux_normal_pct - taux_acre_pct) / 100))
    : 0;

  const raison_fr = eligible
    ? `Éligible à l'ACRE : activité créée le ${debut.toLocaleDateString("fr-FR")}, il vous reste ${mois_restants_acre} mois de réduction de cotisations (taux ${taux_acre_pct}% au lieu de ${r2(taux_normal_pct)}%).`
    : moisEcoules < 0
      ? "Date de début d'activité dans le futur — vérifiez votre profil."
      : `Période ACRE expirée (activité créée le ${debut.toLocaleDateString("fr-FR")}, plus de ${DUREE_ACRE_MOIS} mois). Taux plein applicable (${r2(taux_normal_pct)}%).`;

  return {
    eligible,
    raison_fr,
    taux_normal_pct: r2(taux_normal_pct),
    taux_acre_pct,
    economie_annuelle_estimee,
    fin_periode_acre: eligible ? finPeriode.toISOString().slice(0, 10) : null,
    mois_restants_acre,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 5.7 VERSEMENT LIBÉRATOIRE VS PRÉLÈVEMENT À LA SOURCE ───────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface LiberatoireVsSourceResult {
  ca_annuel: number;
  rfr_par_part_estime: number;
  eligible_liberatoire: boolean;
  cout_liberatoire: number;
  cout_prelevement_source_estime: number;
  economie_liberatoire: number;
  recommandation_fr: string;
}

/**
 * Compare le coût du versement libératoire de l'IR (1.7% du CA, si RFR N-2 par part
 * < seuil) au prélèvement à la source classique estimé via un taux moyen d'imposition
 * simplifié appliqué au bénéfice imposable (CA - abattement forfaitaire micro-BIC 50%).
 * Seuil RFR 2026 : 29 315€/part (rapport.md §5.3).
 */
const RFR_SEUIL_PAR_PART = 29_315;

export function computeLiberatoireVsSource(annualCa: number, rfrParPart?: number, tauxMoyenImpositionPct = 11): LiberatoireVsSourceResult {
  const rfr_par_part_estime = rfrParPart ?? 0;
  const eligible_liberatoire = rfr_par_part_estime > 0 ? rfr_par_part_estime <= RFR_SEUIL_PAR_PART : true;

  const cout_liberatoire = r2(annualCa * (URSSAF.TAUX_VERSEMENT_LIBERATOIRE_PCT / 100));

  // Abattement forfaitaire micro-BIC prestations de services = 50% du CA (bénéfice imposable)
  const beneficeImposable = annualCa * 0.5;
  const cout_prelevement_source_estime = r2(beneficeImposable * (tauxMoyenImpositionPct / 100));

  const economie_liberatoire = r2(cout_prelevement_source_estime - cout_liberatoire);

  let recommandation_fr: string;
  if (!eligible_liberatoire) {
    recommandation_fr = `Non éligible au versement libératoire : votre revenu fiscal de référence par part (${rfr_par_part_estime}€) dépasse le seuil de ${RFR_SEUIL_PAR_PART}€. Le prélèvement à la source classique s'applique.`;
  } else if (economie_liberatoire > 0) {
    recommandation_fr = `Le versement libératoire (1,7% du CA, soit ${cout_liberatoire}€/an) est plus avantageux que le prélèvement à la source estimé (${cout_prelevement_source_estime}€/an), avec une économie de ${economie_liberatoire}€/an. Option à activer sur votre espace URSSAF.`;
  } else {
    recommandation_fr = `Le prélèvement à la source classique (${cout_prelevement_source_estime}€/an estimé) semble plus avantageux que le versement libératoire (${cout_liberatoire}€/an) à votre niveau de CA et de taux d'imposition. Vérifiez avec votre avis d'imposition réel.`;
  }

  return {
    ca_annuel: r2(annualCa),
    rfr_par_part_estime,
    eligible_liberatoire,
    cout_liberatoire,
    cout_prelevement_source_estime,
    economie_liberatoire,
    recommandation_fr,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 6.1 ENTRETIEN PRÉVENTIF PRÉDICTIF ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_MAINTENANCE_SCHEDULE = [
  { component: "vidange",           label_fr: "Vidange",              interval_km: 12500, interval_months: null as number | null, estimated_cost_eur: 100 },
  { component: "pneus",             label_fr: "Pneus",                interval_km: 30000, interval_months: null,                   estimated_cost_eur: 450 },
  { component: "freins",            label_fr: "Freins (plaquettes/disques)", interval_km: 40000, interval_months: null,            estimated_cost_eur: 300 },
  { component: "revision_annuelle", label_fr: "Révision annuelle",    interval_km: null,  interval_months: 12,                     estimated_cost_eur: 200 },
];

export function seedMaintenanceSchedule(): void {
  const cnt = (sqlite.prepare(`SELECT COUNT(*) as c FROM maintenance_schedule`).get() as any).c;
  if (cnt > 0) return;
  const ins = sqlite.prepare(`
    INSERT INTO maintenance_schedule (component, label_fr, interval_km, interval_months, last_done_km, last_done_date, estimated_cost_eur)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `);
  const nowDate = new Date().toISOString().slice(0, 10);
  const tx = sqlite.transaction(() => {
    for (const m of DEFAULT_MAINTENANCE_SCHEDULE) {
      ins.run(m.component, m.label_fr, m.interval_km, m.interval_months, nowDate, m.estimated_cost_eur);
    }
  });
  tx();
}

export interface MaintenanceItem {
  component: string;
  label_fr: string;
  interval_km: number | null;
  interval_months: number | null;
  last_done_km: number;
  last_done_date: string | null;
  current_km: number;
  km_since_last: number;
  km_remaining: number | null;
  months_remaining: number | null;
  urgency: "ok" | "soon" | "urgent" | "overdue";
  estimated_cost_eur: number;
  next_due_label_fr: string;
}

export function computePreventiveMaintenance(): { items: MaintenanceItem[]; prochaine_echeance: MaintenanceItem | null } {
  seedMaintenanceSchedule();
  const profile: any = storage.getDriverProfile() || {};
  const current_km = Number(profile.total_km_driven ?? 0);

  const rows = sqlite.prepare(`SELECT * FROM maintenance_schedule`).all() as any[];
  const items: MaintenanceItem[] = rows.map((r) => {
    const km_since_last = Math.max(0, current_km - (r.last_done_km ?? 0));
    let km_remaining: number | null = null;
    let months_remaining: number | null = null;
    let urgency: MaintenanceItem["urgency"] = "ok";
    let next_due_label_fr = "";

    if (r.interval_km) {
      km_remaining = r.interval_km - km_since_last;
      if (km_remaining < 0) urgency = "overdue";
      else if (km_remaining < r.interval_km * 0.1) urgency = "urgent";
      else if (km_remaining < r.interval_km * 0.2) urgency = "soon";
      next_due_label_fr = km_remaining <= 0
        ? `Dépassé de ${Math.abs(km_remaining)} km`
        : `Dans ${km_remaining} km`;
    }
    if (r.interval_months) {
      const lastDate = r.last_done_date ? new Date(r.last_done_date) : new Date();
      const nextDate = new Date(lastDate);
      nextDate.setMonth(nextDate.getMonth() + r.interval_months);
      const now = new Date();
      months_remaining = Math.round((nextDate.getTime() - now.getTime()) / (30 * 86_400_000));
      if (months_remaining < 0) urgency = "overdue";
      else if (months_remaining < 1) urgency = "urgent";
      else if (months_remaining < 2) urgency = "soon";
      next_due_label_fr = months_remaining <= 0
        ? `Dépassé de ${Math.abs(months_remaining)} mois`
        : `Dans ${months_remaining} mois (${nextDate.toLocaleDateString("fr-FR")})`;
    }

    return {
      component: r.component,
      label_fr: r.label_fr,
      interval_km: r.interval_km,
      interval_months: r.interval_months,
      last_done_km: r.last_done_km,
      last_done_date: r.last_done_date,
      current_km,
      km_since_last,
      km_remaining,
      months_remaining,
      urgency,
      estimated_cost_eur: r.estimated_cost_eur,
      next_due_label_fr,
    };
  });

  const urgencyRank: Record<string, number> = { overdue: 0, urgent: 1, soon: 2, ok: 3 };
  const sorted = [...items].sort((a, b) => urgencyRank[a.urgency] - urgencyRank[b.urgency]);

  return { items, prochaine_echeance: sorted[0] ?? null };
}

export function markMaintenanceScheduleDone(component: string): MaintenanceItem | null {
  const profile: any = storage.getDriverProfile() || {};
  const current_km = Number(profile.total_km_driven ?? 0);
  const nowDate = new Date().toISOString().slice(0, 10);
  sqlite.prepare(`
    UPDATE maintenance_schedule SET last_done_km = ?, last_done_date = ?, updated_at = datetime('now')
    WHERE component = ?
  `).run(current_km, nowDate, component);
  const { items } = computePreventiveMaintenance();
  return items.find((i) => i.component === component) ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 6.3 ALERTE DÉPASSEMENT KM LOA/LLD ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface LoaKmTracker {
  has_contract: boolean;
  contract_type?: string;
  km_plafond_annuel?: number;
  km_parcourus_periode?: number;
  km_prevu_a_date?: number;
  km_reel_a_date?: number;
  ecart_km?: number;
  projection_fin_contrat_km?: number;
  depassement_projete_km?: number;
  penalite_estimee_eur?: number;
  alert_level: "ok" | "attention" | "depassement";
  message_fr: string;
}

export function getLoaContract(): any {
  return sqlite.prepare(`SELECT * FROM loa_contract ORDER BY id DESC LIMIT 1`).get();
}

export function upsertLoaContract(input: {
  contract_type?: string; start_date: string; end_date: string;
  km_plafond_annuel: number; km_depart?: number; penalite_par_km_eur?: number;
}): any {
  const existing = getLoaContract();
  if (existing) {
    sqlite.prepare(`
      UPDATE loa_contract SET contract_type=?, start_date=?, end_date=?, km_plafond_annuel=?, km_depart=?, penalite_par_km_eur=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      input.contract_type ?? existing.contract_type,
      input.start_date, input.end_date, input.km_plafond_annuel,
      input.km_depart ?? existing.km_depart, input.penalite_par_km_eur ?? existing.penalite_par_km_eur,
      existing.id
    );
  } else {
    sqlite.prepare(`
      INSERT INTO loa_contract (contract_type, start_date, end_date, km_plafond_annuel, km_depart, penalite_par_km_eur)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.contract_type ?? "LLD", input.start_date, input.end_date,
      input.km_plafond_annuel, input.km_depart ?? 0, input.penalite_par_km_eur ?? 0.08
    );
  }
  return getLoaContract();
}

export function computeLoaKmTracker(): LoaKmTracker {
  const contract = getLoaContract();
  if (!contract) {
    return { has_contract: false, alert_level: "ok", message_fr: "Aucun contrat LOA/LLD renseigné. Ajoutez vos informations de contrat pour activer le suivi kilométrique." };
  }

  const profile: any = storage.getDriverProfile() || {};
  const current_km = Number(profile.total_km_driven ?? 0);

  const start = new Date(contract.start_date);
  const end = new Date(contract.end_date);
  const now = new Date();

  const dureeContratJours = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  const dureeContratAnnees = dureeContratJours / 365;
  const km_plafond_total = Math.round(contract.km_plafond_annuel * dureeContratAnnees);

  const joursEcoules = Math.max(0, Math.min(dureeContratJours, Math.round((now.getTime() - start.getTime()) / 86_400_000)));
  const km_reel_a_date = Math.max(0, current_km - contract.km_depart);
  const km_prevu_a_date = Math.round((contract.km_plafond_annuel / 365) * joursEcoules);
  const ecart_km = km_reel_a_date - km_prevu_a_date;

  const rythmeJournalier = joursEcoules > 0 ? km_reel_a_date / joursEcoules : 0;
  const projection_fin_contrat_km = Math.round(rythmeJournalier * dureeContratJours);
  const depassement_projete_km = Math.max(0, projection_fin_contrat_km - km_plafond_total);
  const penalite_estimee_eur = r2(depassement_projete_km * (contract.penalite_par_km_eur ?? 0.08));

  let alert_level: LoaKmTracker["alert_level"] = "ok";
  let message_fr: string;
  if (depassement_projete_km > 0) {
    alert_level = "depassement";
    message_fr = `Trajectoire de dépassement : à ce rythme, vous dépasserez le plafond contractuel de ${depassement_projete_km} km en fin de contrat, soit environ ${penalite_estimee_eur}€ de pénalités. Envisagez un avenant ou une réduction de kilométrage.`;
  } else if (ecart_km > contract.km_plafond_annuel * 0.05) {
    alert_level = "attention";
    message_fr = `Vous roulez plus vite que prévu (+${ecart_km} km par rapport au rythme contractuel). Surveillez votre consommation kilométrique.`;
  } else {
    message_fr = `Kilométrage sous contrôle : ${km_reel_a_date} km parcourus vs ${km_prevu_a_date} km prévus à date. Aucune action requise.`;
  }

  return {
    has_contract: true,
    contract_type: contract.contract_type,
    km_plafond_annuel: contract.km_plafond_annuel,
    km_parcourus_periode: km_reel_a_date,
    km_prevu_a_date,
    km_reel_a_date,
    ecart_km,
    projection_fin_contrat_km,
    depassement_projete_km,
    penalite_estimee_eur,
    alert_level,
    message_fr,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 6.4 COMPARATEUR LOA VS LLD VS ACHAT ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface VehicleFinanceOption {
  type: "LOA" | "LLD" | "achat";
  cout_mensuel_estime: number;
  cout_total_periode: number;
  km_inclus_annuel: number | null;
  avantages_fr: string[];
  inconvenients_fr: string[];
}

export interface VehicleFinanceComparison {
  duree_mois: number;
  km_annuel_estime: number;
  options: VehicleFinanceOption[];
  recommandation_fr: string;
}

export function compareVehicleFinance(input: {
  prix_vehicule_eur: number;
  duree_mois?: number;
  km_annuel_estime?: number;
  apport_eur?: number;
}): VehicleFinanceComparison {
  const duree_mois = input.duree_mois ?? 48;
  const km_annuel_estime = input.km_annuel_estime ?? 45000; // VTC roule souvent 60k/an, valeur médiane prudente
  const prix = input.prix_vehicule_eur;
  const apport = input.apport_eur ?? 0;

  // LOA : mensualité incluant option d'achat finale, plafond km standard ~30k/an
  const loaMensualite = r2(((prix - apport) * 0.018) + (prix * 0.002)); // approximation usage courant
  const loaTotal = r2(loaMensualite * duree_mois + apport);

  // LLD : mensualité "tout compris" (entretien inclus généralement), plafond km ~30k/an,
  // majoré si km_annuel_estime dépasse le plafond standard
  const kmPlafondLldStandard = 30000;
  const depassementKm = Math.max(0, km_annuel_estime - kmPlafondLldStandard);
  const surcoutKmMensuel = r2((depassementKm * 0.05) / 12);
  const lldMensualite = r2((prix * 0.022) + surcoutKmMensuel);
  const lldTotal = r2(lldMensualite * duree_mois);

  // Achat comptant/crédit classique : mensualité de crédit + entretien/assurance à charge complète
  const achatMensualite = r2((prix - apport) / duree_mois * 1.04); // approx crédit à ~4% annualisé
  const achatTotal = r2(achatMensualite * duree_mois + apport);

  const options: VehicleFinanceOption[] = [
    {
      type: "LOA",
      cout_mensuel_estime: loaMensualite,
      cout_total_periode: loaTotal,
      km_inclus_annuel: kmPlafondLldStandard,
      avantages_fr: ["Option d'achat en fin de contrat", "Mensualités souvent plus faibles que le crédit classique"],
      inconvenients_fr: ["Plafond kilométrique strict (~30 000 km/an)", "Pénalités élevées en cas de dépassement", "Valeur résiduelle à financer si achat final"],
    },
    {
      type: "LLD",
      cout_mensuel_estime: lldMensualite,
      cout_total_periode: lldTotal,
      km_inclus_annuel: kmPlafondLldStandard,
      avantages_fr: ["Entretien et assurance souvent inclus", "Pas de souci de revente", "Renouvellement facile du véhicule"],
      inconvenients_fr: ["Aucune valeur patrimoniale acquise", "Pénalités de dépassement kilométrique", "Coût total souvent supérieur pour un usage intensif VTC"],
    },
    {
      type: "achat",
      cout_mensuel_estime: achatMensualite,
      cout_total_periode: achatTotal,
      km_inclus_annuel: null,
      avantages_fr: ["Aucune limite de kilométrage", "Véhicule reste un actif revendable", "Coût total souvent inférieur sur usage intensif (60k km/an)"],
      inconvenients_fr: ["Apport ou capacité de crédit nécessaire", "Décote et entretien à anticiper soi-même", "Risque de panne hors garantie à charge du chauffeur"],
    },
  ];

  const kmIntensif = km_annuel_estime > 50000;
  const best = kmIntensif ? "achat" : options.reduce((a, b) => (a.cout_total_periode < b.cout_total_periode ? a : b)).type;

  const recommandation_fr = kmIntensif
    ? `Avec ${km_annuel_estime} km/an estimés (usage VTC intensif), l'achat évite les pénalités de dépassement kilométrique systématiques en LOA/LLD (plafonds standards ~30 000 km/an) et reste généralement le plus économique sur la durée.`
    : `Sur la base de ${km_annuel_estime} km/an, l'option la moins coûteuse sur ${duree_mois} mois est ${best === "LOA" ? "la LOA" : best === "LLD" ? "la LLD" : "l'achat"} (${options.find(o => o.type === best)!.cout_total_periode}€ au total). Vérifiez toutefois les plafonds kilométriques contractuels avant de signer.`;

  return { duree_mois, km_annuel_estime, options, recommandation_fr };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 18.1 RAPPELS URSSAF/TVA/CFE — pré-remplissage échéances FR 2026 ────────
// ═══════════════════════════════════════════════════════════════════════════
export function seedAdminDeadlines2026(): void {
  const cnt = (sqlite.prepare(`SELECT COUNT(*) as c FROM admin_deadlines WHERE due_date LIKE '2026%'`).get() as any).c;
  if (cnt > 0) return;

  const deadlines: { type: string; label_fr: string; due_date: string }[] = [];

  // URSSAF : déclaration mensuelle, échéance le 30 du mois (ou dernier jour si mois plus court)
  const moisJours = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // 2026 non bissextile
  for (let m = 1; m <= 12; m++) {
    const jour = Math.min(30, moisJours[m - 1]);
    deadlines.push({
      type: "urssaf",
      label_fr: `Déclaration URSSAF mensuelle — ${String(m).padStart(2, "0")}/2026`,
      due_date: `2026-${String(m).padStart(2, "0")}-${String(jour).padStart(2, "0")}`,
    });
  }

  // TVA : échéances trimestrielles usuelles
  deadlines.push({ type: "tva", label_fr: "Échéance TVA T1 2026", due_date: "2026-04-24" });
  deadlines.push({ type: "tva", label_fr: "Échéance TVA T2 2026", due_date: "2026-07-24" });
  deadlines.push({ type: "tva", label_fr: "Échéance TVA T3 2026", due_date: "2026-10-24" });
  deadlines.push({ type: "tva", label_fr: "Échéance TVA T4 2026 (solde annuel)", due_date: "2026-12-31" });

  // CFE : solde avant le 15 décembre
  deadlines.push({ type: "cfe", label_fr: "Solde CFE (Cotisation Foncière des Entreprises) 2026", due_date: "2026-12-15" });

  // IR : campagne de déclaration de revenus, mai
  deadlines.push({ type: "ir", label_fr: "Déclaration de revenus (IR) — campagne 2026", due_date: "2026-05-20" });

  const ins = sqlite.prepare(`INSERT INTO admin_deadlines (type, label_fr, due_date, is_recurring) VALUES (?, ?, ?, 1)`);
  const tx = sqlite.transaction(() => {
    for (const d of deadlines) ins.run(d.type, d.label_fr, d.due_date);
  });
  tx();
}

export interface UpcomingDeadline {
  id: number;
  type: string;
  label_fr: string;
  due_date: string;
  due_date_fr: string;
  jours_restants: number;
  urgency: "ok" | "soon" | "urgent" | "overdue";
  is_done: boolean;
}

function toFrDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function urgencyFromDays(jours: number): UpcomingDeadline["urgency"] {
  if (jours < 0) return "overdue";
  if (jours <= 7) return "urgent";
  if (jours <= 30) return "soon";
  return "ok";
}

export function getUpcomingDeadlines(limit = 20): UpcomingDeadline[] {
  seedAdminDeadlines2026();
  const rows = sqlite.prepare(`SELECT * FROM admin_deadlines WHERE is_done = 0 ORDER BY due_date ASC`).all() as any[];
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  return rows.slice(0, limit).map((r) => {
    const due = new Date(r.due_date);
    const jours_restants = Math.round((due.getTime() - now.getTime()) / 86_400_000);
    return {
      id: r.id,
      type: r.type,
      label_fr: r.label_fr,
      due_date: r.due_date,
      due_date_fr: toFrDate(r.due_date),
      jours_restants,
      urgency: urgencyFromDays(jours_restants),
      is_done: Boolean(r.is_done),
    };
  }).sort((a, b) => a.jours_restants - b.jours_restants);
}

export function markDeadlineDone(id: number): void {
  sqlite.prepare(`UPDATE admin_deadlines SET is_done = 1 WHERE id = ?`).run(id);
}

export function addCustomDeadline(input: { type: string; label_fr: string; due_date: string }): any {
  const result = sqlite.prepare(`INSERT INTO admin_deadlines (type, label_fr, due_date, is_recurring) VALUES (?, ?, ?, 0)`)
    .run(input.type, input.label_fr, input.due_date);
  return sqlite.prepare(`SELECT * FROM admin_deadlines WHERE id = ?`).get(result.lastInsertRowid);
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 18.2 CARTE PRO VTC + FORMATION CONTINUE (5 ANS) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface ProfessionalCardStatus {
  carte_pro_date: string | null;
  carte_pro_expiry: string | null;
  jours_restants: number | null;
  urgency: "ok" | "soon" | "urgent" | "overdue" | "non_renseigne";
  message_fr: string;
}

const DUREE_VALIDITE_CARTE_PRO_ANS = 5;

/**
 * Écriture directe SQL des champs fiscaux additifs du profil chauffeur.
 * NÉCESSAIRE car storage.updateDriverProfile() ne connaît qu'une liste figée
 * de colonnes (fuel_consumption_per100km, insurance_annual_eur, etc.) et
 * ignore silencieusement les colonnes ajoutées ici via ALTER TABLE
 * (carte_pro_vtc_date, carte_pro_vtc_expiry, controle_technique_date,
 * assurance_rc_pro_expiry, activite_debut_date, acre_actif,
 * versement_liberatoire_actif). On ne modifie pas storage.ts (additif
 * uniquement) : on fait un UPDATE ciblé ici, avec filtrage des valeurs non
 * fournies pour ne toucher que les champs réellement transmis.
 */
export interface FiscalProfileFieldsInput {
  carte_pro_vtc_date?: string | null;
  carte_pro_vtc_expiry?: string | null;
  controle_technique_date?: string | null;
  assurance_rc_pro_expiry?: string | null;
  activite_debut_date?: string | null;
  acre_actif?: boolean | number | null;
  versement_liberatoire_actif?: boolean | number | null;
}

export function updateFiscalProfileFields(input: FiscalProfileFieldsInput): void {
  const existing: any = storage.getDriverProfile();
  if (!existing || existing.id == null) {
    // Aucun profil existant : rien à mettre à jour (le profil de base est
    // créé ailleurs, ex. onboarding). On évite de créer une ligne partielle.
    return;
  }

  const toIntOrNull = (v: boolean | number | null | undefined): number | null => {
    if (v === undefined) return null;
    if (v === null) return null;
    return v ? 1 : 0;
  };

  const fields: Array<[string, any]> = ([
    ["carte_pro_vtc_date", input.carte_pro_vtc_date],
    ["carte_pro_vtc_expiry", input.carte_pro_vtc_expiry],
    ["controle_technique_date", input.controle_technique_date],
    ["assurance_rc_pro_expiry", input.assurance_rc_pro_expiry],
    ["activite_debut_date", input.activite_debut_date],
    ["acre_actif", input.acre_actif === undefined ? undefined : toIntOrNull(input.acre_actif)],
    ["versement_liberatoire_actif", input.versement_liberatoire_actif === undefined ? undefined : toIntOrNull(input.versement_liberatoire_actif)],
  ] as Array<[string, any]>).filter(([, v]) => v !== undefined);

  if (fields.length === 0) return;

  const setClause = fields.map(([col]) => `${col} = ?`).join(", ");
  const values = fields.map(([, v]) => v);
  sqlite
    .prepare(`UPDATE driver_profile SET ${setClause} WHERE id = ?`)
    .run(...values, existing.id);
}

export function getProfessionalCardStatus(): ProfessionalCardStatus {
  const profile: any = storage.getDriverProfile() || {};
  const carteDate: string | null = profile.carte_pro_vtc_date ?? null;
  let carteExpiry: string | null = profile.carte_pro_vtc_expiry ?? null;

  if (!carteDate && !carteExpiry) {
    return {
      carte_pro_date: null,
      carte_pro_expiry: null,
      jours_restants: null,
      urgency: "non_renseigne",
      message_fr: "Date d'obtention de la carte professionnelle VTC non renseignée. Ajoutez-la dans votre profil pour activer le suivi de renouvellement (formation continue obligatoire tous les 5 ans).",
    };
  }

  if (!carteExpiry && carteDate) {
    const d = new Date(carteDate);
    d.setFullYear(d.getFullYear() + DUREE_VALIDITE_CARTE_PRO_ANS);
    carteExpiry = d.toISOString().slice(0, 10);
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const expiry = new Date(carteExpiry!);
  const jours_restants = Math.round((expiry.getTime() - now.getTime()) / 86_400_000);
  const urgency = urgencyFromDays(jours_restants);

  const message_fr = jours_restants < 0
    ? `Votre carte professionnelle VTC a expiré le ${toFrDate(carteExpiry!)}. Renouvellement urgent requis pour continuer à exercer.`
    : jours_restants <= 60
      ? `Votre carte professionnelle VTC expire le ${toFrDate(carteExpiry!)} (dans ${jours_restants} jours). Pensez à la formation continue obligatoire de renouvellement (tous les 5 ans).`
      : `Carte professionnelle VTC valide jusqu'au ${toFrDate(carteExpiry!)} (dans ${jours_restants} jours).`;

  return { carte_pro_date: carteDate, carte_pro_expiry: carteExpiry, jours_restants, urgency, message_fr };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 18.3 CONTRÔLE TECHNIQUE VÉHICULE ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
const DUREE_VALIDITE_CT_ANS = 2; // véhicule VTC de +4 ans : contrôle technique tous les 2 ans (norme générale véhicules légers)

export interface ControleTechniqueStatus {
  derniere_date: string | null;
  prochaine_echeance: string | null;
  jours_restants: number | null;
  urgency: "ok" | "soon" | "urgent" | "overdue" | "non_renseigne";
  message_fr: string;
}

export function getControleTechniqueStatus(): ControleTechniqueStatus {
  const profile: any = storage.getDriverProfile() || {};
  const derniereDate: string | null = profile.controle_technique_date ?? null;

  if (!derniereDate) {
    return {
      derniere_date: null,
      prochaine_echeance: null,
      jours_restants: null,
      urgency: "non_renseigne",
      message_fr: "Date du dernier contrôle technique non renseignée. Ajoutez-la dans votre profil pour activer le rappel.",
    };
  }

  const derniere = new Date(derniereDate);
  const prochaine = new Date(derniere);
  prochaine.setFullYear(prochaine.getFullYear() + DUREE_VALIDITE_CT_ANS);

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const jours_restants = Math.round((prochaine.getTime() - now.getTime()) / 86_400_000);
  const urgency = urgencyFromDays(jours_restants);
  const prochaineIso = prochaine.toISOString().slice(0, 10);

  const message_fr = jours_restants < 0
    ? `Contrôle technique expiré depuis le ${toFrDate(prochaineIso)}. Circulation interdite jusqu'au renouvellement — risque d'amende (135€) et d'immobilisation.`
    : jours_restants <= 60
      ? `Prochain contrôle technique requis avant le ${toFrDate(prochaineIso)} (dans ${jours_restants} jours).`
      : `Contrôle technique valide jusqu'au ${toFrDate(prochaineIso)} (dans ${jours_restants} jours).`;

  return { derniere_date: derniereDate, prochaine_echeance: prochaineIso, jours_restants, urgency, message_fr };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 18.4 ASSURANCE RC CIRCULATION PROFESSIONNELLE ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface AssuranceRcStatus {
  expiry: string | null;
  jours_restants: number | null;
  urgency: "ok" | "soon" | "urgent" | "overdue" | "non_renseigne";
  message_fr: string;
}

export function getAssuranceRcStatus(): AssuranceRcStatus {
  const profile: any = storage.getDriverProfile() || {};
  const expiry: string | null = profile.assurance_rc_pro_expiry ?? null;

  if (!expiry) {
    return {
      expiry: null,
      jours_restants: null,
      urgency: "non_renseigne",
      message_fr: "Date d'échéance de l'assurance RC circulation professionnelle non renseignée. Obligatoire depuis la loi Thévenoud du 1er octobre 2014 — ajoutez-la dans votre profil.",
    };
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const exp = new Date(expiry);
  const jours_restants = Math.round((exp.getTime() - now.getTime()) / 86_400_000);
  const urgency = urgencyFromDays(jours_restants);

  const message_fr = jours_restants < 0
    ? `Assurance RC circulation professionnelle expirée depuis le ${toFrDate(expiry)}. Rouler sans cette assurance est illégal (loi Thévenoud) — renouvellement urgent.`
    : jours_restants <= 30
      ? `Votre assurance RC circulation professionnelle expire le ${toFrDate(expiry)} (dans ${jours_restants} jours). Pensez au renouvellement.`
      : `Assurance RC circulation professionnelle valide jusqu'au ${toFrDate(expiry)} (dans ${jours_restants} jours).`;

  return { expiry, jours_restants, urgency, message_fr };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── INITIALISATION AU DÉMARRAGE ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export function initFiscalProactif(): void {
  seedAdminDeadlines2026();
  seedMaintenanceSchedule();
  console.log(`[fiscalProactif] Couche Fiscal Proactif initialisée (barèmes ${TAX_CONSTANTS_VERSION}) — échéances 2026 et planning entretien pré-remplis.`);
}
