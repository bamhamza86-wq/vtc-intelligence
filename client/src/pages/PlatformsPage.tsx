/**
 * PlatformsPage — Couche Économie & Fiscalité (multi-plateforme)
 * ─────────────────────────────────────────────────────────────────────────────
 * Comparatif KPI Uber/Bolt/Heetch/FreeNow, règles maison (CRUD), et
 * recommandation "quelle appli allumer maintenant".
 * Endpoints : GET /api/platforms/kpi-comparison, GET /api/platforms/which-now,
 *             GET/POST/PUT/DELETE /api/platforms/rules
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Layers, Zap, TrendingUp, Trash2, Plus, Sparkles } from "lucide-react";

interface PlatformKpi {
  platform: string; hours: number; ca: number; rides: number;
  avg_fare: number; commission_pct: number; net_hourly: number;
}
interface WhichNowRecommendation {
  platform: string; reason_fr: string; expected_hourly: number;
}
interface PlatformRule {
  id: number; platform: string; rule_key: string; value_json: string; active: number;
}

const PLATFORM_META: Record<string, { label: string; color: string; badge: string }> = {
  uber:    { label: "Uber",    color: "#000000", badge: "bg-black text-white" },
  bolt:    { label: "Bolt",    color: "#34d186", badge: "bg-emerald-500 text-white" },
  heetch:  { label: "Heetch",  color: "#f4364c", badge: "bg-rose-500 text-white" },
  freenow: { label: "FreeNow", color: "#fecb00", badge: "bg-yellow-400 text-black" },
  autre:   { label: "Autre",   color: "#64748b", badge: "bg-slate-500 text-white" },
};

const RULE_KEYS = [
  { key: "min_km", label: "Distance min. (km)" },
  { key: "min_fare", label: "Tarif min. (€)" },
  { key: "max_pickup_km", label: "Distance prise en charge max (km)" },
  { key: "blacklist_zone", label: "Zone en liste noire" },
  { key: "blackout_hours", label: "Plage horaire bloquée" },
] as const;

function platformLabel(p: string): string {
  return PLATFORM_META[p]?.label ?? p;
}

// ────────────────────────────────────────────────────────────────
// Comparatif KPI
// ────────────────────────────────────────────────────────────────
function KpiComparisonTable({ data, loading }: { data: PlatformKpi[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (data.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Aucune statistique enregistrée — ajoutez vos heures/CA par plateforme pour voir le comparatif.
      </p>
    );
  }
  const best = [...data].sort((a, b) => b.net_hourly - a.net_hourly)[0];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] text-muted-foreground border-b border-border">
            <th className="py-2 pr-2">Plateforme</th>
            <th className="py-2 pr-2">Heures</th>
            <th className="py-2 pr-2">CA</th>
            <th className="py-2 pr-2">Courses</th>
            <th className="py-2 pr-2">Tarif moy.</th>
            <th className="py-2 pr-2">Comm.</th>
            <th className="py-2 pr-2">€/h net</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const meta = PLATFORM_META[row.platform] ?? PLATFORM_META.autre;
            const isBest = row.platform === best.platform;
            return (
              <tr key={row.platform} className={`border-b border-border/50 last:border-0 ${isBest ? "bg-emerald-500/5" : ""}`}>
                <td className="py-2 pr-2">
                  <Badge className={`text-[10px] ${meta.badge}`}>{meta.label}</Badge>
                  {isBest && <TrendingUp size={12} className="inline ml-1 text-emerald-400" />}
                </td>
                <td className="py-2 pr-2 tabular-nums">{row.hours.toFixed(1)}h</td>
                <td className="py-2 pr-2 tabular-nums">{row.ca.toFixed(0)}€</td>
                <td className="py-2 pr-2 tabular-nums">{row.rides}</td>
                <td className="py-2 pr-2 tabular-nums">{row.avg_fare.toFixed(1)}€</td>
                <td className="py-2 pr-2 tabular-nums">{row.commission_pct.toFixed(0)}%</td>
                <td className="py-2 pr-2 tabular-nums font-bold" style={{ color: isBest ? "#22c55e" : undefined }}>
                  {row.net_hourly.toFixed(0)}€/h
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Widget "quelle appli allumer maintenant"
// ────────────────────────────────────────────────────────────────
function WhichNowWidget() {
  const { data, isLoading } = useQuery<WhichNowRecommendation>({
    queryKey: ["/api/platforms/which-now"],
    refetchInterval: 60_000,
  });
  if (isLoading || !data) return <Skeleton className="h-20 w-full" />;
  const meta = PLATFORM_META[data.platform] ?? PLATFORM_META.autre;
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
          <Sparkles size={13} className="text-primary" /> Quelle appli allumer maintenant ?
        </div>
        <div className="flex items-center justify-between">
          <Badge className={`text-sm px-3 py-1 ${meta.badge}`}>{meta.label}</Badge>
          <span className="text-lg font-bold tabular-nums text-primary">{data.expected_hourly.toFixed(0)} €/h attendu</span>
        </div>
        <p className="text-xs text-muted-foreground mt-2">{data.reason_fr}</p>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────
// Ajout rapide de stats plateforme
// ────────────────────────────────────────────────────────────────
function AddStatsForm() {
  const [platform, setPlatform] = useState("uber");
  const [hours, setHours] = useState("8");
  const [ca, setCa] = useState("150");
  const [rides, setRides] = useState("12");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/platforms/stats", {
        platform,
        period: new Date().toISOString().slice(0, 10),
        hours: parseFloat(hours) || 0,
        ca: parseFloat(ca) || 0,
        rides: parseInt(rides, 10) || 0,
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/platforms/kpi-comparison"] });
      queryClient.invalidateQueries({ queryKey: ["/api/platforms/which-now"] });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Ajouter une session</CardTitle></CardHeader>
      <CardContent className="space-y-3 px-4 pb-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger className="h-9 text-sm" data-testid="select-add-platform"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(PLATFORM_META).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Input type="number" step="0.5" placeholder="Heures" value={hours} onChange={(e) => setHours(e.target.value)} className="h-9 text-sm" data-testid="input-add-hours" />
          <Input type="number" step="1" placeholder="CA (€)" value={ca} onChange={(e) => setCa(e.target.value)} className="h-9 text-sm" data-testid="input-add-ca" />
          <Input type="number" step="1" placeholder="Courses" value={rides} onChange={(e) => setRides(e.target.value)} className="h-9 text-sm" data-testid="input-add-rides" />
        </div>
        <Button size="sm" className="w-full h-9 text-xs gap-1.5" onClick={() => mutation.mutate()} disabled={mutation.isPending} data-testid="button-add-platform-stats">
          <Plus size={13} /> {mutation.isPending ? "Ajout…" : "Enregistrer la session"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────
// Règles maison — CRUD
// ────────────────────────────────────────────────────────────────
function RulesSection() {
  const { data, isLoading } = useQuery<{ rules: PlatformRule[] }>({
    queryKey: ["/api/platforms/rules"],
    refetchInterval: 15_000,
  });
  const rules = data?.rules ?? [];

  const [platform, setPlatform] = useState("uber");
  const [ruleKey, setRuleKey] = useState<typeof RULE_KEYS[number]["key"]>("min_km");
  const [value, setValue] = useState("");

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/platforms/rules", { platform, rule_key: ruleKey, value: parseRuleValue(ruleKey, value) }).then((r) => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/platforms/rules"] }); setValue(""); },
  });
  const toggleMutation = useMutation({
    mutationFn: (vars: { id: number; active: boolean }) =>
      apiRequest("PUT", `/api/platforms/rules/${vars.id}`, { active: vars.active }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/platforms/rules"] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/platforms/rules/${id}`).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/platforms/rules"] }),
  });

  function parseRuleValue(key: string, raw: string): unknown {
    if (key === "min_km" || key === "min_fare" || key === "max_pickup_km") return parseFloat(raw) || 0;
    return raw;
  }

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Règles maison</CardTitle></CardHeader>
      <CardContent className="space-y-3 px-4 pb-4">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : rules.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Aucune règle définie.</p>
        ) : (
          <ul className="space-y-1.5">
            {rules.map((r) => {
              const meta = PLATFORM_META[r.platform] ?? PLATFORM_META.autre;
              const label = RULE_KEYS.find((k) => k.key === r.rule_key)?.label ?? r.rule_key;
              let displayValue = r.value_json;
              try { displayValue = JSON.parse(r.value_json); } catch { /* garder brut */ }
              return (
                <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge className={`text-[9px] shrink-0 ${meta.badge}`}>{meta.label}</Badge>
                    <span className="text-xs truncate">{label} : <strong>{String(displayValue)}</strong></span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={!!r.active}
                      onCheckedChange={(v) => toggleMutation.mutate({ id: r.id, active: v })}
                      data-testid={`switch-rule-${r.id}`}
                    />
                    <button onClick={() => deleteMutation.mutate(r.id)} aria-label="Supprimer" data-testid={`button-delete-rule-${r.id}`}>
                      <Trash2 size={14} className="text-muted-foreground hover:text-red-400" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="grid grid-cols-3 gap-2 pt-1">
          <Select value={platform} onValueChange={setPlatform}>
            <SelectTrigger className="h-9 text-xs" data-testid="select-rule-platform"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(PLATFORM_META).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={ruleKey} onValueChange={(v) => setRuleKey(v as typeof ruleKey)}>
            <SelectTrigger className="h-9 text-xs" data-testid="select-rule-key"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RULE_KEYS.map((k) => <SelectItem key={k.key} value={k.key}>{k.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input placeholder="Valeur" value={value} onChange={(e) => setValue(e.target.value)} className="h-9 text-xs" data-testid="input-rule-value" />
        </div>
        <Button size="sm" variant="outline" className="w-full h-9 text-xs gap-1.5" onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !value} data-testid="button-add-rule">
          <Plus size={13} /> Ajouter la règle
        </Button>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────
// Page principale
// ────────────────────────────────────────────────────────────────
export default function PlatformsPage() {
  const [period, setPeriod] = useState("30d");
  const kpiQ = useQuery<{ platforms: PlatformKpi[] }>({
    queryKey: ["/api/platforms/kpi-comparison", period],
    queryFn: () => apiRequest("GET", `/api/platforms/kpi-comparison?period=${period}`).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div>
        <h2 className="font-bold text-lg flex items-center gap-2">
          <Layers size={18} className="text-primary" /> Multi-plateforme
        </h2>
        <p className="text-sm text-muted-foreground">Comparatif KPI, règles maison et recommandation temps réel</p>
      </div>

      <WhichNowWidget />

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2"><Zap size={14} className="text-amber-400" />Comparatif KPI</CardTitle>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="h-8 w-24 text-xs" data-testid="select-kpi-period"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">7 jours</SelectItem>
              <SelectItem value="30d">30 jours</SelectItem>
              <SelectItem value="90d">90 jours</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <KpiComparisonTable data={kpiQ.data?.platforms ?? []} loading={kpiQ.isLoading} />
        </CardContent>
      </Card>

      <AddStatsForm />
      <RulesSection />
    </div>
  );
}
