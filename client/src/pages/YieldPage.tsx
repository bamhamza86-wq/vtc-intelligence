/**
 * YieldPage.tsx — Couche Yield Management (/#/yield)
 * ─────────────────────────────────────────────────────────────────────────────
 * 6 sections stackées (mobile-first) :
 *   1. Plateforme optimale maintenant (bandeau Uber/Bolt/Heetch/FreeNow)
 *   2. Projection fin de journée (progress bar + prévision €)
 *   3. Value/minute (indicateur temps réel + alerte)
 *   4. Taux d'acceptation cible (jauge + explication)
 *   5. Prix de réserve (curseur + explication + apply)
 *   6. Score qualité journée (radar chart CSS pur)
 *
 * Backend : server/yieldEngine.ts (10 endpoints /api/platforms/optimal-mix,
 * /api/economics/dead-mileage, /api/economics/day-projection,
 * /api/economics/marginal-value, /api/economics/day-quality-score,
 * /api/yield/optimal-acceptance-rate, /api/yield/ride-mix,
 * /api/yield/reserve-price, /api/yield/over-selective-alert,
 * /api/yield/always-on-simulator).
 * Aucune nouvelle dépendance npm — radar chart en CSS/SVG pur.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Zap, TrendingUp, TrendingDown, Clock, Target, DollarSign,
  Gauge, AlertTriangle, CheckCircle2, Route, Layers, Sparkles,
} from "lucide-react";

// ─── Types (alignés sur yieldEngine.ts) ─────────────────────────────────────

interface PlatformMixEntry {
  platform: string;
  label: string;
  score: number;
  commission_pct: number;
  boost_pct: number;
  surge_multiplier: number;
  estimated_wait_min: number;
  net_hourly_historical: number;
  recommended: boolean;
  reason_fr: string;
}
interface OptimalMixResult {
  best_platform: string;
  entries: PlatformMixEntry[];
  computed_at: string;
}
interface DayProjection {
  elapsed_hours: number;
  target_hours: number;
  progress_pct: number;
  current_net_eur: number;
  current_hourly_rate: number;
  projected_final_net_eur: number;
  projected_vs_target_pct: number;
  message_fr: string;
}
interface MarginalValueResult {
  last_60min_hourly_rate: number;
  shift_avg_hourly_rate: number;
  delta_pct: number;
  is_declining: boolean;
  alert_fr: string | null;
}
interface OptimalAcceptanceRate {
  platform: string;
  optimal_min_pct: number;
  optimal_max_pct: number;
  current_estimated_pct: number | null;
  status: "trop_bas" | "optimal" | "trop_haut" | "inconnu";
  recommendation_fr: string;
}
interface ReservePriceResult {
  reserve_price_eur_per_hour: number;
  base_break_even: number;
  fatigue_adjustment_eur: number;
  fill_rate_adjustment_eur: number;
  hour_adjustment_eur: number;
  explanation_fr: string;
}
interface DayQualityScore {
  score_global: number;
  components: {
    hourly_rate: { value: number; score: number };
    dead_mileage: { value_km: number; score: number };
    fatigue: { value_risk: number; score: number };
    stress: { value: number; score: number };
  };
  qualification_fr: "excellente" | "bonne" | "correcte" | "difficile";
  message_fr: string;
}

// ─── Logos couleur par plateforme (pastilles simples, pas d'images externes) ───
const PLATFORM_COLOR: Record<string, string> = {
  uber: "bg-black text-white border-white/20",
  bolt: "bg-emerald-500/20 text-emerald-300 border-emerald-400/40",
  heetch: "bg-pink-500/20 text-pink-300 border-pink-400/40",
  freenow: "bg-sky-500/20 text-sky-300 border-sky-400/40",
};

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 70 ? "text-emerald-400" : score >= 45 ? "text-amber-400" : "text-red-400";
  return <span className={`font-bold tabular-nums ${color}`}>{score}/100</span>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 1 — Plateforme optimale maintenant
// ═════════════════════════════════════════════════════════════════════════════
function OptimalPlatformSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["/api/platforms/optimal-mix"],
    queryFn: () => apiRequest("GET", "/api/platforms/optimal-mix").then((r) => r.json()) as Promise<OptimalMixResult>,
    refetchInterval: 30_000,
  });

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-optimal-platform">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <Zap size={15} className="text-amber-400" />
        Plateforme optimale maintenant
      </p>

      {isLoading && <Skeleton className="h-32 w-full rounded-xl" />}
      {isError && <p className="text-xs text-red-400">Impossible de calculer le mix plateforme pour le moment.</p>}

      {data && (
        <div className="space-y-2">
          {data.entries.map((e) => (
            <div
              key={e.platform}
              data-testid={`platform-card-${e.platform}`}
              className={`rounded-xl border p-3 space-y-1.5 transition-all ${
                e.recommended
                  ? "border-amber-400/50 bg-amber-500/10 ring-1 ring-amber-400/30"
                  : "border-white/10 bg-slate-800/40"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full border text-[11px] font-bold ${PLATFORM_COLOR[e.platform] ?? "bg-slate-700 text-white border-white/20"}`}>
                    {e.label}
                  </span>
                  {e.recommended && (
                    <span className="text-[10px] font-semibold text-amber-300 flex items-center gap-1">
                      <CheckCircle2 size={11} /> Recommandé
                    </span>
                  )}
                </div>
                <ScoreBadge score={e.score} />
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-400">
                <span>Commission <b className="text-slate-200">{e.commission_pct}%</b></span>
                <span>Surge <b className="text-slate-200">x{e.surge_multiplier}</b></span>
                <span>Attente <b className="text-slate-200">{e.estimated_wait_min} min</b></span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className={`h-full rounded-full ${e.recommended ? "bg-amber-400" : "bg-slate-500"}`}
                  style={{ width: `${e.score}%` }}
                />
              </div>
              <p className="text-[10px] text-slate-500 leading-snug">{e.reason_fr}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 2 — Projection fin de journée
// ═════════════════════════════════════════════════════════════════════════════
function DayProjectionSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/economics/day-projection"],
    queryFn: () => apiRequest("GET", "/api/economics/day-projection").then((r) => r.json()) as Promise<DayProjection>,
    refetchInterval: 60_000,
  });

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-day-projection">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <TrendingUp size={15} className="text-emerald-400" />
        Projection fin de journée
      </p>

      {isLoading && <Skeleton className="h-24 w-full rounded-xl" />}

      {data && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>{data.elapsed_hours}h écoulées / {data.target_hours}h visées</span>
            <span className="tabular-nums font-semibold text-slate-200">{data.progress_pct}%</span>
          </div>
          <div className="h-3 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-sky-500 transition-all"
              style={{ width: `${data.progress_pct}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-slate-800/50 p-2.5 text-center">
              <p className="text-[10px] text-slate-500">Net actuel</p>
              <p className="text-base font-bold text-white tabular-nums">{data.current_net_eur} €</p>
            </div>
            <div className="rounded-lg bg-slate-800/50 p-2.5 text-center">
              <p className="text-[10px] text-slate-500">Prévision fin de journée</p>
              <p className="text-base font-bold text-emerald-300 tabular-nums">{data.projected_final_net_eur} €</p>
            </div>
          </div>
          <p className="text-[11px] text-slate-400 leading-snug">{data.message_fr}</p>
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 3 — Value/minute
// ═════════════════════════════════════════════════════════════════════════════
function MarginalValueSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/economics/marginal-value"],
    queryFn: () => apiRequest("GET", "/api/economics/marginal-value").then((r) => r.json()) as Promise<MarginalValueResult>,
    refetchInterval: 30_000,
  });

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-marginal-value">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <Clock size={15} className="text-sky-400" />
        Value / minute (60 dernières minutes)
      </p>

      {isLoading && <Skeleton className="h-16 w-full rounded-xl" />}

      {data && (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-slate-800/50 p-2.5 text-center">
              <p className="text-[10px] text-slate-500">60 dernières min</p>
              <p className="text-base font-bold text-white tabular-nums">{data.last_60min_hourly_rate} €/h</p>
            </div>
            <div className="rounded-lg bg-slate-800/50 p-2.5 text-center">
              <p className="text-[10px] text-slate-500">Moyenne du shift</p>
              <p className="text-base font-bold text-slate-300 tabular-nums">{data.shift_avg_hourly_rate} €/h</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            {data.delta_pct >= 0 ? (
              <TrendingUp size={13} className="text-emerald-400" />
            ) : (
              <TrendingDown size={13} className="text-red-400" />
            )}
            <span className={data.delta_pct >= 0 ? "text-emerald-400" : "text-red-400"}>
              {data.delta_pct >= 0 ? "+" : ""}{data.delta_pct}% vs moyenne
            </span>
          </div>
          {data.alert_fr && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-2.5 flex items-start gap-2">
              <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-200 leading-snug">{data.alert_fr}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 4 — Taux d'acceptation cible
// ═════════════════════════════════════════════════════════════════════════════
const PLATFORMS = ["uber", "bolt", "heetch", "freenow"];
const PLATFORM_LABEL: Record<string, string> = { uber: "Uber", bolt: "Bolt", heetch: "Heetch", freenow: "FreeNow" };

function AcceptanceRateSection() {
  const [platform, setPlatform] = useState("uber");
  const [currentPct, setCurrentPct] = useState(85);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/yield/optimal-acceptance-rate", platform, currentPct],
    queryFn: () =>
      apiRequest("GET", `/api/yield/optimal-acceptance-rate?platform=${platform}&current_pct=${currentPct}`).then((r) =>
        r.json()
      ) as Promise<OptimalAcceptanceRate>,
  });

  const statusColor =
    data?.status === "optimal" ? "text-emerald-400" : data?.status === "inconnu" ? "text-slate-400" : "text-amber-400";

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-acceptance-rate">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <Target size={15} className="text-indigo-400" />
        Taux d'acceptation cible
      </p>

      <div className="flex flex-wrap gap-2">
        {PLATFORMS.map((p) => (
          <button
            key={p}
            onClick={() => setPlatform(p)}
            data-testid={`button-platform-${p}`}
            className={`tap-target px-3 py-2 rounded-xl border text-xs font-medium transition-colors active:scale-95 ${
              platform === p ? "border-indigo-400/50 bg-indigo-500/15 text-indigo-200" : "border-white/10 bg-slate-800/50 text-slate-400"
            }`}
            style={{ minHeight: 44 }}
          >
            {PLATFORM_LABEL[p]}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>Votre taux d'acceptation estimé</span>
          <span className="tabular-nums font-semibold text-white">{currentPct}%</span>
        </div>
        <Slider
          value={[currentPct]}
          min={0}
          max={100}
          step={1}
          onValueChange={(v) => setCurrentPct(v[0])}
          data-testid="slider-acceptance-rate"
        />
      </div>

      {isLoading && <Skeleton className="h-16 w-full rounded-xl" />}

      {data && (
        <div className="space-y-2">
          {/* Jauge visuelle : zone optimale mise en évidence */}
          <div className="relative h-3 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="absolute inset-y-0 bg-emerald-500/30"
              style={{ left: `${data.optimal_min_pct}%`, width: `${data.optimal_max_pct - data.optimal_min_pct}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-1.5 h-4 rounded-full bg-white shadow"
              style={{ left: `calc(${currentPct}% - 3px)` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-slate-500">
            <span>0%</span>
            <span className="text-emerald-400">Zone optimale {data.optimal_min_pct}-{data.optimal_max_pct}%</span>
            <span>100%</span>
          </div>
          <p className={`text-[11px] leading-snug ${statusColor}`}>{data.recommendation_fr}</p>
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 5 — Prix de réserve dynamique
// ═════════════════════════════════════════════════════════════════════════════
function ReservePriceSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/yield/reserve-price"],
    queryFn: () => apiRequest("GET", "/api/yield/reserve-price").then((r) => r.json()) as Promise<ReservePriceResult>,
  });
  const [applied, setApplied] = useState(false);

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-reserve-price">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <DollarSign size={15} className="text-emerald-400" />
        Prix de réserve dynamique
      </p>

      {isLoading && <Skeleton className="h-24 w-full rounded-xl" />}

      {data && (
        <div className="space-y-3">
          <div className="text-center rounded-xl bg-slate-800/50 p-3">
            <p className="text-[10px] text-slate-500">N'acceptez pas de course sous</p>
            <p className="text-2xl font-bold text-emerald-300 tabular-nums">{data.reserve_price_eur_per_hour} €/h</p>
          </div>

          <div className="space-y-1 text-[11px] text-slate-400">
            <div className="flex justify-between"><span>Seuil de rentabilité de base</span><span className="tabular-nums text-slate-200">{data.base_break_even} €/h</span></div>
            <div className="flex justify-between"><span>Ajustement fatigue</span><span className="tabular-nums text-slate-200">{data.fatigue_adjustment_eur >= 0 ? "+" : ""}{data.fatigue_adjustment_eur} €/h</span></div>
            <div className="flex justify-between"><span>Ajustement remplissage du shift</span><span className="tabular-nums text-slate-200">{data.fill_rate_adjustment_eur >= 0 ? "+" : ""}{data.fill_rate_adjustment_eur} €/h</span></div>
            <div className="flex justify-between"><span>Ajustement créneau horaire</span><span className="tabular-nums text-slate-200">{data.hour_adjustment_eur >= 0 ? "+" : ""}{data.hour_adjustment_eur} €/h</span></div>
          </div>

          <p className="text-[11px] text-slate-400 leading-snug">{data.explanation_fr}</p>

          <Button
            className="w-full h-11"
            variant={applied ? "secondary" : "default"}
            onClick={() => setApplied(true)}
            data-testid="button-apply-reserve-price"
          >
            {applied ? "Seuil appliqué pour ce shift ✓" : "Appliquer ce seuil pour mon shift"}
          </Button>
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 6 — Score qualité journée (radar chart CSS/SVG pur)
// ═════════════════════════════════════════════════════════════════════════════
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
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[240px] mx-auto" data-testid="radar-chart-quality">
      {/* Grille */}
      {gridLevels.map((lvl) => {
        const pts = Array.from({ length: n }, (_, i) => pointAt(i, (radius * lvl) / 100));
        return (
          <polygon
            key={lvl}
            points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
          />
        );
      })}
      {/* Axes */}
      {Array.from({ length: n }, (_, i) => {
        const p = pointAt(i, radius);
        return <line key={i} x1={center} y1={center} x2={p.x} y2={p.y} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />;
      })}
      {/* Zone de données */}
      <polygon points={dataPath} fill="rgba(52,211,153,0.25)" stroke="rgb(52,211,153)" strokeWidth={2} />
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} fill="rgb(52,211,153)" />
      ))}
      {/* Labels */}
      {labels.map((label, i) => {
        const p = pointAt(i, radius + 22);
        return (
          <text
            key={label}
            x={p.x}
            y={p.y}
            fontSize={9}
            fill="rgb(148,163,184)"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}

function clamp01(n: number) {
  return Math.max(0, Math.min(100, n));
}

function DayQualitySection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/economics/day-quality-score"],
    queryFn: () => apiRequest("GET", "/api/economics/day-quality-score").then((r) => r.json()) as Promise<DayQualityScore>,
    refetchInterval: 60_000,
  });

  const qualifColor: Record<string, string> = {
    excellente: "text-emerald-400",
    bonne: "text-sky-400",
    correcte: "text-amber-400",
    difficile: "text-red-400",
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-day-quality">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <Sparkles size={15} className="text-amber-400" />
        Score qualité journée
      </p>

      {isLoading && <Skeleton className="h-48 w-full rounded-xl" />}

      {data && (
        <div className="space-y-3">
          <div className="text-center">
            <p className="text-3xl font-bold text-white tabular-nums">{data.score_global}<span className="text-sm text-slate-500">/100</span></p>
            <p className={`text-xs font-semibold uppercase tracking-wide ${qualifColor[data.qualification_fr]}`}>{data.qualification_fr}</p>
          </div>

          <RadarChart
            values={[
              data.components.hourly_rate.score,
              data.components.dead_mileage.score,
              data.components.fatigue.score,
              data.components.stress.score,
            ]}
            labels={["€/h", "Dead-mileage", "Fatigue", "Stress"]}
          />

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-lg bg-slate-800/50 p-2">
              <p className="text-slate-500">€/h</p>
              <p className="font-semibold text-slate-200 tabular-nums">{data.components.hourly_rate.value} €/h</p>
            </div>
            <div className="rounded-lg bg-slate-800/50 p-2">
              <p className="text-slate-500">Dead-mileage</p>
              <p className="font-semibold text-slate-200 tabular-nums">{data.components.dead_mileage.value_km} km</p>
            </div>
            <div className="rounded-lg bg-slate-800/50 p-2">
              <p className="text-slate-500">Risque fatigue</p>
              <p className="font-semibold text-slate-200 tabular-nums">{data.components.fatigue.value_risk}%</p>
            </div>
            <div className="rounded-lg bg-slate-800/50 p-2">
              <p className="text-slate-500">Stress (courses à perte)</p>
              <p className="font-semibold text-slate-200 tabular-nums">{data.components.stress.value}%</p>
            </div>
          </div>

          <p className="text-[11px] text-slate-400 leading-snug">{data.message_fr}</p>
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Page principale
// ═════════════════════════════════════════════════════════════════════════════
export default function YieldPage() {
  return (
    <div className="p-4 space-y-4 pb-24" data-testid="page-yield">
      <div>
        <h1 className="text-lg font-bold text-white flex items-center gap-2">
          <Gauge size={18} className="text-amber-400" />
          Yield Management
        </h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Arbitrage plateforme, projection de journée, prix de réserve et score qualité — pilotez votre rendement en temps réel.
        </p>
      </div>

      <OptimalPlatformSection />
      <DayProjectionSection />
      <MarginalValueSection />
      <AcceptanceRateSection />
      <ReservePriceSection />
      <DayQualitySection />
    </div>
  );
}
