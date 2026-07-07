/**
 * SignalsPage.tsx — Couche Prédictive Signaux (rapport.md §3, §8, §9, §22)
 * ─────────────────────────────────────────────────────────────────────────────
 * Page dédiée aux signaux prédictifs :
 *   - Bandeau "Signaux du jour" (météo, mode actif, grève, événements)
 *   - Carte "Prochaine grosse opportunité" (événement + zone + score)
 *   - "Planning hebdo suggéré" (7 jours, heures optimales)
 *   - Bandeau "Mode spécial actif"
 *   - "Bouchons récurrents à éviter"
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Calendar,
  Cloud,
  AlertCircle,
  Zap,
  TrendingUp,
  Sun,
  CloudRain,
  Train,
  MapPin,
  Clock,
  CalendarDays,
  Construction,
  PartyPopper,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types (reflètent server/predictiveSignals.ts + server/specialModes.ts)
// ─────────────────────────────────────────────────────────────────────────────
interface WeatherCondition {
  code: number;
  description: string;
  precipitation_mm: number;
  windspeed_kmh: number;
  demand_boost: number;
  icon: string;
  isFallback?: boolean;
}

interface SpecialMode {
  id: string;
  active: boolean;
  label: string;
  severity: "info" | "attention" | "urgent";
  recommendations_fr: string[];
  message_fr: string;
}

interface StrikeNotice {
  id: number;
  operator: string;
  line_or_scope: string;
  notice_type: "ponctuelle" | "reconductible";
  start_date: string;
  end_date: string;
  impact_desc: string;
  hours_until_start: number;
  is_within_anticipation_window: boolean;
}

interface MajorEvent2026 {
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

interface TrafficPattern {
  id: string;
  label: string;
  zone_hint: string;
  peak_hours_weekday: number[];
  severity: "moderee" | "forte" | "severe";
  advice_fr: string;
  is_active_now: boolean;
}

interface FerieInfo {
  isFerie: boolean;
  label: string | null;
}

interface TodaySummary {
  date: string;
  weather: WeatherCondition | null;
  sncf_signals: { peak_zones: string[]; total_boost: number };
  active_modes: SpecialMode[];
  most_urgent_mode: SpecialMode | null;
  strikes: { notices: StrikeNotice[]; has_upcoming: boolean; max_boost_pct: number };
  next_major_event: MajorEvent2026 | null;
  traffic_active: TrafficPattern[];
  ferie: FerieInfo;
}

interface OptimalShift {
  id: string;
  label: string;
  start_hour: number;
  end_hour: number;
  zone_hint: string;
  applicable_days: "tous" | "semaine" | "weekend";
  rationale_fr: string;
}

interface RestDayRecommendation {
  day_label: string;
  day_of_week: number;
  period: string;
  reason_fr: string;
  personal_data_backed: boolean;
}

interface WeeklyPlanDay {
  date: string;
  day_label: string;
  is_school_holiday: boolean;
  is_ferie: boolean;
  ferie_label: string | null;
  recommended_shifts: OptimalShift[];
  rest_periods: RestDayRecommendation[];
  note_fr: string;
}

interface WeeklyPlanResponse {
  days: WeeklyPlanDay[];
  summary_fr: string;
}

interface TrafficPatternsResponse {
  patterns: TrafficPattern[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers d'affichage
// ─────────────────────────────────────────────────────────────────────────────
const SEVERITY_STYLE: Record<string, { border: string; bg: string; text: string }> = {
  info: { border: "border-blue-500/40", bg: "bg-blue-500/10", text: "text-blue-500" },
  attention: { border: "border-amber-500/40", bg: "bg-amber-500/10", text: "text-amber-500" },
  urgent: { border: "border-red-500/40", bg: "bg-red-500/10", text: "text-red-500" },
};

const MODE_ICON: Record<string, JSX.Element> = {
  canicule: <Sun size={18} />,
  greve: <Train size={18} />,
  fetes: <PartyPopper size={18} />,
  ramadan: <Calendar size={18} />,
  vacances: <CalendarDays size={18} />,
  weekend: <Clock size={18} />,
};

function formatDateFr(iso: string): string {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
  } catch {
    return iso;
  }
}

function traffisSeverityColor(sev: TrafficPattern["severity"]): string {
  if (sev === "severe") return "text-red-500";
  if (sev === "forte") return "text-amber-500";
  return "text-muted-foreground";
}

// ─────────────────────────────────────────────────────────────────────────────
// Composant principal
// ─────────────────────────────────────────────────────────────────────────────
export default function SignalsPage() {
  const { data: summary, isLoading: loadingSummary } = useQuery<TodaySummary>({
    queryKey: ["/api/signals/today-summary"],
    queryFn: () => apiRequest("GET", "/api/signals/today-summary").then((r) => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: weeklyPlan, isLoading: loadingPlan } = useQuery<WeeklyPlanResponse>({
    queryKey: ["/api/planning/weekly-plan"],
    queryFn: () => apiRequest("GET", "/api/planning/weekly-plan").then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  const { data: trafficData, isLoading: loadingTraffic } = useQuery<TrafficPatternsResponse>({
    queryKey: ["/api/signals/traffic-patterns"],
    queryFn: () => apiRequest("GET", "/api/signals/traffic-patterns").then((r) => r.json()),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const mostUrgentMode = summary?.most_urgent_mode ?? null;

  return (
    <div className="p-3 sm:p-4 space-y-4 max-w-3xl mx-auto pb-24">
      <div className="flex items-center gap-2">
        <Zap size={22} className="text-primary" />
        <h1 className="text-lg sm:text-xl font-bold">Signaux prédictifs</h1>
      </div>

      {/* ─── Bandeau "Signaux du jour" ─────────────────────────────────────── */}
      <Card data-testid="card-signals-today">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar size={16} /> Signaux du jour
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingSummary ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {/* Météo */}
              <div className="flex flex-col items-center justify-center gap-1 p-2 rounded-lg bg-accent/40 min-h-[64px]">
                <span className="text-xl" aria-hidden>{summary?.weather?.icon ?? "🌡️"}</span>
                <span className="text-[11px] text-muted-foreground text-center leading-tight">
                  {summary?.weather?.description ?? "Météo indisponible"}
                </span>
              </div>
              {/* Mode actif */}
              <div className="flex flex-col items-center justify-center gap-1 p-2 rounded-lg bg-accent/40 min-h-[64px]">
                {mostUrgentMode ? MODE_ICON[mostUrgentMode.id] ?? <AlertCircle size={18} /> : <AlertCircle size={18} className="text-muted-foreground" />}
                <span className="text-[11px] text-muted-foreground text-center leading-tight">
                  {mostUrgentMode ? mostUrgentMode.label : "Aucun mode actif"}
                </span>
              </div>
              {/* Grève */}
              <div className="flex flex-col items-center justify-center gap-1 p-2 rounded-lg bg-accent/40 min-h-[64px]">
                <Train size={18} className={summary?.strikes?.has_upcoming ? "text-red-500" : "text-muted-foreground"} />
                <span className="text-[11px] text-muted-foreground text-center leading-tight">
                  {summary?.strikes?.has_upcoming ? `${summary.strikes.notices.length} préavis` : "Trafic normal"}
                </span>
              </div>
              {/* Événements */}
              <div className="flex flex-col items-center justify-center gap-1 p-2 rounded-lg bg-accent/40 min-h-[64px]">
                <PartyPopper size={18} className="text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground text-center leading-tight truncate max-w-full">
                  {summary?.next_major_event ? summary.next_major_event.name : "Aucun événement proche"}
                </span>
              </div>
            </div>
          )}
          {summary?.ferie?.isFerie && (
            <div className="mt-2 text-xs text-amber-500 flex items-center gap-1">
              <AlertCircle size={13} /> Aujourd'hui : jour férié ({summary.ferie.label})
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Mode spécial actif (bandeau visuel) ──────────────────────────── */}
      {mostUrgentMode && (
        <Card
          className={`${SEVERITY_STYLE[mostUrgentMode.severity].border} ${SEVERITY_STYLE[mostUrgentMode.severity].bg}`}
          data-testid="card-special-mode"
        >
          <CardHeader className="pb-2">
            <CardTitle className={`text-base flex items-center gap-2 ${SEVERITY_STYLE[mostUrgentMode.severity].text}`}>
              {MODE_ICON[mostUrgentMode.id] ?? <AlertCircle size={18} />}
              {mostUrgentMode.label}
              <Badge variant={mostUrgentMode.severity === "urgent" ? "destructive" : "secondary"} className="ml-auto">
                {mostUrgentMode.severity === "urgent" ? "Urgent" : mostUrgentMode.severity === "attention" ? "Attention" : "Info"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm">{mostUrgentMode.message_fr}</p>
            <ul className="space-y-1">
              {mostUrgentMode.recommendations_fr.map((rec, i) => (
                <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <span className="mt-0.5">•</span>
                  <span>{rec}</span>
                </li>
              ))}
            </ul>
            {/* Autres modes actifs en plus du plus urgent */}
            {summary && summary.active_modes.length > 1 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {summary.active_modes
                  .filter((m) => m.id !== mostUrgentMode.id)
                  .map((m) => (
                    <Badge key={m.id} variant="outline" className="text-[10px]">
                      {m.label}
                    </Badge>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Prochaine grosse opportunité ──────────────────────────────────── */}
      <Card data-testid="card-next-opportunity">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp size={16} /> Prochaine grosse opportunité
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingSummary ? (
            <Skeleton className="h-20 w-full" />
          ) : summary?.next_major_event ? (
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-sm">{summary.next_major_event.name}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    <MapPin size={12} /> {summary.next_major_event.zone_hint}
                  </p>
                </div>
                <Badge className="shrink-0">+{summary.next_major_event.demand_boost_pct}%</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{summary.next_major_event.expected_impact}</p>
              <p className="text-xs">
                <span className="text-muted-foreground">Dates : </span>
                {formatDateFr(summary.next_major_event.start_date)} → {formatDateFr(summary.next_major_event.end_date)}
              </p>
              {summary.next_major_event.source_url && (
                <a
                  href={summary.next_major_event.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary underline"
                >
                  Voir la source
                </a>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Aucun événement majeur identifié pour le moment.</p>
          )}
        </CardContent>
      </Card>

      {/* ─── Grèves en préavis ─────────────────────────────────────────────── */}
      {summary?.strikes?.notices?.length ? (
        <Card data-testid="card-strikes">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Train size={16} /> Préavis de grève
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {summary.strikes.notices.map((n) => (
              <div key={n.id} className="flex items-start justify-between gap-2 p-2 rounded-lg bg-accent/30">
                <div>
                  <p className="text-sm font-medium">
                    {n.operator} — {n.line_or_scope}
                  </p>
                  <p className="text-xs text-muted-foreground">{n.impact_desc}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDateFr(n.start_date)} → {formatDateFr(n.end_date)} ({n.notice_type})
                  </p>
                </div>
                {n.is_within_anticipation_window && (
                  <Badge variant="destructive" className="shrink-0 text-[10px]">
                    Fenêtre 48-72h
                  </Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* ─── Planning hebdo suggéré ────────────────────────────────────────── */}
      <Card data-testid="card-weekly-plan">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar size={16} /> Planning hebdo suggéré
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingPlan ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="space-y-2">
              {weeklyPlan?.days.map((day) => (
                <div key={day.date} className="p-2.5 rounded-lg border border-border">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-semibold">
                      {day.day_label} <span className="text-muted-foreground font-normal">{formatDateFr(day.date)}</span>
                    </span>
                    <div className="flex gap-1">
                      {day.is_ferie && (
                        <Badge variant="outline" className="text-[10px]">
                          Férié
                        </Badge>
                      )}
                      {day.is_school_holiday && (
                        <Badge variant="secondary" className="text-[10px]">
                          Vacances
                        </Badge>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1.5">{day.note_fr}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {day.recommended_shifts.map((shift) => (
                      <span
                        key={shift.id}
                        className="text-[11px] px-2 py-1 rounded-md bg-primary/10 text-primary flex items-center gap-1"
                        title={shift.rationale_fr}
                      >
                        <Clock size={11} />
                        {shift.start_hour}h-{shift.end_hour}h · {shift.zone_hint}
                      </span>
                    ))}
                  </div>
                  {day.rest_periods.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {day.rest_periods.map((rest, i) => (
                        <span
                          key={i}
                          className="text-[11px] px-2 py-1 rounded-md bg-muted text-muted-foreground"
                          title={rest.reason_fr}
                        >
                          Off conseillé : {rest.day_label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Bouchons récurrents à éviter ──────────────────────────────────── */}
      <Card data-testid="card-traffic-patterns">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Construction size={16} /> Bouchons récurrents à éviter
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadingTraffic ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            trafficData?.patterns.map((p) => (
              <div
                key={p.id}
                className={`flex items-start justify-between gap-2 p-2 rounded-lg ${p.is_active_now ? "bg-red-500/10 border border-red-500/30" : "bg-accent/30"}`}
              >
                <div>
                  <p className={`text-sm font-medium ${traffisSeverityColor(p.severity)}`}>{p.label}</p>
                  <p className="text-xs text-muted-foreground">{p.zone_hint}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{p.advice_fr}</p>
                </div>
                {p.is_active_now && (
                  <Badge variant="destructive" className="shrink-0 text-[10px]">
                    Actif
                  </Badge>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* ─── Sources ──────────────────────────────────────────────────────── */}
      <p className="text-[11px] text-muted-foreground text-center pt-2">
        Données météo :{" "}
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="underline">
          Open-Meteo
        </a>
        {" · "}Calendrier scolaire zones A/B/C :{" "}
        <a
          href="https://www.education.gouv.fr/calendrier-scolaire-12513"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          education.gouv.fr
        </a>
      </p>
    </div>
  );
}
