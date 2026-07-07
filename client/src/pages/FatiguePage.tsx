/**
 * FatiguePage.tsx — Fatigue Coach avancé (Itération 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Rapport §5 (Sécurité et fatigue) + §2 (ML personnel) :
 *   - Courbe personnelle de vigilance par heure (§5.7, §2.12)
 *   - Historique des pauses prises
 *   - Test de réaction interactif (5s, tap sur cible)
 *   - Coach conversationnel (message du moment + niveau de risque)
 *
 * Honnêteté technique : aucun capteur caméra/oculaire. Score basé sur des
 * proxys comportementaux (latence de tap, temps de décision, variance
 * gyro/accéléro, cycle circadien, durée de shift). Toujours présenté comme
 * une ESTIMATION, jamais comme une détection médicale.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Moon, Coffee, Target, AlertTriangle, Info, CheckCircle2, TrendingUp, Timer,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface MicrosleepRisk {
  risk: number;
  indicators: string[];
  confidence: number;
  next_break_recommended_min: number;
}

interface CoachMessage {
  message_fr: string;
  urgency: "info" | "attention" | "urgent";
  action_fr: string;
  expected_gain_fr: string;
}

interface PersonalCurvePoint {
  hour: number;
  avg_tap_latency_ms: number | null;
  avg_decision_time_ms: number | null;
  sample_count: number;
  vigilance_score: number;
}

interface PersonalCurveResponse {
  curve: PersonalCurvePoint[];
  insight_fr: string;
  sample_days: number;
}

interface RestEntry {
  id: number;
  start_ts: string;
  duration_min: number;
  break_type: string;
}

interface ReactionResult {
  latency_ms: number;
  baseline_avg_ms: number;
  delta_pct: number;
  hits: number;
  misses: number;
  verdict_fr: string;
}

const RISK_LABEL: Record<string, { label: string; color: string; icon: JSX.Element }> = {
  low: { label: "Vigilance correcte", color: "text-emerald-500", icon: <CheckCircle2 size={18} className="text-emerald-500" /> },
  medium: { label: "Vigilance à surveiller", color: "text-amber-500", icon: <Info size={18} className="text-amber-500" /> },
  high: { label: "Fatigue probable", color: "text-red-500", icon: <AlertTriangle size={18} className="text-red-500" /> },
};

function riskBand(risk: number): "low" | "medium" | "high" {
  if (risk >= 0.5) return "high";
  if (risk >= 0.25) return "medium";
  return "low";
}

// ─────────────────────────────────────────────────────────────────────────────
// Mini courbe SVG (aucune dépendance graphique, cohérent avec le reste du repo)
// ─────────────────────────────────────────────────────────────────────────────
function VigilanceCurveSvg({ curve }: { curve: PersonalCurvePoint[] }) {
  const width = 320;
  const height = 120;
  const padding = 8;
  const usable = curve.filter((c) => c.sample_count > 0);

  const points = curve.map((c, i) => {
    const x = padding + (i / 23) * (width - 2 * padding);
    const y = height - padding - c.vigilance_score * (height - 2 * padding);
    return { x, y, hasData: c.sample_count > 0 };
  });

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-28" role="img" aria-label="Courbe de vigilance personnelle par heure de la journée">
      {/* Grille horaire légère (0h, 6h, 12h, 18h) */}
      {[0, 6, 12, 18].map((h) => (
        <line
          key={h}
          x1={padding + (h / 23) * (width - 2 * padding)}
          y1={0}
          x2={padding + (h / 23) * (width - 2 * padding)}
          y2={height}
          stroke="currentColor"
          strokeOpacity={0.08}
        />
      ))}
      {usable.length >= 2 && (
        <path d={pathD} fill="none" stroke="#38bdf8" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {points.map((p, i) =>
        p.hasData ? <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="#38bdf8" /> : null
      )}
      {/* Labels heures */}
      {[0, 6, 12, 18].map((h) => (
        <text
          key={`label-${h}`}
          x={padding + (h / 23) * (width - 2 * padding)}
          y={height - 1}
          fontSize={9}
          fill="currentColor"
          fillOpacity={0.5}
          textAnchor="middle"
        >
          {h}h
        </text>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test de réaction interactif (5s, tap sur cible)
// ─────────────────────────────────────────────────────────────────────────────
function ReactionTest({ onResult }: { onResult: (r: ReactionResult) => void }) {
  const [phase, setPhase] = useState<"idle" | "waiting" | "ready" | "done">("idle");
  const [targetPos, setTargetPos] = useState({ x: 50, y: 50 });
  const [latencies, setLatencies] = useState<number[]>([]);
  const [misses, setMisses] = useState(0);
  const appearTsRef = useRef<number>(0);
  const roundRef = useRef(0);
  const TOTAL_ROUNDS = 5;
  const timeoutRef = useRef<number | null>(null);

  function startTest() {
    setLatencies([]);
    setMisses(0);
    roundRef.current = 0;
    nextRound();
  }

  function nextRound() {
    if (roundRef.current >= TOTAL_ROUNDS) {
      finish();
      return;
    }
    setPhase("waiting");
    const delay = 800 + Math.random() * 2200; // apparition aléatoire pour éviter l'anticipation
    timeoutRef.current = window.setTimeout(() => {
      setTargetPos({ x: 15 + Math.random() * 70, y: 15 + Math.random() * 70 });
      appearTsRef.current = performance.now();
      setPhase("ready");
      // Timeout de 1.5s = raté si pas de tap
      timeoutRef.current = window.setTimeout(() => {
        setMisses((m) => m + 1);
        roundRef.current++;
        nextRound();
      }, 1500);
    }, delay);
  }

  function handleTap() {
    if (phase !== "ready") return;
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    const latency = performance.now() - appearTsRef.current;
    setLatencies((prev) => [...prev, latency]);
    roundRef.current++;
    nextRound();
  }

  function finish() {
    setPhase("done");
    const finalLatencies = latencies;
    if (finalLatencies.length === 0) {
      onResult({ latency_ms: 0, baseline_avg_ms: 0, delta_pct: 0, hits: 0, misses, verdict_fr: "Pas assez de données sur ce test." });
      return;
    }
    const avg = finalLatencies.reduce((a, b) => a + b, 0) / finalLatencies.length;
    const mean = avg;
    const variance = finalLatencies.reduce((a, b) => a + (b - mean) ** 2, 0) / finalLatencies.length;
    const std = Math.sqrt(variance);

    apiRequest("POST", "/api/fatigue/reaction-test", {
      latency_ms: Math.round(avg),
      latency_std_ms: Math.round(std),
      hits: finalLatencies.length,
      misses,
    })
      .then((r) => r.json())
      .then((data: ReactionResult) => onResult(data))
      .catch(() => {
        onResult({ latency_ms: Math.round(avg), baseline_avg_ms: Math.round(avg), delta_pct: 0, hits: finalLatencies.length, misses, verdict_fr: "Résultat local (hors ligne)." });
      });
  }

  useEffect(() => {
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  if (phase === "idle" || phase === "done") {
    return (
      <Button onClick={startTest} className="w-full" style={{ minHeight: 44 }} data-testid="button-start-reaction-test">
        <Timer size={16} className="mr-2" />
        {phase === "done" ? "Refaire le test" : "Lancer le test de réaction (5 tap, ~15s)"}
      </Button>
    );
  }

  return (
    <div
      className="relative w-full rounded-xl bg-slate-900 overflow-hidden"
      style={{ height: 220, touchAction: "none" }}
      data-testid="reaction-test-zone"
    >
      {phase === "waiting" && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
          Attends la cible…
        </div>
      )}
      {phase === "ready" && (
        <button
          onClick={handleTap}
          className="absolute rounded-full bg-sky-400 shadow-lg animate-pulse"
          style={{
            width: 48,
            height: 48,
            left: `calc(${targetPos.x}% - 24px)`,
            top: `calc(${targetPos.y}% - 24px)`,
          }}
          aria-label="Cible — tape maintenant"
          data-testid="reaction-target"
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page principale
// ─────────────────────────────────────────────────────────────────────────────
export default function FatiguePage() {
  const queryClient = useQueryClient();
  const [reactionResult, setReactionResult] = useState<ReactionResult | null>(null);
  const [restDuration, setRestDuration] = useState(15);

  const { data: risk, isLoading: riskLoading } = useQuery<MicrosleepRisk>({
    queryKey: ["/api/fatigue/microsleep-risk"],
    queryFn: () => apiRequest("GET", "/api/fatigue/microsleep-risk").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  const { data: coachMsg } = useQuery<CoachMessage>({
    queryKey: ["/api/fatigue/coach-message"],
    queryFn: () => apiRequest("GET", "/api/fatigue/coach-message").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  const { data: curveData, isLoading: curveLoading } = useQuery<PersonalCurveResponse>({
    queryKey: ["/api/fatigue/personal-curve"],
    queryFn: () => apiRequest("GET", "/api/fatigue/personal-curve").then((r) => r.json()),
  });

  const { data: restHistory } = useQuery<{ history: RestEntry[] }>({
    queryKey: ["/api/fatigue/rest-history"],
    queryFn: () => apiRequest("GET", "/api/fatigue/rest-history").then((r) => r.json()),
  });

  async function handleRestTaken(breakType: string) {
    try {
      await apiRequest("POST", "/api/fatigue/rest-taken", { duration_min: restDuration, break_type: breakType });
      queryClient.invalidateQueries({ queryKey: ["/api/fatigue/rest-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fatigue/microsleep-risk"] });
    } catch {
      // silencieux — pas de blocage UX
    }
  }

  const band = risk ? riskBand(risk.risk) : "low";
  const bandCfg = RISK_LABEL[band];

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Moon size={20} className="text-sky-400" />
          Fatigue Coach
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          Estimation basée sur ton comportement (tap, décisions, mouvement du téléphone) — pas de caméra, rien n'est enregistré visuellement.
        </p>
      </div>

      <div className="px-4 space-y-4">
        {/* ── Coach conversationnel ── */}
        <Card data-testid="card-coach-message">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              {bandCfg.icon}
              <span>{bandCfg.label}</span>
              {risk && (
                <Badge variant="outline" className="ml-auto text-[10px]">
                  Confiance {Math.round(risk.confidence * 100)}%
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {riskLoading || !coachMsg ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <div className="space-y-2">
                <p className="text-sm">{coachMsg.message_fr}</p>
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Coffee size={14} className="shrink-0 mt-0.5" />
                  <span>{coachMsg.action_fr}</span>
                </div>
                <p className="text-[11px] italic text-muted-foreground">{coachMsg.expected_gain_fr}</p>
                {risk && risk.indicators.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {risk.indicators.map((ind, i) => (
                      <li key={i} className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                        <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground shrink-0" />
                        {ind}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Pause rapide ── */}
        <Card data-testid="card-quick-rest">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Coffee size={16} />
              Je prends une pause
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              {[10, 15, 20, 30].map((min) => (
                <button
                  key={min}
                  onClick={() => setRestDuration(min)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium border ${
                    restDuration === min ? "bg-sky-500 text-white border-sky-500" : "border-border text-muted-foreground"
                  }`}
                  style={{ minHeight: 44, minWidth: 44 }}
                  data-testid={`button-rest-duration-${min}`}
                >
                  {min} min
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => handleRestTaken("aire_repos")} variant="secondary" style={{ minHeight: 44 }} data-testid="button-rest-aire">
                Aire de repos
              </Button>
              <Button onClick={() => handleRestTaken("parking")} variant="secondary" style={{ minHeight: 44 }} data-testid="button-rest-parking">
                Parking / arrêt
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Courbe personnelle ── */}
        <Card data-testid="card-personal-curve">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp size={16} />
              Ta courbe de vigilance
            </CardTitle>
          </CardHeader>
          <CardContent>
            {curveLoading || !curveData ? (
              <Skeleton className="h-28 w-full" />
            ) : (
              <>
                <VigilanceCurveSvg curve={curveData.curve} />
                <p className="text-xs text-muted-foreground mt-2">{curveData.insight_fr}</p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Basé sur {curveData.sample_days} jour{curveData.sample_days > 1 ? "s" : ""} de données.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Test de réaction ── */}
        <Card data-testid="card-reaction-test">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Target size={16} />
              Test de réaction
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ReactionTest onResult={setReactionResult} />
            {reactionResult && (
              <div className="rounded-lg bg-muted p-3 text-sm space-y-1" data-testid="reaction-result">
                <p className="font-medium">{reactionResult.verdict_fr}</p>
                <p className="text-xs text-muted-foreground">
                  Latence moyenne : {Math.round(reactionResult.latency_ms)} ms (baseline {Math.round(reactionResult.baseline_avg_ms)} ms,{" "}
                  {reactionResult.delta_pct > 0 ? "+" : ""}
                  {reactionResult.delta_pct}%)
                </p>
                <p className="text-xs text-muted-foreground">
                  {reactionResult.hits} touché{reactionResult.hits > 1 ? "s" : ""} / {reactionResult.misses} raté{reactionResult.misses > 1 ? "s" : ""}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Historique pauses ── */}
        <Card data-testid="card-rest-history">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Historique des pauses</CardTitle>
          </CardHeader>
          <CardContent>
            {!restHistory || restHistory.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune pause enregistrée pour l'instant.</p>
            ) : (
              <ul className="space-y-2">
                {restHistory.history.slice(0, 10).map((r) => (
                  <li key={r.id} className="flex items-center justify-between text-sm border-b border-border pb-2 last:border-0">
                    <span className="text-muted-foreground">
                      {new Date(r.start_ts).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span>{r.duration_min} min</span>
                    <Badge variant="outline" className="text-[10px]">
                      {r.break_type === "aire_repos" ? "Aire de repos" : r.break_type === "parking" ? "Parking" : r.break_type}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
