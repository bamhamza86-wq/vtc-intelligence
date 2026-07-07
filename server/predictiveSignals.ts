/**
 * predictiveSignals.ts — Couche Prédictive Signaux (rapport.md §3, §8, §9)
 * ─────────────────────────────────────────────────────────────────────────────
 * Moteur additif regroupant les leviers de prédiction de demande micro-locale,
 * l'arbitrage temporel (time-of-day) et les signaux macro (grèves, événements).
 *
 * Calendriers 100% hardcodés (vacances scolaires 2026-2027, événements IDF 2026,
 * jours fériés 2026) — aucune dépendance réseau, aucun npm supplémentaire.
 *
 * Réutilise :
 *   - weatherService.ts  (météo temps réel + boost)
 *   - sncfService.ts     (signaux gares/RER heuristiques)
 *   - storage.ts (sqlite) (historique des courses `rides` pour corrélations perso)
 *
 * Toutes les fonctions sont synchrones sauf mention contraire (I/O réseau via
 * weatherService uniquement, déjà cache TTL 15 min côté service).
 */

import { sqlite } from "./storage";
import { getCachedWeather, getCurrentWeather, type WeatherCondition } from "./weatherService";

// ═══════════════════════════════════════════════════════════════════════════
// 0. TABLE SQLITE — major_events_2026 (levier 9.2)
// ═══════════════════════════════════════════════════════════════════════════

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS major_events_2026 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    zone_hint TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    expected_impact TEXT NOT NULL,
    demand_boost_pct INTEGER NOT NULL DEFAULT 20,
    source_url TEXT
  );
