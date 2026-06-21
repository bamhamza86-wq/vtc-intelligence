import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { RefreshCw, Database, Plane, Clock, TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle, Navigation, Target, ExternalLink, Zap } from "lucide-react";
import { RouteSourceBadge } from "@/components/RouteSourceBadge";
import { PredictHQBadge } from "@/components/PredictHQBadge";
import { usePredictHQ } from "@/hooks/usePredictHQ";

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
  // PredictHQ Events Intelligence
  const { events: phqEvents, isConnected: phqConnected, hasKey: phqHasKey, activeEventCount: phqActiveCount, lastUpdated: phqLastUpdated } = usePredictHQ();
  const [phqModalOpen, setPhqModalOpen] = useState(false);
  const [phqKeyInput, setPhqKeyInput] = useState("");
  const [phqSaving, setPhqSaving] = useState(false);
  const [phqSaveMsg, setPhqSaveMsg] = useState<string | null>(null);

  const phqTop3 = [...phqEvents]
    .filter((e) => (e.boost ?? 1) > 1.0)
    .sort((a, b) => (b.boost ?? 1) - (a.boost ?? 1))
    .slice(0, 3);

  const phqStatus: { label: string; color: string } = phqConnected
    ? { label: "Connect\u00e9", color: "#22c55e" }
    : phqHasKey
    ? { label: "D\u00e9connect\u00e9", color: "#f97316" }
    : { label: "Pas de cl\u00e9 API", color: "#94a3b8" };

  async function savePhqKey() {
    if (!phqKeyInput.trim()) return;
    setPhqSaving(true);
    setPhqSaveMsg(null);
    try {
      await apiRequest("PUT", "/api/platforms/credentials/predicthq", { api_key: phqKeyInput.trim() });
      await apiRequest("POST", "/api/platforms/test/predicthq").catch(() => {});
      setPhqSaveMsg("Cl\u00e9 enregistr\u00e9e \u2014 reconnexion en cours\u2026");
      setPhqKeyInput("");
      setTimeout(() => setPhqModalOpen(false), 1200);
    } catch (e: any) {
      setPhqSaveMsg(`Erreur : ${e?.message ?? "\u00e9chec enregistrement"}`);
    } finally {
      setPhqSaving(false);
    }
  }

  const { data: analytics, isLoading: loadingAnalytics, refetch } = useQuery({
    queryKey: ["/api/analytics/refresh"],
    queryFn: () => apiRequest("GET", "/api/analytics/refresh").then(r => r.json()),
    refetchInterval: 3_000,
    staleTime: 2_500,
  });

  const { data: sources } = useQuery({
    queryKey: ["/api/data-sources"],
    queryFn: () => apiRequest("GET", "/api/data-sources").then(r => r.json()),
  });

  // ─── Statut Routing ETA (TomTom temps réel / OSRM fallback / Calibré) ───
  // routingStatus contient : tomtomHits, tomtomAvailable, activeSource, tomtom_connected,
  // tomtom_source_active, validEntries, lastRefresh, nextRefresh
  const { data: routingStatus } = useQuery({
    queryKey: ["/api/routing-status"],
    queryFn: () => apiRequest("GET", "/api/routing-status").then(r => r.json()),
    refetchInterval: 3_000,
  });

  // Source ETA active : priorité au champ explicite renvoyé par le backend, sinon dérivée.
  const routingSource: string = routingStatus?.activeSource
    ?? routingStatus?.routing_priority
    ?? (routingStatus?.tomtom_source_active ? "tomtom"
      : routingStatus?.osrmAvailable ? "osrm" : "calibrated");
  const tomtomKeyConfigured: boolean =
    routingStatus?.tomtom_connected ?? routingStatus?.tomtom_key_configured ?? routingStatus?.tomtomAvailable ?? false;
  const routingSourceLabel: string =
    routingSource === "tomtom" ? "TomTom — Trafic temps réel"
    : routingSource === "osrm" ? "OSRM (fallback réseau)"
    : routingSource === "google" ? "Google Maps"
    : "Calibré (mesures terrain)";

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

      {/* ─── Routing ETA — TomTom temps réel / OSRM fallback / Calibré ─── */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Navigation size={14} className="text-green-400" />
            Routing ETA temps réel
          </CardTitle>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            TomTom est désormais utilisé pour le <strong className="text-foreground">routing (ETA temps réel)</strong> en plus du traffic flow — calcul distance/temps de trajet zone par zone.
          </p>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <div className="grid grid-cols-3 gap-2">
            {/* Source active */}
            <div className="rounded-lg border p-2.5 bg-card text-center">
              <p className="text-[10px] text-muted-foreground mb-1">Source active</p>
              <div className="flex justify-center mb-1">
                <RouteSourceBadge source={routingSource} size="xs" />
              </div>
              <p className="text-[9px] text-muted-foreground">{routingSourceLabel}</p>
            </div>
            {/* Zones avec données TomTom */}
            <div className="rounded-lg border p-2.5 bg-card text-center">
              <p className="text-[10px] text-muted-foreground mb-1">Zones données TomTom</p>
              <p className="text-lg font-bold" style={{ color: (routingStatus?.tomtomHits ?? 0) > 0 ? "#22c55e" : "#94a3b8" }}>
                {routingStatus?.tomtomHits ?? 0}
              </p>
              <p className="text-[9px] text-muted-foreground">{routingStatus?.validEntries ?? 0} entrées cache valides</p>
            </div>
            {/* Dernière mise à jour */}
            <div className="rounded-lg border p-2.5 bg-card text-center">
              <p className="text-[10px] text-muted-foreground mb-1">Dernière MAJ</p>
              <p className="text-xs font-bold text-foreground">{fmtTs(routingStatus?.lastRefresh)}</p>
              <p className="text-[9px] text-muted-foreground">refresh auto 3 min</p>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[10px]">
            {tomtomKeyConfigured
              ? <CheckCircle size={11} className="text-green-500" />
              : <AlertTriangle size={11} className="text-amber-500" />}
            <span className="text-muted-foreground">
              Clé TomTom : <strong className={tomtomKeyConfigured ? "text-green-400" : "text-amber-400"}>{tomtomKeyConfigured ? "configurée" : "non configurée (fallback OSRM/Calibré)"}</strong>
            </span>
          </div>
        </CardContent>
      </Card>

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
      {/* PredictHQ Events Intelligence */}
      <Card className="border-emerald-500/30">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Target size={14} className="text-emerald-400" />
            PredictHQ Events Intelligence
            <Badge
              variant="outline"
              className="text-[9px] py-0 ml-auto"
              style={{ borderColor: `${phqStatus.color}80`, color: phqStatus.color }}
            >
              {phqStatus.label}
            </Badge>
          </CardTitle>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Impact des événements (concerts, matchs, salons) sur la demande VTC — boost par zone en quasi temps réel.
          </p>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="rounded-lg border p-2.5 bg-card text-center">
              <p className="text-[10px] text-muted-foreground mb-1">Statut connexion</p>
              <div className="flex justify-center items-center gap-1">
                {phqConnected
                  ? <CheckCircle size={12} className="text-green-500" />
                  : <AlertTriangle size={12} style={{ color: phqStatus.color }} />}
                <span className="text-xs font-bold" style={{ color: phqStatus.color }}>{phqStatus.label}</span>
              </div>
            </div>
            <div className="rounded-lg border p-2.5 bg-card text-center">
              <p className="text-[10px] text-muted-foreground mb-1">Événements actifs</p>
              <p className="text-lg font-bold" style={{ color: phqActiveCount > 0 ? "#10b981" : "#94a3b8" }}>
                {phqActiveCount}
              </p>
              <p className="text-[9px] text-muted-foreground">boostent la demande</p>
            </div>
            <div className="rounded-lg border p-2.5 bg-card text-center">
              <p className="text-[10px] text-muted-foreground mb-1">Dernière MAJ</p>
              <p className="text-xs font-bold text-foreground">{phqLastUpdated ? fmtTs(phqLastUpdated) : "—"}</p>
              <p className="text-[9px] text-muted-foreground">refresh auto 3 s</p>
            </div>
          </div>

          {phqTop3.length > 0 && (
            <div className="space-y-1 mb-3">
              <p className="text-[11px] font-semibold text-muted-foreground">Top 3 événements</p>
              {phqTop3.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-[10px] rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5">
                  <Zap size={12} className="text-emerald-400 flex-shrink-0" />
                  <span className="flex-1 truncate font-medium">{e.title}</span>
                  {e.zone_name && <span className="text-muted-foreground truncate max-w-[90px]">{e.zone_name}</span>}
                  <PredictHQBadge boost={e.boost} eventTitle={e.title} compact />
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-8 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
              onClick={() => setPhqModalOpen(true)}
            >
              <Target size={12} className="mr-1" /> Configurer clé API
            </Button>
            <a
              href="https://control.predicthq.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink size={12} /> control.predicthq.com
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Modal configuration clé API PredictHQ */}
      <Dialog open={phqModalOpen} onOpenChange={setPhqModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target size={16} className="text-emerald-400" /> Clé API PredictHQ
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">
              Collez votre Access Token PredictHQ (control.predicthq.com → API Tokens).
            </p>
            <Input
              type="password"
              placeholder="phq_xxxxxxxxxxxxxxxx"
              value={phqKeyInput}
              onChange={(e) => setPhqKeyInput(e.target.value)}
              autoComplete="off"
            />
            {phqSaveMsg && (
              <p className={`text-xs ${phqSaveMsg.startsWith("Erreur") ? "text-red-400" : "text-emerald-400"}`}>
                {phqSaveMsg}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPhqModalOpen(false)}>Annuler</Button>
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-500 text-white"
              disabled={phqSaving || !phqKeyInput.trim()}
              onClick={savePhqKey}
            >
              {phqSaving ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
