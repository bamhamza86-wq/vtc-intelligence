/**
 * specialModes.ts — Détection automatique des modes spéciaux (rapport.md §22)
 * ─────────────────────────────────────────────────────────────────────────────
 * Détecte les modes 22.1 à 22.6 à partir des signaux déjà disponibles
 * (météo, grèves, calendrier vacances/fêtes, jour de semaine) et retourne
 * pour chacun des recommandations concrètes en français.
 *
 * Aucune donnée n'est inventée : chaque mode se déclenche sur un seuil ou une
 * règle calendaire explicite, sinon `active: false`.
 */

import { getCachedWeather } from "./weatherService";
import {
  getStrikesForecast,
  isSchoolHoliday,
  getSchoolHolidaysImpact,
  isFerie,
} from "./predictiveSignals";

export type SpecialModeId =
  | "canicule"
  | "greve"
  | "fetes"
  | "ramadan"
  | "vacances"
  | "weekend";

export interface SpecialMode {
  id: SpecialModeId;
  active: boolean;
  label: string;
  severity: "info" | "attention" | "urgent";
  recommendations_fr: string[];
  message_fr: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 22.1 MODE CANICULE
// ═══════════════════════════════════════════════════════════════════════════
// Seuil : pas de température directe exposée par weatherService (Open-Meteo
// "current" ne remonte que precipitation/weathercode/windspeed ici) → on
// utilise un seuil saisonnier (juin-août) combiné à l'absence de précipitation
// comme proxy raisonnable, documenté comme estimation.
function detectCanicule(): SpecialMode {
  const month = new Date().getMonth() + 1; // 1-12
  const weather = getCachedWeather();
  const isSummerWindow = month >= 6 && month <= 8;
  const noPrecipitation = !weather || weather.precipitation_mm === 0;
  const active = isSummerWindow && noPrecipitation;

  return {
    id: "canicule",
    active,
    label: "Mode canicule",
    severity: active ? "attention" : "info",
    recommendations_fr: active
      ? [
          "Hydratez-vous régulièrement et faites des pauses à l'ombre entre les courses.",
          "Vérifiez la climatisation du véhicule avant chaque prise en charge.",
          "Privilégiez les zones ombragées (parcs, avenues arborées) pour l'attente entre courses.",
          "La demande peut baisser en pleine journée (chaleur) et remonter en soirée : ajustez vos horaires.",
        ]
      : [],
    message_fr: active
      ? "Conditions estivales sans précipitation détectées — vigilance chaleur recommandée."
      : "Pas de conditions de canicule détectées actuellement.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 22.2 MODE GRÈVE
// ═══════════════════════════════════════════════════════════════════════════
function detectGreve(): SpecialMode {
  const forecast = getStrikesForecast();
  const activeNotice = forecast.notices.find((n) => n.is_within_anticipation_window);
  const active = !!activeNotice;

  return {
    id: "greve",
    active,
    label: "Mode grève",
    severity: active ? "urgent" : "info",
    recommendations_fr: active
      ? [
          `Perturbation ${activeNotice!.operator} (${activeNotice!.line_or_scope}) : privilégiez les zones desservies par les lignes impactées.`,
          "Anticipez une hausse ponctuelle de +20 à +40% de la demande sur les zones concernées.",
          activeNotice!.notice_type === "reconductible"
            ? "Grève reconductible : impact étalé mais incertain, ne présumez pas de sa durée totale."
            : "Grève ponctuelle : fenêtre de sur-demande probablement courte et intense.",
          "Restez prudent sur les temps de trajet (report massif vers la route).",
        ]
      : [],
    message_fr: active
      ? `Préavis de grève actif : ${activeNotice!.impact_desc}`
      : "Aucun préavis de grève dans la fenêtre d'anticipation 48-72h.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 22.3 MODE FÊTES DE FIN D'ANNÉE
// ═══════════════════════════════════════════════════════════════════════════
function detectFetes(dateStr: string): SpecialMode {
  // Fenêtre : 20 décembre → 2 janvier (réveillons inclus)
  const d = new Date(dateStr + "T00:00:00");
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const active = (month === 12 && day >= 20) || (month === 1 && day <= 2);
  const isReveillon = (month === 12 && (day === 24 || day === 31)) || (month === 1 && day === 1);

  return {
    id: "fetes",
    active,
    label: "Mode fêtes de fin d'année",
    severity: isReveillon ? "urgent" : active ? "attention" : "info",
    recommendations_fr: active
      ? [
          isReveillon
            ? "Réveillon : demande nocturne exceptionnelle, tarifs majorés potentiels (+50 à +100%)."
            : "Période de fêtes : anticipez des pics ponctuels autour des repas de famille et grands magasins.",
          "Ciblez le centre-ville, les gares et les grands axes en fin de soirée.",
          "Prudence accrue : trafic dense, comportements festifs, routes parfois glissantes en hiver.",
        ]
      : [],
    message_fr: active
      ? isReveillon
        ? "Soir de réveillon : pic de demande nocturne le plus fort de l'année."
        : "Période de fêtes de fin d'année en cours."
      : "Hors période de fêtes de fin d'année.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 22.4 MODE RAMADAN / CARÊME
// ═══════════════════════════════════════════════════════════════════════════
// Dates approximatives du Ramadan 2026 (calendrier lunaire, communément estimé
// autour du 18 février - 19 mars 2026 selon les observations). Activable
// manuellement/optionnel — présenté comme estimation calendaire.
const RAMADAN_2026 = { start: "2026-02-18", end: "2026-03-19" };

function detectRamadan(dateStr: string): SpecialMode {
  const active = dateStr >= RAMADAN_2026.start && dateStr <= RAMADAN_2026.end;
  return {
    id: "ramadan",
    active,
    label: "Mode Ramadan",
    severity: "info",
    recommendations_fr: active
      ? [
          "Pic de demande décalé autour de l'heure de rupture du jeûne (iftar), généralement en fin d'après-midi/soirée.",
          "Anticipez une activité plus calme en journée dans certains quartiers à forte communauté musulmane.",
          "Regain d'activité nocturne possible après l'iftar (courses courtes, achats, visites familiales).",
        ]
      : [],
    message_fr: active
      ? "Période de Ramadan (estimation calendaire) : créneaux de demande décalés autour de l'iftar."
      : "Hors période de Ramadan.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 22.5 MODE VACANCES SCOLAIRES / GRAND DÉPART
// ═══════════════════════════════════════════════════════════════════════════
function detectVacances(dateStr: string): SpecialMode {
  const holiday = isSchoolHoliday(dateStr);
  const impact = getSchoolHolidaysImpact(dateStr);
  const active = !!holiday;
  const isGrandDepart = impact.impact_aeroport_pct >= 30;

  return {
    id: "vacances",
    active,
    label: "Mode vacances scolaires",
    severity: isGrandDepart ? "attention" : active ? "info" : "info",
    recommendations_fr: active
      ? [
          isGrandDepart
            ? "Grand départ : flux gares/aéroports fortement amplifié (+30%), positionnez-vous en priorité sur CDG/Orly/gares."
            : `${holiday!.name} en cours : zones affaires calmes (-15%), zones touristiques/gares actives (+15%).`,
          "Évitez les zones tertiaires en journée (télétravail/absence accrue).",
        ]
      : [],
    message_fr: impact.message_fr,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 22.6 MODE WEEK-END DIFFÉRENCIÉ
// ═══════════════════════════════════════════════════════════════════════════
function detectWeekend(dateStr: string): SpecialMode {
  const d = new Date(dateStr + "T00:00:00");
  const dow = d.getDay(); // 0=dimanche, 6=samedi
  const active = dow === 0 || dow === 6;
  const isSamedi = dow === 6;

  return {
    id: "weekend",
    active,
    label: "Mode week-end",
    severity: "info",
    recommendations_fr: active
      ? isSamedi
        ? [
            "Samedi soir : forte demande nocturne (sorties, restaurants, soirées) jusqu'à 2h-3h du matin.",
            "Ciblez le centre-ville et les zones de sortie dès 22h.",
          ]
        : [
            "Dimanche : matinée structurellement calme, reprise en fin d'après-midi (retours de week-end, gares).",
            "Dimanche soir : léger regain autour des retours de week-end et trajets de reprise du lundi.",
          ]
      : [],
    message_fr: active
      ? isSamedi
        ? "Samedi : stratégie nocturne prioritaire, forte demande de sorties."
        : "Dimanche : matinée calme, reprise progressive en soirée."
      : "Jour de semaine — pas de logique week-end différenciée.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// API PUBLIQUE — détection agrégée de tous les modes
// ═══════════════════════════════════════════════════════════════════════════

export interface ActiveModesResult {
  date: string;
  modes: SpecialMode[];
  active_modes: SpecialMode[];
  most_urgent: SpecialMode | null;
}

export function detectActiveModes(dateStr?: string): ActiveModesResult {
  const date = dateStr ?? new Date().toISOString().slice(0, 10);

  const modes: SpecialMode[] = [
    detectCanicule(),
    detectGreve(),
    detectFetes(date),
    detectRamadan(date),
    detectVacances(date),
    detectWeekend(date),
  ];

  const active = modes.filter((m) => m.active);
  const severityRank: Record<SpecialMode["severity"], number> = { urgent: 3, attention: 2, info: 1 };
  const mostUrgent = active.length
    ? active.slice().sort((a, b) => severityRank[b.severity] - severityRank[a.severity])[0]
    : null;

  return { date, modes, active_modes: active, most_urgent: mostUrgent };
}
