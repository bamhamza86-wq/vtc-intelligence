/**
 * CoachPage.tsx — Couche Coach IA Économique + Gamification (/coach)
 * ─────────────────────────────────────────────────────────────────────────────
 * Sections :
 *  1. « Brief du matin » — bouton play → SpeechSynthesis native (GET /api/voice/morning-brief)
 *  2. « Ma santé business » — dashboard KPI, peer comparison, score /100
 *     (GET /api/health/business-kpis, /api/health/peer-benchmark, /api/health/perf-score)
 *  3. « Records personnels » — podium des meilleures perfs (GET /api/analytics/personal-records)
 *  4. « Courbe d'apprentissage » — mini chart SVG pur, pas de lib
 *     (GET /api/analytics/learning-curve)
 *  5. « Défi de la semaine » — carte défi actif + progress (GET /api/gamif/weekly-challenge)
 *  6. « Coach — Posez une question » — réutilise le composant CoachSidebar existant
 *
 * SpeechSynthesis Web API native (aucune dépendance npm). UI 100% française,
 * cibles tactiles ≥ 44px. Backend : healthMetrics.ts / coachEngine.ts / gamifEcon.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Mic, Trophy, TrendingUp, Target, Bell, Volume2, Sparkles,
  Sunrise, Moon, Award, LineChart as LineChartIcon, Flame, Play, Square,
} from "lucide-react";
import { CoachSidebar } from "@/components/CoachSidebar";

// ─── Types (alignés sur les réponses serveur healthMetrics.ts / coachEngine.ts / gamifEcon.ts) ───

interface BusinessKpiWindow {
  window_days: number;
  net_per_hour: number;
  net_per_km: number;
  rides_count: number;
  accept_rate_pct: number | null;
  cancel_rate_pct: number | null;
  avg_rating: number | null;
  productive_ratio_pct: number;
  dead_km_ratio_pct: number;
}

interface BusinessKpisResponse {
  windows: { "7j": BusinessKpiWindow; "30j": BusinessKpiWindow; "90j": BusinessKpiWindow };
  trend_7_vs_30_pct: number | null;
  trend_30_vs_90_pct: number | null;
}

interface PeerBenchmarkEcon {
  my_net_per_hour: number;
  median_net_per_hour: number | null;
  top25_net_per_hour: number | null;
  percentile_estimate: number | null;
  k_anonymity: number;
  disclaimer: string;
}

interface PerfScoreResponse {
  score: number;
  components: { profitability: number; efficiency: number; consistency: number; trend: number };
  label_fr: string;
  advice_fr: string;
}

interface MorningBriefResponse {
  text: string;
  generated_at: string;
}

interface PersonalRecord {
  metric: string;
  label_fr: string;
  value: number;
  date_achieved: string;
}

interface LearningCurvePoint {
  period_label: string;
  net_per_hour: number;
  rides_count: number;
}

interface LearningCurveResponse {
  points: LearningCurvePoint[];
  trend_fr: string;
}

interface WeeklyChallengeResponse {
  label_fr: string;
  current_value: number;
  target_value: number;
  baseline_value: number;
  progress_pct: number;
  completed: boolean;
  reward_icon: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await apiRequest("GET", url);
  return (await res.json()) as T;
}

function ScoreRing({ score }: { score: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100);
  const color = score >= 80 ? "#34d399" : score >= 60 ? "#60a5fa" : score >= 40 ? "#fbbf24" : "#f87171";

  return (
    <svg width="100" height="100" viewBox="0 0 100 100" className="shrink-0">
      <circle cx="50" cy="50" r={radius} fill="none" stroke="#1e293b" strokeWidth="10" />
      <circle
        cx="50" cy="50" r={radius} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="47" textAnchor="middle" className="fill-white text-2xl font-bold" style={{ fontSize: 22 }}>
        {score}
      </text>
      <text x="50" y="64" textAnchor="middle" className="fill-slate-400" style={{ fontSize: 9 }}>
        / 100
      </text>
    </svg>
  );
}

/** Mini graphique SVG pur (polyline) — aucune librairie de chart. */
function LearningCurveChart({ points }: { points: LearningCurvePoint[] }) {
  if (points.length < 2) {
    return <p className="text-xs text-slate-500 italic py-6 text-center">Pas encore assez d'historique pour tracer une courbe.</p>;
  }

  const width = 320;
  const height = 100;
  const padding = 8;
  const values = points.map((p) => p.net_per_hour);
  const maxV = Math.max(...values, 1);
  const minV = Math.min(...values, 0);
  const range = Math.max(1, maxV - minV);

  const coords = points.map((p, i) => {
    const x = padding + (i / (points.length - 1)) * (width - padding * 2);
    const y = height - padding - ((p.net_per_hour - minV) / range) * (height - padding * 2);
    return { x, y, p };
  });

  const polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-28" preserveAspectRatio="none" data-testid="learning-curve-svg">
      <polyline points={polylinePoints} fill="none" stroke="#818cf8" strokeWidth="2" />
      {coords.map((c, i) => (
        <circle key={i} cx={c.x} cy={c.y} r={i === coords.length - 1 ? 3.5 : 2} fill={i === coords.length - 1 ? "#a5b4fc" : "#6366f1"} />
      ))}
    </svg>
  );
}

