/**
 * IDFCalendar — "À surveiller cette semaine" (calendrier événements IDF)
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche les 5 événements les plus impactants (PredictHQ + récurrents) de la
 * semaine, cliquables → naviguent vers /events avec l'event présélectionné
 * (paramètre hash simple, pas de dépendance supplémentaire).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { CalendarDays, TrendingUp } from "lucide-react";
import { useIdfCalendar } from "@/hooks/useIdfEvents";
import { haptic } from "@/lib/haptics";

const IMPACT_COLOR: Record<string, string> = {
  extreme: "#ef4444",
  eleve: "#f97316",
  modere: "#fbbf24",
  faible: "#6b7280",
};

const IMPACT_LABEL: Record<string, string> = {
  extreme: "Extrême",
  eleve: "Élevé",
  modere: "Modéré",
  faible: "Faible",
};

function fmtDateFr(iso: string): string {
  try {
    return new Date(iso).toLocaleString("fr-FR", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function IDFCalendar() {
  const { top5, isLoading } = useIdfCalendar(7);

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 animate-pulse h-32" />
    );
  }

  if (top5.length === 0) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4" data-testid="idf-calendar">
      <div className="flex items-center gap-2 mb-3">
        <CalendarDays size={18} className="text-sky-300" />
        <h3 className="text-sm font-bold text-white uppercase tracking-wide">
          À surveiller cette semaine
        </h3>
      </div>

      <div className="space-y-2">
        {top5.map((ev) => (
          <button
            key={ev.key}
            onClick={() => haptic("tap")}
            className="w-full text-left flex items-center gap-3 rounded-xl bg-white/5 hover:bg-white/10 active:scale-[0.99] transition p-3"
            style={{ minHeight: 44 }}
            data-testid={`idf-calendar-item-${ev.key}`}
          >
            <div
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: IMPACT_COLOR[ev.impact_level] }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-white text-sm font-semibold truncate">{ev.name}</div>
              <div className="text-white/50 text-xs">{fmtDateFr(ev.start_time)}</div>
            </div>
            <div className="flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: IMPACT_COLOR[ev.impact_level] }}>
              <TrendingUp size={12} />
              {IMPACT_LABEL[ev.impact_level]}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
