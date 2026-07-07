/**
 * MLInsightsPage.tsx — Couche ML Personnel Driver (page dédiée)
 * ─────────────────────────────────────────────────────────────────────────────
 * 4 sections : Patterns détectés / Anomalies récentes / Confiance du modèle /
 * Prochaine meilleure zone selon IA. Tout en français, mobile-first.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Brain, Sparkles, TrendingUp, TrendingDown, AlertTriangle, MapPin,
  CheckCircle2, XCircle, Gauge, CloudRain, CalendarClock,
} from "lucide-react";
import { SelfSabotageInsight } from "@/components/SelfSabotageInsight";

interface PatternResult {
  pattern_type: "weekday_hour_hotspot" | "weather_boost" | "event_hotspot";
  description_fr: string;
  confidence: number;
  action_hint: string;
}

interface AnomalyResult {
  type: "time_loss" | "expected_vs_real_gap" | "route_suboptimal" | "self_sabotage";
  where: string;
  when: string;
  magnitude: number;
  description_fr: string;
  suggested_action: string;
}

interface SelfEval {
  accuracy_7d: number;
  calibration_score: number;
  brier_score: number;
  honest_confidence: string;
}

interface NextZone {
  zone_id: string;
  name: string;
  expected_gain: number;
  exploration: boolean;
  reason: string;
  model: "cold_start" | "personal";
}

const PATTERN_ICON: Record<PatternResult["pattern_type"], typeof CalendarClock> = {
  weekday_hour_hotspot: CalendarClock,
  weather_boost: CloudRain,
  event_hotspot: Sparkles,
};

const ANOMALY_LABEL: Record<AnomalyResult["type"], string> = {
  time_loss: "Perte de temps",
  expected_vs_real_gap: "Écart prédiction / réalité",
  route_suboptimal: "Itinéraire sous-optimal",
  self_sabotage: "Auto-sabotage",
};

function confidencePct(c: number): number {
  return Math.round(c * 100);
}

export default function MLInsightsPage() {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const { data: patternsData, isLoading: loadingPatterns } = useQuery<{ patterns: PatternResult[] }>({
    queryKey: ["/api/ml/patterns"],
    queryFn: () => apiRequest("GET", "/api/ml/patterns").then((r) => r.json()),
    staleTime: 60_000,
  });

  const { data: anomaliesData, isLoading: loadingAnomalies } = useQuery<{ anomalies: AnomalyResult[] }>({
    queryKey: ["/api/ml/anomalies"],
    queryFn: () => apiRequest("GET", "/api/ml/anomalies").then((r) => r.json()),
    staleTime: 60_000,
  });

  const { data: selfEval, isLoading: loadingEval } = useQuery<SelfEval>({
    queryKey: ["/api/ml/self-eval"],
    queryFn: () => apiRequest("GET", "/api/ml/self-eval").then((r) => r.json()),
    staleTime: 60_000,
  });

  const now = new Date();
  const hour = now.getHours();
  const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday";

  const { data: nextZone, isLoading: loadingZone } = useQuery<NextZone>({
    queryKey: ["/api/ml/next-best-zone", hour, dayType],
    queryFn: () =>
      apiRequest("GET", `/api/ml/next-best-zone?hour=${hour}&day_type=${dayType}`).then((r) => r.json()),
    staleTime: 30_000,
  });

  const patterns = patternsData?.patterns ?? [];
  const anomalies = (anomaliesData?.anomalies ?? []).filter((a, i) => !dismissed.has(`${a.type}-${i}`));

  const handleDismiss = (key: string) => {
    setDismissed((prev) => new Set(prev).add(key));
  };

  const handleCorrect = (key: string) => {
    // Placeholder d'action corrective : marque comme traité côté UI (pas d'endpoint dédié requis).
    setDismissed((prev) => new Set(prev).add(key));
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold flex items-center gap-2">
          <Brain size={20} className="text-cyan-400" />
          Insights IA personnels
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Analyse de vos 90 derniers jours de courses — modèles entraînés uniquement sur vos données.
        </p>
      </div>

      {/* ─── Section : Patterns détectés chez vous ───────────────────────── */}
      <section className="px-4 mt-3">
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <Sparkles size={15} className="text-amber-400" />
          Patterns détectés chez vous
        </h2>
        {loadingPatterns ? (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-64 shrink-0 rounded-lg" />)}
          </div>
        ) : (
          <div className="flex gap-2.5 overflow-x-auto pb-2 -mx-1 px-1 snap-x" data-testid="ml-patterns-row">
            {patterns.map((p, i) => {
              const Icon = PATTERN_ICON[p.pattern_type] ?? Sparkles;
              return (
                <Card key={i} className="shrink-0 w-64 snap-start border-amber-500/20" data-testid={`ml-pattern-card-${i}`}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <Icon size={16} className="text-amber-400" />
                      <Badge variant="outline" className="text-[10px]">
                        Confiance {confidencePct(p.confidence)}%
                      </Badge>
                    </div>
                    <p className="text-xs leading-snug">{p.description_fr}</p>
                    <p className="text-[11px] text-cyan-400 font-medium">{p.action_hint}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Section : Anomalies récentes ────────────────────────────────── */}
      <section className="px-4 mt-5">
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <AlertTriangle size={15} className="text-orange-400" />
          Anomalies récentes
        </h2>
        {loadingAnomalies ? (
          <div className="space-y-2">
            {[0, 1].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
          </div>
        ) : anomalies.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">Aucune anomalie détectée récemment. 👍</p>
        ) : (
          <div className="space-y-2" data-testid="ml-anomalies-list">
            {anomalies.map((a, i) => {
              const key = `${a.type}-${i}`;
              return (
                <Card key={key} className="border-orange-500/20" data-testid={`ml-anomaly-card-${i}`}>
                  <CardContent className="p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Badge className="bg-orange-600/80 text-white text-[10px]">{ANOMALY_LABEL[a.type]}</Badge>
                      <span className="text-[10px] text-muted-foreground">{a.where} · {a.when}</span>
                    </div>
                    <p className="text-xs leading-snug">{a.description_fr}</p>
                    <p className="text-[11px] text-muted-foreground italic">{a.suggested_action}</p>
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" variant="outline" className="h-7 text-[11px] flex-1" onClick={() => handleCorrect(key)} data-testid={`btn-correct-${i}`}>
                        <CheckCircle2 size={12} className="mr-1" /> Corriger
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-[11px] flex-1" onClick={() => handleDismiss(key)} data-testid={`btn-ignore-${i}`}>
                        <XCircle size={12} className="mr-1" /> Ignorer
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Section : Confiance du modèle ───────────────────────────────── */}
      <section className="px-4 mt-5">
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <Gauge size={15} className="text-emerald-400" />
          Confiance du modèle
        </h2>
        {loadingEval ? (
          <Skeleton className="h-28 w-full rounded-lg" />
        ) : (
          <Card className="border-emerald-500/20" data-testid="ml-confidence-gauge">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="relative w-16 h-16 shrink-0">
                  <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90">
                    <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
                    <circle
                      cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="3"
                      strokeDasharray={`${(selfEval?.accuracy_7d ?? 0) * 97.4} 97.4`}
                      strokeLinecap="round"
                      className={
                        (selfEval?.accuracy_7d ?? 0) >= 0.75 ? "text-emerald-400" :
                        (selfEval?.accuracy_7d ?? 0) >= 0.55 ? "text-amber-400" : "text-red-400"
                      }
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center text-sm font-bold">
                    {confidencePct(selfEval?.accuracy_7d ?? 0)}%
                  </div>
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-xs text-muted-foreground">Précision sur 7 jours</p>
                  <div className="flex gap-3 text-[11px]">
                    <span>Calibration : <b>{confidencePct(selfEval?.calibration_score ?? 0)}%</b></span>
                    <span>Brier : <b>{(selfEval?.brier_score ?? 0).toFixed(2)}</b></span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground border-t border-border pt-2">{selfEval?.honest_confidence}</p>
            </CardContent>
          </Card>
        )}
      </section>

      {/* ─── Couche Wow Factor : détection auto-sabotage économique ─── */}
      <section className="px-4 mt-5">
        <SelfSabotageInsight />
      </section>

      {/* ─── Section : Prochaine meilleure zone selon IA ─────────────────── */}
      <section className="px-4 mt-5">
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <MapPin size={15} className="text-cyan-400" />
          Prochaine meilleure zone selon IA
        </h2>
        {loadingZone ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : nextZone ? (
          <Card className="border-cyan-500/20" data-testid="ml-next-zone-card">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-base font-bold">{nextZone.name}</span>
                <div className="flex gap-1.5">
                  {nextZone.exploration && (
                    <Badge className="bg-purple-600/80 text-white text-[10px]">Exploration</Badge>
                  )}
                  <Badge variant="outline" className="text-[10px]">
                    {nextZone.model === "cold_start" ? "Démarrage" : "Modèle perso"}
                  </Badge>
                </div>
              </div>
              {nextZone.expected_gain > 0 && (
                <p className="text-sm text-emerald-400 font-semibold flex items-center gap-1">
                  <TrendingUp size={14} /> +{nextZone.expected_gain}€ estimé
                </p>
              )}
              <p className="text-xs text-muted-foreground">{nextZone.reason}</p>
            </CardContent>
          </Card>
        ) : null}
      </section>
    </div>
  );
}
