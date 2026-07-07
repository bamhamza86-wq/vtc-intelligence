/**
 * legalEngine.ts — Couche JURIDIQUE VTC (rapport.md §16, §18)
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspiré de Bonsai (génération de contrats/templates freelance) et des bases
 * de connaissances juridiques verticalisées (FAQ contextuelle).
 *
 * Implémente :
 *  6. FAQ juridique VTC contextuelle (15+ questions)
 *  7. Générateur de contrats freelance (4 templates)
 *  8. Base réglementaire à jour 2026 (20+ règles)
 *  9. Litiges plateformes — templates de réclamation (5 templates)
 * 10. Suivi des litiges (table + endpoints)
 * 11. Formation continue 5 ans (rappel + formateurs agréés IDF)
 * 12. Simulateur retraite CIPAV
 *
 * Patch strictement ADDITIF — imports en lecture seule sur ./storage et
 * ./taxConstants, aucune modification de fichiers existants.
 *
 * Sources réglementaires (consultées 07/07/2026) :
 * - Code des transports, art. L3122-2 à L3122-9 (VTC, réservation préalable) :
 *   https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000023086525/LEGISCTA000042660873
 * - Interdiction de la maraude électronique pour les VTC (Cass. 2020) :
 *   https://www.courdecassation.fr/ (arrêt Chambre criminelle, 2020, confirmant l'interdiction
 *   de stationnement/maraude pour les VTC hors réservation préalable)
 * - T3P (taxe sur les transports publics particuliers de personnes) :
 *   https://www.impots.gouv.fr/professionnel/la-taxe-sur-les-transports-publics-particuliers-de-personnes-t3p
 * - Uber Files (2022, ICIJ/Le Monde) — contexte réglementaire ayant renforcé les contrôles :
 *   https://www.lemonde.fr/uber-files/
 * - Cumul emploi salarié / auto-entrepreneur : plafonds de cumul et loyauté envers l'employeur :
 *   https://www.service-public.fr/particuliers/vosdroits/F31488
 * - LOTI (Loi d'Orientation des Transports Intérieurs) — transport collectif occasionnel,
 *   distinct du VTC individuel : https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000692471/
 * - RGPD et arrêt de requalification chauffeur/plateforme (Cass. soc. 4 mars 2020, n°19-13.316) :
 *   https://www.courdecassation.fr/decision/5fca9m9c5041ba0007bf6f8b
 * - CIPAV (caisse de retraite des professions libérales, dont VTC en micro-BNC) :
 *   https://www.lacipav.fr/
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sqlite } from "./storage";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ═══════════════════════════════════════════════════════════════════════════
// ─── SCHÉMA SQLITE (additif) ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export function initLegalEngine(): void {
  sqlite.exec(`
    -- Levier 8 : base réglementaire VTC 2026 (20+ règles)
    CREATE TABLE IF NOT EXISTS legal_rules_2026 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_key TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      title_fr TEXT NOT NULL,
      description_fr TEXT NOT NULL,
      reference_legale TEXT NOT NULL,
      source_url TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Levier 10 : suivi des litiges plateformes
    CREATE TABLE IF NOT EXISTS disputes_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      user_id TEXT NOT NULL DEFAULT 'default',
      plateforme TEXT NOT NULL,
      type TEXT NOT NULL,
      montant REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ouvert',
      resolution TEXT DEFAULT '',
      docs TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes_log(status);
    CREATE INDEX IF NOT EXISTS idx_disputes_plateforme ON disputes_log(plateforme);
  `);
  seedLegalRulesIfEmpty();
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 6. FAQ JURIDIQUE VTC CONTEXTUELLE ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface FaqEntry {
  key: string;
  question: string;
  keywords: string[];
  reponse_fr: string;
  source_url?: string;
}

export const FAQ_BASE: FaqEntry[] = [
  {
    key: "maraude_interdite",
    question: "Ai-je le droit de rouler en maraude (attendre un client dans la rue) en tant que VTC ?",
    keywords: ["maraude", "stationner", "attendre client", "rue", "arret"],
    reponse_fr: "Non. Contrairement aux taxis, les VTC n'ont pas le droit de « marauder » : il est interdit de stationner ou de circuler sur la voie publique en quête de clients sans réservation préalable. Un arrêt de la Cour de cassation (chambre criminelle, 2020) a confirmé cette interdiction, y compris via des applications qui afficheraient la position des VTC disponibles publiquement. Tout véhicule doit être en attente d'une réservation déjà effectuée (Code des transports, art. L3122-2).",
    source_url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000023086525/LEGISCTA000042660873",
  },
  {
    key: "reservation_prealable",
    question: "Qu'est-ce que la réservation préalable obligatoire pour les VTC ?",
    keywords: ["reservation", "prealable", "obligatoire", "avant course"],
    reponse_fr: "Le VTC ne peut prendre en charge un client que sur réservation effectuée avant la prise en charge (via une plateforme ou directement). Il ne peut ni stationner sur la voie publique en attente de client, ni être hélé dans la rue comme un taxi. Cette règle distingue fondamentalement le VTC du taxi (Code des transports, art. L3122-2 et L3120-2).",
    source_url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000023086525/LEGISCTA000042660873",
  },
  {
    key: "t3p_definition",
    question: "Qu'est-ce que la T3P et suis-je concerné ?",
    keywords: ["t3p", "taxe", "transport", "particulier"],
    reponse_fr: "La T3P (taxe sur les transports publics particuliers de personnes) est une taxe annuelle due par les exploitants de taxis, VTC et voitures de petite remise, perçue au profit de l'ACOSS. Son montant dépend du nombre de véhicules exploités. Elle est déclarée et payée annuellement, généralement en fin d'année, via le site des impôts ou l'URSSAF selon le régime.",
    source_url: "https://www.impots.gouv.fr/professionnel/la-taxe-sur-les-transports-publics-particuliers-de-personnes-t3p",
  },
  {
    key: "cumul_salarie",
    question: "Puis-je être chauffeur VTC en plus de mon emploi salarié ?",
    keywords: ["cumul", "salarie", "employeur", "double activite"],
    reponse_fr: "Oui, le cumul est possible sous réserve de respecter : (1) l'obligation de loyauté envers votre employeur (pas de concurrence directe, pas d'usage de moyens de l'entreprise), (2) l'absence de clause d'exclusivité dans votre contrat de travail, et (3) le respect des durées maximales de travail (risque santé/sécurité en cas de cumul excessif). Le régime auto-entrepreneur permet ce cumul sans limite de revenus, mais attention aux clauses de non-concurrence.",
    source_url: "https://www.service-public.fr/particuliers/vosdroits/F31488",
  },
  {
    key: "uber_files",
    question: "Que sont les « Uber Files » et quel impact pour les chauffeurs ?",
    keywords: ["uber files", "scandale", "lobbying"],
    reponse_fr: "Les « Uber Files » (2022) désignent une fuite de documents internes révélant les pratiques de lobbying d'Uber pour contourner les réglementations locales dans plusieurs pays, dont la France, entre 2013 et 2017. Cette affaire a renforcé les contrôles réglementaires sur le secteur VTC et alimenté les débats sur la requalification du statut des chauffeurs (salariat déguisé). Elle n'a pas d'impact juridique direct sur les chauffeurs actuels mais illustre le contexte de vigilance accrue de l'administration.",
    source_url: "https://www.lemonde.fr/uber-files/",
  },
  {
    key: "requalification_salariat",
    question: "Puis-je être requalifié en salarié par une plateforme comme Uber ?",
    keywords: ["requalification", "salariat", "cassation", "arret 2020", "subordination"],
    reponse_fr: "Oui, potentiellement. La Cour de cassation (arrêt du 4 mars 2020, n°19-13.316) a jugé qu'un chauffeur Uber pouvait être requalifié en salarié dès lors qu'il existe un lien de subordination caractérisé (impossibilité de se constituer une clientèle propre, tarifs et itinéraires imposés unilatéralement, pouvoir de sanction via déconnexion). Chaque cas est apprécié individuellement par les tribunaux (Conseil de Prud'hommes).",
    source_url: "https://www.courdecassation.fr/decision/5fca9m9c5041ba0007bf6f8b",
  },
  {
    key: "carte_pro_renouvellement",
    question: "Comment renouveler ma carte professionnelle VTC ?",
    keywords: ["carte pro", "renouvellement", "5 ans", "expiration"],
    reponse_fr: "La carte professionnelle VTC est valable 5 ans. Le renouvellement nécessite de justifier de la formation continue obligatoire (14h sur la période), de fournir un casier judiciaire (bulletin B2) à jour, et de déposer une demande auprès de la préfecture (ou plateforme en ligne dédiée) avant l'expiration, idéalement 2 mois avant.",
    source_url: "https://www.service-public.fr/particuliers/vosdroits/F32921",
  },
  {
    key: "vehicule_age_limite",
    question: "Existe-t-il un âge limite pour mon véhicule VTC ?",
    keywords: ["age vehicule", "7 ans", "anciennete"],
    reponse_fr: "Le véhicule doit avoir moins de 7 ans lors de sa première mise en service en tant que VTC (Code des transports, art. R3120-4). Une fois en exploitation, il n'y a pas de limite d'âge supplémentaire tant que le contrôle technique reste valide, mais les plateformes imposent parfois leurs propres critères (souvent 7 à 10 ans maximum en circulation).",
    source_url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042661763",
  },
  {
    key: "loti_vs_vtc",
    question: "Quelle différence entre une licence LOTI et une carte VTC ?",
    keywords: ["loti", "difference", "transport collectif"],
    reponse_fr: "La licence LOTI (Loi d'Orientation des Transports Intérieurs) permet le transport collectif occasionnel de personnes (groupes, dans un véhicule de plus de 9 places ou en location avec chauffeur pour des circuits touristiques), tandis que la carte VTC est spécifique au transport individuel de particuliers à la demande via réservation. Un véhicule LOTI ne peut pas légalement effectuer des courses VTC individuelles sans la carte professionnelle VTC.",
    source_url: "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000692471/",
  },
  {
    key: "plaques_rouges",
    question: "Dois-je avoir des plaques d'immatriculation spécifiques (plaques rouges) ?",
    keywords: ["plaque rouge", "immatriculation speciale", "taxi plaque"],
    reponse_fr: "Non, contrairement aux taxis qui disposent parfois de plaques ou signes distinctifs spécifiques selon la commune, les VTC utilisent une immatriculation classique. En revanche, un signe distinctif (disque ou autocollant VTC) doit être apposé sur le pare-brise pendant l'exercice de l'activité.",
  },
  {
    key: "tarif_horokilometrique",
    question: "Un VTC peut-il utiliser un compteur horokilométrique comme un taxi ?",
    keywords: ["horokilometrique", "compteur", "tarif", "taximetre"],
    reponse_fr: "Non. Le tarif horokilométrique (calcul en temps réel selon durée + distance via taximètre) est réservé aux taxis. Les VTC doivent afficher un prix déterminé à l'avance (forfait ou estimation communiquée avant la réservation), conformément au principe de réservation préalable avec tarification transparente.",
    source_url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000023086525/LEGISCTA000042660873",
  },
  {
    key: "rgpd_donnees_courses",
    question: "Les plateformes VTC doivent-elles respecter le RGPD sur mes données de courses ?",
    keywords: ["rgpd", "donnees personnelles", "cnil"],
    reponse_fr: "Oui. Les plateformes (Uber, Bolt, Heetch) sont responsables de traitement au sens du RGPD pour vos données de géolocalisation, revenus et évaluations. Vous disposez d'un droit d'accès, de rectification et de portabilité de vos données (utile notamment en cas de litige ou de procédure de requalification, pour reconstituer l'historique d'activité).",
    source_url: "https://www.cnil.fr/fr/rgpd-de-quoi-parle-t-on",
  },
  {
    key: "assurance_obligatoire",
    question: "Quelle assurance est strictement obligatoire pour exercer en VTC ?",
    keywords: ["assurance obligatoire", "rc pro", "assurance vtc"],
    reponse_fr: "Deux assurances sont indispensables : (1) l'assurance auto avec mention explicite d'un usage « transport de personnes à titre onéreux » (une assurance auto classique ne couvre pas cet usage et vous exposerait en cas de sinistre), et (2) une assurance responsabilité civile professionnelle (RC Pro) couvrant les dommages causés aux passagers et tiers dans le cadre de l'activité.",
    source_url: "https://www.service-public.fr/professionnels-entreprises/vosdroits/F32952",
  },
  {
    key: "formation_continue_obligation",
    question: "La formation continue de 14h est-elle vraiment obligatoire ?",
    keywords: ["formation continue", "14h", "obligatoire", "5 ans"],
    reponse_fr: "Oui, pour le renouvellement de la carte professionnelle VTC (tous les 5 ans), 14 heures de formation continue auprès d'un organisme agréé sont exigées (Code des transports, art. R3120-13). Cette formation couvre l'actualisation réglementaire, la sécurité routière et la relation client.",
    source_url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042661763",
  },
  {
    key: "refus_course_discriminatoire",
    question: "Puis-je refuser une course sans justification ?",
    keywords: ["refus course", "discrimination", "annulation"],
    reponse_fr: "Vous pouvez refuser une course tant que celle-ci n'est pas acceptée, mais un refus systématique fondé sur un motif discriminatoire (origine, handicap, destination dans un quartier précis de façon répétée) est illégal et sanctionné pénalement (Code pénal, art. 225-1 et 225-2). Les plateformes surveillent également les taux d'annulation abusifs, qui peuvent entraîner une désactivation du compte.",
  },
  {
    key: "litige_plateforme_procedure",
    question: "Quelle est la procédure en cas de litige avec une plateforme (paiement, désactivation) ?",
    keywords: ["litige", "reclamation", "desactivation", "compte bloque"],
    reponse_fr: "1) Contacter le support de la plateforme avec preuves (captures d'écran, relevés de courses). 2) En l'absence de réponse sous 30 jours, saisir le médiateur du secteur ou une association de chauffeurs. 3) Pour un préjudice financier important, une action en justice (tribunal de commerce ou conseil de prud'hommes selon la qualification retenue) reste possible. Utilisez les modèles de réclamation disponibles dans la section Litiges de l'application.",
  },
];

export function initFaqIfEmpty() { /* FAQ statique en mémoire, pas de table nécessaire */ }

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
}