// ─── Section 1 : Brief du matin (SpeechSynthesis native) ───────────────────

function MorningBriefSection() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/voice/morning-brief"],
    queryFn: () => fetchJson<MorningBriefResponse>("/api/voice/morning-brief"),
  });

  function speak() {
    if (!data?.text) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(data.text);
    utter.lang = "fr-FR";
    utter.rate = 1.0;
    utter.onend = () => setIsSpeaking(false);
    utter.onerror = () => setIsSpeaking(false);
    utterRef.current = utter;
    window.speechSynthesis.speak(utter);
    setIsSpeaking(true);
  }

  function stop() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-morning-brief">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <Sunrise size={15} className="text-amber-400" />
        Brief du matin
      </p>

      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <p className="text-xs text-slate-300 leading-relaxed">{data?.text}</p>
      )}

      <button
        onClick={isSpeaking ? stop : speak}
        disabled={!data?.text}
        className="tap-target flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500/15 border border-amber-400/40 text-amber-200 text-sm font-medium active:scale-95 transition-transform disabled:opacity-40"
        style={{ minHeight: 44 }}
        data-testid="button-play-morning-brief"
      >
        {isSpeaking ? <Square size={16} /> : <Play size={16} />}
        {isSpeaking ? "Arrêter" : "Écouter le brief"}
        <Volume2 size={14} className="ml-auto opacity-60" />
      </button>
    </section>
  );
}

// ─── Section 2 : Ma santé business (KPI + peer + score) ────────────────────

function HealthBusinessSection() {
  const kpis = useQuery({
    queryKey: ["/api/health/business-kpis"],
    queryFn: () => fetchJson<BusinessKpisResponse>("/api/health/business-kpis"),
  });
  const peer = useQuery({
    queryKey: ["/api/health/peer-benchmark"],
    queryFn: () => fetchJson<PeerBenchmarkEcon>("/api/health/peer-benchmark"),
  });
  const score = useQuery({
    queryKey: ["/api/health/perf-score"],
    queryFn: () => fetchJson<PerfScoreResponse>("/api/health/perf-score"),
  });

  const w7 = kpis.data?.windows["7j"];

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-4" data-testid="section-health-business">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <TrendingUp size={15} className="text-emerald-400" />
        Ma santé business
      </p>

      {/* Score global */}
      <div className="flex items-center gap-4">
        {score.isLoading ? (
          <Skeleton className="h-24 w-24 rounded-full" />
        ) : score.data ? (
          <ScoreRing score={score.data.score} />
        ) : null}
        <div className="space-y-1 flex-1 min-w-0">
          <p className="text-sm font-semibold text-white">{score.data?.label_fr ?? "—"}</p>
          <p className="text-[11px] text-slate-400 leading-snug">{score.data?.advice_fr}</p>
        </div>
      </div>

      {/* KPI 7j */}
      {kpis.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : w7 ? (
        <div className="grid grid-cols-2 gap-2 text-xs" data-testid="kpi-grid-7j">
          <div className="rounded-lg bg-slate-800/60 p-2.5">
            <p className="text-slate-500">€/h net (7j)</p>
            <p className="text-base font-bold text-emerald-300 tabular-nums">{w7.net_per_hour} €</p>
          </div>
          <div className="rounded-lg bg-slate-800/60 p-2.5">
            <p className="text-slate-500">€/km net (7j)</p>
            <p className="text-base font-bold text-sky-300 tabular-nums">{w7.net_per_km} €</p>
          </div>
          <div className="rounded-lg bg-slate-800/60 p-2.5">
            <p className="text-slate-500">Km à vide</p>
            <p className="text-base font-bold text-amber-300 tabular-nums">{w7.dead_km_ratio_pct}%</p>
          </div>
          <div className="rounded-lg bg-slate-800/60 p-2.5">
            <p className="text-slate-500">Courses (7j)</p>
            <p className="text-base font-bold text-white tabular-nums">{w7.rides_count}</p>
          </div>
        </div>
      ) : null}

      {/* Peer comparison */}
      {peer.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : peer.data && peer.data.median_net_per_hour != null ? (
        <div className="rounded-lg bg-slate-800/40 p-2.5 text-[11px] text-slate-300 space-y-1" data-testid="peer-comparison">
          <p>
            Votre €/h : <span className="font-semibold text-white">{peer.data.my_net_per_hour} €</span> — médiane : {peer.data.median_net_per_hour} € — top 25% : {peer.data.top25_net_per_hour} €
          </p>
          {peer.data.percentile_estimate != null && (
            <p className="text-emerald-300">Vous êtes au {peer.data.percentile_estimate}ᵉ percentile de votre historique.</p>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-slate-500 italic">{peer.data?.disclaimer ?? "Comparaison anonyme indisponible pour le moment."}</p>
      )}
    </section>
  );
}

// ─── Section 3 : Records personnels (podium) ───────────────────────────────

function PersonalRecordsSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/analytics/personal-records"],
    queryFn: () => fetchJson<PersonalRecord[]>("/api/analytics/personal-records"),
  });

  const medalColors = ["text-amber-300", "text-slate-300", "text-orange-400"];

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-personal-records">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <Trophy size={15} className="text-amber-400" />
        Records personnels
      </p>

      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : !data || data.length === 0 ? (
        <p className="text-xs text-slate-500 italic">Pas encore de record enregistré — continuez à rouler !</p>
      ) : (
        <div className="space-y-2">
          {data.map((r, i) => (
            <div key={r.metric} className="flex items-center gap-3 rounded-lg bg-slate-800/50 p-2.5" data-testid={`record-${r.metric}`}>
              <Award size={18} className={medalColors[i] ?? "text-slate-500"} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-white truncate">{r.label_fr}</p>
                <p className="text-[10px] text-slate-500">{new Date(r.date_achieved).toLocaleDateString("fr-FR")}</p>
              </div>
              <p className="text-sm font-bold text-emerald-300 tabular-nums">{r.value}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Section 4 : Courbe d'apprentissage ────────────────────────────────────

function LearningCurveSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/analytics/learning-curve"],
    queryFn: () => fetchJson<LearningCurveResponse>("/api/analytics/learning-curve"),
  });

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-learning-curve">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <LineChartIcon size={15} className="text-indigo-400" />
        Courbe d'apprentissage
      </p>
      {isLoading ? <Skeleton className="h-28 w-full" /> : <LearningCurveChart points={data?.points ?? []} />}
      {data?.trend_fr && <p className="text-[11px] text-slate-400">{data.trend_fr}</p>}
    </section>
  );
}

