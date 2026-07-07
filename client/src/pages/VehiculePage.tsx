/**
 * VehiculePage.tsx — COUCHE VÉHICULE (entretien, EV, carburant, éco-conduite)
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspiré du rapport.md §4 (Optimisation carburant/énergie) et §6 (Coûts cachés).
 * Sections :
 *   1. Score éco-conduite du jour (jauge + tips)
 *   2. Stations carburant proches (liste triée par prix)
 *   3. Recharge EV / Pauses (stratégie 3 paliers)
 *   4. Entretien à venir (calendrier prochaines échéances)
 *   5. LOA/LLD tracker (jauge km + alerte dépassement)
 *   6. Consommation moyenne (chart CSS pur : 30 derniers pleins)
 *   7. EV vs Thermique (comparatif visuel économie/an)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import {
  Car, Fuel, Zap, Wrench, Gauge, TrendingDown, MapPin, Battery,
  Coffee, AlertTriangle, CheckCircle2, Calendar, Droplet,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface EcoScoreResult {
  score: number;
  breakdown: { label_fr: string; points: number; max_points: number }[];
  tips_fr: string[];
  conso_impact_pct: number;
  date: string;
}

interface FuelStation {
  id: string; name: string; brand: string; city: string; fuel_type: string;
  price_eur: number; unit: string; distanceKm: number; economie_vs_plus_cher_eur_par_plein: number;
}
interface CheapFuelResult {
  stations: FuelStation[]; fuel_type: string; station_moins_chere: string | null; prix_moyen_zone: number;
}

interface ChargingStationT { id: string; name: string; network: string; powerKw: number; distanceKm: number; estimatedPriceEurPerKwh: number; address: string; }
interface ChargingTier { palier: string; label_fr: string; duree_min: number; pct_batterie_gagne: number; stations: ChargingStationT[]; conseil_fr: string; }
interface ChargingStrategyResult { paliers: ChargingTier[]; }

interface MaintenanceReminder {
  id: number; type: string; km_next: number; date_next: string | null;
  cost_estimate: number; status: string;
}

interface LoaTracker {
  has_contract: boolean;
  contract_type?: string;
  km_plafond_annuel?: number;
  km_reel_a_date?: number;
  km_prevu_a_date?: number;
  ecart_km?: number;
  projection_fin_contrat_km?: number;
  depassement_projete_km?: number;
  penalite_estimee_eur?: number;
  alert_level: "ok" | "attention" | "depassement";
  message_fr: string;
}

interface FuelLogStats {
  logs: any[];
  conso_moyenne_l_100km: number | null;
  conso_moyenne_kwh_100km: number | null;
  cout_moyen_par_plein_eur: number;
  cout_total_periode_eur: number;
}

interface EvVsThermalResult {
  jours: { jour: number; economie_jour_eur: number; cumul_economie_eur: number }[];
  cout_ev_mensuel_eur: number;
  cout_thermique_mensuel_eur: number;
  economie_mensuelle_eur: number;
  economie_annuelle_estimee_eur: number;
  hypotheses_fr: string[];
}

const MAINTENANCE_LABELS: Record<string, string> = {
  vidange: "Vidange", pneus: "Pneus", freins: "Freins", revision: "Révision", CT: "Contrôle technique", filtre: "Filtres",
};
const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "text-red-500 bg-red-500/10" },
  proche: { label: "Bientôt", color: "text-amber-500 bg-amber-500/10" },
  a_venir: { label: "À venir", color: "text-muted-foreground bg-muted" },
  fait: { label: "Fait", color: "text-emerald-500 bg-emerald-500/10" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Jauge circulaire simple (SVG, aucune dépendance)
// ─────────────────────────────────────────────────────────────────────────────
function ScoreGauge({ score }: { score: number }) {
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 75 ? "#22c55e" : score >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <div className="relative w-32 h-32 mx-auto">
      <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.1} strokeWidth={10} />
        <circle
          cx="60" cy="60" r={radius} fill="none" stroke={color} strokeWidth={10}
          strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold" style={{ color }}>{score}</span>
        <span className="text-[10px] text-muted-foreground">/100</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mini barre chart CSS pur (consommation 30 derniers pleins)
// ─────────────────────────────────────────────────────────────────────────────
function ConsoBarChart({ logs }: { logs: any[] }) {
  const withConso = logs.filter((l) => l.l_100km != null).slice(0, 30).reverse();
  if (withConso.length === 0) {
    return <p className="text-sm text-muted-foreground">Pas encore de pleins enregistrés avec calcul de consommation.</p>;
  }
  const max = Math.max(...withConso.map((l) => l.l_100km), 1);
  return (
    <div className="flex items-end gap-1 h-28 overflow-x-auto pb-1">
      {withConso.map((l, i) => {
        const h = Math.max(4, (l.l_100km / max) * 100);
        return (
          <div key={i} className="flex flex-col items-center gap-1 shrink-0" style={{ width: 10 }}>
            <div
              className="w-full rounded-t bg-sky-400"
              style={{ height: `${h}%`, minHeight: 4 }}
              title={`${l.l_100km} L/100km — ${l.date}`}
            />
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page principale
// ─────────────────────────────────────────────────────────────────────────────
export default function VehiculePage() {
  const queryClient = useQueryClient();
  const { position } = useGpsPosition();
  const lat = position?.lat ?? 48.8566;
  const lng = position?.lng ?? 2.3522;
  const [fuelType, setFuelType] = useState("E10");

  // ── 1. Score éco-conduite ──
  const { data: ecoScore, isLoading: ecoLoading } = useQuery<EcoScoreResult>({
    queryKey: ["/api/vehicle/eco-score"],
    queryFn: () => apiRequest("GET", "/api/vehicle/eco-score").then((r) => r.json()),
  });

  // ── 2. Stations carburant ──
  const { data: cheapFuel, isLoading: fuelLoading } = useQuery<CheapFuelResult>({
    queryKey: ["/api/vehicle/cheap-fuel", lat, lng, fuelType],
    queryFn: () =>
      apiRequest("GET", `/api/vehicle/cheap-fuel?lat=${lat}&lng=${lng}&type=${fuelType}`).then((r) => r.json()),
  });

  // ── 3. Stratégie recharge EV ──
  const { data: chargingStrategy, isLoading: chargingLoading } = useQuery<ChargingStrategyResult>({
    queryKey: ["/api/vehicle/charging-strategy", lat, lng],
    queryFn: () => apiRequest("GET", `/api/vehicle/charging-strategy?lat=${lat}&lng=${lng}`).then((r) => r.json()),
  });

  // ── 4. Entretien ──
  const { data: maintenanceData, isLoading: maintenanceLoading } = useQuery<{ reminders: MaintenanceReminder[] }>({
    queryKey: ["/api/vehicle/maintenance-reminders"],
    queryFn: () => apiRequest("GET", "/api/vehicle/maintenance-reminders").then((r) => r.json()),
  });

  // ── 5. LOA/LLD tracker ──
  const { data: loaTracker, isLoading: loaLoading } = useQuery<LoaTracker>({
    queryKey: ["/api/vehicle/loa-tracker"],
    queryFn: () => apiRequest("GET", "/api/vehicle/loa-tracker").then((r) => r.json()),
  });

  // ── 6. Consommation moyenne ──
  const { data: fuelLogStats, isLoading: fuelLogLoading } = useQuery<FuelLogStats>({
    queryKey: ["/api/vehicle/fuel-log"],
    queryFn: () => apiRequest("GET", "/api/vehicle/fuel-log?limit=30").then((r) => r.json()),
  });

  // ── 7. EV vs Thermique ──
  const { data: evVsThermal, isLoading: evLoading } = useQuery<EvVsThermalResult>({
    queryKey: ["/api/vehicle/ev-vs-thermal"],
    queryFn: () => apiRequest("GET", "/api/vehicle/ev-vs-thermal").then((r) => r.json()),
  });

  async function markMaintenanceDone(id: number, type: string) {
    const intervals: Record<string, number> = { vidange: 15000, pneus: 30000, freins: 40000, revision: 20000, CT: 999999, filtre: 20000 };
    try {
      await apiRequest("PUT", `/api/vehicle/maintenance-reminders/${id}/done`, { next_km_interval: intervals[type] ?? 15000 });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle/maintenance-reminders"] });
    } catch {
      // silencieux
    }
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Car size={20} className="text-primary" />
          Véhicule
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          Entretien, carburant, recharge EV et éco-conduite — tout pour optimiser le coût réel de ton véhicule.
        </p>
      </div>

      <div className="px-4 space-y-4">
        {/* ── 1. Score éco-conduite du jour ── */}
        <Card data-testid="card-eco-score">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Gauge size={16} />
              Score éco-conduite du jour
            </CardTitle>
          </CardHeader>
          <CardContent>
            {ecoLoading || !ecoScore ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <div className="space-y-3">
                <ScoreGauge score={ecoScore.score} />
                <div className="grid grid-cols-3 gap-2 text-center">
                  {ecoScore.breakdown.map((b) => (
                    <div key={b.label_fr} className="rounded-lg bg-muted p-2">
                      <p className="text-sm font-semibold">{b.points}/{b.max_points}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{b.label_fr}</p>
                    </div>
                  ))}
                </div>
                {ecoScore.conso_impact_pct > 0 && (
                  <p className="text-xs text-center text-amber-500">
                    Surconsommation estimée : +{ecoScore.conso_impact_pct}%
                  </p>
                )}
                <ul className="space-y-1.5">
                  {ecoScore.tips_fr.map((tip, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground shrink-0" />
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── 2. Stations carburant proches ── */}
        <Card data-testid="card-fuel-stations">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Fuel size={16} />
              Stations carburant proches
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              {["E10", "Gazole", "GNV"].map((t) => (
                <button
                  key={t}
                  onClick={() => setFuelType(t)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border ${
                    fuelType === t ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground"
                  }`}
                  style={{ minHeight: 36 }}
                  data-testid={`button-fuel-type-${t}`}
                >
                  {t}
                </button>
              ))}
            </div>
            {fuelLoading || !cheapFuel ? (
              <Skeleton className="h-40 w-full" />
            ) : cheapFuel.stations.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune station {fuelType} trouvée à proximité.</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Prix moyen zone : <span className="font-medium">{cheapFuel.prix_moyen_zone}€</span>
                  {cheapFuel.stations[0].unit === "kg" ? "/kg" : "/L"}
                </p>
                <ul className="space-y-2">
                  {cheapFuel.stations.slice(0, 8).map((s) => (
                    <li key={s.id} className="flex items-center justify-between border-b border-border pb-2 last:border-0" data-testid={`station-${s.id}`}>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{s.name}</p>
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <MapPin size={10} /> {s.distanceKm} km · {s.city}
                        </p>
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        <p className="text-sm font-bold">{s.price_eur}€{s.unit === "kg" ? "/kg" : "/L"}</p>
                        {s.economie_vs_plus_cher_eur_par_plein > 0 && (
                          <p className="text-[10px] text-emerald-500">-{s.economie_vs_plus_cher_eur_par_plein}€/plein</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── 3. Recharge EV / Pauses ── */}
        <Card data-testid="card-charging-strategy">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap size={16} />
              Recharge EV / Pauses
            </CardTitle>
          </CardHeader>
          <CardContent>
            {chargingLoading || !chargingStrategy ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <div className="space-y-3">
                {chargingStrategy.paliers.map((p) => (
                  <div key={p.palier} className="rounded-lg border border-border p-3" data-testid={`tier-${p.palier}`}>
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold flex items-center gap-1.5">
                        <Battery size={14} className="text-sky-400" />
                        {p.label_fr}
                      </p>
                      <Badge variant="outline" className="text-[10px]">{p.duree_min} min · +{p.pct_batterie_gagne}%</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{p.conseil_fr}</p>
                    {p.stations.length > 0 && (
                      <p className="text-[11px] mt-2 text-muted-foreground">
                        Le plus proche : <span className="font-medium">{p.stations[0].name}</span> ({p.stations[0].distanceKm} km, {p.stations[0].powerKw} kW)
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── 4. Entretien à venir ── */}
        <Card data-testid="card-maintenance">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Wrench size={16} />
              Entretien à venir
            </CardTitle>
          </CardHeader>
          <CardContent>
            {maintenanceLoading || !maintenanceData ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <ul className="space-y-2">
                {maintenanceData.reminders.map((r) => {
                  const style = STATUS_STYLE[r.status] ?? STATUS_STYLE.a_venir;
                  return (
                    <li key={r.id} className="flex items-center justify-between border-b border-border pb-2 last:border-0" data-testid={`maintenance-${r.type}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <Calendar size={14} className="text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{MAINTENANCE_LABELS[r.type] ?? r.type}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {r.km_next < 999999 ? `${r.km_next.toLocaleString("fr-FR")} km` : ""}
                            {r.date_next ? ` · ${new Date(r.date_next).toLocaleDateString("fr-FR")}` : ""}
                            {" · ~"}{r.cost_estimate}€
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${style.color}`}>{style.label}</span>
                        <button
                          onClick={() => markMaintenanceDone(r.id, r.type)}
                          className="p-1.5 rounded-md hover:bg-accent"
                          style={{ minWidth: 32, minHeight: 32 }}
                          aria-label="Marquer comme fait"
                          data-testid={`button-maintenance-done-${r.type}`}
                        >
                          <CheckCircle2 size={16} className="text-emerald-500" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ── 5. LOA/LLD tracker ── */}
        <Card data-testid="card-loa-tracker">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingDown size={16} />
              LOA/LLD tracker
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loaLoading || !loaTracker ? (
              <Skeleton className="h-24 w-full" />
            ) : !loaTracker.has_contract ? (
              <p className="text-sm text-muted-foreground">{loaTracker.message_fr}</p>
            ) : (
              <div className="space-y-2">
                <div className="w-full h-3 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      loaTracker.alert_level === "depassement" ? "bg-red-500" : loaTracker.alert_level === "attention" ? "bg-amber-500" : "bg-emerald-500"
                    }`}
                    style={{
                      width: `${Math.min(100, ((loaTracker.km_reel_a_date ?? 0) / Math.max(1, loaTracker.km_prevu_a_date ?? 1)) * 100)}%`,
                    }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{loaTracker.km_reel_a_date?.toLocaleString("fr-FR")} km réels</span>
                  <span>{loaTracker.km_prevu_a_date?.toLocaleString("fr-FR")} km prévus</span>
                </div>
                <div className={`flex items-start gap-2 text-xs rounded-lg p-2.5 ${
                  loaTracker.alert_level === "depassement" ? "bg-red-500/10 text-red-500" :
                  loaTracker.alert_level === "attention" ? "bg-amber-500/10 text-amber-500" : "bg-emerald-500/10 text-emerald-500"
                }`}>
                  {loaTracker.alert_level !== "ok" ? <AlertTriangle size={14} className="shrink-0 mt-0.5" /> : <CheckCircle2 size={14} className="shrink-0 mt-0.5" />}
                  <span>{loaTracker.message_fr}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── 6. Consommation moyenne ── */}
        <Card data-testid="card-fuel-log">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Droplet size={16} />
              Consommation moyenne
            </CardTitle>
          </CardHeader>
          <CardContent>
            {fuelLogLoading || !fuelLogStats ? (
              <Skeleton className="h-28 w-full" />
            ) : (
              <div className="space-y-2">
                <ConsoBarChart logs={fuelLogStats.logs} />
                <div className="grid grid-cols-2 gap-2 text-center mt-2">
                  <div className="rounded-lg bg-muted p-2">
                    <p className="text-sm font-semibold">
                      {fuelLogStats.conso_moyenne_l_100km != null ? `${fuelLogStats.conso_moyenne_l_100km} L/100km` : "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">Conso thermique moy.</p>
                  </div>
                  <div className="rounded-lg bg-muted p-2">
                    <p className="text-sm font-semibold">{fuelLogStats.cout_moyen_par_plein_eur}€</p>
                    <p className="text-[10px] text-muted-foreground">Coût moyen/plein</p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── 7. EV vs Thermique ── */}
        <Card data-testid="card-ev-vs-thermal">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap size={16} />
              EV vs Thermique
            </CardTitle>
          </CardHeader>
          <CardContent>
            {evLoading || !evVsThermal ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-sky-500/10 p-3 text-center">
                    <p className="text-lg font-bold text-sky-500">{evVsThermal.cout_ev_mensuel_eur}€</p>
                    <p className="text-[10px] text-muted-foreground">Coût mensuel EV</p>
                  </div>
                  <div className="rounded-lg bg-orange-500/10 p-3 text-center">
                    <p className="text-lg font-bold text-orange-500">{evVsThermal.cout_thermique_mensuel_eur}€</p>
                    <p className="text-[10px] text-muted-foreground">Coût mensuel thermique</p>
                  </div>
                </div>
                <div className="rounded-lg bg-emerald-500/10 p-3 text-center">
                  <p className="text-xl font-bold text-emerald-500">+{evVsThermal.economie_annuelle_estimee_eur}€/an</p>
                  <p className="text-[11px] text-muted-foreground">Économie estimée en passant à l'électrique</p>
                </div>
                <ul className="space-y-1">
                  {evVsThermal.hypotheses_fr.map((h, i) => (
                    <li key={i} className="text-[10px] text-muted-foreground flex items-start gap-1.5">
                      <span className="mt-1 w-1 h-1 rounded-full bg-muted-foreground shrink-0" />
                      {h}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
