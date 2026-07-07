/**
 * healthEngine.ts — Couche SANTÉ chauffeur (Itération Santé & Finance)
 * ═════════════════════════════════════════════════════════════════════════════
 * Inspiré du rapport §6 (Santé physique/mentale du chauffeur), §11 (Écosystème
 * services chauffeur) et gaps benchmark identifiés :
 *   - Stride/Gridwise : marketplace assurance santé/véhicule pour indépendants US
 *   - Bibliothèque d'exercices d'étirement adaptés à la position assise prolongée
 *   - Score d'ergonomie véhicule (questionnaire → recommandations d'achat)
 *   - Comparateur mutuelles TNS (Travailleur Non Salarié) pré-rempli
 *
 * ZÉRO nouvelle dépendance npm — réutilise better-sqlite3 déjà présent (comme
 * fatigueCoach.ts, mlPersonal.ts). Tables créées en CREATE TABLE IF NOT EXISTS,
 * complètement additionnelles.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";

// Connexion séparée au même fichier data.db (WAL supporte le multi-connexion),
// même pattern que fatigueCoach.ts.
const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

export const DEFAULT_USER = "root"; // app single-tenant

// ─────────────────────────────────────────────────────────────────────────────
// Schéma
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS health_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    sitting_minutes INTEGER NOT NULL DEFAULT 0,
    breaks_count INTEGER NOT NULL DEFAULT 0,
    stretch_done INTEGER NOT NULL DEFAULT 0,
    pain_score INTEGER NOT NULL DEFAULT 0,
    sleep_hours REAL NOT NULL DEFAULT 0,
    hydration_glasses INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_health_log_user_ts ON health_log(user_id, ts);

  CREATE TABLE IF NOT EXISTS vehicle_ergo_score (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    answers TEXT NOT NULL DEFAULT '[]',
    score INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS mutuelles_tns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    prix_min REAL NOT NULL,
    prix_max REAL NOT NULL,
    indemnites_journalieres TEXT NOT NULL,
    garanties TEXT NOT NULL DEFAULT '[]',
    delai_carence_jours INTEGER NOT NULL DEFAULT 0,
    note_fr TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS assurances_vehicule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    prix_min REAL NOT NULL,
    prix_max REAL NOT NULL,
    garanties TEXT NOT NULL DEFAULT '[]',
    specificite_vtc TEXT NOT NULL DEFAULT '',
    note_fr TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT ''
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// Seed — Mutuelles TNS (pré-remplies, fourchettes tarifaires indicatives 2026)
// ─────────────────────────────────────────────────────────────────────────────
function seedMutuelles() {
  const count = (db.prepare(`SELECT COUNT(*) as n FROM mutuelles_tns`).get() as { n: number }).n;
  if (count > 0) return;
  const rows: Array<[string, number, number, string, string[], number, string, string]> = [
    [
      "SwissLife TNS",
      55, 110,
      "20 à 100 €/jour dès le 4e jour d'arrêt (option 1er jour possible)",
      ["Hospitalisation renforcée", "Indemnités journalières modulables", "Assistance auto en cas d'arrêt maladie", "Options dentaire/optique renforcées"],
      3,
      "Référence historique TNS, très personnalisable mais devis nécessaire pour tarif exact.",
      "https://www.swisslife.fr/",
    ],
    [
      "Allianz Pro",
      50, 100,
      "15 à 80 €/jour selon formule, franchise 3 à 7 jours",
      ["Réseau de soins Allianz", "Indemnités journalières incluses dès formule Confort", "Téléconsultation illimitée"],
      3,
      "Bon rapport garanties/prix pour chauffeurs VTC à revenu variable.",
      "https://www.allianz.fr/",
    ],
    [
      "MMA Indépendants",
      52, 115,
      "18 à 90 €/jour, carence réduite en option",
      ["Assurance perte de revenus dédiée indépendants", "Prévoyance décès/invalidité incluse", "Hospitalisation et maternité renforcées"],
      5,
      "Bon compromis santé + prévoyance dans un seul contrat.",
      "https://www.mma.fr/",
    ],
    [
      "AXA Auto-Entrepreneur",
      50, 95,
      "10 à 70 €/jour, formule pensée pour micro-entrepreneurs",
      ["Tarif dégressif selon CA déclaré", "Module perte d'exploitation en option", "Application de suivi remboursements"],
      7,
      "Spécifiquement calibré pour le statut auto-entrepreneur / micro-BNC des VTC.",
      "https://www.axa.fr/",
    ],
    [
      "Alan Pro",
      45, 90,
      "Non incluses par défaut (santé pure) — prévoyance via partenaire",
      ["100% digital, remboursement en 24-48h", "Carte de tiers payant immédiate", "Application mobile primée UX"],
      0,
      "Meilleure expérience digitale, mais indemnités journalières à ajouter en option prévoyance séparée — vérifier avant de compter dessus pour un arrêt.",
      "https://alan.com/",
    ],
    [
      "Alptis",
      48, 105,
      "12 à 75 €/jour, forfaits modulables par palier",
      ["Spécialiste historique TNS/indépendants", "Garanties hospitalisation à la carte", "Option maintien de revenu en cas d'accident"],
      3,
      "Large choix de formules à la carte, bon pour ajuster précisément budget/garanties.",
      "https://www.alptis.org/",
    ],
  ];
  const stmt = db.prepare(`
    INSERT INTO mutuelles_tns (nom, prix_min, prix_max, indemnites_journalieres, garanties, delai_carence_jours, note_fr, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(r[0], r[1], r[2], r[3], JSON.stringify(r[4]), r[5], r[6], r[7]);
    }
  });
  tx();
}
seedMutuelles();

// ─────────────────────────────────────────────────────────────────────────────
// Seed — Assurances véhicule VTC
// ─────────────────────────────────────────────────────────────────────────────
function seedAssurancesVehicule() {
  const count = (db.prepare(`SELECT COUNT(*) as n FROM assurances_vehicule`).get() as { n: number }).n;
  if (count > 0) return;
  const rows: Array<[string, number, number, string[], string, string, string]> = [
    [
      "Amaguiz",
      45, 90,
      ["Tous risques VTC", "Protection juridique incluse", "Assistance 0km en option"],
      "Devis 100% en ligne, tarif compétitif pour véhicules récents utilisés en VTC.",
      "Bon premier réflexe pour comparer un tarif de base, mais vérifier l'exclusion transport de personnes à titre onéreux avant souscription.",
      "https://www.amaguiz.com/",
    ],
    [
      "Direct Assurance Pro",
      55, 105,
      ["Formule VTC dédiée", "Valeur à neuf 24 mois", "Bris de glace sans franchise en option"],
      "Offre pro spécifique transport de personnes, activable en quelques jours.",
      "Bon compromis prix/simplicité pour chauffeurs en LOA/LLD.",
      "https://www.directassurance.fr/",
    ],
    [
      "AXA VTC",
      65, 130,
      ["Tous risques VTC", "Protection du revenu en cas d'immobilisation", "Véhicule de remplacement inclus"],
      "Offre premium avec garantie perte de revenus si le véhicule est immobilisé après sinistre — rare sur le marché.",
      "Le plus complet pour sécuriser le revenu, mais aussi le plus cher.",
      "https://www.axa.fr/",
    ],
    [
      "Assurance-VTC.com",
      50, 100,
      ["Spécialiste 100% VTC/taxi", "Accompagnement déclaration d'activité", "Réseau de courtiers dédiés"],
      "Courtier spécialisé uniquement VTC/taxi, connaît bien les spécificités réglementaires (carte VTC, registre).",
      "Bon choix si besoin de conseil personnalisé sur le statut VTC.",
      "https://www.assurance-vtc.com/",
    ],
    [
      "Alors Pro (Groupama)",
      50, 95,
      ["Formule Pro Transport", "Assistance panne 0km", "Protection juridique renforcée"],
      "Backing Groupama, réseau d'agences physiques pour suivi de sinistre.",
      "Utile si le chauffeur préfère un contact en agence plutôt que 100% digital.",
      "https://www.alors.fr/",
    ],
  ];
  const stmt = db.prepare(`
    INSERT INTO assurances_vehicule (nom, prix_min, prix_max, garanties, specificite_vtc, note_fr, url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(r[0], r[1], r[2], JSON.stringify(r[3]), r[4], r[5], r[6]);
    }
  });
  tx();
}
seedAssurancesVehicule();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface HealthLogInput {
  sitting_minutes?: number;
  breaks_count?: number;
  stretch_done?: boolean | number;
  pain_score?: number;
  sleep_hours?: number;
  hydration_glasses?: number;
}

export interface Exercise {
  id: string;
  nom: string;
  categorie: "dos" | "nuque" | "jambes" | "poignets" | "respiration" | "tronc";
  duree_secondes: number;
  instructions: string[];
  benefice_fr: string;
}

export interface ErgoQuestion {
  id: string;
  question: string;
  options: { label: string; points: number }[];
}

export interface ErgoResult {
  score: number;
  niveau: "critique" | "à améliorer" | "correct" | "excellent";
  recommandations: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Journal santé — POST /api/health/log, GET /api/health/log
// ─────────────────────────────────────────────────────────────────────────────
export function logHealth(userId: string, input: HealthLogInput) {
  const stretchDone = input.stretch_done ? 1 : 0;
  const painScore = Math.max(0, Math.min(10, Math.round(input.pain_score ?? 0)));
  const info = db
    .prepare(
      `INSERT INTO health_log (user_id, ts, sitting_minutes, breaks_count, stretch_done, pain_score, sleep_hours, hydration_glasses)
       VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      Math.max(0, Math.round(input.sitting_minutes ?? 0)),
      Math.max(0, Math.round(input.breaks_count ?? 0)),
      stretchDone,
      painScore,
      Math.max(0, input.sleep_hours ?? 0),
      Math.max(0, Math.round(input.hydration_glasses ?? 0))
    );

  // Message de coaching immédiat basé sur les valeurs saisies (piège évité :
  // pas de diagnostic médical, uniquement des conseils génériques de bon sens)
  const tips: string[] = [];
  if (painScore >= 7) tips.push("Douleur élevée signalée — pense à consulter un professionnel de santé si cela persiste plusieurs jours.");
  if ((input.sitting_minutes ?? 0) > 240 && (input.breaks_count ?? 0) < 2) tips.push("Plus de 4h assis avec peu de pauses — programme une pause étirement dans les 30 minutes.");
  if ((input.sleep_hours ?? 0) > 0 && (input.sleep_hours ?? 0) < 6) tips.push("Nuit courte détectée — vigilance renforcée recommandée sur la route aujourd'hui.");
  if ((input.hydration_glasses ?? 0) < 4) tips.push("Hydratation faible — vise au moins 6 à 8 verres d'eau sur la journée.");
  if (!input.stretch_done) tips.push("Pas encore d'étirement aujourd'hui — 2 minutes suffisent, consulte la bibliothèque d'exercices.");

  return { id: Number(info.lastInsertRowid), tips_fr: tips };
}

export function getHealthHistory(userId: string, limit = 30) {
  return db
    .prepare(
      `SELECT id, ts, sitting_minutes, breaks_count, stretch_done, pain_score, sleep_hours, hydration_glasses
       FROM health_log WHERE user_id = ? ORDER BY ts DESC LIMIT ?`
    )
    .all(userId, limit);
}

export function getHealthToday(userId: string) {
  const rows = db
    .prepare(
      `SELECT id, ts, sitting_minutes, breaks_count, stretch_done, pain_score, sleep_hours, hydration_glasses
       FROM health_log WHERE user_id = ? AND date(ts) = date('now') ORDER BY ts DESC`
    )
    .all(userId) as any[];
  const totals = rows.reduce(
    (acc, r) => {
      acc.sitting_minutes += r.sitting_minutes;
      acc.breaks_count += r.breaks_count;
      acc.stretch_done = acc.stretch_done || !!r.stretch_done;
      acc.hydration_glasses += r.hydration_glasses;
      acc.pain_scores.push(r.pain_score);
      if (r.sleep_hours) acc.sleep_hours = r.sleep_hours;
      return acc;
    },
    { sitting_minutes: 0, breaks_count: 0, stretch_done: false, hydration_glasses: 0, pain_scores: [] as number[], sleep_hours: 0 }
  );
  const avgPain = totals.pain_scores.length
    ? Math.round((totals.pain_scores.reduce((a: number, b: number) => a + b, 0) / totals.pain_scores.length) * 10) / 10
    : 0;
  return { entries: rows, ...totals, avg_pain_score: avgPain };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Bibliothèque d'exercices — GET /api/health/exercises (12+ exercices FR)
// ─────────────────────────────────────────────────────────────────────────────
export const EXERCISES: Exercise[] = [
  {
    id: "rotation-nuque",
    nom: "Rotation de la nuque",
    categorie: "nuque",
    duree_secondes: 30,
    instructions: [
      "Assis bien droit, ceinture détachée si à l'arrêt.",
      "Tourne lentement la tête vers la droite, maintiens 3 secondes.",
      "Reviens au centre puis tourne vers la gauche, maintiens 3 secondes.",
      "Répète 4 à 5 fois de chaque côté, mouvements lents et contrôlés.",
    ],
    benefice_fr: "Relâche les tensions cervicales dues à la position figée au volant.",
  },
  {
    id: "etirement-trapezes",
    nom: "Étirement des trapèzes",
    categorie: "nuque",
    duree_secondes: 45,
    instructions: [
      "Assis, incline la tête vers l'épaule droite sans forcer.",
      "Pose délicatement la main droite sur le côté gauche de la tête.",
      "Maintiens l'étirement 20 secondes en respirant calmement.",
      "Change de côté et répète.",
    ],
    benefice_fr: "Réduit les douleurs de trapèzes liées au stress et à la posture au volant.",
  },
  {
    id: "rotation-epaules",
    nom: "Rotation des épaules",
    categorie: "dos",
    duree_secondes: 30,
    instructions: [
      "Assis droit, mains sur le volant ou sur les genoux si à l'arrêt.",
      "Fais rouler les épaules vers l'arrière en grands cercles, 10 fois.",
      "Inverse le sens et refais 10 cercles vers l'avant.",
    ],
    benefice_fr: "Décontracte les épaules et améliore la circulation sanguine du haut du dos.",
  },
  {
    id: "etirement-dos",
    nom: "Étirement du dos (torsion assise)",
    categorie: "dos",
    duree_secondes: 60,
    instructions: [
      "Assis, pieds bien à plat, dos droit.",
      "Pose la main gauche sur le siège passager ou l'appui-tête.",
      "Tourne doucement le buste vers la droite en regardant par-dessus l'épaule.",
      "Maintiens 20 à 30 secondes puis inverse le côté.",
    ],
    benefice_fr: "Soulage les tensions lombaires accumulées après plusieurs heures assises.",
  },
  {
    id: "mouvement-poignets",
    nom: "Mouvement des poignets",
    categorie: "poignets",
    duree_secondes: 30,
    instructions: [
      "Lâche le volant à l'arrêt (véhicule immobile, moteur coupé de préférence).",
      "Tends les bras devant toi et fais des rotations de poignets, 10 dans chaque sens.",
      "Ouvre et ferme les poings 10 fois pour relancer la circulation.",
    ],
    benefice_fr: "Prévient les tensions et le syndrome du canal carpien liés à la tenue prolongée du volant.",
  },
  {
    id: "flexion-chevilles",
    nom: "Flexion/extension des chevilles",
    categorie: "jambes",
    duree_secondes: 30,
    instructions: [
      "Assis, soulève légèrement les talons puis les pointes de pieds alternativement.",
      "Répète le mouvement 15 à 20 fois de chaque côté.",
      "Termine par quelques rotations de chevilles dans les deux sens.",
    ],
    benefice_fr: "Active le retour veineux et limite les jambes lourdes en fin de shift.",
  },
  {
    id: "etirement-quadriceps",
    nom: "Étirement des quadriceps debout",
    categorie: "jambes",
    duree_secondes: 60,
    instructions: [
      "Debout à côté du véhicule, prends appui d'une main sur la carrosserie.",
      "Attrape ta cheville droite derrière toi et rapproche le talon de la fesse.",
      "Maintiens 20 à 30 secondes, genoux alignés, puis change de jambe.",
    ],
    benefice_fr: "Détend les cuisses raccourcies par la position assise prolongée.",
  },
  {
    id: "etirement-ischios",
    nom: "Étirement des ischio-jambiers",
    categorie: "jambes",
    duree_secondes: 60,
    instructions: [
      "Debout, pose un talon sur un support bas (bordure, marchepied) jambe tendue.",
      "Penche légèrement le buste vers l'avant, dos droit, sans forcer.",
      "Maintiens 20 à 30 secondes puis change de jambe.",
    ],
    benefice_fr: "Réduit les tensions à l'arrière des cuisses, fréquentes chez les conducteurs assis longtemps.",
  },
  {
    id: "respiration-diaphragmatique",
    nom: "Respiration diaphragmatique",
    categorie: "respiration",
    duree_secondes: 120,
    instructions: [
      "Assis confortablement, une main sur le ventre, une main sur la poitrine.",
      "Inspire lentement par le nez en gonflant le ventre (4 secondes).",
      "Retiens 2 secondes puis expire lentement par la bouche (6 secondes).",
      "Répète pendant 2 minutes pour faire retomber le stress.",
    ],
    benefice_fr: "Diminue le stress au volant et améliore l'oxygénation, utile avant une course difficile.",
  },
  {
    id: "massage-tempes",
    nom: "Massage des tempes",
    categorie: "nuque",
    duree_secondes: 30,
    instructions: [
      "Place l'index et le majeur de chaque main sur les tempes.",
      "Effectue de petits cercles doux pendant 20 à 30 secondes.",
      "Respire calmement pendant le massage.",
    ],
    benefice_fr: "Soulage les maux de tête liés à la fatigue visuelle et à la concentration prolongée.",
  },
  {
    id: "etirement-lateral-tronc",
    nom: "Étirement latéral du tronc",
    categorie: "tronc",
    duree_secondes: 45,
    instructions: [
      "Assis droit, lève le bras droit au-dessus de la tête.",
      "Penche doucement le buste vers la gauche en gardant les fessiers ancrés au siège.",
      "Maintiens 15 à 20 secondes puis change de côté.",
    ],
    benefice_fr: "Étire les flancs et le bas du dos, compressés par la position assise.",
  },
  {
    id: "automassage-lombaires",
    nom: "Auto-massage des lombaires",
    categorie: "dos",
    duree_secondes: 60,
    instructions: [
      "Assis ou debout, place les poings ou les paumes dans le bas du dos.",
      "Effectue des pressions circulaires de part et d'autre de la colonne, 30 secondes.",
      "Ajoute de légères extensions du bassin vers l'avant pour décompresser les lombaires.",
    ],
    benefice_fr: "Détend la zone lombaire, la plus sollicitée en position assise prolongée au volant.",
  },
];

export function getExercises(categorie?: string): Exercise[] {
  if (categorie) return EXERCISES.filter((e) => e.categorie === categorie);
  return EXERCISES;
}

/** Suggestion contextuelle : exercice recommandé selon le dernier journal santé. */
export function getRecommendedExercise(userId: string): { exercise: Exercise; raison_fr: string } {
  const last = db
    .prepare(
      `SELECT sitting_minutes, pain_score FROM health_log WHERE user_id = ? ORDER BY ts DESC LIMIT 1`
    )
    .get(userId) as { sitting_minutes: number; pain_score: number } | undefined;

  if (last && last.pain_score >= 6) {
    const ex = EXERCISES.find((e) => e.id === "automassage-lombaires")!;
    return { exercise: ex, raison_fr: "Douleur élevée signalée récemment — un auto-massage lombaire peut soulager rapidement." };
  }
  if (last && last.sitting_minutes >= 180) {
    const ex = EXERCISES.find((e) => e.id === "etirement-ischios")!;
    return { exercise: ex, raison_fr: "Plus de 3h assis détectées — un étirement des jambes est prioritaire." };
  }
  // Rotation naturelle sinon (varie selon l'heure pour éviter la monotonie)
  const idx = new Date().getHours() % EXERCISES.length;
  return { exercise: EXERCISES[idx], raison_fr: "Exercice du moment pour varier les zones travaillées sur la journée." };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Score ergonomie véhicule — questionnaire 8 questions → /100
// ─────────────────────────────────────────────────────────────────────────────
export const ERGO_QUESTIONS: ErgoQuestion[] = [
  {
    id: "siege_reglable",
    question: "Ton siège conducteur est-il réglable en hauteur et en inclinaison ?",
    options: [
      { label: "Oui, complètement réglable", points: 15 },
      { label: "Partiellement réglable", points: 8 },
      { label: "Non réglable", points: 0 },
    ],
  },
  {
    id: "soutien_lombaire",
    question: "As-tu un soutien lombaire (intégré ou coussin) ?",
    options: [
      { label: "Oui, efficace", points: 15 },
      { label: "Un coussin basique", points: 8 },
      { label: "Aucun soutien", points: 0 },
    ],
  },
  {
    id: "appui_tete",
    question: "L'appui-tête est-il bien positionné (hauteur/distance) ?",
    options: [
      { label: "Oui, réglé correctement", points: 10 },
      { label: "Approximatif", points: 5 },
      { label: "Jamais réglé", points: 0 },
    ],
  },
  {
    id: "distance_pedales",
    question: "La distance aux pédales te permet-elle une jambe presque tendue ?",
    options: [
      { label: "Oui, confortable", points: 10 },
      { label: "Un peu trop proche/loin", points: 5 },
      { label: "Inconfortable", points: 0 },
    ],
  },
  {
    id: "climatisation",
    question: "La climatisation/chauffage maintient une température stable en conduite longue ?",
    options: [
      { label: "Oui, sans problème", points: 10 },
      { label: "Parfois insuffisant", points: 5 },
      { label: "Souvent inconfortable", points: 0 },
    ],
  },
  {
    id: "pauses_frequence",
    question: "À quelle fréquence fais-tu une pause debout/marche pendant un shift de 8h+ ?",
    options: [
      { label: "Toutes les 2h ou plus souvent", points: 15 },
      { label: "Une seule fois", points: 7 },
      { label: "Jamais ou presque", points: 0 },
    ],
  },
  {
    id: "tapis_anti_fatigue",
    question: "Utilises-tu un tapis ou repose-pied anti-fatigue ?",
    options: [
      { label: "Oui", points: 10 },
      { label: "Non mais j'y pense", points: 3 },
      { label: "Non", points: 0 },
    ],
  },
  {
    id: "douleurs_frequentes",
    question: "Ressens-tu des douleurs (dos, nuque, jambes) plusieurs fois par semaine ?",
    options: [
      { label: "Jamais ou rarement", points: 15 },
      { label: "Occasionnellement", points: 7 },
      { label: "Fréquemment", points: 0 },
    ],
  },
];

export function computeErgoScore(userId: string, answers: Record<string, number>): ErgoResult {
  let score = 0;
  for (const q of ERGO_QUESTIONS) {
    const pts = answers[q.id];
    if (typeof pts === "number") score += Math.max(0, Math.min(15, pts));
  }
  score = Math.max(0, Math.min(100, score));

  let niveau: ErgoResult["niveau"];
  if (score < 40) niveau = "critique";
  else if (score < 65) niveau = "à améliorer";
  else if (score < 85) niveau = "correct";
  else niveau = "excellent";

  const recommandations: string[] = [];
  if ((answers["soutien_lombaire"] ?? 0) < 10) recommandations.push("Coussin lombaire ergonomique (15-40 €) pour soulager le bas du dos sur les longs shifts.");
  if ((answers["appui_tete"] ?? 0) < 10) recommandations.push("Réajuste ou change ton appui-tête (hauteur au niveau du sommet du crâne, distance ~10cm).");
  if ((answers["tapis_anti_fatigue"] ?? 0) < 10) recommandations.push("Tapis anti-fatigue ou repose-pied (20-50 €) pour améliorer la circulation dans les jambes.");
  if ((answers["pauses_frequence"] ?? 0) < 15) recommandations.push("Planifie une pause debout/marche toutes les 2 heures, même 5 minutes suffisent.");
  if ((answers["siege_reglable"] ?? 0) < 15) recommandations.push("Envisage un coussin de rehausse ou une housse ergonomique si le siège n'est pas réglable.");
  if ((answers["climatisation"] ?? 0) < 10) recommandations.push("Vérifie/entretiens la climatisation — l'inconfort thermique augmente la fatigue perçue.");
  if (recommandations.length === 0) recommandations.push("Ton installation est déjà bien pensée — continue à surveiller les signes de douleur au fil des mois.");

  db.prepare(`INSERT INTO vehicle_ergo_score (user_id, ts, answers, score) VALUES (?, datetime('now'), ?, ?)`).run(
    userId,
    JSON.stringify(answers),
    score
  );

  return { score, niveau, recommandations };
}

export function getErgoHistory(userId: string, limit = 10) {
  return db
    .prepare(`SELECT id, ts, score FROM vehicle_ergo_score WHERE user_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(userId, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Comparateur mutuelles TNS
// ─────────────────────────────────────────────────────────────────────────────
export function getMutuellesTns() {
  const rows = db.prepare(`SELECT * FROM mutuelles_tns ORDER BY prix_min ASC`).all() as any[];
  return rows.map((r) => ({ ...r, garanties: JSON.parse(r.garanties) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Comparateur assurances véhicule VTC
// ─────────────────────────────────────────────────────────────────────────────
export function getAssurancesVehicule() {
  const rows = db.prepare(`SELECT * FROM assurances_vehicule ORDER BY prix_min ASC`).all() as any[];
  return rows.map((r) => ({ ...r, garanties: JSON.parse(r.garanties) }));
}