// ─── Section 5 : Défi de la semaine ─────────────────────────────────────────

function WeeklyChallengeSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/gamif/weekly-challenge"],
    queryFn: () => fetchJson<WeeklyChallengeResponse | null>("/api/gamif/weekly-challenge"),
  });

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="section-weekly-challenge">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <Target size={15} className="text-rose-400" />
        Défi de la semaine
      </p>

      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : !data ? (
        <p className="text-xs text-slate-500 italic">Aucun défi actif pour le moment.</p>
      ) : (
        <div className="space-y-2" data-testid="weekly-challenge-card">
          <p className="text-xs text-slate-200 flex items-center gap-2">
            <span className="text-lg">{data.reward_icon}</span>
            {data.label_fr}
          </p>
          <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full ${data.completed ? "bg-emerald-500" : "bg-gradient-to-r from-rose-500 to-amber-400"}`}
              style={{ width: `${Math.max(4, data.progress_pct)}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>{data.current_value} / {data.target_value}</span>
            <span className={data.completed ? "text-emerald-300 font-semibold flex items-center gap-1" : ""}>
              {data.completed ? (<><Flame size={12} /> Complété !</>) : `${data.progress_pct}%`}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Page principale ─────────────────────────────────────────────────────────

export default function CoachPage() {
  return (
    <div className="p-4 space-y-4 pb-24" data-testid="page-coach">
      <div>
        <h1 className="text-lg font-bold text-white flex items-center gap-2">
          <Sparkles size={18} className="text-indigo-400" />
          Coach IA & Gamification
        </h1>
        <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-1.5">
          <Mic size={12} />
          Votre coach économique personnel — briefs vocaux, santé business, défis et records.
        </p>
      </div>

      <MorningBriefSection />
      <HealthBusinessSection />
      <PersonalRecordsSection />
      <LearningCurveSection />
      <WeeklyChallengeSection />

      <CoachSidebar title="Coach — Posez une question" />

      <p className="text-[10px] text-slate-600 flex items-center gap-1 justify-center pt-2">
        <Bell size={10} />
        Notifications adaptées à votre conduite — jamais de distraction au volant.
      </p>
    </div>
  );
}
