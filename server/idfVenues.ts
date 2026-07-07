/**
 * idfVenues.ts — Données statiques Île-de-France (Couche Aéroports/Événements/Grèves)
 * ─────────────────────────────────────────────────────────────────────────────
 * Contient :
 *  1. Points de dépose/reprise optimisés par salle (venue_dropoff_points seed)
 *  2. Événements récurrents hardcodés (matches PSG, spectacles Bercy, Roland-Garros)
 *     utilisés pour enrichir le calendrier IDF centralisé (GET /api/events/idf-calendar)
 *
 * Conformément à la contrainte du projet, ces données récurrentes sont isolées
 * dans un fichier JSON/TS séparé (pas mélangées avec la logique dans airportEngine.ts).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type Side = "nord" | "sud" | "est" | "ouest";

export interface VenueDropoffPoint {
  venue_key: string;
  salle_name: string;
  lat: number;
  lng: number;
  ideal_side: Side;
  notes_fr: string;
  walking_distance_m: number;
}

// ─── Zones dépose/reprise optimisées par salle (pré-remplissage) ───────────────
export const VENUE_DROPOFF_POINTS: VenueDropoffPoint[] = [
  {
    venue_key: "bercy",
    salle_name: "Accor Arena (Bercy)",
    lat: 48.8389,
    lng: 2.3789,
    ideal_side: "nord",
    notes_fr: "Dépose optimale : côté nord Bercy — entrée principale, évite le flux boulevard de Bercy.",
    walking_distance_m: 180,
  },
  {
    venue_key: "stade_de_france",
    salle_name: "Stade de France — Tribune Nord",
    lat: 48.9256,
    lng: 2.3607,
    ideal_side: "nord",
    notes_fr: "Dépose côté Porte H/I (nord) — flux sortant plus fluide vers Saint-Denis Basilique.",
    walking_distance_m: 350,
  },
  {
    venue_key: "stade_de_france",
    salle_name: "Stade de France — Tribune Sud",
    lat: 48.9231,
    lng: 2.3606,
    ideal_side: "sud",
    notes_fr: "Dépose côté Porte A/B (sud) — proche RER B La Plaine Stade de France.",
    walking_distance_m: 300,
  },
  {
    venue_key: "stade_de_france",
    salle_name: "Stade de France — Tribune Est",
    lat: 48.9245,
    lng: 2.3632,
    ideal_side: "est",
    notes_fr: "Dépose côté Porte E/F (est) — accès direct avenue Jules Rimet.",
    walking_distance_m: 280,
  },
  {
    venue_key: "stade_de_france",
    salle_name: "Stade de France — Tribune Ouest",
    lat: 48.9243,
    lng: 2.3583,
    ideal_side: "ouest",
    notes_fr: "Dépose côté Porte K/L (ouest) — attention embouteillages RD1 après match.",
    walking_distance_m: 320,
  },
  {
    venue_key: "stade_de_france",
    salle_name: "Stade de France — Tribune Présidentielle",
    lat: 48.9247,
    lng: 2.3601,
    ideal_side: "ouest",
    notes_fr: "Dépose VIP côté ouest — accès filtré, prévoir contrôle d'accès.",
    walking_distance_m: 150,
  },
  {
    venue_key: "roland_garros",
    salle_name: "Roland-Garros — Court Philippe-Chatrier",
    lat: 48.8470,
    lng: 2.2508,
    ideal_side: "est",
    notes_fr: "Dépose porte des Mousquetaires (est) — évite le contournement bois de Boulogne.",
    walking_distance_m: 400,
  },
  {
    venue_key: "roland_garros",
    salle_name: "Roland-Garros — Court Suzanne-Lenglen",
    lat: 48.8463,
    lng: 2.2489,
    ideal_side: "ouest",
    notes_fr: "Dépose porte d'Auteuil (ouest) — plus proche du court Lenglen.",
    walking_distance_m: 320,
  },
  {
    venue_key: "grand_palais",
    salle_name: "Grand Palais",
    lat: 48.8662,
    lng: 2.3125,
    ideal_side: "nord",
    notes_fr: "Dépose avenue Winston Churchill (nord) — dépose/reprise interdite avenue du Général Eisenhower.",
    walking_distance_m: 120,
  },
  {
    venue_key: "la_defense_arena",
    salle_name: "Paris La Défense Arena",
    lat: 48.8958,
    lng: 2.2297,
    ideal_side: "sud",
    notes_fr: "Dépose parvis sud (côté Nanterre-Préfecture) — évite le rond-point saturé côté CNIT.",
    walking_distance_m: 220,
  },
];

// ─── Type d'événement récurrent ─────────────────────────────────────────────
export type RecurringEventType = "foot" | "concert" | "tennis" | "conference";

export interface RecurringEventTemplate {
  key: string;
  name: string;
  venue_key: string;
  zone_id: string;
  event_type: RecurringEventType;
  // Jour de la semaine typique (0=dimanche..6=samedi) — indicatif seulement
  typical_days: number[];
  typical_start_hour: number;
  typical_duration_min: number;
  expected_attendance: number;
  demand_boost: number;
  season_months?: number[]; // mois où l'événement est susceptible d'avoir lieu (ex: Roland-Garros mai-juin)
  notes_fr: string;
}

// ─── Événements récurrents Île-de-France (hardcodés, séparés de la logique) ───
export const RECURRING_IDF_EVENTS: RecurringEventTemplate[] = [
  {
    key: "psg_parc_des_princes",
    name: "Match PSG — Parc des Princes",
    venue_key: "parc_des_princes",
    zone_id: "z_montreuil", // zone VTC existante la plus proche (couverture 93) — le Parc lui-même est hors périmètre zones
    event_type: "foot",
    typical_days: [5, 6, 0], // vendredi, samedi, dimanche (Ligue 1 typique)
    typical_start_hour: 21,
    typical_duration_min: 110,
    expected_attendance: 47000,
    demand_boost: 1.9,
    notes_fr: "Sortie étalée sur 30-45 min post-match, forte demande Porte de Saint-Cloud / Porte d'Auteuil.",
  },
  {
    key: "bercy_spectacle",
    name: "Spectacle / Concert — Accor Arena Bercy",
    venue_key: "bercy",
    zone_id: "z_montreuil", // zone VTC existante la plus proche de Bercy dans le périmètre couvert
    event_type: "concert",
    typical_days: [4, 5, 6],
    typical_start_hour: 20,
    typical_duration_min: 150,
    expected_attendance: 15000,
    demand_boost: 2.1,
    notes_fr: "Sortie groupée immédiate en fin de concert, pic de demande dans les 10-15 min suivant la fin.",
  },
  {
    key: "roland_garros_session",
    name: "Roland-Garros — session courts principaux",
    venue_key: "roland_garros",
    zone_id: "z_montreuil", // fallback zone existante — Roland-Garros hors périmètre géographique des zones 93
    event_type: "tennis",
    typical_days: [0, 1, 2, 3, 4, 5, 6],
    typical_start_hour: 11,
    typical_duration_min: 360,
    expected_attendance: 30000,
    demand_boost: 1.6,
    season_months: [5, 6], // fin mai - début juin
    notes_fr: "Sortie étalée sur plusieurs heures (matches successifs) — pic modéré mais long en fin de journée.",
  },
  {
    key: "la_defense_arena_event",
    name: "Événement — Paris La Défense Arena",
    venue_key: "la_defense_arena",
    zone_id: "z_epinay_gennevilliers", // zone existante la plus proche géographiquement de La Défense
    event_type: "concert",
    typical_days: [4, 5, 6],
    typical_start_hour: 20,
    typical_duration_min: 140,
    expected_attendance: 40000,
    demand_boost: 2.3,
    notes_fr: "Plus grande salle indoor d'Europe — sortie massive, forte tension VTC/RER A pendant 20-30 min.",
  },
];