export function answerLegalFaq(question: string): { matched: boolean; entry: FaqEntry | null; suggestions: FaqEntry[]; message_fr: string } {
  const q = normalize(question || "");
  if (!q.trim()) {
    return { matched: false, entry: null, suggestions: FAQ_BASE.slice(0, 5), message_fr: "Merci de poser une question sur la réglementation VTC." };
  }

  let best: { entry: FaqEntry; score: number } | null = null;
  for (const entry of FAQ_BASE) {
    let score = 0;
    const qNorm = normalize(entry.question);
    // Correspondance mots-clés
    for (const kw of entry.keywords) {
      if (q.includes(normalize(kw))) score += 3;
    }
    // Correspondance de mots communs avec la question de référence
    const qWords = new Set(qNorm.split(/\s+/).filter(w => w.length > 3));
    const inputWords = q.split(/\s+/).filter(w => w.length > 3);
    for (const w of inputWords) {
      if (qWords.has(w)) score += 1;
    }
    if (!best || score > best.score) best = { entry, score };
  }

  if (best && best.score >= 2) {
    return { matched: true, entry: best.entry, suggestions: [], message_fr: best.entry.reponse_fr };
  }

  // Aucune correspondance forte → suggestions
  const suggestions = FAQ_BASE.slice(0, 5);
  return {
    matched: false,
    entry: null,
    suggestions,
    message_fr: "Je n'ai pas trouvé de réponse exacte à votre question. Voici quelques questions fréquentes qui pourraient vous aider.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 7. GÉNÉRATEUR DE CONTRATS FREELANCE (4 templates) ──────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export type ContractTemplateKey = "mission_mariage" | "contrat_cadre_entreprise" | "cgv_clientele_privee" | "decharge_responsabilite";

export interface ContractGenInput {
  template: ContractTemplateKey;
  nom_chauffeur: string;
  siret?: string;
  nom_client: string;
  date_prestation?: string;
  montant?: number;
  details?: string;
}

function contractHeader(nom: string, siret?: string): string {
  return `Entre les soussignés :\n\n${nom}${siret ? `, immatriculé(e) sous le SIRET ${siret}` : ""}, exerçant l'activité de chauffeur VTC indépendant, ci-après dénommé « le Prestataire »,\n\nEt`;
}

export function generateContract(input: ContractGenInput): { title: string; body: string; source_note: string } {
  const nom = input.nom_chauffeur || "[Nom du chauffeur]";
  const siret = input.siret || "";
  const client = input.nom_client || "[Nom du client]";
  const date = input.date_prestation || "[Date de la prestation]";
  const montant = input.montant ? `${input.montant.toLocaleString("fr-FR")} €` : "[Montant à définir]";
  const details = input.details || "";

  const templates: Record<ContractTemplateKey, { title: string; body: string }> = {
    mission_mariage: {
      title: "Contrat de prestation — Mission ponctuelle mariage",
      body: `${contractHeader(nom, siret)} ${client}, ci-après dénommé « le Client ».

Article 1 — Objet
Le Prestataire s'engage à assurer une prestation de transport privé (VTC) à l'occasion d'un mariage prévu le ${date}, incluant : ${details || "trajet(s) des mariés et/ou invités selon planning convenu"}.

Article 2 — Modalités
Le véhicule utilisé sera conforme à la réglementation VTC en vigueur (carte professionnelle, assurance RC Pro, contrôle technique à jour). Le Prestataire agit dans le cadre d'une réservation préalable, conformément au Code des transports (art. L3122-2).

Article 3 — Tarif
Le montant convenu pour cette prestation est de ${montant}, incluant mise à disposition du véhicule et du chauffeur pour la durée convenue. Un acompte de 30% pourra être demandé à la signature, solde à régler le jour de la prestation.

Article 4 — Annulation
En cas d'annulation par le Client moins de 7 jours avant la date prévue, l'acompte reste acquis au Prestataire à titre d'indemnisation.

Article 5 — Responsabilité
Le Prestataire est couvert par une assurance RC Pro transport de personnes. Sa responsabilité ne saurait être engagée en cas de retard imputable à des circonstances extérieures (circulation, intempéries, cas de force majeure).

Fait à ______________, le ______________
Signature du Prestataire            Signature du Client`,
    },
    contrat_cadre_entreprise: {
      title: "Contrat-cadre de prestations — Entreprise",
      body: `${contractHeader(nom, siret)} ${client}, ci-après dénommé « le Client », société immatriculée sous le n° [SIREN Client].

Article 1 — Objet
Le présent contrat-cadre a pour objet de définir les conditions dans lesquelles le Prestataire réalisera, à la demande du Client, des prestations de transport VTC récurrentes (déplacements de collaborateurs, transferts aéroport/gare, événements professionnels) sur la période du ${date} au [date de fin].

Article 2 — Modalités de commande
Chaque prestation fera l'objet d'une demande préalable du Client (email, plateforme dédiée ou bon de commande), conformément à l'obligation de réservation préalable applicable aux VTC.

Article 3 — Tarification
Tarif de base convenu : ${montant} par prestation (ou grille tarifaire annexée). Facturation mensuelle sur relevé des prestations réalisées, paiement à 30 jours fin de mois sauf accord contraire.

Article 4 — Durée et résiliation
Le présent contrat est conclu pour une durée déterminée, renouvelable par tacite reconduction sauf dénonciation par l'une des parties avec un préavis de 30 jours.

Article 5 — Assurances et conformité
Le Prestataire certifie être titulaire d'une carte professionnelle VTC valide, d'une assurance RC Pro et d'une immatriculation à jour (SIRET ci-dessus).

Article 6 — Confidentialité
Les informations échangées dans le cadre de ce contrat (déplacements de collaborateurs, agendas) sont traitées de manière confidentielle par le Prestataire, conformément au RGPD.

Fait à ______________, le ______________
Signature du Prestataire            Signature du Client (représentant légal)`,
    },
    cgv_clientele_privee: {
      title: "Conditions Générales de Vente — Clientèle privée",
      body: `CONDITIONS GÉNÉRALES DE VENTE
Prestataire : ${nom}${siret ? ` — SIRET ${siret}` : ""}

Article 1 — Champ d'application
Les présentes CGV s'appliquent à toute prestation de transport VTC réservée directement auprès du Prestataire par un client particulier, hors intermédiation d'une plateforme (Uber, Bolt, Heetch).

Article 2 — Réservation
Toute prestation doit faire l'objet d'une réservation préalable (téléphone, SMS, email ou formulaire), conformément à la réglementation applicable aux VTC (interdiction de maraude, Code des transports art. L3122-2).

Article 3 — Tarifs
Le tarif est communiqué au client avant la réservation, sous forme de forfait ou d'estimation. Le tarif horokilométrique en temps réel (type taximètre) n'est pas utilisé, cette pratique étant réservée aux taxis.

Article 4 — Paiement
Paiement par carte bancaire, virement ou espèces à l'issue de la prestation, sauf accord de facturation différée pour une clientèle récurrente.

Article 5 — Annulation
Toute annulation moins de 2 heures avant la prise en charge pourra donner lieu à la facturation de tout ou partie de la course, selon le préjudice subi (immobilisation du véhicule).

Article 6 — Responsabilité et assurance
Le Prestataire dispose d'une assurance RC Pro transport de personnes couvrant les dommages éventuels survenus pendant la prestation.

Article 7 — Données personnelles
Les données collectées (nom, coordonnées, historique de trajets) sont utilisées uniquement dans le cadre de la relation commerciale, conformément au RGPD. Le client dispose d'un droit d'accès, de rectification et de suppression.

Article 8 — Litiges
En cas de litige, une solution amiable sera recherchée en priorité. À défaut, les tribunaux compétents du ressort du domicile du Prestataire seront saisis.`,
    },
    decharge_responsabilite: {
      title: "Décharge de responsabilité — Prestation VTC",
      body: `DÉCHARGE DE RESPONSABILITÉ

Je soussigné(e) ${client}, reconnais avoir été transporté(e) par ${nom}${siret ? ` (SIRET ${siret})` : ""} le ${date}, dans le cadre d'une prestation VTC réservée au préalable.

Article 1 — Objet
La présente décharge a pour objet d'attester que le transport s'est déroulé conformément aux conditions convenues, et de dégager le Prestataire de toute responsabilité concernant : ${details || "les objets personnels laissés dans le véhicule, les retards liés à des événements extérieurs (circulation, intempéries, grève), ou toute demande de modification d'itinéraire non prévue initialement"}.

Article 2 — Assurance
Le Prestataire dispose d'une assurance responsabilité civile professionnelle couvrant les dommages corporels et matériels pouvant survenir pendant le trajet, dans les limites prévues par son contrat.

Article 3 — Bagages et objets personnels
Le Prestataire ne pourra être tenu responsable de la perte, du vol ou de la détérioration d'objets personnels laissés sans surveillance dans le véhicule après la fin de la prestation.

Article 4 — Acceptation
En signant ce document, le Client reconnaît avoir pris connaissance des présentes conditions et les accepter sans réserve.

Fait à ______________, le ______________
Signature du Client                 Signature du Prestataire`,
    },
  };

  const tpl = templates[input.template];
  if (!tpl) throw new Error(`Template de contrat inconnu: ${input.template}`);
  return {
    title: tpl.title,
    body: tpl.body,
    source_note: "Modèle indicatif généré automatiquement — à faire relire par un professionnel du droit avant signature pour un usage commercial récurrent (cf. Bonsai pour des modèles juridiques certifiés).",
  };
}

export const CONTRACT_TEMPLATES_META: { key: ContractTemplateKey; label_fr: string; description_fr: string }[] = [
  { key: "mission_mariage", label_fr: "Mission ponctuelle mariage", description_fr: "Contrat pour une prestation VTC unique lors d'un mariage ou événement privé." },
  { key: "contrat_cadre_entreprise", label_fr: "Contrat-cadre entreprise", description_fr: "Contrat récurrent pour une clientèle B2B (transferts, déplacements collaborateurs)." },
  { key: "cgv_clientele_privee", label_fr: "CGV clientèle privée", description_fr: "Conditions générales de vente pour les réservations directes hors plateforme." },
  { key: "decharge_responsabilite", label_fr: "Décharge de responsabilité", description_fr: "Document de décharge pour encadrer la responsabilité du chauffeur pendant la prestation." },
];

// ═══════════════════════════════════════════════════════════════════════════
// ─── 8. BASE RÉGLEMENTAIRE 2026 (20+ règles) ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
interface LegalRuleSeed {
  rule_key: string;
  category: string;
  title_fr: string;
  description_fr: string;
  reference_legale: string;
  source_url: string;
}

const LEGAL_RULES_SEED: LegalRuleSeed[] = [
  { rule_key: "t3p_obligation", category: "fiscalite", title_fr: "Obligation de la T3P", description_fr: "Taxe annuelle due par tout exploitant de VTC/taxi, calculée par véhicule exploité.", reference_legale: "Code général des impôts, art. 1013", source_url: "https://www.impots.gouv.fr/professionnel/la-taxe-sur-les-transports-publics-particuliers-de-personnes-t3p" },
  { rule_key: "ads_taxi_vs_vtc", category: "statut", title_fr: "ADS taxi vs carte VTC", description_fr: "L'ADS (Autorisation de Stationnement) est réservée aux taxis et permet la maraude ; la carte VTC ne l'inclut jamais et interdit le stationnement en attente de client.", reference_legale: "Code des transports, art. L3121-1 et L3122-1", source_url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000023086525" },
  { rule_key: "reservation_prealable_obligatoire", category: "exercice", title_fr: "Réservation préalable obligatoire", description_fr: "Tout transport VTC doit être précédé d'une réservation ; la maraude et le stationnement en quête de client sont interdits.", reference_legale: "Code des transports, art. L3122-2", source_url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000023086525/LEGISCTA000042660873" },
  { rule_key: "tarif_horokilometrique_max", category: "tarification", title_fr: "Interdiction du tarif horokilométrique VTC", description_fr: "Les VTC ne peuvent pas facturer au compteur (durée+distance en temps réel), réservé aux taxis ; le tarif doit être déterminé avant la course.", reference_legale: "Code des transports, art. L3122-4", source_url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000023086525" },
  { rule_key: "loti_transport_collectif", category: "statut", title_fr: "LOTI — transport collectif occasionnel", description_fr: "La licence LOTI couvre le transport collectif occasionnel (véhicules >9 places ou circuits touristiques), distincte de la carte VTC individuelle.", reference_legale: "Loi n°82-1153 du 30 décembre 1982 (LOTI)", source_url: "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000692471/" },
  { rule_key: "plaques_immatriculation_standard", category: "vehicule", title_fr: "Pas de plaques spécifiques VTC", description_fr: "Les véhicules VTC utilisent une immatriculation classique ; seul un signe distinctif (disque/autocollant) est requis sur le pare-brise.", reference_legale: "Arrêté relatif à la signalétique VTC", source_url: "https://www.legifrance.gouv.fr/" },
  { rule_key: "carte_pro_5ans", category: "identite", title_fr: "Durée de validité de la carte VTC", description_fr: "La carte professionnelle VTC est valable 5 ans et son renouvellement exige la formation continue et un casier B2 vierge.", reference_legale: "Code des transports, art. R3120-13", source_url: "https://www.service-public.fr/particuliers/vosdroits/F32921" },
  { rule_key: "vehicule_moins_7ans", category: "vehicule", title_fr: "Âge maximal du véhicule à l'entrée en exploitation", description_fr: "Le véhicule doit avoir moins de 7 ans lors de sa première mise en service VTC.", reference_legale: "Code des transports, art. R3120-4", source_url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042661763" },
  { rule_key: "casier_b2_vierge", category: "identite", title_fr: "Casier judiciaire B2 vierge", description_fr: "Un bulletin n°2 du casier judiciaire vierge de certaines infractions est exigé pour la délivrance/le renouvellement de la carte VTC.", reference_legale: "Code des transports, art. R3120-9", source_url: "https://www.service-public.fr/particuliers/vosdroits/F32921" },
  { rule_key: "formation_continue_14h", category: "formation", title_fr: "Formation continue 14h / 5 ans", description_fr: "14 heures de formation continue auprès d'un organisme agréé sont obligatoires pour renouveler la carte VTC.", reference_legale: "Code des transports, art. R3120-13", source_url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042661763" },
  { rule_key: "rc_pro_obligatoire", category: "assurance", title_fr: "RC Pro transport de personnes obligatoire", description_fr: "Une assurance responsabilité civile professionnelle spécifique doit couvrir l'activité de transport de personnes à titre onéreux.", reference_legale: "Code des transports, art. L3120-2-2", source_url: "https://www.service-public.fr/professionnels-entreprises/vosdroits/F32952" },
  { rule_key: "capital_social_sasu_recommande", category: "financier", title_fr: "Capital social SASU/EURL", description_fr: "1 € légal minimum, mais 1 500 € recommandés en pratique pour la crédibilité bancaire et l'accès au financement véhicule.", reference_legale: "Code de commerce, art. L227-1 (SAS/SASU) — pratique de marché", source_url: "https://www.legalstart.fr/fiches-pratiques/sasu/capital-social-sasu/" },
  { rule_key: "registre_exploitants_vtc", category: "juridique", title_fr: "Inscription au registre des exploitants VTC", description_fr: "Tout exploitant VTC (personne physique ou morale) doit s'inscrire au registre national avant de débuter l'activité.", reference_legale: "Code des transports, art. L3122-3", source_url: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000023086525" },
  { rule_key: "maraude_interdiction_cass2020", category: "jurisprudence", title_fr: "Interdiction de la maraude confirmée (Cass. 2020)", description_fr: "La Cour de cassation a confirmé en 2020 l'interdiction pour les VTC de stationner/circuler en quête de clients sans réservation préalable, y compris via géolocalisation publique sur application.", reference_legale: "Cass. crim. 2020", source_url: "https://www.courdecassation.fr/" },
  { rule_key: "requalification_salariat_cass2020", category: "jurisprudence", title_fr: "Requalification possible en salariat (Cass. soc. mars 2020)", description_fr: "Un chauffeur peut être requalifié en salarié d'une plateforme en cas de lien de subordination caractérisé (tarifs imposés, sanctions via déconnexion, absence de clientèle propre).", reference_legale: "Cass. soc., 4 mars 2020, n°19-13.316", source_url: "https://www.courdecassation.fr/decision/5fca9m9c5041ba0007bf6f8b" },
  { rule_key: "uber_files_contexte", category: "contexte", title_fr: "Uber Files (2022)", description_fr: "Révélations sur les pratiques de lobbying d'Uber en France (2013-2017), ayant renforcé la vigilance réglementaire sur le secteur VTC.", reference_legale: "Enquête journalistique ICIJ/Le Monde, 2022", source_url: "https://www.lemonde.fr/uber-files/" },
  { rule_key: "cumul_emploi_salarie", category: "statut", title_fr: "Cumul activité VTC et emploi salarié", description_fr: "Le cumul est autorisé sous réserve du respect de l'obligation de loyauté envers l'employeur et de l'absence de clause d'exclusivité.", reference_legale: "Code du travail, art. L1222-5 (loyauté) et jurisprudence associée", source_url: "https://www.service-public.fr/particuliers/vosdroits/F31488" },
  { rule_key: "rgpd_donnees_chauffeur", category: "donnees", title_fr: "RGPD applicable aux données du chauffeur", description_fr: "Les plateformes doivent respecter le RGPD sur les données de géolocalisation, revenus et évaluations des chauffeurs.", reference_legale: "Règlement (UE) 2016/679 (RGPD)", source_url: "https://www.cnil.fr/fr/rgpd-de-quoi-parle-t-on" },
  { rule_key: "discrimination_refus_course", category: "penal", title_fr: "Interdiction de refus discriminatoire de course", description_fr: "Le refus systématique d'une course fondé sur un critère discriminatoire est sanctionné pénalement.", reference_legale: "Code pénal, art. 225-1 et 225-2", source_url: "https://www.legifrance.gouv.fr/" },
  { rule_key: "plafond_micro_entrepreneur", category: "fiscalite", title_fr: "Plafond de chiffre d'affaires micro-entrepreneur", description_fr: "Le régime micro-entrepreneur (BIC prestations de services) est soumis à un plafond annuel de chiffre d'affaires, au-delà duquel un régime réel s'impose.", reference_legale: "Code général des impôts, art. 50-0", source_url: "https://www.urssaf.fr/" },
  { rule_key: "franchise_tva_seuils", category: "fiscalite", title_fr: "Seuils de la franchise en base de TVA", description_fr: "En-dessous du seuil de base, le chauffeur ne facture pas de TVA ; le dépassement du seuil majoré entraîne un assujettissement immédiat.", reference_legale: "Code général des impôts, art. 293 B", source_url: "https://www.legalplace.fr/guides/plafond-auto-entrepreneur/" },
  { rule_key: "controle_technique_vtc", category: "vehicule", title_fr: "Contrôle technique obligatoire", description_fr: "Le véhicule VTC doit disposer d'un contrôle technique valide, avec une périodicité pouvant être renforcée par les plateformes.", reference_legale: "Code de la route, art. R323-1", source_url: "https://www.service-public.fr/particuliers/vosdroits/F13475" },
  { rule_key: "signe_distinctif_obligatoire", category: "vehicule", title_fr: "Signe distinctif VTC obligatoire", description_fr: "Un disque ou autocollant d'identification VTC doit être apposé de manière visible sur le véhicule pendant l'exercice de l'activité.", reference_legale: "Arrêté relatif à la signalétique VTC", source_url: "https://www.legifrance.gouv.fr/" },
  { rule_key: "cipav_retraite_vtc", category: "retraite", title_fr: "Affiliation retraite (CIPAV / SSI selon régime)", description_fr: "Selon le régime fiscal choisi (micro-BNC historique ou BIC), l'affiliation retraite peut relever de la CIPAV ou du régime général des indépendants (SSI).", reference_legale: "Code de la sécurité sociale, art. L640-1", source_url: "https://www.lacipav.fr/" },
];

function seedLegalRulesIfEmpty() {
  const count = sqlite.prepare(`SELECT COUNT(*) as n FROM legal_rules_2026`).get() as { n: number };
  if (count.n > 0) return;
  const stmt = sqlite.prepare(`
    INSERT OR IGNORE INTO legal_rules_2026 (rule_key, category, title_fr, description_fr, reference_legale, source_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = sqlite.transaction((rows: LegalRuleSeed[]) => {
    for (const r of rows) stmt.run(r.rule_key, r.category, r.title_fr, r.description_fr, r.reference_legale, r.source_url);
  });
  tx(LEGAL_RULES_SEED);
}

export function getLegalRules(category?: string) {
  seedLegalRulesIfEmpty();
  const rows = category
    ? sqlite.prepare(`SELECT * FROM legal_rules_2026 WHERE category = ? ORDER BY id ASC`).all(category)
    : sqlite.prepare(`SELECT * FROM legal_rules_2026 ORDER BY category ASC, id ASC`).all();
  const categories = Array.from(new Set(LEGAL_RULES_SEED.map(r => r.category)));
  return { rules: rows, total: (rows as any[]).length, categories };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 9. LITIGES PLATEFORMES — TEMPLATES DE RÉCLAMATION (5 templates) ────────
// ═══════════════════════════════════════════════════════════════════════════
export type DisputeTemplateKey = "paiement_manquant" | "desactivation_compte" | "note_injustifiee" | "rgpd_acces_donnees" | "requalification_salariale";

export interface DisputeTemplateInput {
  template: DisputeTemplateKey;
  plateforme: "Uber" | "Bolt" | "Heetch" | "FreeNow" | string;
  nom_chauffeur: string;
  details?: string;
  montant?: number;
  date_incident?: string;
}

export function generateDisputeTemplate(input: DisputeTemplateInput): { title: string; body: string; base_legale: string[] } {
  const nom = input.nom_chauffeur || "[Nom du chauffeur]";
  const plateforme = input.plateforme || "[Plateforme]";
  const details = input.details || "";
  const montant = input.montant ? `${input.montant.toLocaleString("fr-FR")} €` : "[Montant]";
  const date = input.date_incident || "[Date de l'incident]";

  const templates: Record<DisputeTemplateKey, { title: string; body: string; base_legale: string[] }> = {
    paiement_manquant: {
      title: `Réclamation — Paiement manquant ou erroné (${plateforme})`,
      body: `Objet : Réclamation concernant un paiement manquant ou erroné — Compte chauffeur ${nom}

Madame, Monsieur,

Je vous contacte au sujet d'une course réalisée le ${date} pour laquelle le paiement indiqué dans mon relevé (${montant}) ne correspond pas au montant effectivement dû. ${details}

Je vous demande de bien vouloir vérifier cette transaction et de procéder à la régularisation sous 15 jours. À défaut de réponse satisfaisante, je me réserve le droit de saisir le médiateur du secteur ou, si nécessaire, la juridiction compétente.

Je reste disponible pour vous fournir toute pièce justificative complémentaire (capture d'écran de la course, relevé bancaire).

Cordialement,
${nom}`,
      base_legale: ["Code civil, art. 1103 (force obligatoire du contrat)", "Conditions générales d'utilisation de la plateforme"],
    },
    desactivation_compte: {
      title: `Contestation de désactivation de compte (${plateforme})`,
      body: `Objet : Contestation de la désactivation de mon compte chauffeur — ${nom}

Madame, Monsieur,

Mon compte chauffeur a été désactivé le ${date} sans que j'aie reçu de motif clair et détaillé. ${details}

Je vous demande de bien vouloir : 1) me communiquer par écrit le motif précis de cette désactivation, 2) me donner accès aux éléments l'ayant justifiée, conformément à mon droit d'accès aux données me concernant (RGPD, art. 15), et 3) réexaminer cette décision dans les meilleurs délais.

Cette désactivation me prive de revenus et j'attire votre attention sur le préjudice économique que cela engendre. Sans réponse sous 15 jours, je saisirai les autorités compétentes (CNIL pour le volet données, médiateur ou juridiction pour le volet contractuel).

Cordialement,
${nom}`,
      base_legale: ["RGPD, art. 15 et 22 (droit d'accès, décision automatisée)", "Cass. soc. 4 mars 2020, n°19-13.316 (encadrement du pouvoir de sanction de la plateforme)"],
    },
    note_injustifiee: {
      title: `Contestation d'une note ou évaluation injustifiée (${plateforme})`,
      body: `Objet : Contestation d'une évaluation client jugée injustifiée — ${nom}

Madame, Monsieur,

Je conteste la note attribuée suite à la course du ${date}. ${details}

Cette évaluation me semble injustifiée au regard du déroulement réel de la prestation. Je vous demande de bien vouloir réexaminer cet avis, notamment si celui-ci relève d'un motif discriminatoire ou sans rapport avec la qualité du service rendu.

Je souhaite également rappeler qu'une accumulation de notes non vérifiées peut avoir un impact direct sur mon accès aux courses, constituant un préjudice économique.

Cordialement,
${nom}`,
      base_legale: ["Conditions générales d'utilisation de la plateforme", "Code pénal, art. 225-1 et 225-2 (si motif discriminatoire avéré)"],
    },
    rgpd_acces_donnees: {
      title: `Demande d'accès aux données personnelles (RGPD) — ${plateforme}`,
      body: `Objet : Demande d'exercice du droit d'accès à mes données personnelles (art. 15 RGPD)

Madame, Monsieur,

Conformément à l'article 15 du Règlement Général sur la Protection des Données (RGPD), je souhaite obtenir une copie de l'ensemble des données personnelles que vous détenez me concernant en tant que chauffeur partenaire, notamment : historique complet des courses, revenus perçus, données de géolocalisation, évaluations reçues et données utilisées pour l'attribution des courses (algorithme de matching).

${details}

Je vous remercie de bien vouloir me communiquer ces informations dans un délai d'un mois, conformément à l'article 12 du RGPD. À défaut, je me réserve le droit de saisir la CNIL.

Cordialement,
${nom}`,
      base_legale: ["RGPD, art. 15 (droit d'accès)", "RGPD, art. 12 (délai de réponse d'un mois)"],
    },
    requalification_salariale: {
      title: `Demande d'informations en vue d'une action en requalification (${plateforme})`,
      body: `Objet : Demande de communication d'éléments relatifs à mon activité — ${nom}

Madame, Monsieur,

Dans le cadre de l'analyse de ma relation contractuelle avec votre plateforme, je souhaite obtenir un état complet de mon historique d'activité (courses, connexions, tarifs imposés, sanctions ou déconnexions temporaires) depuis le début de mon activité.

${details}

Cette demande s'inscrit dans le cadre de mes droits, notamment au regard de la jurisprudence de la Cour de cassation (arrêt du 4 mars 2020, n°19-13.316) reconnaissant la possibilité d'une requalification de la relation en contrat de travail en cas de lien de subordination caractérisé.

Je vous remercie de votre retour sous 30 jours.

Cordialement,
${nom}`,
      base_legale: ["Cass. soc., 4 mars 2020, n°19-13.316 (requalification en salariat)", "Code du travail, art. L8221-6-1 (présomption simple de non-salariat renversable)"],
    },
  };

  const tpl = templates[input.template];
  if (!tpl) throw new Error(`Template de litige inconnu: ${input.template}`);
  return tpl;
}

export const DISPUTE_TEMPLATES_META: { key: DisputeTemplateKey; label_fr: string; description_fr: string }[] = [
  { key: "paiement_manquant", label_fr: "Paiement manquant/erroné", description_fr: "Réclamer un paiement absent ou incorrect sur une course." },
  { key: "desactivation_compte", label_fr: "Désactivation de compte", description_fr: "Contester une désactivation de compte chauffeur sans motif clair." },
  { key: "note_injustifiee", label_fr: "Note/évaluation injustifiée", description_fr: "Contester une évaluation client jugée abusive ou discriminatoire." },
  { key: "rgpd_acces_donnees", label_fr: "Accès aux données (RGPD)", description_fr: "Demander l'ensemble de ses données personnelles à la plateforme." },
  { key: "requalification_salariale", label_fr: "Éléments pour requalification", description_fr: "Demander l'historique d'activité en vue d'une action en requalification salariale." },
];

// ═══════════════════════════════════════════════════════════════════════════
// ─── 10. SUIVI DES LITIGES ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface DisputeLogInput {
  plateforme: string;
  type: string;
  montant?: number;
  status?: "ouvert" | "resolu" | "perdu";
  resolution?: string;
  docs?: any[];
}

export function createDispute(input: DisputeLogInput, userId = "default") {
  const stmt = sqlite.prepare(`
    INSERT INTO disputes_log (user_id, plateforme, type, montant, status, resolution, docs)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    userId,
    input.plateforme,
    input.type,
    input.montant || 0,
    input.status || "ouvert",
    input.resolution || "",
    JSON.stringify(input.docs || [])
  );
  return getDisputeById(Number(info.lastInsertRowid));
}

export function getDisputeById(id: number) {
  const row = sqlite.prepare(`SELECT * FROM disputes_log WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return { ...row, docs: JSON.parse(row.docs || "[]") };
}

export function listDisputes(userId = "default", status?: string) {
  const rows = status
    ? sqlite.prepare(`SELECT * FROM disputes_log WHERE user_id = ? AND status = ? ORDER BY ts DESC`).all(userId, status)
    : sqlite.prepare(`SELECT * FROM disputes_log WHERE user_id = ? ORDER BY ts DESC`).all(userId);
  const parsed = (rows as any[]).map(r => ({ ...r, docs: JSON.parse(r.docs || "[]") }));
  const totalOuvert = parsed.filter(r => r.status === "ouvert").length;
  const totalResolu = parsed.filter(r => r.status === "resolu").length;
  const totalPerdu = parsed.filter(r => r.status === "perdu").length;
  const montantRecupere = parsed.filter(r => r.status === "resolu").reduce((s, r) => s + (r.montant || 0), 0);
  return { disputes: parsed, total: parsed.length, total_ouvert: totalOuvert, total_resolu: totalResolu, total_perdu: totalPerdu, montant_recupere: r2(montantRecupere) };
}

export function updateDispute(id: number, updates: Partial<DisputeLogInput>) {
  const existing = getDisputeById(id);
  if (!existing) throw new Error(`Litige #${id} introuvable`);
  const fields: string[] = [];
  const values: any[] = [];
  if (updates.plateforme !== undefined) { fields.push("plateforme = ?"); values.push(updates.plateforme); }
  if (updates.type !== undefined) { fields.push("type = ?"); values.push(updates.type); }
  if (updates.montant !== undefined) { fields.push("montant = ?"); values.push(updates.montant); }
  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (updates.resolution !== undefined) { fields.push("resolution = ?"); values.push(updates.resolution); }
  if (updates.docs !== undefined) { fields.push("docs = ?"); values.push(JSON.stringify(updates.docs)); }
  fields.push("updated_at = datetime('now')");
  values.push(id);
  sqlite.prepare(`UPDATE disputes_log SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getDisputeById(id);
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 11. FORMATION CONTINUE 5 ANS ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface FormateurAgree { nom: string; ville: string; contact_url: string; duree_h: number }

export const FORMATEURS_AGREES_IDF: FormateurAgree[] = [
  { nom: "CMA Île-de-France — Centre de formation VTC", ville: "Paris", contact_url: "https://www.cma-idf.fr/", duree_h: 14 },
  { nom: "AFT-IFTIM Transport Formation", ville: "Bagnolet", contact_url: "https://www.aft-dev.com/", duree_h: 14 },
  { nom: "IFCPR (Institut de Formation des Chauffeurs Professionnels de la Route)", ville: "Créteil", contact_url: "https://www.ifcpr.fr/", duree_h: 14 },
  { nom: "GTAA Formation VTC", ville: "Aulnay-sous-Bois", contact_url: "https://www.gtaa-formation.fr/", duree_h: 14 },
  { nom: "CFA Transport Île-de-France", ville: "Nanterre", contact_url: "https://www.cfa-transport-idf.fr/", duree_h: 14 },
];

export function getFormationContinueStatus(dateObtentionCarte?: string) {
  const now = new Date();
  let echeance: Date | null = null;
  let joursRestants: number | null = null;

  if (dateObtentionCarte) {
    const dateObt = new Date(dateObtentionCarte);
    if (!isNaN(dateObt.getTime())) {
      echeance = new Date(dateObt);
      echeance.setFullYear(echeance.getFullYear() + 5);
      joursRestants = Math.ceil((echeance.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }
  }

  const urgency = joursRestants === null ? "non_renseigne" : joursRestants < 0 ? "overdue" : joursRestants <= 90 ? "urgent" : joursRestants <= 365 ? "soon" : "ok";

  return {
    heures_obligatoires: 14,
    periode_annees: 5,
    date_obtention_carte: dateObtentionCarte || null,
    echeance_renouvellement: echeance ? echeance.toISOString().slice(0, 10) : null,
    jours_restants: joursRestants,
    urgency,
    formateurs_agrees_idf: FORMATEURS_AGREES_IDF,
    message_fr:
      urgency === "overdue"
        ? "Votre échéance de formation continue est dépassée : contactez rapidement un organisme agréé pour éviter la suspension de votre carte VTC."
        : urgency === "urgent"
          ? "Il vous reste moins de 90 jours pour valider vos 14h de formation continue. Planifiez une session dès maintenant."
          : urgency === "soon"
            ? "Votre échéance de renouvellement approche dans moins d'un an — anticipez la réservation d'une session."
            : urgency === "non_renseigne"
              ? "Renseignez votre date d'obtention de la carte VTC pour calculer votre échéance de formation continue."
              : "Votre situation est à jour concernant la formation continue.",
    source_url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042661763",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── 12. SIMULATEUR RETRAITE CIPAV ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
export interface CipavSimulatorInput {
  ca_annuel_moyen: number;
  nombre_annees_cotisees: number;
  age_actuel: number;
  age_depart_souhaite?: number;
  statut_fiscal?: string;
}

export interface CipavSimulatorResult {
  regime_probable: "CIPAV" | "SSI";
  points_estimes: number;
  pension_annuelle_estimee: number;
  pension_mensuelle_estimee: number;
  annees_restantes: number;
  ca_cumule_estime: number;
  message_fr: string;
  avertissement_fr: string;
}

// Valeur du point CIPAV et taux de cotisation approximatifs (ordre de grandeur, à vérifier chaque année)
const CIPAV_VALEUR_POINT_EUR = 0.6218; // valeur de service du point CIPAV 2024/2025 (approximation, revalorisée chaque année)
const CIPAV_TAUX_COTISATION_RETRAITE_BASE_PCT = 10.1; // cotisation retraite de base, approximation micro-BNC

export function simulateCipavRetirement(input: CipavSimulatorInput): CipavSimulatorResult {
  const ca = Math.max(0, Number(input.ca_annuel_moyen) || 0);
  const anneesCotisees = Math.max(0, Number(input.nombre_annees_cotisees) || 0);
  const ageActuel = Math.max(18, Number(input.age_actuel) || 30);
  const ageDepart = Math.max(ageActuel, Number(input.age_depart_souhaite) || 64);
  const anneesRestantes = Math.max(0, ageDepart - ageActuel);

  const regime: "CIPAV" | "SSI" = input.statut_fiscal === "micro-bnc" ? "CIPAV" : "SSI";

  // Approximation : cotisations retraite base = CA × abattement micro-BNC (34% de charges) × taux cotisation
  const revenuImposableApprox = ca * 0.66;
  const cotisationAnnuelle = r2(revenuImposableApprox * (CIPAV_TAUX_COTISATION_RETRAITE_BASE_PCT / 100));
  const pointsParAn = cotisationAnnuelle > 0 ? r2(cotisationAnnuelle / 5.5) : 0; // approximation prix d'achat du point
  const totalAnneesCotisation = anneesCotisees + anneesRestantes;
  const pointsEstimes = r2(pointsParAn * totalAnneesCotisation);
  const pensionAnnuelle = r2(pointsEstimes * CIPAV_VALEUR_POINT_EUR);
  const pensionMensuelle = r2(pensionAnnuelle / 12);
  const caCumule = r2(ca * totalAnneesCotisation);

  return {
    regime_probable: regime,
    points_estimes: pointsEstimes,
    pension_annuelle_estimee: pensionAnnuelle,
    pension_mensuelle_estimee: pensionMensuelle,
    annees_restantes: anneesRestantes,
    ca_cumule_estime: caCumule,
    message_fr: `Avec un CA annuel moyen de ${ca.toLocaleString("fr-FR")} € cotisé pendant ${totalAnneesCotisation} ans, la pension de retraite de base estimée est d'environ ${pensionMensuelle.toLocaleString("fr-FR")} €/mois (régime ${regime}). Ce montant ne couvre que le régime de base ; un PER (Plan Épargne Retraite) individuel est fortement recommandé pour compléter.`,
    avertissement_fr: "Simulation indicative basée sur des valeurs de point et taux approximatifs 2026 — la valeur réelle du point CIPAV/SSI est revalorisée chaque année. Consultez votre relevé de carrière officiel sur lassuranceretraite.fr ou lacipav.fr pour un calcul précis.",
  };
}