`);

function seedMajorEvents2026(): void {
  const count = (sqlite.prepare(`SELECT COUNT(*) as c FROM major_events_2026`).get() as any).c;
  if (count > 0) return;

  const insert = sqlite.prepare(
    `INSERT INTO major_events_2026 (name, category, zone_hint, start_date, end_date, expected_impact, demand_boost_pct, source_url)
     VALUES (@name, @category, @zone_hint, @start_date, @end_date, @expected_impact, @demand_boost_pct, @source_url)`
  );

  const events = [
    {
      name: "Roland-Garros 2026",
      category: "sport",
      zone_hint: "Porte d'Auteuil / Stade Roland-Garros (16e)",
      start_date: "2026-05-25",
      end_date: "2026-06-09",
      expected_impact: "Forte affluence quotidienne, pics fin de journée à la sortie des sessions",
      demand_boost_pct: 40,
      source_url: "https://www.rolandgarros.com/fr-fr",
    },
    {
      name: "Fashion Week Haute Couture (Janvier)",
      category: "mode",
      zone_hint: "Triangle d'or / Paris centre (8e, 1er, 16e)",
      start_date: "2026-01-19",
      end_date: "2026-01-23",
      expected_impact: "Clientèle premium, courses longues et tarifs élevés",
      demand_boost_pct: 35,
      source_url: "https://www.fhcm.paris/fr/",
    },
    {
      name: "Salon de l'Agriculture 2026",
      category: "salon",
      zone_hint: "Paris Expo Porte de Versailles (15e)",
      start_date: "2026-02-21",
      end_date: "2026-03-01",
      expected_impact: "~700 000 visiteurs, forte densité VTC concurrente",
      demand_boost_pct: 50,
      source_url: "https://expo.paris/salon/salon-international-de-l-agriculture-2026",
    },
    {
      name: "Fashion Week Prêt-à-Porter (Février-Mars)",
      category: "mode",
      zone_hint: "Paris centre / Carrousel du Louvre",
      start_date: "2026-02-27",
      end_date: "2026-03-10",
      expected_impact: "Clientèle premium internationale, courses aéroport fréquentes",
      demand_boost_pct: 35,
      source_url: "https://www.fhcm.paris/fr/",
    },
    {
      name: "Foire de Paris",
      category: "salon",
      zone_hint: "Paris Expo Porte de Versailles (15e)",
      start_date: "2026-04-30",
      end_date: "2026-05-10",
      expected_impact: "Grand public, forte affluence week-ends",
      demand_boost_pct: 30,
      source_url: "https://expo.paris/salon/foire-de-paris-2027-paris-expo-porte-de-versailles",
    },
    {
      name: "Fashion Week Haute Couture (Juillet)",
      category: "mode",
      zone_hint: "Triangle d'or / Paris centre (8e, 1er, 16e)",
      start_date: "2026-07-06",
      end_date: "2026-07-10",
      expected_impact: "Clientèle premium, courses longues et tarifs élevés",
      demand_boost_pct: 35,
      source_url: "https://www.fhcm.paris/fr/",
    },
    {
      name: "Fashion Week Prêt-à-Porter (Septembre)",
      category: "mode",
      zone_hint: "Paris centre / Carrousel du Louvre",
      start_date: "2026-09-29",
      end_date: "2026-10-07",
      expected_impact: "Clientèle premium internationale, courses aéroport fréquentes",
      demand_boost_pct: 35,
      source_url: "https://www.fhcm.paris/fr/",
    },
    {
      name: "Mondial de l'Auto 2026",
      category: "salon",
      zone_hint: "Paris Expo Porte de Versailles (15e)",
      start_date: "2026-10-12",
      end_date: "2026-10-18",
      expected_impact: "Grand public, forte affluence week-ends",
      demand_boost_pct: 35,
      source_url: "https://expo.paris/salon/mondial-de-l-auto-2026",
    },
    {
      name: "NRJ Music Awards 2026",
      category: "spectacle",
      zone_hint: "Zone concert (variable selon lieu annoncé)",
      start_date: "2026-11-13",
      end_date: "2026-11-13",
      expected_impact: "Pic ponctuel très fort en fin de soirée à la sortie",
      demand_boost_pct: 45,
      source_url: "https://www.nrj.fr/nrj-music-awards",
    },
    {
      name: "Événements JO 2024 — héritage (anniversaires / animations Paris 2026)",
      category: "heritage_jo",
      zone_hint: "Sites héritage JO (Saint-Denis, Stade de France, Seine-Saint-Denis)",
      start_date: "2026-07-26",
      end_date: "2026-08-11",
      expected_impact: "Animations commémoratives ponctuelles, affluence modérée sur sites héritage",
      demand_boost_pct: 20,
      source_url: "https://www.paris2024.org/fr/heritage/",
    },
    {
      name: "Réveillon de Noël",
      category: "fetes",
      zone_hint: "Paris centre / gares / centres commerciaux",
      start_date: "2026-12-24",
      end_date: "2026-12-25",
      expected_impact: "Demande nocturne exceptionnelle, tarifs majorés potentiels",
      demand_boost_pct: 60,
      source_url: "",
    },
    {
      name: "Réveillon du Nouvel An",
      category: "fetes",
      zone_hint: "Paris centre (Champs-Élysées, Trocadéro) / gares",
      start_date: "2026-12-31",
      end_date: "2027-01-01",
      expected_impact: "Pic de demande nocturne le plus fort de l'année, majoration forte",
      demand_boost_pct: 80,
      source_url: "",
    },
  ];

  const insertMany = sqlite.transaction((rows: typeof events) => {
    for (const e of rows) insert.run(e);
  });
  insertMany(events);
}
seedMajorEvents2026();

export interface MajorEvent2026 {
  id: number;
  name: string;
  category: string;
  zone_hint: string;
  start_date: string;
  end_date: string;
  expected_impact: string;
  demand_boost_pct: number;
  source_url: string | null;
}

export function getMajorEvents2026(): MajorEvent2026[] {
  return sqlite.prepare(`SELECT * FROM major_events_2026 ORDER BY start_date ASC`).all() as MajorEvent2026[];
}

export function getNextMajorEvent(fromDate?: Date): MajorEvent2026 | null {
  const now = fromDate ?? new Date();
  const iso = now.toISOString().slice(0, 10);
  const row = sqlite
    .prepare(`SELECT * FROM major_events_2026 WHERE end_date >= ? ORDER BY start_date ASC LIMIT 1`)
    .get(iso) as MajorEvent2026 | undefined;
  return row ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. CALENDRIER FÉRIÉS 2026
// ═══════════════════════════════════════════════════════════════════════════

export const FERIES_2026: { date: string; label: string }[] = [
  { date: "2026-01-01", label: "Jour de l'An" },
  { date: "2026-04-06", label: "Lundi de Pâques" },
  { date: "2026-05-01", label: "Fête du Travail" },
  { date: "2026-05-08", label: "Victoire 1945" },
  { date: "2026-05-14", label: "Ascension" },
  { date: "2026-05-25", label: "Lundi de Pentecôte" },
  { date: "2026-07-14", label: "Fête Nationale" },
  { date: "2026-08-15", label: "Assomption" },
  { date: "2026-11-01", label: "Toussaint" },
  { date: "2026-11-11", label: "Armistice 1918" },
  { date: "2026-12-25", label: "Noël" },
];

export function isFerie(dateStr: string): { isFerie: boolean; label: string | null } {
  const f = FERIES_2026.find((x) => x.date === dateStr);
  return { isFerie: !!f, label: f?.label ?? null };
}

export function getNextFerie(fromDate?: Date): { date: string; label: string; days_until: number } | null {
  const now = fromDate ?? new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const upcoming = FERIES_2026.filter((f) => f.date >= todayIso).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length === 0) return null;
  const next = upcoming[0];
  const days = Math.round((new Date(next.date + "T00:00:00").getTime() - new Date(todayIso + "T00:00:00").getTime()) / 86400000);
  return { ...next, days_until: days };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. VACANCES SCOLAIRES FR 2026-2027 (Zones A / B / C — Paris = Zone C)
// ═══════════════════════════════════════════════════════════════════════════

export type ZoneScolaire = "A" | "B" | "C";

export interface VacancesPeriod {
  name: string;
  zones: ZoneScolaire[];
  start_date: string; // ISO, inclusif
  end_date: string;   // ISO, inclusif
}

// Zone A : Besançon, Bordeaux, Clermont-Ferrand, Dijon, Grenoble, Limoges, Lyon, Poitiers
// Zone B : Aix-Marseille, Amiens, Caen, Lille, Nancy-Metz, Nantes, Nice, Normandie, Orléans-Tours,
//          Reims, Rennes, Strasbourg
// Zone C : Créteil, Montpellier, Paris, Toulouse, Versailles  → Paris/IDF = Zone C
export const VACANCES_SCOLAIRES_2026_2027: VacancesPeriod[] = [
  // ── Vacances d'hiver 2026 ──
  { name: "Vacances d'hiver", zones: ["A"], start_date: "2026-02-07", end_date: "2026-02-23" },
  { name: "Vacances d'hiver", zones: ["C"], start_date: "2026-02-14", end_date: "2026-03-02" },
  { name: "Vacances d'hiver", zones: ["B"], start_date: "2026-02-21", end_date: "2026-03-09" },
  // ── Vacances de printemps 2026 ──
  { name: "Vacances de printemps", zones: ["A"], start_date: "2026-04-11", end_date: "2026-04-27" },
  { name: "Vacances de printemps", zones: ["C"], start_date: "2026-04-18", end_date: "2026-05-04" },
  { name: "Vacances de printemps", zones: ["B"], start_date: "2026-04-25", end_date: "2026-05-11" },
  // ── Vacances d'été 2026 (toutes zones identiques) ──
  { name: "Vacances d'été", zones: ["A", "B", "C"], start_date: "2026-07-04", end_date: "2026-09-01" },
  // ── Vacances de la Toussaint 2026 (toutes zones identiques) ──
  { name: "Vacances de la Toussaint", zones: ["A", "B", "C"], start_date: "2026-10-17", end_date: "2026-11-02" },
  // ── Vacances de Noël 2026 (toutes zones identiques) ──
  { name: "Vacances de Noël", zones: ["A", "B", "C"], start_date: "2026-12-19", end_date: "2027-01-04" },
  // ── Vacances d'hiver 2027 (démarrage anticipé pour couverture) ──
  { name: "Vacances d'hiver", zones: ["A"], start_date: "2027-02-06", end_date: "2027-02-22" },
  { name: "Vacances d'hiver", zones: ["C"], start_date: "2027-02-13", end_date: "2027-03-01" },
  { name: "Vacances d'hiver", zones: ["B"], start_date: "2027-02-20", end_date: "2027-03-08" },
];

export const ZONE_C_ACADEMIES = ["Créteil", "Montpellier", "Paris", "Toulouse", "Versailles"];
export const ZONE_A_ACADEMIES = ["Besançon", "Bordeaux", "Clermont-Ferrand", "Dijon", "Grenoble", "Limoges", "Lyon", "Poitiers"];
export const ZONE_B_ACADEMIES = [
  "Aix-Marseille", "Amiens", "Caen", "Lille", "Nancy-Metz", "Nantes", "Nice", "Normandie", "Orléans-Tours", "Reims", "Rennes", "Strasbourg",
];

// Zone opérée par l'app = Île-de-France → Zone C
export const DRIVER_ZONE_SCOLAIRE: ZoneScolaire = "C";

export function isSchoolHoliday(dateStr: string, zone: ZoneScolaire = DRIVER_ZONE_SCOLAIRE): VacancesPeriod | null {
  const match = VACANCES_SCOLAIRES_2026_2027.find(
    (p) => p.zones.includes(zone) && dateStr >= p.start_date && dateStr <= p.end_date
  );
  return match ?? null;
}

export function getSchoolHolidaysImpact(dateStr: string): {
  is_holiday: boolean;
  period_name: string | null;
  zone: ZoneScolaire;
  impact_bureau_pct: number;   // impact zones affaires (négatif = baisse)
  impact_touristique_pct: number; // impact zones touristiques/gares (positif = hausse)
  impact_aeroport_pct: number;    // impact zones aéroport (positif = hausse pendant grand départ)
  message_fr: string;
} {
  const holiday = isSchoolHoliday(dateStr);
  if (!holiday) {
    return {
      is_holiday: false,
      period_name: null,
      zone: DRIVER_ZONE_SCOLAIRE,
      impact_bureau_pct: 0,
      impact_touristique_pct: 0,
      impact_aeroport_pct: 0,
      message_fr: "Période scolaire normale — pas d'effet vacances.",
    };
  }
  // Début/fin de période (±3 jours) = pic "grand départ" sur zones aéroport/gares
  const startDelta = Math.abs((new Date(dateStr).getTime() - new Date(holiday.start_date).getTime()) / 86400000);
  const endDelta = Math.abs((new Date(holiday.end_date).getTime() - new Date(dateStr).getTime()) / 86400000);
  const isGrandDepart = startDelta <= 3 || endDelta <= 3;

  return {
    is_holiday: true,
    period_name: holiday.name,
    zone: DRIVER_ZONE_SCOLAIRE,
    impact_bureau_pct: -15,
    impact_touristique_pct: 15,
    impact_aeroport_pct: isGrandDepart ? 30 : 12,
    message_fr: isGrandDepart
      ? `${holiday.name} (Zone C, Paris) — période de grand départ : flux gares/aéroports amplifié (+30%), zones affaires calmes (-15%).`
      : `${holiday.name} (Zone C, Paris) en cours — zones affaires calmes (-15%), zones touristiques/gares actives (+15%).`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3.1 MODÈLE MÉTÉO-DEMANDE PERSONNALISÉ
// ═══════════════════════════════════════════════════════════════════════════

export interface WeatherDemandModel {
  current_weather: WeatherCondition | null;
  personal_rain_uplift_pct: number | null; // corrélation perso pluie vs €/h
  personal_sample_size: number;
  market_rain_uplift_pct: number; // valeur de référence marché si pas assez de données perso
  predicted_uplift_pct: number;   // valeur retenue (perso si dispo, sinon marché)
  confidence: "faible" | "moyenne" | "haute";
  message_fr: string;
}

// Impact marché de référence : +15 à 25% de courses en cas de pluie (rapport §3.1)
const MARKET_RAIN_UPLIFT_PCT = 20;

/**
 * Calcule la corrélation historique personnelle météo (pluie) vs €/h à partir
 * de la colonne `rides.weather` (texte libre stocké à la course) et
 * `rides.hourly_rate`. Nécessite un minimum d'échantillons pour être fiable.
 */
export function computeWeatherDemandModel(): WeatherDemandModel {
  const current = getCachedWeather();

  const rainyRows = sqlite
    .prepare(
      `SELECT hourly_rate FROM rides WHERE weather IS NOT NULL AND (
         LOWER(weather) LIKE '%pluie%' OR LOWER(weather) LIKE '%averse%' OR LOWER(weather) LIKE '%orage%' OR LOWER(weather) LIKE '%bruine%'
       )`
    )
    .all() as { hourly_rate: number }[];

  const dryRows = sqlite
    .prepare(
      `SELECT hourly_rate FROM rides WHERE weather IS NULL OR NOT (
         LOWER(weather) LIKE '%pluie%' OR LOWER(weather) LIKE '%averse%' OR LOWER(weather) LIKE '%orage%' OR LOWER(weather) LIKE '%bruine%'
       )`
    )
    .all() as { hourly_rate: number }[];

  const MIN_SAMPLES = 8;
  let personalUplift: number | null = null;
  let confidence: "faible" | "moyenne" | "haute" = "faible";

  if (rainyRows.length >= MIN_SAMPLES && dryRows.length >= MIN_SAMPLES) {
    const avgRain = rainyRows.reduce((s, r) => s + r.hourly_rate, 0) / rainyRows.length;
    const avgDry = dryRows.reduce((s, r) => s + r.hourly_rate, 0) / dryRows.length;
    if (avgDry > 0) {
      personalUplift = Math.round(((avgRain - avgDry) / avgDry) * 1000) / 10;
      confidence = rainyRows.length >= 25 && dryRows.length >= 25 ? "haute" : "moyenne";
    }
  }

  const predicted = personalUplift ?? MARKET_RAIN_UPLIFT_PCT;

  return {
    current_weather: current,
    personal_rain_uplift_pct: personalUplift,
    personal_sample_size: rainyRows.length,
    market_rain_uplift_pct: MARKET_RAIN_UPLIFT_PCT,
    predicted_uplift_pct: predicted,
    confidence,
    message_fr:
      personalUplift !== null
        ? `Sur votre historique, la pluie augmente votre €/h de ${personalUplift > 0 ? "+" : ""}${personalUplift}% (${rainyRows.length} courses pluie analysées).`
        : `Pas encore assez de données personnelles (${rainyRows.length}/${MIN_SAMPLES} courses pluie) — estimation marché retenue : +${MARKET_RAIN_UPLIFT_PCT}%.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3.2 CORRÉLATION JOURS DE PAIE
