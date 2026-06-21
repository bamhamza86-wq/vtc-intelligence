import { useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, API_BASE, getAuthToken } from "@/lib/queryClient";
import { useGpsPosition, GPS_FALLBACK } from "@/hooks/useGpsPosition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { RouteSourceBadge } from "@/components/RouteSourceBadge";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";
import {
  TrendingUp, Euro, Fuel, Wrench, Target, ChevronRight,
  AlertTriangle, CheckCircle, Clock, Zap, Car, BarChart2, Settings,
} from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────────
// Types — l'API SQLite renvoie majoritairement du snake_case.
// On modélise donc les champs tels que renvoyés par les endpoints.
// ──────────────────────────────────────────────────────────────────────────────
interface DriverProfile {
  id?: number;
  fuel_consumption_per100km: number;
  fuel_price_per_liter: number;
  platform_commission_pct: number;
  hourly_target_income: number;
  wear_cost_per_km: number;
  min_profitable_km_per_min: number;
  vehicle_type?: string;
  prefer_long_rides?: boolean;
}

interface RideStats {
  total: number;
  totalNetProfit: number;
  avgHourlyRate: number;
  avgDistance: number;
  profitableCount: number;
  longRideCount: number;
}

interface Ride {
  id?: number;
  pickup_zone_id: string;
  dropoff_zone_id: string;
  distance_km: number;
  duration_min: number;
  fare: number;
  commission: number;
  fuel_cost: number;
  net_profit: number;
  hourly_rate: number;
  is_profitable: number | boolean;
  is_long_ride?: number | boolean;
  timestamp: string;
  weather?: string | null;
}

interface ProfitabilityScore {
  zone_id: string;
  zone_name?: string;
  zone_type?: string;
  hour: number;
  day_type: string;
  avg_distance_km: number;
  avg_duration_min: number;
  avg_fare: number;
  profitability_index: number;
  surge_multiplier?: number;
}

interface RouteEntry {
  zoneId: string;
  roadKm: number;
  etaMin: number;
  speedKmH: number;
  distanceSource?: string;
}

interface GmapsDistances {
  entries: Record<string, RouteEntry>;
  lastUpdated: string;
  zonesCount: number;
}

// Défauts du modèle économique (issus du repo / énoncé).
const DEFAULT_PROFILE: DriverProfile = {
  fuel_consumption_per100km: 7.5,
  fuel_price_per_liter: 1.92,
  platform_commission_pct: 25,
  hourly_target_income: 35,
  wear_cost_per_km: 0.08,
  min_profitable_km_per_min: 1.0,
};

const WORK_HOURS = 8;
const UBER_COMMISSION_BENCHMARK = 25; // %
const FUEL_BENCHMARK = 1.44; // €/course (20km × 7.5L/100 × 1.92€)

// ──────────────────────────────────────────────────────────────────────────────
// Helpers de calcul — modèle économique strict
// ──────────────────────────────────────────────────────────────────────────────
function computeRideEconomics(distanceKm: number, durationMin: number, fare: number, p: DriverProfile) {
  const commission = fare * (p.platform_commission_pct / 100);
  const fuelCost = (distanceKm / 100) * p.fuel_consumption_per100km * p.fuel_price_per_liter;
  const wearCost = distanceKm * p.wear_cost_per_km;
  const netProfit = fare - commission - fuelCost - wearCost;
  const hourlyRate = durationMin > 0 ? (netProfit / durationMin) * 60 : 0;
  // Seuil : 1€/km ET 1min/km
  const isProfitable = distanceKm > 0 && fare >= distanceKm && durationMin <= distanceKm;
  return { commission, fuelCost, wearCost, netProfit, hourlyRate, isProfitable };
}

function isSameDay(iso: string, ref: Date): boolean {
  const d = new Date(iso);
  return d.getFullYear() === ref.getFullYear()
    && d.getMonth() === ref.getMonth()
    && d.getDate() === ref.getDate();
}

function eur(v: number, digits = 2): string {
  return `${v.toFixed(digits)} €`;
}

