import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RefreshCw, Database, Plane, Clock, TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle } from "lucide-react";

const ZONE_LABELS: Record<string, string> = {
  z_cdg: "CDG", z_orly: "Orly", z_saint_denis_gare: "Gare Saint-Denis",
  z_bobigny_gare: "Bobigny", z_aubervilliers: "Aubervilliers",
  z_epinay_gennevilliers: "Épinay/Gennevilliers", z_plaine_commune: "Plaine Commune",
  z_le_bourget: "Le Bourget", z_villepinte: "Villepinte", z_tremblay: "Tremblay",
  z_stade_france: "Stade de France", z_93_centre: "Saint-Denis Centre",
  z_montreuil: "Montreuil", z_aulnay: "Aulnay",
};

function deltaColor(d: number) {
  if (d > 3) return "#22c55e";
  if (d < -3) return "#ef4444";
  return "#94a3b8";
}
function DeltaIcon({ d }: { d: number }) {
  if (d > 3) return <TrendingUp size={12} className="inline" style={{ color: "#22c55e" }} />;
  if (d < -3) return <TrendingDown size={12} className="inline" style={{ color: "#ef4444" }} />;
  return <Minus size={12} className="inline" style={{ color: "#94a3b8" }} />;
}
function fmtTs(iso: string | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function peakColor(level: string) {
  return { low: "#6b7280", medium: "#fbbf24", high: "#f97316", surge: "#ef4444" }[level] || "#6b7280";
}

export default function DataSourcesPage() {
  const { data: analytics, isLoading: loadingAnalytics, refetch } = useQuery({
    queryKey: ["/api/analytics/refresh"],
    queryFn: () => apiRequest("GET", "/api/analytics/refresh").then(r => r.json()),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  const { data: sources } = useQuery({
    queryKey: ["/api/data-sources"],
    queryFn: () => apiRequest("GET", "/api/data-sources").then(r => r.json()),
  });

  const diff = analytics?.historical_diff?.diff || [];
  const hasHistory = analytics?.historical_diff?.hasHistory;

  // Résumé par zone pour heure courante (weekday)
  const currentHour = analytics?.current_hour ?? new Date().getHours();
  const diffAtCurrentHour = diff.filter((d: any) => d.hour === currentHour && d.day_type === "weekday");

  // Top 5 gains / pertes
  const weekdayDiff = diff.filter((d: any) => d.day_type === "weekday");
  const sortedByDelta = [...weekdayDiff].sort((a: any, b: any) => b.delta_index - a.delta_index);
  const topGainers = sortedByDelta.slice(0, 5);
  const topLosers = sortedByDelta.slice(-5).reverse();

  return (
    <div className="p-3 space-y-4 pb-20 overflow-y-auto" style={{ maxHeight: "calc(100vh - 8.5rem)" }}>

      {/* ─── En-tête statut ─── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold">Sources & Données</h2>
          <p className="text-xs text-muted-foreground">
            {analytics ? `Données du ${analytics.today_label} ${analytics.today} — ${fmtTs(analytics.seed_meta?.last_seed_ts)}` : "Chargement…"}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1.5 text-xs text-primary bg-primary/10 border border-primary/20 rounded-lg px-3 py-1.5 hover:bg-primary/20 transition-colors"
        >
          <RefreshCw size={12} className={loadingAnalytics ? "animate-spin" : ""} />
          Actualiser
        </button>
      </div>

      {/* ─── Bandeau fraîcheur données ─── */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border p-3 bg-card">
          <div className="flex items-center gap-2 mb-1">
            <Database size={13} className="text-primary" />
            <span className="text-xs font-semibold">SQLite — Scores</span>
            {analytics?.data_freshness?.scores_for_date === new Date().toISOString().split("T")[0]
              ? <CheckCircle size={11} className="text-green-500 ml-auto" />
              : <AlertTriangle size={11} className="text-amber-500 ml-auto" />
            }
          </div>
          <p className="text-[10px] text-muted-foreground">Date : <strong className="text-foreground">{analytics?.data_freshness?.scores_for_date || "—"}</strong></p>
          <p className="text-[10px] text-muted-foreground">Scores : <strong className="text-foreground">{analytics?.current_scores_count || 0}</strong> zones × heure actuelle</p>
          <p className="text-[10px] text-muted-foreground">Refresh : <strong className="text-foreground">quotidien automatique</strong></p>
          <p className="text-[10px] text-muted-foreground">Historique J-1 : <strong className={hasHistory ? "text-green-400" : "text-amber-400"}>{hasHistory ? "Disponible" : "Pas encore"}</strong></p>
        </div>
        <div className="rounded-lg border p-3 bg-card">
          <div className="flex items-center gap-2 mb-1">
            <Plane size={13} className="text-sky-400" />
            <span className="text-xs font-semibold">Vols temps réel</span>
            {analytics?.flights?.source === "opensky"
              ? <CheckCircle size={11} className="text-green-500 ml-auto" />
              : <span className="text-[9px] text-amber-400 ml-auto">Heuristique</span>
            }
          </div>
          {analytics?.flights && (
            <>
              <div className="flex items-center gap-1 text-[10px] mt-1">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: peakColor(analytics.flights.cdg.peak_level) }} />
                <span className="text-muted-foreground">CDG :</span>
                <strong style={{ color: peakColor(analytics.flights.cdg.peak_level) }}>{analytics.flights.cdg.arrivals_next_hour} arr/h</strong>
                <span className="text-muted-foreground ml-1">boost ×{analytics.flights.cdg.vtc_demand_boost.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-1 text-[10px]">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: peakColor(analytics.flights.orly.peak_level) }} />
                <span className="text-muted-foreground">Orly :</span>
                <strong style={{ color: peakColor(analytics.flights.orly.peak_level) }}>{analytics.flights.orly.arrivals_next_hour} arr/h</strong>
                <span className="text-muted-foreground ml-1">boost ×{analytics.flights.orly.vtc_demand_boost.toFixed(2)}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">Source : <strong className="text-foreground">{analytics.flights.source === "opensky" ? "OpenSky Network" : "Heuristique ADP"}</strong></p>
            </>
          )}
        </div>
      </div>

      {/* ─── Analyse inversée J vs J-1 ─── */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp size={14} className="text-primary" />
            Analyse inversée — {analytics?.yesterday_label || "Lundi 08"} → {analytics?.today_label || "Mardi 09"} juin 2026
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          {!hasHistory ? (
            <div className="rounded-lg bg-amber-950/30 border border-amber-500/30 p-3 text-xs text-amber-400">
              <AlertTriangle size={13} className="inline mr-1" />
              Historique J-1 pas encore disponible — il sera généré automatiquement au prochain démarrage du serveur le lendemain. Les données d'aujourd'hui seront archivées ce soir.
            </div>
          ) : (
            <>
              {/* Stats globales */}
              {analytics?.stats && (
                <div className="grid grid-cols-4 gap-2 mb-3">
                  <div className="bg-green-950/30 border border-green-500/20 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Zones ↑</p>
                    <p className="text-lg font-bold text-green-400">{analytics.stats.posZones}</p>
                  </div>
                  <div className="bg-red-950/30 border border-red-500/20 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Zones ↓</p>
                    <p className="text-lg font-bold text-red-400">{analytics.stats.negZones}</p>
                  </div>
                  <div className="bg-muted/30 border border-border rounded-lg p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Stables</p>
                    <p className="text-lg font-bold">{analytics.stats.stableZones}</p>
                  </div>
                  <div className="bg-primary/10 border border-primary/20 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Δ moyen</p>
                    <p className="text-lg font-bold" style={{ color: deltaColor(analytics.stats.avgDelta) }}>
                      {analytics.stats.avgDelta > 0 ? "+" : ""}{analytics.stats.avgDelta}
                    </p>
                  </div>
                </div>
              )}

              {/* Tableau heure courante */}
              <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">
                Zones à {String(currentHour).padStart(2,"0")}h00 — Δ score (mardi vs lundi)
              </p>
              <div className="space-y-1">
                {diffAtCurrentHour.sort((a: any, b: any) => b.delta_index - a.delta_index).map((d: any) => (
                  <div key={d.zone_id} className="flex items-center gap-2 text-[10px]">
                    <span className="w-28 text-muted-foreground truncate">{ZONE_LABELS[d.zone_id] || d.zone_id}</span>
                    <div className="flex-1 flex items-center gap-1">
                      <span className="text-muted-foreground w-8 text-right">{Math.round(d.yesterday_index)}</span>
                      <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, d.today_index)}%`, background: deltaColor(d.delta_index) }} />
                      </div>
                      <span className="font-bold w-8">{Math.round(d.today_index)}</span>
                    </div>
                    <span className="font-bold w-12 text-right" style={{ color: deltaColor(d.delta_index) }}>
                      <DeltaIcon d={d.delta_index} /> {d.delta_index > 0 ? "+" : ""}{d.delta_index}
                    </span>
                    <span className="text-muted-foreground w-10 text-right text-[9px]">s×{d.today_surge.toFixed(1)}</span>
                  </div>
                ))}
              </div>

              {/* Top gains / pertes journée complète */}
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <p className="text-[10px] font-semibold text-green-400 mb-1">Meilleures progressions (journée)</p>
                  {topGainers.map((d: any) => (
                    <div key={`g-${d.zone_id}-${d.hour}`} className="flex justify-between text-[9px] text-muted-foreground py-0.5">
                      <span>{ZONE_LABELS[d.zone_id] || d.zone_id} {String(d.hour).padStart(2,"0")}h</span>
                      <span className="text-green-400 font-bold">+{d.delta_index}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-red-400 mb-1">Plus fortes baisses (journée)</p>
                  {topLosers.map((d: any) => (
                    <div key={`l-${d.zone_id}-${d.hour}`} className="flex justify-between text-[9px] text-muted-foreground py-0.5">
                      <span>{ZONE_LABELS[d.zone_id] || d.zone_id} {String(d.hour).padStart(2,"0")}h</span>
                      <span className="text-red-400 font-bold">{d.delta_index}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Corrélation */}
              {analytics?.correlations?.pearson_surge_vs_profitability !== null && (
                <div className="mt-3 rounded-lg bg-primary/5 border border-primary/20 p-2 text-[10px]">
                  <span className="text-muted-foreground">Corrélation Pearson surge × rentabilité (aujourd'hui) : </span>
                  <strong className="text-primary">{analytics?.correlations?.pearson_surge_vs_profitability}</strong>
                  <span className="text-muted-foreground ml-2">
                    {Math.abs(analytics?.correlations?.pearson_surge_vs_profitability) > 0.8
                      ? "— corrélation forte ✓"
                      : Math.abs(analytics?.correlations?.pearson_surge_vs_profitability) > 0.5
                      ? "— corrélation modérée"
                      : "— corrélation faible"}
                  </span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ─── Coefficients jour de la semaine ─── */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock size={14} className="text-amber-400" />
            Coefficients jours appliqués aujourd'hui ({analytics?.today_label || "Mardi"})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <div className="grid grid-cols-7 gap-1 text-center text-[9px]">
            {[
              { j: "Dim", d: 0, co: { demand: 0.72, surge: 1.10 } },
              { j: "Lun", d: 1, co: { demand: 0.92, surge: 1.08 } },
              { j: "Mar", d: 2, co: { demand: 1.00, surge: 1.12 } },
              { j: "Mer", d: 3, co: { demand: 1.02, surge: 1.12 } },
              { j: "Jeu", d: 4, co: { demand: 1.05, surge: 1.15 } },
              { j: "Ven", d: 5, co: { demand: 1.08, surge: 1.25 } },
              { j: "Sam", d: 6, co: { demand: 0.80, surge: 1.20 } },
            ].map(({ j, d, co }) => {
              const isToday = d === new Date().getDay();
              return (
                <div key={d} className={`rounded p-1.5 border ${isToday ? "border-primary bg-primary/10" : "border-border bg-muted/30"}`}>
                  <p className={`font-bold ${isToday ? "text-primary" : "text-muted-foreground"}`}>{j}</p>
                  <p className="text-green-400 mt-0.5">D×{co.demand}</p>
                  <p className="text-amber-400">S×{co.surge}</p>
                </div>
              );
            })}
          </div>
          <p className="text-[9px] text-muted-foreground mt-2">
            D = demande, S = surge — coefficients appliqués au seed quotidien pour refléter la saisonnalité hebdomadaire réelle (données ADP + RATP)
          </p>
        </CardContent>
      </Card>

      {/* ─── Sources de données ─── */}
      {sources?.categories && (
        <Card>
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-sm">Sources intégrées</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 space-y-3">
            {sources.categories.map((cat: any) => (
              <div key={cat.name}>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">{cat.name}</p>
                <div className="space-y-1">
                  {cat.sources.map((s: any) => (
                    <div key={s.name} className="flex items-center justify-between text-xs py-1 border-b border-border/40">
                      <div>
                        <span className="font-medium">{s.name}</span>
                        <p className="text-[10px] text-muted-foreground">{s.description}</p>
                      </div>
                      <Badge variant="outline" className={`text-[9px] py-0 ml-2 shrink-0 ${s.status === "live" ? "border-green-500/50 text-green-400" : s.status === "open" ? "border-blue-500/50 text-blue-400" : "border-border text-muted-foreground"}`}>
                        {s.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
