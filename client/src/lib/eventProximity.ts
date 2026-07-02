/**
 * eventProximity — Utilitaires partagés pour classer les événements PredictHQ
 *   selon leur proximité horaire par rapport à l'instant courant.
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilisé par :
 *   - hooks/usePredictHQ.ts       (liste temps réel des events, 3s)
 *   - hooks/useZonesSummary.ts    (résumé par zone, 30s, utilisé par la carte)
 *   - pages/MapPage.tsx           (markers, tooltips, panel latéral)
 *
 * Règles :
 *   - Filtrage par défaut = jour courant (calendaire local).
 *   - Code couleur :
 *       imminent : event en cours ou dans < 60 min → rouge (repositionnement)
 *       soon     : event dans < 3 h                 → orange
 *       today    : event plus tard dans la journée  → neutre / rank
 *       past     : déjà terminé                     → filtré par défaut
 *       future   : autre jour                        → filtré par défaut
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type EventProximity = "imminent" | "soon" | "today" | "past" | "future";

export const IMMINENT_MINUTES = 60;   // < 1h  → rouge
export const SOON_MINUTES = 180;      // < 3h  → orange

/** Vrai si les deux dates tombent sur le même jour calendaire local. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export interface ProximityInfo {
  minutesUntilStart: number | null;
  proximity: EventProximity;
  timeLabel: string;
}

/**
 * Calcule la classe de proximité + libellé temps humain pour un event.
 *   start / end : ISO strings (peuvent être undefined).
 *   now         : instant de référence (par défaut : maintenant).
 */
export function classifyEventProximity(
  start: string | undefined,
  end: string | undefined,
  now: Date = new Date(),
): ProximityInfo {
  if (!start) {
    return { minutesUntilStart: null, proximity: "future", timeLabel: "" };
  }
  let startDate: Date;
  try {
    startDate = new Date(start);
    if (isNaN(startDate.getTime())) throw new Error("invalid start");
  } catch {
    return { minutesUntilStart: null, proximity: "future", timeLabel: "" };
  }
  const endDate = end ? new Date(end) : null;
  const endMs = endDate && !isNaN(endDate.getTime()) ? endDate.getTime() : null;
  const startMs = startDate.getTime();
  const nowMs = now.getTime();
  const minutesUntilStart = (startMs - nowMs) / 60000;
  const sameDay = isSameLocalDay(startDate, now);

  let proximity: EventProximity;
  if (!sameDay && minutesUntilStart > 0) {
    proximity = "future";
  } else if (!sameDay && minutesUntilStart < 0) {
    // Event d'un autre jour déjà commencé — pertinent seulement s'il n'est pas fini.
    proximity = endMs && endMs > nowMs ? "imminent" : "past";
  } else if (minutesUntilStart <= 0) {
    // Commencé aujourd'hui : imminent tant que end n'est pas dépassé.
    proximity = endMs && endMs < nowMs ? "past" : "imminent";
  } else if (minutesUntilStart < IMMINENT_MINUTES) {
    proximity = "imminent";
  } else if (minutesUntilStart < SOON_MINUTES) {
    proximity = "soon";
  } else {
    proximity = "today";
  }
  return {
    minutesUntilStart,
    proximity,
    timeLabel: formatTimeLabel(minutesUntilStart, start, end, now),
  };
}

/** Libellé court « dans 42 min » / « dans 2h15 » / « 18:30 » / « en cours ». */
export function formatTimeLabel(
  minutesUntilStart: number | null,
  startIso?: string,
  endIso?: string,
  now: Date = new Date(),
): string {
  if (minutesUntilStart == null) return "";
  if (minutesUntilStart <= 0) {
    if (endIso) {
      const endDelta = (new Date(endIso).getTime() - now.getTime()) / 60000;
      if (endDelta > 0) return "en cours";
    }
    return "commencé";
  }
  if (minutesUntilStart < 60) return `dans ${Math.round(minutesUntilStart)} min`;
  if (minutesUntilStart < 12 * 60) {
    const h = Math.floor(minutesUntilStart / 60);
    const m = Math.round(minutesUntilStart - h * 60);
    return m > 0 ? `dans ${h}h${m.toString().padStart(2, "0")}` : `dans ${h}h`;
  }
  if (startIso) {
    return new Date(startIso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }
  return "";
}

/**
 * Couleur canonique associée à une proximité (utilisée pour les marqueurs Leaflet,
 * les badges et les liserets de zones).
 */
export function proximityColor(prox: EventProximity | undefined): string {
  switch (prox) {
    case "imminent": return "#ef4444"; // rouge
    case "soon":     return "#f97316"; // orange
    case "today":    return "#eab308"; // jaune / neutre
    default:         return "#9ca3af"; // gris (past/future)
  }
}

/** Ordre de tri : imminent d'abord, past en dernier. */
export const PROXIMITY_SORT_ORDER: Record<EventProximity, number> = {
  imminent: 0,
  soon: 1,
  today: 2,
  future: 3,
  past: 4,
};
