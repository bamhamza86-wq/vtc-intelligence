/**
 * coachTemplates.ts — Base de connaissances FAQ VTC (Coach conversationnel)
 * ─────────────────────────────────────────────────────────────────────────────
 * AUCUN LLM. Pur matching par mots-clés + variables dynamiques (année en cours,
 * seuils actuels importés de taxConstants.ts). Cf. rapport.md §12.4 : « toujours
 * limiter les réponses à des sources vérifiées internes, jamais de génération
 * libre sur ce sujet sensible ».
 *
 * Format : chaque entrée définit un id, une liste de mots-clés (matching OR,
 * score = nombre de mots-clés trouvés dans la question normalisée), un template
 * de réponse (fonction pour interpoler les variables dynamiques) et des sources.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { URSSAF, TVA, DEFAULTS_IDF, TAX_CONSTANTS_LAST_CHECKED } from "./taxConstants";

export interface CoachSource {
  label: string;
  url_or_data_ref: string;
}

export interface CoachTemplate {
  id: string;
  question_pattern: string[]; // mots-clés (normalisés, sans accents, minuscules)
  category: string;
  render: () => string;
  sources: CoachSource[];
}

const CURRENT_YEAR = new Date().getFullYear();

// ─── Helpers ────────────────────────────────────────────────────────────────
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // supprime accents
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Templates FAQ ──────────────────────────────────────────────────────────
export const COACH_TEMPLATES: CoachTemplate[] = [
  {
    id: "urssaf_taux",
    question_pattern: ["urssaf", "cotisation", "cotisations", "charges sociales", "taux urssaf"],
    category: "urssaf",
    render: () =>
      `En ${CURRENT_YEAR}, le taux global de cotisations sociales URSSAF pour un micro-entrepreneur VTC ` +
      `(prestations de services commerciales, régime BIC) est de ${URSSAF.TAUX_COTISATIONS_PCT}%, ` +
      `auquel s'ajoute la contribution formation professionnelle (CFP) de ${URSSAF.TAUX_CFP_PCT}%. ` +
      `Soit un total d'environ ${(URSSAF.TAUX_COTISATIONS_PCT + URSSAF.TAUX_CFP_PCT).toFixed(1)}% de votre chiffre d'affaires encaissé, ` +
      `à déclarer et payer mensuellement ou trimestriellement sur le site autoentrepreneur.urssaf.fr. ` +
      `Si vous bénéficiez de l'ACRE (première année), ce taux est réduit de ${URSSAF.TAUX_ACRE_REDUCTION_PCT}% pendant les 4 premiers trimestres civils.`,
    sources: [{ label: "URSSAF Auto-entrepreneur — cotisations", url_or_data_ref: URSSAF.SOURCE_URL }],
  },
  {
    id: "tva_franchise",
    question_pattern: [
      "tva", "franchise", "franchise tva", "assujetti", "seuil tva", "plafond tva",
    ],
    category: "tva",
    render: () =>
      `La franchise en base de TVA vous dispense de facturer la TVA tant que votre chiffre d'affaires annuel ` +
      `reste sous le seuil de base de ${TVA.FRANCHISE_SEUIL_BASE_EUR.toLocaleString("fr-FR")}€ (prestations de services). ` +
      `Un seuil majoré de tolérance existe à ${TVA.FRANCHISE_SEUIL_MAJORE_EUR.toLocaleString("fr-FR")}€ : ` +
      `si vous le dépassez en cours d'année, vous devenez assujetti à la TVA immédiatement (dès le mois du dépassement). ` +
      `Si vous devenez assujetti, le taux de TVA applicable au transport de voyageurs est de ${TVA.TAUX_TVA_TRANSPORT_PCT}%. ` +
      `Conseil : suivez votre chiffre d'affaires cumulé dans l'app (Journal fiscal) pour anticiper ce seuil plutôt que de le découvrir en fin d'année.`,
    sources: [{ label: "Seuils franchise TVA — LegalPlace", url_or_data_ref: TVA.SOURCE_URL }],
  },
  {
    id: "ik_bareme",
    question_pattern: [
      "indemnite kilometrique", "ik", "bareme kilometrique", "bareme km", "frais reels km",
    ],
    category: "ik",
    render: () =>
      `Le barème des indemnités kilométriques (IK) sert de référence officielle pour estimer le coût réel ` +
      `d'usage d'un véhicule (carburant, usure, assurance, entretien inclus) en fonction de sa puissance fiscale (CV) ` +
      `et de la distance annuelle parcourue. Il est publié chaque année par l'administration fiscale. ` +
      `Ce barème n'est utile pour un micro-entrepreneur VTC qu'à titre indicatif de coût réel — le régime micro ` +
      `applique un abattement forfaitaire de 50% et non les frais réels. Consultez votre Journal fiscal pour ` +
      `voir votre estimation IK personnalisée selon votre véhicule.`,
    sources: [{ label: "Barème IK 2026 — LégiSocial", url_or_data_ref: "https://www.legisocial.fr/reperes-sociaux/bareme-kilometrique-2026.html" }],
  },
  {
    id: "statuts",
    question_pattern: [
      "micro entrepreneur", "auto entrepreneur", "statut", "ei", "sasu", "quel statut",
      "changer de statut", "regime fiscal",
    ],
    category: "statut",
    render: () =>
      `Trois statuts sont pertinents pour un chauffeur VTC : ` +
      `1) Micro-entrepreneur (BIC prestations de services) — le plus simple, cotisations à ${URSSAF.TAUX_COTISATIONS_PCT}% du CA, ` +
      `plafond annuel ${URSSAF.PLAFOND_CA_ANNUEL_EUR.toLocaleString("fr-FR")}€, idéal en début d'activité ou CA modéré. ` +
      `2) Entreprise individuelle (EI) au régime réel — intéressant si vos charges réelles (carburant, entretien, assurance) ` +
      `dépassent l'abattement forfaitaire de 50% du micro, généralement à partir d'un CA élevé. ` +
      `3) SASU — pertinent à partir d'environ 80 000€ de CA annuel pour optimiser rémunération et protection sociale, ` +
      `mais implique une comptabilité complète. Utilisez le simulateur de statut (Assistant fiscal) pour comparer selon votre CA réel.`,
    sources: [{ label: "Portail Auto-Entrepreneur — statuts", url_or_data_ref: "https://www.portail-autoentrepreneur.fr/academie/statut-auto-entrepreneur/cotisations" }],
  },
  {
    id: "commission_plateforme",
    question_pattern: [
      "commission uber", "commission bolt", "commission heetch", "commission plateforme",
      "combien uber prend", "combien bolt prend", "pourcentage plateforme",
    ],
    category: "plateforme",
    render: () =>
      `Les plateformes (Uber, Bolt, Heetch) prélèvent une commission sur chaque course, généralement entre 20% et 25% ` +
      `du montant de la course selon la plateforme, le contrat et les périodes promotionnelles en vigueur. ` +
      `Ce taux n'est pas réglementé et varie selon les accords contractuels individuels — vérifiez le récapitulatif de paiement ` +
      `hebdomadaire de votre plateforme pour connaître votre taux exact. Renseignez votre taux personnel dans votre profil ` +
      `chauffeur pour que les calculs de marge nette de l'app soient précis.`,
    sources: [{ label: "Comparateur plateformes (données internes)", url_or_data_ref: "/api/platforms/kpi-comparison" }],
  },
  {
    id: "arret_travail",
    question_pattern: [
      "arret de travail", "accident travail", "arret maladie", "incapacite", "invalidite",
    ],
    category: "protection_sociale",
    render: () =>
      `En tant que micro-entrepreneur, vous cotisez à la sécurité sociale des indépendants (SSI, intégrée au régime général). ` +
      `Vous pouvez percevoir des indemnités journalières en cas d'arrêt de travail, sous réserve d'avoir un CA suffisant ` +
      `sur les 12 mois précédents (des seuils minimaux de cotisation s'appliquent) et d'avoir au moins 1 an d'affiliation. ` +
      `Le calcul se base sur votre revenu annuel moyen des 3 dernières années. Déclarez votre arrêt via votre compte ameli.fr ` +
      `et informez votre CPAM rapidement pour ne pas retarder le versement.`,
    sources: [{ label: "Ameli — indemnités journalières indépendants", url_or_data_ref: "https://www.ameli.fr/independant" }],
  },
  {
    id: "conges_maladie",
    question_pattern: ["conges maladie", "conge maladie", "malade", "je suis malade", "maladie chauffeur"],
    category: "protection_sociale",
    render: () =>
      `Il n'existe pas de "congés payés" pour un indépendant : chaque jour non travaillé est un jour sans chiffre d'affaires. ` +
      `En cas de maladie, seules les indemnités journalières de la sécurité sociale des indépendants (sous conditions de CA minimum ` +
      `et d'ancienneté) peuvent compenser partiellement la perte de revenu. Beaucoup de chauffeurs VTC souscrivent en complément ` +
      `une prévoyance privée (assurance perte de revenu) pour sécuriser les périodes d'arrêt. Pensez à provisionner un fonds ` +
      `d'urgence équivalent à 1-2 mois de charges fixes.`,
    sources: [{ label: "Ameli — indemnités journalières indépendants", url_or_data_ref: "https://www.ameli.fr/independant" }],
  },
  {
    id: "prime_activite",
    question_pattern: ["prime d activite", "prime activite", "caf prime"],
    category: "aides",
    render: () =>
      `La prime d'activité est un complément de revenu versé par la CAF (ou la MSA), ouvert aux travailleurs indépendants ` +
      `y compris micro-entrepreneurs, sous conditions de ressources du foyer. Son montant dépend de votre chiffre d'affaires ` +
      `déclaré, de votre situation familiale et de vos autres revenus. Faites une simulation sur caf.fr tous les 3 mois ` +
      `(la déclaration trimestrielle de revenus est obligatoire pour continuer à la percevoir).`,
    sources: [{ label: "CAF — simulateur prime d'activité", url_or_data_ref: "https://www.caf.fr/allocataires/aides-et-demarches/droits-et-prestations/tester-mes-droits-a-la-prime-d-activite" }],
  },
  {
    id: "declaration_ca",
    question_pattern: [
      "declarer mon chiffre d affaires", "comment declarer", "declaration mensuelle", "declaration trimestrielle", "declarer ca",
    ],
    category: "urssaf",
    render: () =>
      `Vous devez déclarer votre chiffre d'affaires encaissé (pas facturé) sur autoentrepreneur.urssaf.fr, chaque mois ou ` +
      `chaque trimestre selon l'option choisie à la création. Le paiement des cotisations (${URSSAF.TAUX_COTISATIONS_PCT}% + ${URSSAF.TAUX_CFP_PCT}% CFP) ` +
      `intervient au même moment. Utilisez le Journal fiscal de l'app pour obtenir automatiquement le total de CA de la période ` +
      `et éviter les erreurs de déclaration.`,
    sources: [{ label: "URSSAF Auto-entrepreneur", url_or_data_ref: URSSAF.SOURCE_URL }],
  },
  {
    id: "amortissement_vehicule",
    question_pattern: ["amortissement", "amortir vehicule", "achat vehicule"],
    category: "vehicule",
    render: () =>
      `En micro-entrepreneur, vous ne déduisez pas l'amortissement du véhicule (l'abattement forfaitaire de 50% du CA ` +
      `couvre déjà forfaitairement toutes vos charges, y compris l'usure du véhicule). L'amortissement réel n'a de sens ` +
      `qu'en EI au régime réel ou en société (SASU). Dans l'app, la valeur "amortissement annuel" que vous renseignez ` +
      `sert uniquement à calculer votre coût réel au km à titre informatif, pas pour une déduction fiscale.`,
    sources: [{ label: "Barèmes internes VTC Intelligence", url_or_data_ref: "server/taxConstants.ts" }],
  },
  {
    id: "droit_travail_syntec_vtc",
    question_pattern: [
      "convention collective", "syntec", "droit du travail", "duree travail",
      "temps de travail vtc", "repos obligatoire", "amplitude horaire",
    ],
    category: "droit_travail",
    render: () =>
      `Un chauffeur VTC micro-entrepreneur (LOTI ou carte VTC individuelle) n'est PAS salarié : il n'est donc pas ` +
      `couvert par la convention collective Syntec (bureaux d'études techniques, ingénierie, conseil), qui ne s'applique ` +
      `qu'aux salariés d'entreprises relevant de ce secteur. En tant qu'indépendant, vous n'avez pas de durée légale ` +
      `du travail (35h) ni de convention collective de branche VTC à proprement parler, mais des obligations de sécurité ` +
      `routière s'appliquent : le Code des transports impose un repos quotidien d'au moins 11h consécutives et une pause ` +
      `d'au moins 30 min après 4h30 de conduite continue pour les VTC, par analogie avec les règles applicables aux ` +
      `taxis/VTC professionnels. Certains donneurs d'ordres (plateformes) intègrent des clauses contractuelles inspirées ` +
      `de ces standards dans leurs CGU. Si vous devenez salarié d'une société de VTC (SASU employant des chauffeurs), ` +
      `c'est alors la convention collective des Transports routiers de voyageurs qui s'applique, pas Syntec. ` +
      `Consultez le Timer légal de l'app (Sécurité) pour un suivi automatique de vos temps de conduite/repos.`,
    sources: [
      { label: "Code des transports — temps de conduite VTC", url_or_data_ref: "https://www.legifrance.gouv.fr/codes/id/LEGISCTA000031801530" },
      { label: "Convention collective Transports routiers de voyageurs (IDCC 1424)", url_or_data_ref: "https://www.legifrance.gouv.fr/conv_coll/id/KALICONT000005635624" },
    ],
  },
  {
    id: "requalification_salariat",
    question_pattern: [
      "requalification", "salariat", "lien de subordination", "faux independant", "employe deguise",
    ],
    category: "droit_travail",
    render: () =>
      `La requalification d'un chauffeur VTC indépendant en salarié de la plateforme peut être prononcée par les ` +
      `prud'hommes si un lien de subordination est prouvé (horaires imposés, sanctions disciplinaires type déconnexion, ` +
      `impossibilité de refuser des courses sans pénalité, tarifs unilatéraux non négociables). La Cour de cassation ` +
      `(arrêt Uber, 4 mars 2020) a déjà reconnu ce lien dans certains cas. Cette requalification, si elle intervient, ` +
      `ouvre des droits salariés rétroactifs (congés payés, indemnités) mais reste une procédure judiciaire longue et ` +
      `individuelle. Ce n'est pas un sujet que l'app peut trancher pour votre cas précis — consultez un avocat en droit ` +
      `du travail ou un syndicat de chauffeurs (ex. CSRP, INV) si vous pensez être dans cette situation.`,
    sources: [{ label: "Cour de cassation, arrêt Uber, 4 mars 2020 (n°19-13.316)", url_or_data_ref: "https://www.courdecassation.fr/decision/5fca9dcd8d4c9c0007bf9b31" }],
  },
];

/**
 * Trouve le meilleur template correspondant à une question libre.
 * Score = nombre de mots-clés du pattern trouvés dans la question normalisée.
 * Retourne null si aucun mot-clé ne correspond.
 */
export function matchCoachTemplate(question: string): { template: CoachTemplate; score: number } | null {
  const q = normalize(question);
  let best: { template: CoachTemplate; score: number } | null = null;
  for (const template of COACH_TEMPLATES) {
    let score = 0;
    for (const kw of template.question_pattern) {
      if (q.includes(normalize(kw))) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { template, score };
    }
  }
  return best;
}

export const COACH_FALLBACK_ANSWER =
  `Je n'ai pas de réponse préparée pour cette question précise. Voici les sujets que je maîtrise bien : ` +
  `URSSAF et cotisations, franchise TVA, barème IK, choix de statut (micro/EI/SASU), commissions des plateformes, ` +
  `arrêt de travail, congés maladie, prime d'activité, droit du travail (convention collective, requalification). ` +
  `Reformulez votre question en utilisant l'un de ces mots-clés, ou consultez un expert-comptable ou un avocat ` +
  `pour les cas très spécifiques.`;
