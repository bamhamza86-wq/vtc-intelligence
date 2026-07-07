/**
 * AnalyticsPage.tsx — Couche ANALYTICS BI AVANCÉE (/#/analytics)
 * ─────────────────────────────────────────────────────────────────────────────
 * 8 sections stackées (mobile-first) :
 *   1. Insight du jour (grande carte)
 *   2. Score professionnalisation (jauge /100 + détails)
 *   3. Décomposition CA (donut CSS pur + tableau)
 *   4. Saisonnalité (heatmap CSS pur 12x4)
 *   5. Corrélations découvertes (liste)
 *   6. Simulateur what-if (formulaire + résultat)
 *   7. Rapports (boutons semaine/mois → aperçu HTML imprimable)
 *   8. Qualité de vie (radar CSS pur)
 *
 * Backend : server/analyticsEngine.ts (15 endpoints /api/analytics/*).
 * Aucune nouvelle dépendance npm — donut/heatmap/radar en SVG/CSS pur.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, API_BASE, getAuthToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Lightbulb,
  Award,
  Target,
  FileBarChart,
  Users,
  CalendarDays,
  Sparkles,
  Download,
  Printer,
  AlertTriangle,
  HeartPulse,
} from "lucide-react";

// ─── Types (alignés sur analyticsEngine.ts) ─────────────────────────────────
interface DailyInsight {
  insight_fr: string;
  category: string;
  generated_at: string;
  data_source: string;
}
interface ProComponent {
  key: string;
  label_fr: string;
  score: number;
  detail_fr: string;
}
interface ProfessionalizationScore {
  score_global: number;
  components: ProComponent[];
  qualification_fr: string;
  data_source: string;
}
interface RevenueSlice {
  label: string;
  key: string;
  pct: number;
  ca_eur: number;
  n_rides: number;
}
interface RevenueDecomposition {
  total_ca_eur: number;
  by_platform: RevenueSlice[];
  by_timeslot: RevenueSlice[];
  by_zone: RevenueSlice[];
  by_ride_type: RevenueSlice[];
  data_source: string;
}
interface SeasonalityCell {
  month: number;
  week_of_month: number;
  avg_hourly_rate: number;
  n_rides: number;
}
interface Seasonality {
  cells: SeasonalityCell[];
  best_cell: SeasonalityCell | null;
  worst_cell: SeasonalityCell | null;
  data_source: string;
}
interface CorrelationFinding {
  pattern_fr: string;
  factor: string;
  impact_pct: number;
  confidence: string;
}
interface CorrelationsFound {
  findings: CorrelationFinding[];
  data_source: string;
}
interface DowntrendAlert {
  window: string;
  metric: string;
  slope_pct: number;
  severity: string;
  message_fr: string;
}
interface DowntrendAlerts {
  alerts: DowntrendAlert[];
  data_source: string;
}
interface WhatIfResult {
  scenario: string;
  baseline_ca_eur: number;
  simulated_ca_eur: number;
  delta_eur: number;
  delta_pct: number;
  explanation_fr: string;
  data_source: string;
}
interface CohortComparison {
  user: { avg_hourly_rate: number; total_rides: number; activity_age_months: number; main_zone: string; main_platform: string };
  cohort: { label_fr: string; size_estimate: number; avg_hourly_rate: number; p25_hourly_rate: number; p75_hourly_rate: number };
  comparison: { delta_pct: number; percentile_estimate: number; verdict_fr: string };
  data_source: string;
}
interface QualityOfLife {
  score_global: number;
  components: { key: string; label_fr: string; score: number }[];
  qualification_fr: string;
  advice_fr: string;
  data_source: string;
}
interface MonthEndForecast {
  days_elapsed: number;
  days_in_month: number;
  ca_so_far_eur: number;
  daily_avg_ca_eur: number;
  forecast_ca_eur: number;
  confidence: string;
  message_fr: string;
  data_source: string;
}

const MONTH_LABELS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
const DONUT_COLORS = ["#34d399", "#38bdf8", "#f472b6", "#fbbf24", "#a78bfa", "#fb923c"];

function SourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  const isReal = source === "historique";
  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wide font-semibold ${
        isReal ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"
      }`}
    >
      {isReal ? "Historique" : "Référence flotte"}
    </span>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 1 — Insight du jour
// ═════════════════════════════════════════════════════════════════════════════
function DailyInsightSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/analytics/daily-insight"],
    queryFn: () => apiRequest("GET", "/api/analytics/daily-insight").then((r) => r.json()) as Promise<DailyInsight>,
  });

  return (
    <section
      className="rounded-2xl border border-amber-400/30 bg-gradient-to-br from-amber-500/10 via-slate-900/60 to-slate-900/60 p-5 space-y-2"
      data-testid="section-daily-insight"
    >
      <p className="text-xs font-semibold text-amber-300 flex items-center gap-2 uppercase tracking-wide">
        <Lightbulb size={15} />
        Insight du jour
      </p>
      {isLoading && <Skeleton className="h-14 w-full rounded-xl" />}
      {data && (
        <div className="flex items-start justify-between gap-3">
          <p className="text-base sm:text-lg font-semibold text-white leading-snug">{data.insight_fr}</p>
          <SourceBadge source={data.data_source} />
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 2 — Score professionnalisation
// ═════════════════════════════════════════════════════════════════════════════
function Gauge100({ score }: { score: number }) {
  const size = 160;
  const stroke = 14;
  const radius = (size - stroke) / 2;
  const circumference = Math.PI * radius; // demi-cercle
  const pct = Math.max(0, Math.min(100, score));
  const dash = (pct / 100) * circumference;
  const color = pct >= 75 ? "#34d399" : pct >= 50 ? "#38bdf8" : pct >= 30 ? "#fbbf24" : "#f87171";

  return (
    <svg viewBox={`0 0 ${size} ${size / 2 + 10}`} className="w-full max-w-[220px] mx-auto">
      <path
        d={`M ${stroke / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - stroke / 2} ${size / 2}`}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
      <path
        d={`M ${stroke / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - stroke / 2} ${size / 2}`}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circumference}`}
      />
      <text x={size / 2} y={size / 2 - 8} textAnchor="middle" fontSize={28} fontWeight={700} fill="white">
        {score}
      </text>
      <text x={size / 2} y={size / 2 + 10} textAnchor="middle" fontSize={11} fill="rgb(148,163,184)">
        / 100
      </text>
    </svg>
  );
}

function ProfessionalizationSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/analytics/professionalization-score"],
    queryFn: () => apiRequest("GET", "/api/analytics/professionalization-score").then((r) => r.json()) as Promise<ProfessionalizationScore>,
  });

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-professionalization">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white flex items-center gap-2">
          <Award size={15} className="text-sky-400" />
          Score de professionnalisation
        </p>
        <SourceBadge source={data?.data_source} />
      </div>

      {isLoading && <Skeleton className="h-48 w-full rounded-xl" />}

      {data && (
        <div className="space-y-3">
          <Gauge100 score={data.score_global} />
          <p className="text-center text-xs font-semibold uppercase tracking-wide text-sky-300">{data.qualification_fr.replace(/_/g, " ")}</p>

          <div className="space-y-2">
            {data.components.map((c) => (
              <div key={c.key} className="space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-300">{c.label_fr}</span>
                  <span className="font-semibold text-slate-200 tabular-nums">{c.score}/100</span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-400"
                    style={{ width: `${c.score}%` }}
                  />
                </div>
                <p className="text-[10px] text-slate-500">{c.detail_fr}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 3 — Décomposition CA (donut CSS pur + tableau)
// ═════════════════════════════════════════════════════════════════════════════
function Donut({ slices }: { slices: RevenueSlice[] }) {
  const size = 160;
  const radius = size / 2;
  const inner = radius * 0.6;
  let cumulative = 0;

  const total = slices.reduce((s, sl) => s + sl.pct, 0) || 1;

  function arcPath(startPct: number, endPct: number) {
    const startAngle = (startPct / 100) * 2 * Math.PI - Math.PI / 2;
    const endAngle = (endPct / 100) * 2 * Math.PI - Math.PI / 2;
    const x1 = radius + radius * Math.cos(startAngle);
    const y1 = radius + radius * Math.sin(startAngle);
    const x2 = radius + radius * Math.cos(endAngle);
    const y2 = radius + radius * Math.sin(endAngle);
    const xi1 = radius + inner * Math.cos(startAngle);
    const yi1 = radius + inner * Math.sin(startAngle);
    const xi2 = radius + inner * Math.cos(endAngle);
    const yi2 = radius + inner * Math.sin(endAngle);
    const largeArc = endPct - startPct > 50 ? 1 : 0;
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${inner} ${inner} 0 ${largeArc} 0 ${xi1} ${yi1} Z`;
  }

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[180px] mx-auto">
      {slices.map((s, i) => {
        const startPct = cumulative;
        const normalizedPct = (s.pct / total) * 100;
        cumulative += normalizedPct;
        return <path key={s.key} d={arcPath(startPct, cumulative)} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />;
      })}
      <text x={radius} y={radius - 4} textAnchor="middle" fontSize={16} fontWeight={700} fill="white">
        100%
      </text>
      <text x={radius} y={radius + 12} textAnchor="middle" fontSize={9} fill="rgb(148,163,184)">
        CA réparti
      </text>
    </svg>
  );
}

function DecompositionTable({ title, slices }: { title: string; slices: RevenueSlice[] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{title}</p>
      <table className="w-full text-[11px]">
        <tbody>
          {slices.map((s, i) => (
            <tr key={s.key} className="border-b border-white/5 last:border-0">
              <td className="py-1 pr-2">
                <span
                  className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                  style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}
                />
                <span className="text-slate-300">{s.label}</span>
              </td>
              <td className="py-1 text-right text-slate-200 tabular-nums">{s.ca_eur} €</td>
              <td className="py-1 pl-2 text-right font-semibold text-slate-100 tabular-nums w-12">{s.pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RevenueDecompositionSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/analytics/revenue-decomposition"],
    queryFn: () => apiRequest("GET", "/api/analytics/revenue-decomposition").then((r) => r.json()) as Promise<RevenueDecomposition>,
  });
  const [tab, setTab] = useState<"platform" | "timeslot" | "zone" | "ride_type">("platform");

  const tabsMap: Record<string, { label: string; slices: RevenueSlice[] | undefined }> = {
    platform: { label: "Plateforme", slices: data?.by_platform },
    timeslot: { label: "Créneau", slices: data?.by_timeslot },
    zone: { label: "Zone", slices: data?.by_zone },
    ride_type: { label: "Type de course", slices: data?.by_ride_type },
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-revenue-decomposition">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white flex items-center gap-2">
          <BarChart3 size={15} className="text-emerald-400" />
          Décomposition du CA {data ? `— ${data.total_ca_eur} €` : ""}
        </p>
        <SourceBadge source={data?.data_source} />
      </div>

      {isLoading && <Skeleton className="h-48 w-full rounded-xl" />}

      {data && (
        <div className="space-y-3">
          <div className="flex gap-1.5 flex-wrap">
            {Object.entries(tabsMap).map(([key, t]) => (
              <button
                key={key}
                onClick={() => setTab(key as any)}
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                  tab === key ? "bg-emerald-500/20 border-emerald-400/40 text-emerald-200" : "border-white/10 text-slate-400"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <Donut slices={tabsMap[tab].slices || []} />
          <DecompositionTable title={tabsMap[tab].label} slices={tabsMap[tab].slices || []} />
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 4 — Saisonnalité (heatmap CSS pur 12x4)
// ═════════════════════════════════════════════════════════════════════════════
function heatColor(value: number, min: number, max: number) {
  if (max === min) return "rgba(52,211,153,0.3)";
  const t = (value - min) / (max - min);
  // du rouge (faible) au vert (fort)
  const r = Math.round(248 - t * (248 - 52));
  const g = Math.round(113 + t * (211 - 113));
  const b = Math.round(113 + t * (153 - 113));
  return `rgb(${r},${g},${b})`;
}

function SeasonalitySection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/analytics/seasonality"],
    queryFn: () => apiRequest("GET", "/api/analytics/seasonality").then((r) => r.json()) as Promise<Seasonality>,
  });

  const values = data?.cells.map((c) => c.avg_hourly_rate).filter((v) => v > 0) || [];
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-seasonality">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white flex items-center gap-2">
          <CalendarDays size={15} className="text-purple-400" />
          Saisonnalité personnelle
        </p>
        <SourceBadge source={data?.data_source} />
      </div>

      {isLoading && <Skeleton className="h-64 w-full rounded-xl" />}

      {data && (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <div className="grid gap-[3px] min-w-[420px]" style={{ gridTemplateColumns: "32px repeat(12, 1fr)" }}>
              <div />
              {MONTH_LABELS.map((m) => (
                <div key={m} className="text-[9px] text-slate-500 text-center">
                  {m}
                </div>
              ))}
              {[1, 2, 3, 4].map((week) => (
                <>
                  <div key={`w-${week}`} className="text-[9px] text-slate-500 flex items-center">
                    S{week}
                  </div>
                  {Array.from({ length: 12 }, (_, mi) => {
                    const cell = data.cells.find((c) => c.month === mi + 1 && c.week_of_month === week);
                    const val = cell?.avg_hourly_rate || 0;
                    return (
                      <div
                        key={`${week}-${mi}`}
                        title={`${MONTH_LABELS[mi]} S${week} : ${val} €/h`}
                        className="aspect-square rounded-[3px]"
                        style={{ background: val > 0 ? heatColor(val, min, max) : "rgba(255,255,255,0.04)" }}
                      />
                    );
                  })}
                </>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between text-[10px] text-slate-500">
            <span>Faible €/h</span>
            <div className="flex-1 mx-2 h-2 rounded-full" style={{ background: "linear-gradient(90deg, rgb(248,113,113), rgb(52,211,153))" }} />
            <span>Fort €/h</span>
          </div>
          {data.best_cell && data.worst_cell && (
            <p className="text-[11px] text-slate-400">
              Meilleur créneau : <span className="text-emerald-300 font-semibold">{MONTH_LABELS[data.best_cell.month - 1]} S{data.best_cell.week_of_month}</span>{" "}
              ({data.best_cell.avg_hourly_rate} €/h) · Plus faible :{" "}
              <span className="text-red-300 font-semibold">{MONTH_LABELS[data.worst_cell.month - 1]} S{data.worst_cell.week_of_month}</span> (
              {data.worst_cell.avg_hourly_rate} €/h)
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 5 — Corrélations découvertes + alertes tendances baissières
// ═════════════════════════════════════════════════════════════════════════════
function CorrelationsSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/analytics/correlations-found"],
    queryFn: () => apiRequest("GET", "/api/analytics/correlations-found").then((r) => r.json()) as Promise<CorrelationsFound>,
  });
  const { data: downtrend } = useQuery({
    queryKey: ["/api/analytics/downtrend-alerts"],
    queryFn: () => apiRequest("GET", "/api/analytics/downtrend-alerts").then((r) => r.json()) as Promise<DowntrendAlerts>,
  });

  const severityColor: Record<string, string> = {
    critique: "border-red-400/40 bg-red-500/10 text-red-300",
    attention: "border-amber-400/40 bg-amber-500/10 text-amber-300",
    info: "border-sky-400/40 bg-sky-500/10 text-sky-300",
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-correlations">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white flex items-center gap-2">
          <Sparkles size={15} className="text-pink-400" />
          Corrélations découvertes
        </p>
        <SourceBadge source={data?.data_source} />
      </div>

      {isLoading && <Skeleton className="h-32 w-full rounded-xl" />}

      {data && (
        <ul className="space-y-1.5">
          {data.findings.map((f, i) => (
            <li key={i} className="flex items-center justify-between text-[12px] rounded-lg bg-slate-800/50 px-3 py-2">
              <span className="text-slate-200">{f.pattern_fr}</span>
              <span className={`flex items-center gap-1 font-semibold ${f.impact_pct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {f.impact_pct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {f.confidence}
              </span>
            </li>
          ))}
        </ul>
      )}

      {downtrend && downtrend.alerts.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1">
            <AlertTriangle size={12} />
            Alertes tendances baissières
          </p>
          {downtrend.alerts.map((a, i) => (
            <div key={i} className={`text-[11px] rounded-lg border px-3 py-2 ${severityColor[a.severity] || severityColor.info}`}>
              {a.message_fr}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 6 — Simulateur what-if
// ═════════════════════════════════════════════════════════════════════════════
function WhatIfSimulatorSection() {
  const [scenario, setScenario] = useState<"extra_hour_per_day" | "refuse_below_threshold">("extra_hour_per_day");
  const [extraHours, setExtraHours] = useState(1);
  const [threshold, setThreshold] = useState(8);

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/analytics/what-if-simulator", {
        scenario,
        extra_hours_per_day: extraHours,
        refuse_fare_threshold_eur: threshold,
      }).then((r) => r.json()) as Promise<WhatIfResult>,
  });

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-whatif">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <Target size={15} className="text-cyan-400" />
        Simulateur "et si..."
      </p>

      <div className="space-y-2">
        <div className="flex gap-1.5">
          <button
            onClick={() => setScenario("extra_hour_per_day")}
            className={`flex-1 text-[11px] py-1.5 rounded-lg border ${
              scenario === "extra_hour_per_day" ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200" : "border-white/10 text-slate-400"
            }`}
          >
            + d'heures/jour
          </button>
          <button
            onClick={() => setScenario("refuse_below_threshold")}
            className={`flex-1 text-[11px] py-1.5 rounded-lg border ${
              scenario === "refuse_below_threshold" ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200" : "border-white/10 text-slate-400"
            }`}
          >
            Refuser courses &lt; seuil
          </button>
        </div>

        {scenario === "extra_hour_per_day" ? (
          <label className="block text-[11px] text-slate-400">
            Heures supplémentaires par jour
            <input
              type="number"
              min={0.5}
              max={6}
              step={0.5}
              value={extraHours}
              onChange={(e) => setExtraHours(Number(e.target.value))}
              className="w-full mt-1 bg-slate-800/70 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
            />
          </label>
        ) : (
          <label className="block text-[11px] text-slate-400">
            Seuil de refus (€)
            <input
              type="number"
              min={4}
              max={20}
              step={1}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-full mt-1 bg-slate-800/70 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
            />
          </label>
        )}

        <Button size="sm" className="w-full" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Simulation..." : "Simuler"}
        </Button>
      </div>

      {mutation.data && (
        <div className="rounded-xl bg-slate-800/50 p-3 space-y-1.5">
          <p className="text-xs text-slate-400">{mutation.data.scenario}</p>
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-400">Base : {mutation.data.baseline_ca_eur} €</span>
            <span className="text-white font-bold">Simulé : {mutation.data.simulated_ca_eur} €</span>
          </div>
          <p className={`text-sm font-semibold ${mutation.data.delta_eur >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {mutation.data.delta_eur >= 0 ? "+" : ""}
            {mutation.data.delta_eur} € ({mutation.data.delta_pct >= 0 ? "+" : ""}
            {mutation.data.delta_pct}%)
          </p>
          <p className="text-[11px] text-slate-400 leading-snug">{mutation.data.explanation_fr}</p>
          <SourceBadge source={mutation.data.data_source} />
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 7 — Rapports (semaine/mois → aperçu HTML imprimable) + export Excel
// ═════════════════════════════════════════════════════════════════════════════
function ReportsSection() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [loadingReport, setLoadingReport] = useState<string | null>(null);

  async function openReport(kind: "weekly" | "monthly") {
    setLoadingReport(kind);
    try {
      const endpoint = kind === "weekly" ? "/api/analytics/weekly-report" : "/api/analytics/monthly-report";
      const res = await apiRequest("GET", endpoint);
      const html = await res.text();
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setPreviewTitle(kind === "weekly" ? "Rapport hebdomadaire" : "Rapport mensuel");
    } finally {
      setLoadingReport(null);
    }
  }

  async function downloadExcel() {
    const token = getAuthToken();
    const res = await fetch(`${API_BASE}/api/analytics/export-excel`, {
      headers: { Authorization: `Bearer ${token}`, "X-Auth-Token": token || "" },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vtc_analytics_export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-reports">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <FileBarChart size={15} className="text-indigo-400" />
        Rapports
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" size="sm" onClick={() => openReport("weekly")} disabled={loadingReport === "weekly"}>
          <Printer size={13} className="mr-1.5" />
          {loadingReport === "weekly" ? "Chargement..." : "Rapport semaine"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => openReport("monthly")} disabled={loadingReport === "monthly"}>
          <Printer size={13} className="mr-1.5" />
          {loadingReport === "monthly" ? "Chargement..." : "Rapport mois"}
        </Button>
      </div>

      <Button variant="outline" size="sm" className="w-full" onClick={downloadExcel}>
        <Download size={13} className="mr-1.5" />
        Exporter vers Excel (CSV)
      </Button>

      {previewUrl && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[11px] text-slate-400">{previewTitle} — aperçu imprimable</p>
          <iframe src={previewUrl} title={previewTitle} className="w-full h-[420px] rounded-lg border border-white/10 bg-white" />
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 8 — Qualité de vie (radar CSS pur) + cohorte + prévision fin de mois
// ═════════════════════════════════════════════════════════════════════════════
function clamp01(n: number) {
  return Math.max(0, Math.min(100, n));
}

function RadarChart({ values, labels }: { values: number[]; labels: string[] }) {
  const size = 200;
  const center = size / 2;
  const radius = 75;
  const n = values.length;

  const pointAt = (i: number, r: number) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return { x: center + r * Math.cos(angle), y: center + r * Math.sin(angle) };
  };

  const dataPoints = values.map((v, i) => pointAt(i, (radius * clamp01(v)) / 100));
  const dataPath = dataPoints.map((p) => `${p.x},${p.y}`).join(" ");
  const gridLevels = [25, 50, 75, 100];

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[220px] mx-auto" data-testid="radar-chart-qol">
      {gridLevels.map((lvl) => {
        const pts = Array.from({ length: n }, (_, i) => pointAt(i, (radius * lvl) / 100));
        return <polygon key={lvl} points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={1} />;
      })}
      {Array.from({ length: n }, (_, i) => {
        const p = pointAt(i, radius);
        return <line key={i} x1={center} y1={center} x2={p.x} y2={p.y} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />;
      })}
      <polygon points={dataPath} fill="rgba(244,114,182,0.25)" stroke="rgb(244,114,182)" strokeWidth={2} />
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} fill="rgb(244,114,182)" />
      ))}
      {labels.map((label, i) => {
        const p = pointAt(i, radius + 22);
        return (
          <text key={label} x={p.x} y={p.y} fontSize={9} fill="rgb(148,163,184)" textAnchor="middle" dominantBaseline="middle">
            {label}
          </text>
        );
      })}
    </svg>
  );
}

function QualityOfLifeSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/analytics/quality-of-life"],
    queryFn: () => apiRequest("GET", "/api/analytics/quality-of-life").then((r) => r.json()) as Promise<QualityOfLife>,
  });
  const { data: cohort } = useQuery({
    queryKey: ["/api/analytics/cohort-comparison"],
    queryFn: () => apiRequest("GET", "/api/analytics/cohort-comparison").then((r) => r.json()) as Promise<CohortComparison>,
  });
  const { data: forecast } = useQuery({
    queryKey: ["/api/analytics/month-end-forecast"],
    queryFn: () => apiRequest("GET", "/api/analytics/month-end-forecast").then((r) => r.json()) as Promise<MonthEndForecast>,
  });

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-quality-of-life">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white flex items-center gap-2">
          <HeartPulse size={15} className="text-rose-400" />
          Baromètre qualité de vie
        </p>
        <SourceBadge source={data?.data_source} />
      </div>

      {isLoading && <Skeleton className="h-56 w-full rounded-xl" />}

      {data && (
        <div className="space-y-2">
          <div className="text-center">
            <p className="text-3xl font-bold text-white tabular-nums">
              {data.score_global}
              <span className="text-sm text-slate-500">/100</span>
            </p>
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-300">{data.qualification_fr}</p>
          </div>
          <RadarChart values={data.components.map((c) => c.score)} labels={data.components.map((c) => c.label_fr)} />
          <p className="text-[11px] text-slate-400 leading-snug">{data.advice_fr}</p>
        </div>
      )}

      {cohort && (
        <div className="rounded-lg bg-slate-800/50 p-3 space-y-1 text-[11px]">
          <p className="font-semibold text-slate-300 flex items-center gap-1.5">
            <Users size={12} />
            Comparaison à votre cohorte
          </p>
          <p className="text-slate-400">{cohort.cohort.label_fr}</p>
          <p className="text-slate-200">
            Vous : <span className="font-semibold">{cohort.user.avg_hourly_rate} €/h</span> · Cohorte :{" "}
            <span className="font-semibold">{cohort.cohort.avg_hourly_rate} €/h</span> · Percentile{" "}
            <span className="font-semibold text-emerald-300">{cohort.comparison.percentile_estimate}<sup>e</sup></span>
          </p>
          <p className="text-slate-400">{cohort.comparison.verdict_fr}</p>
        </div>
      )}

      {forecast && (
        <div className="rounded-lg bg-slate-800/50 p-3 space-y-1 text-[11px]">
          <p className="font-semibold text-slate-300 flex items-center gap-1.5">
            <TrendingUp size={12} />
            Prévision CA fin de mois
          </p>
          <p className="text-white text-base font-bold">{forecast.forecast_ca_eur} €</p>
          <p className="text-slate-400">{forecast.message_fr}</p>
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Page principale
// ═════════════════════════════════════════════════════════════════════════════
export default function AnalyticsPage() {
  return (
    <div className="p-4 space-y-4 pb-24" data-testid="page-analytics">
      <div>
        <h1 className="text-lg font-bold text-white flex items-center gap-2">
          <BarChart3 size={18} className="text-emerald-400" />
          Analytics BI
        </h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Analyse rétrospective avancée : cohorte, saisonnalité, corrélations, simulations et rapports automatiques.
        </p>
      </div>

      <DailyInsightSection />
      <ProfessionalizationSection />
      <RevenueDecompositionSection />
      <SeasonalitySection />
      <CorrelationsSection />
      <WhatIfSimulatorSection />
      <ReportsSection />
      <QualityOfLifeSection />
    </div>
  );
}
