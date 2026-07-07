/**
 * onboardingEngine.ts — Couche ONBOARDING NOUVEAU CHAUFFEUR (rapport.md §16, §18)
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspiré de Bonsai (génération de business plan / contrats structurés) et
 * QuickBooks Live Tax (guide de statut fiscal assisté, checklist obligations).
 *
 * Implémente :
 *  1. Simulateur d'installation (break-even, CA 3 ans, cash-flow mensuel)
 *  2. Générateur de business plan HTML "PDF-ready"
 *  3. Checklist administrative pré-activité (15+ items, statut par utilisateur)
 *  4. Guide de statut fiscal initial (micro-BNC / micro-BIC / EI réel / SASU)
 *  5. Parcours des 30 premiers jours (30 jalons progressifs)
 *
 * Patch strictement ADDITIF : nouvelles tables, nouvelles fonctions, aucune
 * modification des fichiers existants — imports en lecture seule sur
 * ./storage et ./taxConstants.
 *
 * Sources réglementaires (consultées 07/07/2026) :
 * - Carte professionnelle VTC (examen + renouvellement 5 ans) :
 *   https://www.service-public.fr/particuliers/vosdroits/F32921
 * - Capital social minimum SASU/SAS : 1 € légal, mais 1 500 € recommandé pour
 *   crédibilité bancaire/leasing VTC (pratique de marché, non une obligation légale) :
 *   https://www.legalstart.fr/fiches-pratiques/sasu/capital-social-sasu/
 * - RC Pro VTC obligatoire (assurance transport de personnes) :
 *   https://www.service-public.fr/professionnels-entreprises/vosdroits/F32952
 * - Casier judiciaire B2 vierge exigé pour la carte VTC :
 *   https://www.service-public.fr/particuliers/vosdroits/F32921
 * - Véhicule de moins de 7 ans à l'immatriculation initiale VTC (Code des transports,
 *   art. R3120-4) : https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042661763
 * - Formation continue VTC 14h/5 ans (art. R3120-13 Code des transports) :
 *   https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042661763
 * - Barèmes URSSAF/TVA : ./taxConstants (TAX_CONSTANTS_VERSION "2026.1")
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sqlite } from "./storage";
import { URSSAF, TVA } from "./taxConstants";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ═══════════════════════════════════════════════════════════════════════════
// ─── SCHÉMA SQLITE (additif) ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export function initOnboardingEngine(): void {
  sqlite.exec(`
    -- Levier 3 : checklist administrative pré-activité (statut par item/utilisateur)
    CREATE TABLE IF NOT EXISTS onboarding_checklist_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      item_key TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, item_key)
    );

    -- Levier 5 : parcours des 30 premiers jours (jalons progressifs)
    CREATE TABLE IF NOT EXISTS onboarding_journey (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      day_number INTEGER NOT NULL,
      milestone TEXT NOT NULL,
      target TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, day_number)
    );

    -- Historique des business plans générés (permet de re-servir le dernier)
    CREATE TABLE IF NOT EXISTS business_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      inputs_json TEXT NOT NULL,
      html TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  seedChecklistIfEmpty();
  seedJourneyIfEmpty("default");
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 1. SIMULATEUR D'INSTALLATION ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface InstallationSimulatorInput {
  vehicule_prix: number;
  apport: number;
  statut_fiscal: "micro-bic" | "micro-bnc" | "ei-reel" | "sasu" | string;
  zone: "paris" | "petite-couronne" | "grande-couronne" | "aeroport" | string;
  experience: "debutant" | "1-2ans" | "2ans-plus" | string;
}

export interface InstallationSimulatorResult {
  hypotheses: Record<string, any>;
  breakeven_mois: number;
  ca_year1: number;
  ca_year2: number;
  ca_year3: number;
  cash_flow_mensuel: { mois: number; ca: number; charges: number; mensualite: number; net: number; cumul: number }[];
  seuil_rentabilite_eur_mois: number;
  message_fr: string;
}

// CA mensuel moyen par zone (ordres de grandeur réalistes, brut avant commission plateforme)
const CA_MENSUEL_ZONE: Record<string, number> = {
  paris: 5200,
  "petite-couronne": 4500,
  "grande-couronne": 3800,
  aeroport: 4900,
};

// Facteur de montée en charge selon l'expérience (courbe d'apprentissage)
const RAMP_EXPERIENCE: Record<string, number[]> = {
  // [mois1, mois2, mois3, mois4-6, mois7-12]
  debutant: [0.55, 0.65, 0.75, 0.85, 0.95],
  "1-2ans": [0.7, 0.8, 0.88, 0.95, 1.0],
  "2ans-plus": [0.85, 0.92, 0.97, 1.0, 1.0],
};

function commissionPlateformeMoyenne(): number {
  return 0.25; // moyenne pondérée Uber/Bolt/Heetch ~25%
}

function chargesFixesMensuelles(statut: string): number {
  // Assurance pro + mutuelle TNS + télépéage/entretien de base (hors mensualité véhicule)
  const base = 420; // assurance RC pro + entretien + carburant part fixe
  const mutuelle = statut === "sasu" ? 180 : 140; // charges sociales dirigeant SASU plus élevées
  return base + mutuelle;
}

function tauxCotisationsPct(statut: string): number {
  switch (statut) {
    case "micro-bic": return URSSAF.TAUX_COTISATIONS_PCT; // 21.2%
    case "micro-bnc": return 23.1; // micro-BNC : taux URSSAF prestations libérales 2026
    case "ei-reel": return 30; // EI au réel : cotisations sur bénéfice réel, approximation
    case "sasu": return 45; // SASU président assimilé salarié : charges sociales élevées
    default: return URSSAF.TAUX_COTISATIONS_PCT;
  }
}

function mensualiteCredit(montantAFinancer: number, dureeMois = 60, tauxAnnuel = 0.065): number {
  if (montantAFinancer <= 0) return 0;
  const tauxMensuel = tauxAnnuel / 12;
  const m = (montantAFinancer * tauxMensuel) / (1 - Math.pow(1 + tauxMensuel, -dureeMois));
  return r2(m);
}

export function simulateInstallation(input: InstallationSimulatorInput): InstallationSimulatorResult {
  const vehiculePrix = Math.max(0, Number(input.vehicule_prix) || 0);
  const apport = Math.max(0, Math.min(Number(input.apport) || 0, vehiculePrix));
  const statut = input.statut_fiscal || "micro-bic";
  const zone = input.zone || "petite-couronne";
  const experience = input.experience || "debutant";

  const montantAFinancer = Math.max(0, vehiculePrix - apport);
  const mensualite = mensualiteCredit(montantAFinancer);
  const chargesFixes = chargesFixesMensuelles(statut);
  const tauxCotisations = tauxCotisationsPct(statut);
  const caBaseMensuel = CA_MENSUEL_ZONE[zone] ?? CA_MENSUEL_ZONE["petite-couronne"];
  const ramp = RAMP_EXPERIENCE[experience] ?? RAMP_EXPERIENCE["debutant"];

  const cashFlow: InstallationSimulatorResult["cash_flow_mensuel"] = [];
  let cumul = -apport; // l'apport initial est une sortie de trésorerie au mois 0
  let breakevenMois = -1;

  for (let mois = 1; mois <= 36; mois++) {
    let factor: number;
    if (mois === 1) factor = ramp[0];
    else if (mois === 2) factor = ramp[1];
    else if (mois === 3) factor = ramp[2];
    else if (mois <= 6) factor = ramp[3];
    else factor = ramp[4] * (1 + Math.min(0.15, (mois - 6) * 0.005)); // légère croissance annuelle

    const caMois = r2(caBaseMensuel * factor);
    const caNetCommission = r2(caMois * (1 - commissionPlateformeMoyenne()));
    const cotisations = r2(caNetCommission * (tauxCotisations / 100));
    const chargesMois = r2(chargesFixes + cotisations);
    const netMois = r2(caNetCommission - chargesMois - mensualite);
    cumul = r2(cumul + netMois);

    if (breakevenMois === -1 && cumul >= 0) breakevenMois = mois;

    if (mois <= 24 || mois % 3 === 0 || mois === 36) {
      cashFlow.push({ mois, ca: caMois, charges: chargesMois, mensualite, net: netMois, cumul });
    }
  }

  // CA annuel brut estimé par année (avant commission)
  const caY1 = r2(caBaseMensuel * (ramp[0] + ramp[1] + ramp[2] + ramp[3] * 3 + ramp[4] * 6));
  const caY2 = r2(caBaseMensuel * ramp[4] * 12 * 1.05);
  const caY3 = r2(caBaseMensuel * ramp[4] * 12 * 1.1);

  const seuilRentabiliteMensuel = r2((chargesFixes + mensualite) / (1 - commissionPlateformeMoyenne()) / (1 - tauxCotisations / 100));

  const message =
    breakevenMois === -1
      ? `Seuil de rentabilité non atteint sur 36 mois avec ces hypothèses — réduire l'apport nécessaire ou viser une zone à plus forte demande (Paris/aéroport).`
      : `Seuil de rentabilité (break-even) atteint au mois ${breakevenMois}. CA mensuel minimum à réaliser pour couvrir charges + mensualité : ${seuilRentabiliteMensuel} €.`;

  return {
    hypotheses: {
      vehicule_prix: vehiculePrix,
      apport,
      montant_finance: montantAFinancer,
      mensualite_estimee: mensualite,
      duree_credit_mois: 60,
      taux_annuel_pct: 6.5,
      commission_plateforme_moyenne_pct: r2(commissionPlateformeMoyenne() * 100),
      taux_cotisations_pct: tauxCotisations,
      charges_fixes_mensuelles: chargesFixes,
      statut_fiscal: statut,
      zone,
      experience,
    },
    breakeven_mois: breakevenMois,
    ca_year1: caY1,
    ca_year2: caY2,
    ca_year3: caY3,
    cash_flow_mensuel: cashFlow,
    seuil_rentabilite_eur_mois: seuilRentabiliteMensuel,
    message_fr: message,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 2. BUSINESS PLAN AUTOMATIQUE (HTML PDF-ready) ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface BusinessPlanInput extends InstallationSimulatorInput {
  nom_chauffeur?: string;
  ville?: string;
}

export function generateBusinessPlan(input: BusinessPlanInput, userId = "default"): { html: string; id: number } {
  const sim = simulateInstallation(input);
  const nom = input.nom_chauffeur || "Chauffeur VTC";
  const ville = input.ville || "Île-de-France";
  const today = new Date().toLocaleDateString("fr-FR");

  const statutLabels: Record<string, string> = {
    "micro-bic": "Micro-entrepreneur (régime micro-BIC)",
    "micro-bnc": "Micro-entrepreneur (régime micro-BNC)",
    "ei-reel": "Entreprise Individuelle au régime réel",
    sasu: "SASU (président assimilé salarié)",
  };
  const zoneLabels: Record<string, string> = {
    paris: "Paris intra-muros",
    "petite-couronne": "Petite couronne (92/93/94)",
    "grande-couronne": "Grande couronne",
    aeroport: "Zone aéroportuaire (CDG/Orly)",
  };

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<title>Business Plan VTC — ${nom}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; max-width: 860px; margin: 0 auto; padding: 40px 24px; line-height: 1.6; }
  h1 { color: #0f172a; border-bottom: 3px solid #2563eb; padding-bottom: 12px; font-size: 26px; }
  h2 { color: #2563eb; margin-top: 32px; font-size: 19px; border-left: 4px solid #2563eb; padding-left: 10px; }
  h3 { color: #334155; font-size: 15px; margin-top: 18px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: right; font-size: 13px; }
  th { background: #f1f5f9; text-align: center; }
  td:first-child, th:first-child { text-align: left; }
  .kpi-grid { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
  .kpi { flex: 1; min-width: 140px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; text-align: center; }
  .kpi .val { font-size: 22px; font-weight: 700; color: #2563eb; }
  .kpi .lbl { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: .03em; }
  .footer { margin-top: 40px; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 12px; }
  .badge { display: inline-block; background: #dbeafe; color: #1e40af; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
</style>
</head>
<body>

<h1>Business Plan — Activité Chauffeur VTC</h1>
<p><span class="badge">${today}</span> &nbsp; Porteur de projet : <strong>${nom}</strong> · Zone : <strong>${zoneLabels[input.zone] || input.zone}</strong></p>

<h2>1. Executive Summary</h2>
<p>
  ${nom} envisage de créer une activité de chauffeur VTC (Voiture de Transport avec Chauffeur) en
  ${zoneLabels[input.zone] || input.zone}, sous le statut <strong>${statutLabels[input.statut_fiscal] || input.statut_fiscal}</strong>.
  L'investissement véhicule s'élève à <strong>${sim.hypotheses.vehicule_prix.toLocaleString("fr-FR")} €</strong>
  (apport initial de ${sim.hypotheses.apport.toLocaleString("fr-FR")} €, solde financé sur ${sim.hypotheses.duree_credit_mois} mois).
  Le seuil de rentabilité est estimé au <strong>mois ${sim.breakeven_mois > 0 ? sim.breakeven_mois : "> 36"}</strong>
  avec un chiffre d'affaires prévisionnel de <strong>${sim.ca_year1.toLocaleString("fr-FR")} €</strong> en année 1.
</p>

<div class="kpi-grid">
  <div class="kpi"><div class="val">${sim.breakeven_mois > 0 ? sim.breakeven_mois + " mois" : "n/a"}</div><div class="lbl">Break-even</div></div>
  <div class="kpi"><div class="val">${sim.ca_year1.toLocaleString("fr-FR")} €</div><div class="lbl">CA Année 1</div></div>
  <div class="kpi"><div class="val">${sim.ca_year2.toLocaleString("fr-FR")} €</div><div class="lbl">CA Année 2</div></div>
  <div class="kpi"><div class="val">${sim.ca_year3.toLocaleString("fr-FR")} €</div><div class="lbl">CA Année 3</div></div>
</div>

<h2>2. Le Marché VTC en Île-de-France</h2>
<p>
  Le marché VTC francilien est structuré autour de trois plateformes principales (Uber, Bolt, Heetch)
  captant l'essentiel de la demande urbaine, avec une commission moyenne d'environ
  <strong>${sim.hypotheses.commission_plateforme_moyenne_pct}%</strong> par course. La demande est fortement
  concentrée sur Paris intra-muros, les zones aéroportuaires (CDG, Orly) et les grands pôles d'affaires
  (La Défense). La réglementation impose une réservation préalable obligatoire (pas de maraude), une carte
  professionnelle VTC et un véhicule conforme aux normes en vigueur (cf. Base réglementaire jointe).
</p>

<h2>3. L'Offre de Services</h2>
<p>
  Activité de transport de personnes par réservation préalable (VTC), ciblant :
</p>
<ul>
  <li>Trajets particuliers via plateformes (Uber, Bolt, Heetch, FreeNow)</li>
  <li>Transferts aéroport / gare (créneaux à forte marge)</li>
  <li>Clientèle privée directe (mariages, événements, entreprises) — marge supérieure aux plateformes</li>
</ul>

<h2>4. Prévisionnel Financier — 3 ans</h2>
<h3>Hypothèses retenues</h3>
<table>
  <tr><th>Paramètre</th><th>Valeur</th></tr>
  <tr><td>Prix véhicule</td><td>${sim.hypotheses.vehicule_prix.toLocaleString("fr-FR")} €</td></tr>
  <tr><td>Apport personnel</td><td>${sim.hypotheses.apport.toLocaleString("fr-FR")} €</td></tr>
  <tr><td>Montant financé</td><td>${sim.hypotheses.montant_finance.toLocaleString("fr-FR")} €</td></tr>
  <tr><td>Mensualité crédit (${sim.hypotheses.duree_credit_mois} mois, ${sim.hypotheses.taux_annuel_pct}%)</td><td>${sim.hypotheses.mensualite_estimee.toLocaleString("fr-FR")} €/mois</td></tr>
  <tr><td>Statut fiscal</td><td>${statutLabels[input.statut_fiscal] || input.statut_fiscal}</td></tr>
  <tr><td>Taux de cotisations sociales</td><td>${sim.hypotheses.taux_cotisations_pct}%</td></tr>
  <tr><td>Charges fixes mensuelles (hors crédit)</td><td>${sim.hypotheses.charges_fixes_mensuelles.toLocaleString("fr-FR")} €</td></tr>
</table>

<h3>Chiffre d'affaires prévisionnel</h3>
<table>
  <tr><th>Année</th><th>CA brut estimé</th></tr>
  <tr><td>Année 1 (montée en charge)</td><td>${sim.ca_year1.toLocaleString("fr-FR")} €</td></tr>
  <tr><td>Année 2 (rythme de croisière)</td><td>${sim.ca_year2.toLocaleString("fr-FR")} €</td></tr>
  <tr><td>Année 3 (consolidation)</td><td>${sim.ca_year3.toLocaleString("fr-FR")} €</td></tr>
</table>

<h3>Trésorerie mensuelle (extrait)</h3>
<table>
  <tr><th>Mois</th><th>CA</th><th>Charges</th><th>Mensualité</th><th>Net</th><th>Cumul</th></tr>
  ${sim.cash_flow_mensuel.slice(0, 12).map(r => `<tr><td>M${r.mois}</td><td>${r.ca.toLocaleString("fr-FR")} €</td><td>${r.charges.toLocaleString("fr-FR")} €</td><td>${r.mensualite.toLocaleString("fr-FR")} €</td><td>${r.net.toLocaleString("fr-FR")} €</td><td>${r.cumul.toLocaleString("fr-FR")} €</td></tr>`).join("\n  ")}
</table>
<p>${sim.message_fr}</p>

<h2>5. Plan de Financement</h2>
<table>
  <tr><th>Ressources</th><th>Montant</th></tr>
  <tr><td>Apport personnel</td><td>${sim.hypotheses.apport.toLocaleString("fr-FR")} €</td></tr>
  <tr><td>Emprunt bancaire / LOA / LLD</td><td>${sim.hypotheses.montant_finance.toLocaleString("fr-FR")} €</td></tr>
  <tr><td><strong>Total</strong></td><td><strong>${sim.hypotheses.vehicule_prix.toLocaleString("fr-FR")} €</strong></td></tr>
</table>
<p>
  Capital social minimum recommandé si constitution en société (SASU) : 1 500 € (le minimum légal est de 1 €,
  mais un capital de 1 500 € minimum est recommandé pour la crédibilité bancaire et l'accès au financement
  véhicule — <a href="https://www.legalstart.fr/fiches-pratiques/sasu/capital-social-sasu/">LegalStart</a>).
</p>

<div class="footer">
  Document généré automatiquement par VTC Intelligence — Couche Onboarding. À usage indicatif, ne remplace pas
  l'avis d'un expert-comptable ou d'un conseiller France Travail / URSSAF. Sources réglementaires : voir Base
  réglementaire 2026 de l'application (§ Juridique).
</div>

</body>
</html>`;

  const stmt = sqlite.prepare(
    `INSERT INTO business_plans (user_id, inputs_json, html) VALUES (?, ?, ?)`
  );
  const info = stmt.run(userId, JSON.stringify(input), html);
  return { html, id: Number(info.lastInsertRowid) };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 3. CHECKLIST ADMINISTRATIVE PRÉ-ACTIVITÉ (15+ items) ───────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface ChecklistItemDef {
  key: string;
  label_fr: string;
  description_fr: string;
  category: "identite" | "juridique" | "assurance" | "vehicule" | "formation" | "financier";
  obligatoire: boolean;
  source_url?: string;
}

export const CHECKLIST_ITEMS: ChecklistItemDef[] = [
  { key: "examen_vtc", label_fr: "Examen VTC réussi", description_fr: "Épreuves écrites + pratique auprès d'un organisme agréé (préfecture).", category: "formation", obligatoire: true, source_url: "https://www.service-public.fr/particuliers/vosdroits/F32921" },
  { key: "carte_pro_vtc", label_fr: "Carte professionnelle VTC obtenue", description_fr: "Délivrée par la préfecture après réussite à l'examen, valable 5 ans.", category: "identite", obligatoire: true, source_url: "https://www.service-public.fr/particuliers/vosdroits/F32921" },
  { key: "casier_b2", label_fr: "Casier judiciaire (bulletin B2) vierge", description_fr: "Obligatoire pour la délivrance et le renouvellement de la carte VTC.", category: "identite", obligatoire: true, source_url: "https://www.service-public.fr/particuliers/vosdroits/F32921" },
  { key: "permis_3ans", label_fr: "Permis de conduire (B) ≥ 3 ans", description_fr: "Ancienneté minimale exigée pour exercer en tant que VTC.", category: "identite", obligatoire: true },
  { key: "immatriculation_siren", label_fr: "Immatriculation SIREN/SIRET (URSSAF/INSEE)", description_fr: "Création d'entreprise (micro-entrepreneur ou société) auprès du guichet unique INPI.", category: "juridique", obligatoire: true, source_url: "https://www.autoentrepreneur.urssaf.fr/" },
  { key: "registre_vtc", label_fr: "Inscription au registre des exploitants VTC", description_fr: "Immatriculation obligatoire auprès du registre national VTC (tenu par la DREAL / plateforme dédiée).", category: "juridique", obligatoire: true },
  { key: "rc_pro", label_fr: "Assurance RC Pro transport de personnes", description_fr: "Responsabilité civile professionnelle spécifique VTC (distincte de l'assurance auto classique).", category: "assurance", obligatoire: true, source_url: "https://www.service-public.fr/professionnels-entreprises/vosdroits/F32952" },
  { key: "assurance_auto_pro", label_fr: "Assurance véhicule à usage VTC", description_fr: "Contrat auto avec mention explicite de l'usage transport de personnes à titre onéreux.", category: "assurance", obligatoire: true },
  { key: "mutuelle_tns", label_fr: "Mutuelle santé TNS (travailleur non-salarié)", description_fr: "Complémentaire santé adaptée au statut indépendant (non obligatoire légalement mais fortement recommandée).", category: "assurance", obligatoire: false },
  { key: "prevoyance", label_fr: "Contrat de prévoyance (arrêt de travail)", description_fr: "Couvre la perte de revenus en cas d'accident ou de maladie (statut indépendant = pas d'IJ automatique suffisante).", category: "assurance", obligatoire: false },
  { key: "vehicule_moins_7ans", label_fr: "Véhicule de moins de 7 ans", description_fr: "Condition réglementaire à la première immatriculation VTC (Code des transports, art. R3120-4).", category: "vehicule", obligatoire: true, source_url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042661763" },
  { key: "controle_technique", label_fr: "Contrôle technique à jour", description_fr: "Visite technique valide, à renouveler selon périodicité réglementaire.", category: "vehicule", obligatoire: true },
  { key: "vehicule_4portes_6places", label_fr: "Véhicule 4 portes, 4 à 6 places", description_fr: "Norme de gabarit exigée pour l'exploitation VTC.", category: "vehicule", obligatoire: true },
  { key: "capital_social", label_fr: "Capital social ≥ 1 500 € (si société)", description_fr: "Recommandé pour la crédibilité bancaire si constitution en SASU/EURL (1 € légal minimum).", category: "financier", obligatoire: false, source_url: "https://www.legalstart.fr/fiches-pratiques/sasu/capital-social-sasu/" },
  { key: "compte_bancaire_dedie", label_fr: "Compte bancaire dédié à l'activité", description_fr: "Obligatoire au-delà de 2 années consécutives de CA > 10 000 € en micro-entreprise.", category: "financier", obligatoire: true },
  { key: "formation_continue_initiale", label_fr: "Session d'information formation continue planifiée", description_fr: "Anticiper les 14h de formation continue obligatoires tous les 5 ans (voir Formation continue).", category: "formation", obligatoire: false, source_url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042661763" },
  { key: "attestation_fiscale", label_fr: "Attestation de régularité fiscale", description_fr: "Souvent exigée par les plateformes (Uber/Bolt) lors de l'inscription chauffeur.", category: "juridique", obligatoire: true },
  { key: "plaque_identification", label_fr: "Disque/autocollant d'identification VTC apposé", description_fr: "Signe distinctif obligatoire sur le pare-brise du véhicule.", category: "vehicule", obligatoire: true },
];

function seedChecklistIfEmpty(userId = "default") {
  const count = sqlite.prepare(`SELECT COUNT(*) as n FROM onboarding_checklist_status WHERE user_id = ?`).get(userId) as { n: number };
  if (count.n > 0) return;
  const stmt = sqlite.prepare(`INSERT OR IGNORE INTO onboarding_checklist_status (user_id, item_key, completed) VALUES (?, ?, 0)`);
  const tx = sqlite.transaction((items: ChecklistItemDef[]) => {
    for (const it of items) stmt.run(userId, it.key);
  });
  tx(CHECKLIST_ITEMS);
}

export function getChecklist(userId = "default") {
  seedChecklistIfEmpty(userId);
  const statusRows = sqlite.prepare(`SELECT item_key, completed, completed_at FROM onboarding_checklist_status WHERE user_id = ?`).all(userId) as any[];
  const statusMap = new Map(statusRows.map(r => [r.item_key, r]));
  const items = CHECKLIST_ITEMS.map(def => {
    const st = statusMap.get(def.key);
    return { ...def, completed: !!st?.completed, completed_at: st?.completed_at || null };
  });
  const totalObligatoire = items.filter(i => i.obligatoire).length;
  const doneObligatoire = items.filter(i => i.obligatoire && i.completed).length;
  const pct = totalObligatoire > 0 ? r2((doneObligatoire / totalObligatoire) * 100) : 0;
  return { items, total_items: items.length, done_items: items.filter(i => i.completed).length, pct_obligatoire_complete: pct };
}

export function toggleChecklistItem(itemKey: string, completed: boolean, userId = "default") {
  const exists = CHECKLIST_ITEMS.some(i => i.key === itemKey);
  if (!exists) throw new Error(`Item de checklist inconnu: ${itemKey}`);
  sqlite.prepare(`
    INSERT INTO onboarding_checklist_status (user_id, item_key, completed, completed_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, item_key) DO UPDATE SET completed = excluded.completed, completed_at = excluded.completed_at, updated_at = datetime('now')
  `).run(userId, itemKey, completed ? 1 : 0, completed ? new Date().toISOString() : null);
  return getChecklist(userId);
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 4. GUIDE STATUT FISCAL INITIAL ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface StatusGuideInput {
  ca_previsionnel_annuel: number;
  situation_famille: "celibataire" | "marie" | "pacse" | "famille_enfants" | string;
  conjoint_revenus?: number;
  souhaite_associes?: boolean;
  souhaite_deduire_charges_reelles?: boolean;
}

export interface StatusGuideResult {
  recommandation: "micro-bic" | "micro-bnc" | "ei-reel" | "sasu";
  label_fr: string;
  score_details: { statut: string; label_fr: string; score: number; avantages: string[]; inconvenients: string[] }[];
  explication_fr: string;
}

export function recommendFiscalStatus(input: StatusGuideInput): StatusGuideResult {
  const ca = Math.max(0, Number(input.ca_previsionnel_annuel) || 0);
  const wantsCharges = !!input.souhaite_deduire_charges_reelles;
  const wantsAssocies = !!input.souhaite_associes;

  const candidates = [
    {
      statut: "micro-bic",
      label_fr: "Micro-entrepreneur (micro-BIC)",
      score: 0,
      avantages: [
        "Création en ligne gratuite et rapide (guichet unique INPI)",
        `Cotisations sociales simplifiées (${URSSAF.TAUX_COTISATIONS_PCT}% du CA)`,
        "Comptabilité allégée (livre des recettes)",
        `Franchise en base de TVA jusqu'à ${TVA.FRANCHISE_SEUIL_BASE_EUR.toLocaleString("fr-FR")} € de CA`,
      ],
      inconvenients: [
        `Plafond de CA annuel ${URSSAF.PLAFOND_CA_ANNUEL_EUR.toLocaleString("fr-FR")} €`,
        "Pas de déduction des charges réelles (abattement forfaitaire de 34% uniquement)",
        "Pas de récupération de TVA sur les achats (véhicule, carburant) en franchise",
      ],
    },
    {
      statut: "micro-bnc",
      label_fr: "Micro-entrepreneur (micro-BNC)",
      score: 0,
      avantages: ["Régime simplifié similaire au micro-BIC", "Adapté si activité mixte avec prestations intellectuelles"],
      inconvenients: [
        "Non adapté au transport de personnes classique (régime BIC prestations de services habituellement retenu pour le VTC)",
        "Abattement forfaitaire plus faible (34% également mais moins pertinent ici)",
      ],
    },
    {
      statut: "ei-reel",
      label_fr: "Entreprise Individuelle au régime réel",
      score: 0,
      avantages: [
        "Déduction des charges réelles (amortissement véhicule, carburant, assurance, entretien)",
        "Récupération de la TVA sur les achats si assujetti",
        "Pas de plafond de chiffre d'affaires",
      ],
      inconvenients: [
        "Comptabilité complète obligatoire (bilan, compte de résultat)",
        "Expert-comptable fortement recommandé (coût ~800-1500€/an)",
        "Cotisations sociales calculées sur le bénéfice réel, plus complexes à anticiper",
      ],
    },
    {
      statut: "sasu",
      label_fr: "SASU (président assimilé salarié)",
      score: 0,
      avantages: [
        "Responsabilité limitée aux apports (protection du patrimoine personnel)",
        "Statut assimilé salarié (protection sociale renforcée, hors chômage)",
        "Peut évoluer facilement en SAS pour accueillir des associés",
        "Optimisation possible rémunération / dividendes",
      ],
      inconvenients: [
        "Charges sociales élevées sur la rémunération (~45%)",
        "Comptabilité et formalisme juridique complets (statuts, AG, liasse fiscale)",
        "Coût de création et de gestion (expert-comptable quasi indispensable)",
      ],
    },
  ];

  // Scoring simple basé sur CA prévisionnel et préférences
  for (const c of candidates) {
    if (c.statut === "micro-bic") {
      c.score = ca <= URSSAF.PLAFOND_CA_ANNUEL_EUR * 0.9 && !wantsCharges && !wantsAssocies ? 90 : 40;
      if (ca > URSSAF.PLAFOND_CA_ANNUEL_EUR) c.score = 5;
    }
    if (c.statut === "micro-bnc") {
      c.score = 15; // rarement le régime pertinent pour du VTC pur transport
    }
    if (c.statut === "ei-reel") {
      c.score = ca > URSSAF.PLAFOND_CA_ANNUEL_EUR || wantsCharges ? 75 : 35;
    }
    if (c.statut === "sasu") {
      c.score = wantsAssocies || ca > 90000 ? 80 : 30;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  const explication = `Avec un chiffre d'affaires prévisionnel de ${ca.toLocaleString("fr-FR")} €/an` +
    `${wantsCharges ? ", un souhait de déduire vos charges réelles" : ""}` +
    `${wantsAssocies ? " et un projet d'association" : ""}, le statut le plus adapté est ` +
    `${best.label_fr}. ${ca > URSSAF.PLAFOND_CA_ANNUEL_EUR ? "Attention : votre CA prévisionnel dépasse le plafond micro-entrepreneur, un régime réel est obligatoire." : ""}` +
    ` Cette recommandation est indicative — un expert-comptable (type QuickBooks Live Tax) doit valider le choix final selon votre situation complète.`;

  return {
    recommandation: best.statut as any,
    label_fr: best.label_fr,
    score_details: candidates,
    explication_fr: explication,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 5. PARCOURS DES 30 PREMIERS JOURS ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
interface JourneyMilestoneDef { day: number; milestone: string; target: string }

const JOURNEY_TEMPLATE: JourneyMilestoneDef[] = [
  { day: 1, milestone: "Immatriculation activité", target: "Finaliser l'immatriculation SIREN/SIRET et créer le compte URSSAF." },
  { day: 2, milestone: "Ouverture compte bancaire dédié", target: "Ouvrir un compte bancaire séparé pour l'activité VTC." },
  { day: 3, milestone: "Souscription RC Pro", target: "Souscrire l'assurance RC Pro transport de personnes." },
  { day: 4, milestone: "Assurance véhicule VTC", target: "Mettre à jour l'assurance auto avec mention usage VTC." },
  { day: 5, milestone: "Inscription registre VTC", target: "S'inscrire au registre national des exploitants VTC." },
  { day: 6, milestone: "Carte professionnelle", target: "Vérifier la validité et la réception de la carte pro VTC." },
  { day: 7, milestone: "Bilan semaine 1", target: "Point d'étape administratif : vérifier les 6 premiers jalons." },
  { day: 8, milestone: "Inscription plateforme Uber", target: "Créer et valider le compte chauffeur Uber (documents + véhicule)." },
  { day: 9, milestone: "Inscription plateforme Bolt", target: "Créer et valider le compte chauffeur Bolt." },
  { day: 10, milestone: "Inscription plateforme Heetch", target: "Créer et valider le compte chauffeur Heetch." },
  { day: 11, milestone: "Équipement véhicule", target: "Installer support téléphone, chargeurs, disque VTC obligatoire." },
  { day: 12, milestone: "Paramétrage app VTC Intelligence", target: "Configurer profil, zones favorites, objectifs de revenus." },
  { day: 13, milestone: "Première session de conduite", target: "Réaliser les premières courses tests en heures creuses." },
  { day: 14, milestone: "Bilan semaine 2", target: "Analyser le CA des 7 premiers jours et ajuster les créneaux." },
  { day: 15, milestone: "Provisionnement fiscal", target: "Mettre en place l'épargne automatique URSSAF/TVA (voir Fiscal Proactif)." },
  { day: 16, milestone: "Notes de frais", target: "Commencer le suivi des dépenses déductibles (carburant, péages)." },
  { day: 17, milestone: "Optimisation zones", target: "Identifier les 3 zones les plus rentables selon les données collectées." },
  { day: 18, milestone: "Test créneaux nuit/week-end", target: "Évaluer la rentabilité des créneaux majorés (nuit, dimanche)." },
  { day: 19, milestone: "Diversification clientèle", target: "Explorer une première mission privée (mariage, transfert entreprise)." },
  { day: 20, milestone: "Mutuelle et prévoyance", target: "Finaliser la souscription mutuelle TNS et prévoyance." },
  { day: 21, milestone: "Bilan semaine 3", target: "Comparer le CA réel au prévisionnel du business plan." },
  { day: 22, milestone: "Entretien véhicule", target: "Planifier la première vidange/contrôle après les premiers km VTC." },
  { day: 23, milestone: "Analyse multi-plateforme", target: "Comparer les revenus nets Uber/Bolt/Heetch et ajuster la répartition." },
  { day: 24, milestone: "Objectif hebdomadaire", target: "Fixer un objectif de CA hebdomadaire réaliste basé sur les 3 semaines passées." },
  { day: 25, milestone: "Vérification fiscale", target: "Contrôler l'avancement vers le seuil de franchise TVA." },
  { day: 26, milestone: "Réseau professionnel", target: "Rejoindre un groupe/communauté de chauffeurs VTC IDF." },
  { day: 27, milestone: "Formation continue", target: "Planifier la première session de formation continue (14h/5 ans)." },
  { day: 28, milestone: "Bilan mensuel préliminaire", target: "Préparer le calcul du CA du mois 1 et des cotisations à venir." },
  { day: 29, milestone: "Ajustements stratégie", target: "Définir les ajustements de zone/horaires pour le mois 2." },
  { day: 30, milestone: "Bilan des 30 jours", target: "Comparer CA réel vs business plan, valider ou ajuster le statut fiscal." },
];

function seedJourneyIfEmpty(userId = "default") {
  const count = sqlite.prepare(`SELECT COUNT(*) as n FROM onboarding_journey WHERE user_id = ?`).get(userId) as { n: number };
  if (count.n > 0) return;
  const stmt = sqlite.prepare(`INSERT OR IGNORE INTO onboarding_journey (user_id, day_number, milestone, target, completed) VALUES (?, ?, ?, ?, 0)`);
  const tx = sqlite.transaction((items: JourneyMilestoneDef[]) => {
    for (const it of items) stmt.run(userId, it.day, it.milestone, it.target);
  });
  tx(JOURNEY_TEMPLATE);
}

export function getJourney(userId = "default") {
  seedJourneyIfEmpty(userId);
  const rows = sqlite.prepare(`SELECT * FROM onboarding_journey WHERE user_id = ? ORDER BY day_number ASC`).all(userId) as any[];
  const doneCount = rows.filter(r => r.completed).length;
  return { milestones: rows, total: rows.length, done: doneCount, pct: rows.length ? r2((doneCount / rows.length) * 100) : 0 };
}

export function updateJourneyMilestone(dayNumber: number, updates: { completed?: boolean; note?: string }, userId = "default") {
  seedJourneyIfEmpty(userId);
  const existing = sqlite.prepare(`SELECT * FROM onboarding_journey WHERE user_id = ? AND day_number = ?`).get(userId, dayNumber);
  if (!existing) throw new Error(`Jalon jour ${dayNumber} introuvable`);
  const fields: string[] = [];
  const values: any[] = [];
  if (updates.completed !== undefined) { fields.push("completed = ?"); values.push(updates.completed ? 1 : 0); }
  if (updates.note !== undefined) { fields.push("note = ?"); values.push(updates.note); }
  fields.push("updated_at = datetime('now')");
  values.push(userId, dayNumber);
  sqlite.prepare(`UPDATE onboarding_journey SET ${fields.join(", ")} WHERE user_id = ? AND day_number = ?`).run(...values);
  return getJourney(userId);
}
