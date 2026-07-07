import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, TrendingUp, Lightbulb } from "lucide-react";

interface PredictionHour {
  hour: number;
  predicted_index: number;
  confidence: number;
  factors: Record<string, any>;
}

interface ZonePrediction {
  zone_id: string;
  zone_name: string;
  hours: PredictionHour[];
}

// ─── Couche ML Personnel : explicabilité inline (XAI) pour la zone top-1 ───
interface AcceptanceExplanation {
  p_accept: number;
  expected_gain: number;
  explanation: { feature: string; weight: number; label_fr: string }[];
  model: "cold_start" | "personal";
  ride_count: number;
}

function shortFeatureLabel(feature: string): string {
  const map: Record<string, string> = {
    fare: "tarif",
    distance_km: "distance",
    duration_min: "durée",
    hour_sin: "météo",
    hour_cos: "horaire",
    zone_known: "historique",
    fleet_avg: "moyenne flotte",
  };
  return map[feature] ?? feature;
}

function scoreColor(score: number): string {
  if (score >= 75) return "bg-emerald-500";
  if (score >= 60) return "bg-amber-500";
  if (score >= 45) return "bg-orange-500";
  return "bg-red-500";
}

// ─── Vague 3, Levier 2 : barre de confiance à 3 segments (réutilise VERB_COLOR-like palette) ───
const CONFIDENCE_COLOR = {
  high: "bg-emerald-500",
  medium: "bg-amber-500",
  low: "bg-red-500",
} as const;

function confidenceSegments(confidence: number): number {
  if (confidence > 0.7) return 3;
  if (confidence >= 0.4) return 2;
  return 1;
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const filled = confidenceSegments(confidence);
  const fillColor =
    filled === 3 ? CONFIDENCE_COLOR.high : filled === 2 ? CONFIDENCE_COLOR.medium : CONFIDENCE_COLOR.low;
  return (
    <div
      className="flex items-center gap-0.5"
      role="img"
      aria-label={`Confiance de la prédiction : ${filled}/3`}
      data-testid="prediction-confidence-bar"
    >
      {[1, 2, 3].map((seg) => (
        <span
          key={seg}
          className={`inline-block h-[2px] w-[5px] rounded-full ${seg <= filled ? `${fillColor} opacity-90` : "bg-muted"}`}
        />
      ))}
    </div>
  );
}

function fmtHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

export default function PredictionPanel() {
  const { data, isLoading } = useQuery<{ predictions: ZonePrediction[] }>({
    queryKey: ["/api/predictions"],
    queryFn: () => apiRequest("GET", "/api/predictions").then(r => r.json()),
    refetchInterval: 3_000,
    staleTime: 0,
    retry: 3,
    retryDelay: (n) => n * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Brain size={16} className="text-cyan-400" />
            Prédiction de demande
            <Badge className="bg-cyan-600 text-white text-[10px]">IA</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-4 pb-4">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
        </CardContent>
      </Card>
    );
  }

  const predictions = data?.predictions ?? [];
  // Top 6 zones par score moyen prédit sur la fenêtre
  const ranked = [...predictions]
    .map(z => ({
      ...z,
      avg: z.hours.length ? z.hours.reduce((a, h) => a + h.predicted_index, 0) / z.hours.length : 0,
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 6);

  const topZone = ranked[0];
  const nowHour = new Date().getHours();
  const { data: xai } = useQuery<AcceptanceExplanation>({
    queryKey: ["/api/ml/predict-acceptance", topZone?.zone_id, nowHour],
    queryFn: () =>
      apiRequest("POST", "/api/ml/predict-acceptance", {
        zone_id: topZone?.zone_id ?? "unknown",
        distance_km: 8,
        duration_min: 18,
        fare: 16,
        hour: nowHour,
      }).then(r => r.json()),
    enabled: !!topZone,
    staleTime: 30_000,
  });

  return (
    <Card className="border-cyan-500/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Brain size={16} className="text-cyan-400" />
          Prédiction de demande — 6h
          <Badge className="bg-cyan-600 text-white text-[10px] ml-auto">IA</Badge>
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">Indice de rentabilité prédit par zone et par heure</p>
      </CardHeader>
      <CardContent className="space-y-3 px-3 pb-4">
        {ranked.length === 0 && (
          <p className="text-xs text-muted-foreground py-2">Prédictions en cours de calcul…</p>
        )}
        {xai && xai.explanation.length > 0 && (
          <div
            className="flex items-start gap-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-1.5"
            data-testid="prediction-xai-inline"
          >
            <Lightbulb size={12} className="text-cyan-400 mt-0.5 shrink-0" />
            <p className="text-[10.5px] text-muted-foreground leading-snug">
              <span className="font-medium text-foreground">Pourquoi : </span>
              {xai.explanation
                .map(e => `${e.weight >= 0 ? "+" : ""}${shortFeatureLabel(e.feature)}`)
                .join(", ")}
              {xai.model === "cold_start" ? " (démarrage, moyenne flotte)" : ""}
            </p>
          </div>
        )}
        {ranked.map(zone => (
          <div key={zone.zone_id} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium truncate max-w-[60%]">{zone.zone_name}</span>
              <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                <TrendingUp size={11} />moy. {Math.round(zone.avg)}
              </span>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 snap-x">
              {zone.hours.map(h => (
                <div
                  key={h.hour}
                  className="shrink-0 snap-start flex flex-col items-center gap-1 min-w-[52px] rounded-lg border border-border/50 bg-card p-1.5"
                  title={`Trafic ${h.factors?.traffic_ratio ?? "?"} · coeff ${h.factors?.day_coeff ?? "?"}`}
                >
                  <span className="text-[10px] text-muted-foreground">{fmtHour(h.hour)}</span>
                  <div className="w-full h-12 flex items-end justify-center rounded bg-muted/40 overflow-hidden">
                    <div
                      className={`w-full ${scoreColor(h.predicted_index)} transition-all`}
                      style={{ height: `${Math.max(8, Math.min(100, h.predicted_index))}%` }}
                    />
                  </div>
                  <span className="text-xs font-bold tabular-nums">{Math.round(h.predicted_index)}</span>
                  <ConfidenceBar confidence={h.confidence} />
                  <span className="text-[9px] text-muted-foreground tabular-nums">{Math.round(h.confidence * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