// Couleur du taux horaire selon paliers
function hourlyColor(rate: number): string {
  if (rate < 25) return "#ef4444";
  if (rate < 35) return "#f59e0b";
  if (rate < 50) return "#22c55e";
  return "#3b82f6";
}

// Nom court de zone (retire suffixes longs)
function shortZoneName(name: string | undefined, zoneId: string): string {
  if (!name) return zoneId.replace(/^z_/, "").replace(/_/g, " ");
  return name.split(/[—/]/)[0].trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Hooks de données partagés (dashboard complet + widget)
// ──────────────────────────────────────────────────────────────────────────────
function useEconomicsData() {
  const { position } = useGpsPosition();
  const profileQ = useQuery<DriverProfile | null>({
    queryKey: ["/api/driver-profile"],
    refetchInterval: 3_000,
  });
  const statsQ = useQuery<RideStats>({
    queryKey: ["/api/rides/stats"],
    refetchInterval: 3_000,
  });
  const ridesQ = useQuery<Ride[]>({
    queryKey: ["/api/rides"],
    refetchInterval: 3_000,
  });
  const profitQ = useQuery<ProfitabilityScore[]>({
    queryKey: ["/api/profitability", position.lat, position.lng],
    queryFn: () => apiRequest("GET", `/api/profitability?lat=${position.lat}&lng=${position.lng}`).then(r => r.json()),
    refetchInterval: 3_000,
  });
  const distQ = useQuery<GmapsDistances>({
    queryKey: ["/api/gmaps-distances"],
    refetchInterval: 3_000,
  });

  const profile: DriverProfile = profileQ.data ?? DEFAULT_PROFILE;

  return { profileQ, statsQ, ridesQ, profitQ, distQ, profile };
}

// Agrégats journaliers calculés depuis les courses + le profil
interface DailyAgg {
  dailyRealized: number;
  dailyTarget: number;
  avgHourlyRate: number;
  profitableCount: number;
  totalRides: number;
  efficiencyRatio: number;
  commissionLeakage: number;
  avgFuelPerRide: number;
  avgWearPerRide: number;
  commissionToday: number;
  hourlyBuckets: { hour: number; rate: number; count: number }[];
}

function buildDailyAgg(rides: Ride[], profile: DriverProfile): DailyAgg {
  const ref = new Date();
  const todays = rides.filter((r) => isSameDay(r.timestamp, ref));
  const set = todays.length > 0 ? todays : rides; // fallback : toutes les courses si rien aujourd'hui

  let sumNet = 0, sumFare = 0, sumComm = 0, sumFuel = 0, sumWear = 0;
  let profitable = 0;
  const buckets = new Map<number, { sum: number; count: number }>();

  for (const r of set) {
    const e = computeRideEconomics(r.distance_km, r.duration_min, r.fare, profile);
    sumNet += e.netProfit;
    sumFare += r.fare;
    sumComm += e.commission;
    sumFuel += e.fuelCost;
    sumWear += e.wearCost;
    if (e.isProfitable) profitable += 1;
    const h = new Date(r.timestamp).getHours();
    const b = buckets.get(h) ?? { sum: 0, count: 0 };
    b.sum += e.hourlyRate;
    b.count += 1;
    buckets.set(h, b);
  }

  const total = set.length;
  const hourlyBuckets = Array.from(buckets.entries())
    .map(([hour, b]) => ({ hour, rate: b.count > 0 ? b.sum / b.count : 0, count: b.count }))
    .sort((a, b) => a.hour - b.hour);

  return {
    dailyRealized: sumNet,
    dailyTarget: profile.hourly_target_income * WORK_HOURS,
    avgHourlyRate: total > 0 ? hourlyBuckets.reduce((s, x) => s + x.rate * x.count, 0) / total : 0,
    profitableCount: profitable,
    totalRides: total,
    efficiencyRatio: total > 0 ? (profitable / total) * 100 : 0,
    commissionLeakage: sumFare > 0 ? (sumComm / sumFare) * 100 : 0,
    avgFuelPerRide: total > 0 ? sumFuel / total : 0,
    avgWearPerRide: total > 0 ? sumWear / total : 0,
    commissionToday: sumComm,
    hourlyBuckets,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Petits composants
// ──────────────────────────────────────────────────────────────────────────────
function KpiCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
          <span style={{ color }}>{icon}</span>
          <span>{label}</span>
        </div>
        <p className="text-2xl font-bold leading-tight" style={{ color }}>{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function Gauge({ icon, label, value, benchmark, unit, warnIfAbove }: {
  icon: React.ReactNode;
  label: string;
  value: number;
  benchmark: number;
  unit: string;
  warnIfAbove: boolean;
}) {
  const ratio = benchmark > 0 ? Math.min(150, (value / benchmark) * 100) : 0;
  const over = value > benchmark;
  const bad = warnIfAbove ? over : value > benchmark;
  const barColor = bad ? "#ef4444" : "#22c55e";
  return (
    <Card className="bg-card border-border">
      <CardContent className="py-3 px-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span style={{ color: barColor }}>{icon}</span>{label}
          </div>
          <span className="text-sm font-bold" style={{ color: barColor }}>
            {unit === "%" ? `${value.toFixed(1)}%` : eur(value)}
          </span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${ratio}%`, background: barColor }} />
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          Benchmark : {unit === "%" ? `${benchmark}%` : eur(benchmark)}
          {over ? " — au-dessus" : " — sous le seuil"}
        </p>
      </CardContent>
    </Card>
  );
}

type InsightLevel = "good" | "warning" | "critical";
interface Insight { level: InsightLevel; title: string; detail: string; }

function InsightRow({ insight }: { insight: Insight }) {
  const cfg = {
    good: { color: "#22c55e", icon: <CheckCircle size={15} /> },
    warning: { color: "#f59e0b", icon: <AlertTriangle size={15} /> },
    critical: { color: "#ef4444", icon: <AlertTriangle size={15} /> },
  }[insight.level];
  return (
    <li className="flex gap-3 py-2 border-b border-border last:border-0">
      <span style={{ color: cfg.color }} className="mt-0.5 shrink-0">{cfg.icon}</span>
      <div>
        <p className="text-sm font-medium">{insight.title}</p>
        <p className="text-xs text-muted-foreground">{insight.detail}</p>
      </div>
    </li>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Génération des insights actionnables
// ──────────────────────────────────────────────────────────────────────────────
function buildInsights(agg: DailyAgg, scores: ProfitabilityScore[], profile: DriverProfile): Insight[] {
  const out: Insight[] = [];

  // 1. Optimisation horaire — meilleures tranches
  if (agg.hourlyBuckets.length > 0) {
    const top = [...agg.hourlyBuckets].sort((a, b) => b.rate - a.rate).slice(0, 3);
    const slots = top.map((b) => `${b.hour}h`).join(", ");
    out.push({
      level: "good",
      title: "Optimisation horaire",
      detail: `Priorité ${slots} — vos meilleures €/h (jusqu'à ${eur(top[0].rate, 0)}/h).`,
    });
  }

  // 2. Routes haute valeur — zones ≥ 1.5€/km
  const highValue = scores
    .filter((s) => s.avg_distance_km > 0 && s.avg_fare / s.avg_distance_km >= 1.5)
    .sort((a, b) => (b.avg_fare / b.avg_distance_km) - (a.avg_fare / a.avg_distance_km))
    .slice(0, 1);
  if (highValue.length > 0) {
    const z = highValue[0];
    const perKm = z.avg_fare / z.avg_distance_km;
    out.push({
      level: "good",
      title: "Routes haute valeur",
      detail: `${shortZoneName(z.zone_name, z.zone_id)} : ${perKm.toFixed(1)}€/km moyen — la distance compense largement.`,
    });
  }

  // 3. Fuite commission > 25%
  if (agg.commissionLeakage > UBER_COMMISSION_BENCHMARK) {
    out.push({
      level: "warning",
      title: "Fuite commission",
      detail: `Perte commission : ${eur(agg.commissionToday)} aujourd'hui (${agg.commissionLeakage.toFixed(1)}% du CA brut) — envisager une tarification minimale.`,
    });
  }

  // 4. Courses non rentables — zones avec avg_fare < avg_distance_km
  const unprofitable = scores.filter((s) => s.avg_fare < s.avg_distance_km);
  if (unprofitable.length > 0) {
    const list = unprofitable
      .slice(0, 3)
      .map((s) => {
        const loss = s.avg_distance_km - s.avg_fare;
        return `${shortZoneName(s.zone_name, s.zone_id)} (−${loss.toFixed(1)}€)`;
      })
      .join(", ");
    out.push({
      level: "critical",
      title: "Zones non rentables",
      detail: `Tarif sous le seuil 1€/km : ${list}. Pertes estimées par course.`,
    });
  }

  // 5. Plage de pause optimale — creux 10h-16h
  const midday = agg.hourlyBuckets.filter((b) => b.hour >= 10 && b.hour <= 16);
  if (midday.length > 0) {
    const worst = [...midday].sort((a, b) => a.rate - b.rate)[0];
    out.push({
      level: "warning",
      title: "Plage de pause optimale",
      detail: `Pause recommandée 13h-15h — creux de profitabilité en journée (min ${eur(worst.rate, 0)}/h vers ${worst.hour}h).`,
    });
  } else {
    out.push({
      level: "warning",
      title: "Plage de pause optimale",
      detail: "Pause recommandée 13h-15h — profitabilité historiquement faible en milieu de journée.",
    });
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Dashboard complet
// ──────────────────────────────────────────────────────────────────────────────
export default function EconomicsDashboard() {
  const { profileQ, ridesQ, profitQ, distQ, profile } = useEconomicsData();

  const rides: Ride[] = ridesQ.data ?? [];
  const scores: ProfitabilityScore[] = profitQ.data ?? [];
  const routeEntries: Record<string, RouteEntry> = distQ.data?.entries ?? {};
  const primarySource: string = Object.values(routeEntries)[0]?.distanceSource ?? "calibrated";

  const agg = useMemo(() => buildDailyAgg(rides, profile), [rides, profile]);
  const insights = useMemo(() => buildInsights(agg, scores, profile), [agg, scores, profile]);

  // Mutation : mise à jour du profil (paramètres économiques)
  const updateProfile = useMutation({
    mutationFn: (patch: Partial<DriverProfile>) =>
      apiRequest("PUT", "/api/driver-profile", patch).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/driver-profile"] });
    },
  });

  // Données par zone pour la heatmap
  const zoneCards = useMemo(() => {
    return scores.map((s) => {
      const net = s.avg_fare
        - s.avg_fare * (profile.platform_commission_pct / 100)
        - (s.avg_distance_km / 100) * profile.fuel_consumption_per100km * profile.fuel_price_per_liter
        - s.avg_distance_km * profile.wear_cost_per_km;
      const hourlyNet = s.avg_duration_min > 0 ? (net / s.avg_duration_min) * 60 : 0;
      const profitable = s.avg_distance_km > 0
        && s.avg_fare >= s.avg_distance_km
        && s.avg_duration_min <= s.avg_distance_km;
      const road = routeEntries[s.zone_id];
      return {
        zoneId: s.zone_id,
        name: shortZoneName(s.zone_name, s.zone_id),
        hourlyNet,
        profitable,
        roadKm: road?.roadKm ?? s.avg_distance_km,
      };
    });
  }, [scores, profile, routeEntries]);

  // Données du graphique comparatif (Section 5) — par heure 6h→22h
  const chartData = useMemo(() => {
    const target = profile.hourly_target_income;
    const byHour = new Map(agg.hourlyBuckets.map((b) => [b.hour, b.rate]));
    const rows: { hour: string; rate: number; target: number }[] = [];
    for (let h = 6; h <= 22; h++) {
      rows.push({ hour: `${h}h`, rate: Math.round(byHour.get(h) ?? 0), target });
    }
    return rows;
  }, [agg.hourlyBuckets, profile.hourly_target_income]);

  const loading = profileQ.isLoading || ridesQ.isLoading || profitQ.isLoading;
  const hasRides = agg.totalRides > 0;
  const target = profile.hourly_target_income * WORK_HOURS;

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-lg flex items-center gap-2">
            <BarChart2 size={20} className="text-primary" />
            Unit Economics — Chauffeur VTC
          </h2>
          <p className="text-sm text-muted-foreground">
            Rentabilité réelle · Seine-Saint-Denis (93) · seuil 1€/km &amp; 1min/km
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Données temps réel :</span>
            <RouteSourceBadge source={primarySource} size="xs" />
          </div>
          <Badge variant="outline" className="border-border text-muted-foreground gap-1">
            <Settings size={12} /> {profile.platform_commission_pct}% comm.
          </Badge>
        </div>
      </div>

      {/* SECTION 1 — KPIs Journaliers */}
      <section>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2 font-medium">
          KPIs journaliers
        </p>
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              icon={<Euro size={14} />}
              label="Revenu net réalisé"
              value={eur(agg.dailyRealized)}
              sub={`Objectif ${eur(target, 0)}`}
              color={agg.dailyRealized >= target ? "#22c55e" : "#ef4444"}
            />
            <KpiCard
              icon={<Target size={14} />}
              label="Objectif journalier"
              value={eur(target, 0)}
              sub={`${profile.hourly_target_income}€/h × ${WORK_HOURS}h`}
              color="#3b82f6"
            />
            <KpiCard
              icon={<TrendingUp size={14} />}
              label="Taux horaire moyen"
              value={`${agg.avgHourlyRate.toFixed(0)} €/h`}
              sub={`cible ${profile.hourly_target_income}€/h`}
              color="#f59e0b"
            />
            <KpiCard
              icon={<Zap size={14} />}
              label="Courses rentables"
              value={`${agg.profitableCount}/${agg.totalRides}`}
              sub={`${agg.efficiencyRatio.toFixed(0)}% efficacité`}
              color={agg.efficiencyRatio > 70 ? "#22c55e" : agg.efficiencyRatio > 50 ? "#f59e0b" : "#ef4444"}
            />
          </div>
        )}
        {!loading && !hasRides && (
          <p className="text-xs text-muted-foreground mt-2 italic">
            Aucune course enregistrée aujourd'hui — les KPIs s'actualiseront automatiquement.
          </p>
        )}
      </section>

      {/* SECTION 2 — Analyse des coûts */}
      <section>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2 font-medium">
          Analyse des coûts
        </p>
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Gauge
              icon={<Euro size={14} />}
              label="Commission leakage"
              value={agg.commissionLeakage}
              benchmark={UBER_COMMISSION_BENCHMARK}
              unit="%"
              warnIfAbove
            />
            <Gauge
              icon={<Fuel size={14} />}
              label="Carburant / course"
              value={agg.avgFuelPerRide}
              benchmark={FUEL_BENCHMARK}
              unit="€"
              warnIfAbove
            />
            <Gauge
              icon={<Wrench size={14} />}
              label="Usure véhicule / course"
              value={agg.avgWearPerRide}
              benchmark={profile.wear_cost_per_km * 20}
              unit="€"
              warnIfAbove
            />
          </div>
        )}
      </section>

      {/* SECTION 3 — Heatmap zones 93 */}
      <section>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2 font-medium">
          Heatmap zones 93 — taux horaire net moyen
        </p>
        {profitQ.isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
          </div>
        ) : zoneCards.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Aucune donnée de zone disponible.</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {zoneCards.map((z) => {
              const color = hourlyColor(z.hourlyNet);
              return (
                <Card key={z.zoneId} className="bg-card border-border" style={{ borderColor: `${color}55` }}>
                  <CardContent className="py-3 px-3">
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-xs font-medium leading-tight">{z.name}</span>
                      <Car size={12} className="text-muted-foreground shrink-0 mt-0.5" />
                    </div>
                    <p className="text-xl font-bold mt-1" style={{ color }}>
                      {z.hourlyNet.toFixed(0)} <span className="text-xs font-normal">€/h</span>
                    </p>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[10px] text-muted-foreground">{z.roadKm.toFixed(1)} km</span>
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1.5 py-0 h-4"
                        style={{
                          borderColor: z.profitable ? "#22c55e66" : "#ef444466",
                          color: z.profitable ? "#22c55e" : "#ef4444",
                        }}
                      >
                        {z.profitable ? "rentable" : "sous seuil"}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* SECTION 4 — Insights actionnables */}
      <section>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2 font-medium">
          Insights actionnables
        </p>
        <Card className="bg-card border-border">
          <CardContent className="py-2 px-4">
            {profitQ.isLoading ? (
              <div className="space-y-2 py-2">
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : insights.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-3">
                Pas assez de données pour générer des recommandations.
              </p>
            ) : (
              <ul>
                {insights.map((ins, i) => <InsightRow key={i} insight={ins} />)}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* SECTION 5 — Comparatif cibles vs réalisé */}
      <section>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2 font-medium">
          Réalisé vs cible {profile.hourly_target_income}€/h — par tranche horaire
        </p>
        <Card className="bg-card border-border">
          <CardContent className="py-4 px-2">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: -15 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="hour" tick={{ fontSize: 10, fill: "#94a3b8" }} interval={0} />
                  <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v) => `${v}€`} />
                  <Tooltip
                    contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#e2e8f0" }}
                    formatter={(v: number) => [`${Number(v).toFixed(0)} €/h`, "Taux horaire"]}
                  />
                  <ReferenceLine
                    y={profile.hourly_target_income}
                    stroke="#3b82f6"
                    strokeDasharray="4 4"
                    label={{ value: "cible", fill: "#3b82f6", fontSize: 10, position: "right" }}
                  />
                  <Bar dataKey="rate" radius={[3, 3, 0, 0]}>
                    {chartData.map((entry, i) => (
                      <Cell key={i} fill={entry.rate > profile.hourly_target_income ? "#22c55e" : "#ef4444"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {!hasRides && (
              <p className="text-[11px] text-muted-foreground mt-1 text-center italic">
                Graphique vide — en attente des premières courses du jour.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Bouton de calibrage (mutation profil) */}
      <div className="flex justify-end">
        <button
          onClick={() => updateProfile.mutate({ hourly_target_income: profile.hourly_target_income })}
          disabled={updateProfile.isPending}
          className="text-xs flex items-center gap-1 text-muted-foreground hover:text-primary transition-colors"
        >
          {updateProfile.isPending ? "Synchronisation…" : "Recalibrer le profil"}
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Widget compact — 2 KPIs + 1 insight — pour intégration dans d'autres pages
// ──────────────────────────────────────────────────────────────────────────────
export function EconomicsWidget() {
  const { ridesQ, profitQ, profile, profileQ } = useEconomicsData();
  const rides: Ride[] = ridesQ.data ?? [];
  const scores: ProfitabilityScore[] = profitQ.data ?? [];

  const agg = useMemo(() => buildDailyAgg(rides, profile), [rides, profile]);
  const insights = useMemo(() => buildInsights(agg, scores, profile), [agg, scores, profile]);
  const target = profile.hourly_target_income * WORK_HOURS;
  const loading = profileQ.isLoading || ridesQ.isLoading;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart2 size={15} className="text-primary" /> Unit Economics
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-background/60 rounded-lg p-3">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Euro size={12} /> Net réalisé
              </div>
              <p
                className="text-xl font-bold"
                style={{ color: agg.dailyRealized >= target ? "#22c55e" : "#ef4444" }}
              >
                {eur(agg.dailyRealized)}
              </p>
            </div>
            <div className="bg-background/60 rounded-lg p-3">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Clock size={12} /> Taux horaire
              </div>
              <p className="text-xl font-bold" style={{ color: "#f59e0b" }}>
                {agg.avgHourlyRate.toFixed(0)} €/h
              </p>
            </div>
          </div>
        )}
        <Separator />
        {insights.length > 0 ? (
          <ul>
            <InsightRow insight={insights[0]} />
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground italic">Pas encore de recommandation.</p>
        )}
      </CardContent>
    </Card>
  );
}

// Référence explicite (évite l'erreur "unused import" sous certains linters
// tout en gardant les helpers d'auth disponibles si besoin de fetch manuel).
export const _ECONOMICS_AUTH_REF = { getAuthToken, API_BASE };