// ═══════════════════════════════════════════════════════════════════════════

export interface PaydayEffect {
  date: string;
  day_of_month: number;
  is_payday_window: boolean;
  window_label: string | null;
  boost_pct: number;
  message_fr: string;
}

/**
 * Fenêtres de paie : 25-30 du mois (salaires versés en fin de mois, majorité des
 * salariés) et 5-10 (SMIC / certaines conventions versant en tout début de mois).
 * Règle calendaire simple, pas de ML nécessaire (rapport §3.2, effort S).
 */
export function computePaydayEffect(dateStr?: string): PaydayEffect {
  const date = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
  const day = date.getDate();
  const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

  const isEndOfMonthWindow = day >= 25 && day <= lastDayOfMonth;
  const isStartOfMonthWindow = day >= 5 && day <= 10;

  let windowLabel: string | null = null;
  let boost = 0;
  if (isEndOfMonthWindow) {
    windowLabel = "Fin de mois (25-30) — versement salaires";
    boost = 5; // +3 à 6%/jour (rapport §3.2)
  } else if (isStartOfMonthWindow) {
    windowLabel = "Début de mois (5-10) — versement SMIC / prestations sociales";
    boost = 4;
  }

  return {
    date: date.toISOString().slice(0, 10),
    day_of_month: day,
    is_payday_window: isEndOfMonthWindow || isStartOfMonthWindow,
    window_label: windowLabel,
    boost_pct: boost,
    message_fr: windowLabel
      ? `${windowLabel} : pic de consommation attendu, +${boost}% de demande estimée.`
      : "Pas de fenêtre de paie identifiée aujourd'hui — demande neutre sur ce facteur.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3.4 AGRÉGATS MICRO-LOCAUX (hôtels, hôpitaux, cinémas, bureaux)
// ═══════════════════════════════════════════════════════════════════════════

export interface LocalHotspot {
  type: "hotel" | "hopital" | "cinema" | "bureau";
  label: string;
  zone_hint: string;
  peak_hours: number[]; // heures CEST où le hotspot est actif
  is_active_now: boolean;
  boost_pct: number;
  message_fr: string;
}

function currentCestHourLocal(): number {
  return (new Date().getUTCHours() + 2) % 24;
}

const LOCAL_HOTSPOTS_TEMPLATE: Omit<LocalHotspot, "is_active_now">[] = [
  {
    type: "hotel",
    label: "Checkout hôtels",
    zone_hint: "Hôtels proches gares / aéroports (Saint-Denis, CDG, Orly)",
    peak_hours: [10, 11, 12],
    boost_pct: 18,
    message_fr: "Créneau de checkout hôtelier (10h-12h) : forte probabilité de courses vers gares/aéroports.",
  },
  {
    type: "hopital",
    label: "Heures de visite hôpitaux",
    zone_hint: "CHU / cliniques (Saint-Denis, Bobigny, Aulnay)",
    peak_hours: [13, 14, 15, 18, 19, 20],
    boost_pct: 10,
    message_fr: "Heures de visite hospitalières : flux régulier de courses courtes autour des établissements de santé.",
  },
  {
    type: "cinema",
    label: "Fin de séance cinéma",
    zone_hint: "Multiplexes (centres commerciaux 93)",
    peak_hours: [22, 23, 0],
    boost_pct: 15,
    message_fr: "Fin des séances du soir : pic de demande ponctuel aux abords des cinémas.",
  },
  {
    type: "bureau",
    label: "Heures de pointe bureaux",
    zone_hint: "Zones tertiaires / La Plaine Saint-Denis",
    peak_hours: [8, 9, 18, 19],
    boost_pct: 20,
    message_fr: "Heure de pointe bureaux : forte densité de trajets domicile-travail.",
  },
];

export function getLocalHotspots(hour?: number): LocalHotspot[] {
  const h = hour ?? currentCestHourLocal();
  return LOCAL_HOTSPOTS_TEMPLATE.map((t) => ({
    ...t,
    is_active_now: t.peak_hours.includes(h),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 9.3 ALERTES TRAFIC RÉCURRENTES
// ═══════════════════════════════════════════════════════════════════════════

export interface TrafficPattern {
  id: string;
  label: string;
  zone_hint: string;
  peak_hours_weekday: number[];
  severity: "moderee" | "forte" | "severe";
  advice_fr: string;
  is_active_now: boolean;
}

const TRAFFIC_PATTERNS_TEMPLATE: Omit<TrafficPattern, "is_active_now">[] = [
  {
    id: "a86",
    label: "A86 — bouchons récurrents",
    zone_hint: "A86 (tronçons Nord / Est 93)",
    peak_hours_weekday: [7, 8, 9, 17, 18, 19],
    severity: "severe",
    advice_fr: "A86 chargée aux heures de pointe — privilégier des trajets courts locaux plutôt que de s'y engager.",
  },
  {
    id: "a6a",
    label: "A6a — bouchons récurrents",
    zone_hint: "A6a (accès Porte d'Orléans / Sud parisien)",
    peak_hours_weekday: [7, 8, 18, 19],
    severity: "forte",
    advice_fr: "A6a saturée en heures de pointe — éviter pour les courses vers le Sud pendant ces créneaux.",
  },
  {
    id: "porte_bagnolet",
    label: "Porte de Bagnolet — bouchons récurrents",
    zone_hint: "Périphérique / Porte de Bagnolet",
    peak_hours_weekday: [8, 9, 18, 19, 20],
    severity: "forte",
    advice_fr: "Porte de Bagnolet régulièrement saturée en soirée — anticiper un détour ou attendre la fin du pic.",
  },
];

export function getTrafficPatterns(hour?: number, isWeekend?: boolean): TrafficPattern[] {
  const h = hour ?? currentCestHourLocal();
  const weekend = isWeekend ?? [0, 6].includes(new Date().getDay());
  return TRAFFIC_PATTERNS_TEMPLATE.map((t) => ({
    ...t,
    is_active_now: !weekend && t.peak_hours_weekday.includes(h),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 9.1 CALENDRIER GRÈVES 48-72H (préavis SNCF/RATP)
// ═══════════════════════════════════════════════════════════════════════════

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS strike_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator TEXT NOT NULL,
    line_or_scope TEXT NOT NULL,
    notice_type TEXT NOT NULL DEFAULT 'ponctuelle',
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT (datetime('now')),
    impact_desc TEXT NOT NULL,
    source_url TEXT
  );
`);

export interface StrikeNotice {
  id: number;
  operator: string;
  line_or_scope: string;
  notice_type: "ponctuelle" | "reconductible";
  start_date: string;
  end_date: string;
  published_at: string;
  impact_desc: string;
  source_url: string | null;
  hours_until_start: number;
  is_within_anticipation_window: boolean; // fenêtre 48-72h
}

/**
 * getStrikesForecast — Lit les préavis de grève enregistrés (table strike_notices,
 * alimentable manuellement/par cron) dans la fenêtre d'anticipation 48-72h.
 * Ne fabrique aucune donnée si la table est vide (pas de préavis factice).
 */
export function getStrikesForecast(): { notices: StrikeNotice[]; has_upcoming: boolean; max_boost_pct: number } {
  const rows = sqlite
    .prepare(`SELECT * FROM strike_notices WHERE end_date >= date('now') ORDER BY start_date ASC`)
    .all() as any[];

  const now = Date.now();
  const notices: StrikeNotice[] = rows.map((r) => {
    const startMs = new Date(r.start_date + "T00:00:00").getTime();
    const hoursUntil = Math.round((startMs - now) / 3600000);
    return {
      id: r.id,
      operator: r.operator,
      line_or_scope: r.line_or_scope,
      notice_type: r.notice_type,
      start_date: r.start_date,
      end_date: r.end_date,
      published_at: r.published_at,
      impact_desc: r.impact_desc,
      source_url: r.source_url,
      hours_until_start: hoursUntil,
      is_within_anticipation_window: hoursUntil >= 0 && hoursUntil <= 72,
    };
  });

  const maxBoost = notices.some((n) => n.notice_type === "ponctuelle" && n.is_within_anticipation_window)
    ? 30
    : notices.some((n) => n.is_within_anticipation_window)
    ? 20
    : 0;

  return { notices, has_upcoming: notices.length > 0, max_boost_pct: maxBoost };
}

export function addStrikeNotice(input: {
  operator: string;
  line_or_scope: string;
  notice_type?: "ponctuelle" | "reconductible";
  start_date: string;
  end_date: string;
  impact_desc: string;
  source_url?: string;
}): number {
  const stmt = sqlite.prepare(
    `INSERT INTO strike_notices (operator, line_or_scope, notice_type, start_date, end_date, impact_desc, source_url)
     VALUES (@operator, @line_or_scope, @notice_type, @start_date, @end_date, @impact_desc, @source_url)`
  );
  const info = stmt.run({
    operator: input.operator,
    line_or_scope: input.line_or_scope,
    notice_type: input.notice_type ?? "ponctuelle",
    start_date: input.start_date,
    end_date: input.end_date,
    impact_desc: input.impact_desc,
    source_url: input.source_url ?? null,
  });
  return Number(info.lastInsertRowid);
}

// ═══════════════════════════════════════════════════════════════════════════
// 8.1 SHIFTS OPTIMAUX RECOMMANDÉS
// ═══════════════════════════════════════════════════════════════════════════

export interface OptimalShift {
  id: string;
  label: string;
  start_hour: number;
  end_hour: number;
  zone_hint: string;
  applicable_days: "tous" | "semaine" | "weekend";
  rationale_fr: string;
}

export const OPTIMAL_SHIFTS: OptimalShift[] = [
  {
    id: "matin_aeroport",
    label: "Matin — Aéroport",
    start_hour: 6,
    end_hour: 9,
    zone_hint: "CDG / Orly",
    applicable_days: "tous",
    rationale_fr: "Premiers vols du matin, forte demande de courses longues vers/depuis les aéroports.",
  },
  {
    id: "midi_bureau",
    label: "Midi — Zones bureaux",
    start_hour: 12,
    end_hour: 14,
    zone_hint: "Zones tertiaires (La Plaine Saint-Denis, Bobigny)",
    applicable_days: "semaine",
    rationale_fr: "Pause déjeuner : rotations courtes mais fréquentes autour des pôles d'affaires.",
  },
  {
    id: "soir_sortie",
    label: "Soir — Sorties",
    start_hour: 18,
    end_hour: 21,
    zone_hint: "Centres commerciaux, restaurants, gares",
    applicable_days: "tous",
    rationale_fr: "Retour domicile-travail puis début de soirée : double vague de demande.",
  },
  {
    id: "nuit_weekend",
    label: "Nuit — Week-end",
    start_hour: 22,
    end_hour: 3,
    zone_hint: "Centre-ville / sorties de soirée",
    applicable_days: "weekend",
    rationale_fr: "Majoration nocturne + forte demande de sorties le vendredi/samedi soir.",
  },
];

export function getOptimalShifts(dayOfWeek?: number): OptimalShift[] {
  const dow = dayOfWeek ?? new Date().getDay(); // 0=dimanche..6=samedi
  const isWeekend = dow === 0 || dow === 5 || dow === 6; // vendredi soir inclus dans logique week-end nocturne
  return OPTIMAL_SHIFTS.filter((s) => {
    if (s.applicable_days === "tous") return true;
    if (s.applicable_days === "weekend") return isWeekend;
    if (s.applicable_days === "semaine") return !isWeekend;
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 8.2 JOURS OFF RECOMMANDÉS
// ═══════════════════════════════════════════════════════════════════════════

export interface RestDayRecommendation {
  day_label: string;
  day_of_week: number; // 0=dimanche..6=samedi
  period: "matin" | "apres_midi" | "soir" | "journee";
  reason_fr: string;
  personal_data_backed: boolean;
}

// Créneaux structurellement creux (rapport §8.2, §8.5) : dimanche matin, mardi
// après-midi. Base de connaissance métier, affinée si historique personnel dispo.
const REST_DAYS_BASE: RestDayRecommendation[] = [
  {
    day_label: "Dimanche matin",
    day_of_week: 0,
    period: "matin",
    reason_fr: "Créneau structurellement calme (peu de trajets domicile-travail, sorties tardives la veille).",
    personal_data_backed: false,
  },
  {
    day_label: "Mardi après-midi",
    day_of_week: 2,
    period: "apres_midi",
    reason_fr: "Jour le plus faible de la semaine selon les moyennes du secteur VTC.",
    personal_data_backed: false,
  },
];

export function getRestDaysRecommendation(): { recommendations: RestDayRecommendation[]; based_on_personal_history: boolean } {
  // Tentative d'enrichissement avec l'historique personnel (rides.timestamp + hourly_rate)
  const rows = sqlite
    .prepare(
      `SELECT timestamp, hourly_rate FROM rides WHERE timestamp >= datetime('now', '-60 days')`
    )
    .all() as { timestamp: string; hourly_rate: number }[];

  if (rows.length < 20) {
    return { recommendations: REST_DAYS_BASE, based_on_personal_history: false };
  }

  // Moyenne €/h par (jour de semaine, demi-journée)
  const buckets: Record<string, { sum: number; n: number }> = {};
  for (const r of rows) {
    const d = new Date(r.timestamp);
    const dow = d.getDay();
    const hour = d.getHours();
    const period: "matin" | "apres_midi" | "soir" = hour < 12 ? "matin" : hour < 18 ? "apres_midi" : "soir";
    const key = `${dow}_${period}`;
    if (!buckets[key]) buckets[key] = { sum: 0, n: 0 };
    buckets[key].sum += r.hourly_rate;
    buckets[key].n += 1;
  }

  const entries = Object.entries(buckets)
    .filter(([, v]) => v.n >= 3)
    .map(([key, v]) => ({ key, avg: v.sum / v.n, n: v.n }));

  if (entries.length < 3) {
    return { recommendations: REST_DAYS_BASE, based_on_personal_history: false };
  }

  entries.sort((a, b) => a.avg - b.avg);
  const worst = entries.slice(0, 2);
  const DAY_LABELS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const PERIOD_LABELS: Record<string, RestDayRecommendation["period"]> = {
    matin: "matin",
    apres_midi: "apres_midi",
    soir: "soir",
  };

  const personalized: RestDayRecommendation[] = worst.map(({ key, avg, n }) => {
    const [dowStr, period] = key.split("_");
    const dow = parseInt(dowStr, 10);
    return {
      day_label: `${DAY_LABELS[dow].charAt(0).toUpperCase()}${DAY_LABELS[dow].slice(1)} ${period === "matin" ? "matin" : period === "apres_midi" ? "après-midi" : "soir"}`,
      day_of_week: dow,
      period: PERIOD_LABELS[period] ?? "journee",
      reason_fr: `Sur vos ${n} dernières courses de ce créneau, votre €/h moyen (${Math.round(avg * 100) / 100}€/h) est parmi les plus faibles de la semaine.`,
      personal_data_backed: true,
    };
  });

  return { recommendations: personalized, based_on_personal_history: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 8.3 PLANNING HEBDOMADAIRE SUGGÉRÉ
// ═══════════════════════════════════════════════════════════════════════════

export interface WeeklyPlanDay {
  date: string;
  day_label: string;
  is_school_holiday: boolean;
  is_ferie: boolean;
  ferie_label: string | null;
  recommended_shifts: OptimalShift[];
  rest_periods: RestDayRecommendation[];
  payday_effect: PaydayEffect;
  note_fr: string;
}

const DAY_LABELS_FR = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];

export function getWeeklyPlan(startDate?: string): { days: WeeklyPlanDay[]; summary_fr: string } {
  const start = startDate ? new Date(startDate + "T00:00:00") : new Date();
  const { recommendations: restRecs } = getRestDaysRecommendation();

  const days: WeeklyPlanDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    const ferie = isFerie(iso);
    const holiday = isSchoolHoliday(iso);
    const shifts = getOptimalShifts(dow);
    const restForDay = restRecs.filter((r) => r.day_of_week === dow);
    const payday = computePaydayEffect(iso);

    let note = "";
    if (ferie.isFerie) note = `Jour férié (${ferie.label}) : demande atypique, souvent proche d'un dimanche.`;
    else if (holiday) note = `${holiday.name} en cours (Zone C) : zones affaires calmes, gares/aéroports actifs.`;
    else if (payday.is_payday_window) note = payday.message_fr;
    else note = "Journée standard.";

    days.push({
      date: iso,
      day_label: DAY_LABELS_FR[dow],
      is_school_holiday: !!holiday,
      is_ferie: ferie.isFerie,
      ferie_label: ferie.label,
      recommended_shifts: shifts,
      rest_periods: restForDay,
      payday_effect: payday,
      note_fr: note,
    });
  }

  return {
    days,
    summary_fr: "Semaine type basée sur les shifts optimaux (aéroport matin, bureaux midi, sorties soir, nuit week-end) et vos créneaux creux identifiés.",
  };
}
