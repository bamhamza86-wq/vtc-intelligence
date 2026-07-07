import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { User, BarChart, Wrench, Brain, Gauge, AlertTriangle, Lightbulb, MapPin, Clock, Plug, CheckCircle2, XCircle, AlertCircle, RefreshCw, Wallet, Zap as ZapIcon, RotateCcw } from "lucide-react";
import { MobileSettings } from "@/components/MobileSettings";
import { Flame } from "lucide-react";
import { getDailyGoalTarget, setDailyGoalTarget, useDailyStreak } from "@/hooks/useDailyStreak";
import { ReputationBadge } from "@/components/ReputationBadge";
import { BellOff, ShieldAlert } from "lucide-react";
import { isSilentModeActive, setSilentModeFor, clearSilentMode, getSilentModeUntil } from "@/lib/silentMode";
import { AmberNightToggle } from "@/components/AmberNightToggle";
import { isAiDisabledToday, enableAiDisabledToday, disableAiDisabledToday } from "@/lib/aiToggle";
import { BrainCircuit } from "lucide-react";
import { StreakBadge } from "@/components/StreakBadge";
import { QuestsCard } from "@/components/QuestsCard";
import { Gamepad2 } from "lucide-react";
// ─── Couche UX Avancée (Itération 3) : prompt notifications intelligent (§10.9) ───
import { NotifPermissionPrompt } from "@/components/NotifPermissionPrompt";
import { useSessionCount } from "@/hooks/useSessionCount";

const ZONES_93 = [
  { id: "z_cdg", name: "CDG" }, { id: "z_orly", name: "Orly" },
  { id: "z_saint_denis_gare", name: "Gare Saint-Denis" }, { id: "z_bobigny_gare", name: "Bobigny" },
  { id: "z_aubervilliers", name: "Aubervilliers" }, { id: "z_epinay_gennevilliers", name: "Épinay/Gennevilliers" },
  { id: "z_plaine_commune", name: "Plaine Commune" }, { id: "z_le_bourget", name: "Le Bourget" },
  { id: "z_villepinte", name: "Villepinte" }, { id: "z_tremblay", name: "Tremblay" },
  { id: "z_stade_france", name: "Stade de France" }, { id: "z_93_centre", name: "Saint-Denis Centre" },
  { id: "z_montreuil", name: "Montreuil" }, { id: "z_aulnay", name: "Aulnay" },
];

const URGENCY_META: Record<string, { label: string; cls: string }> = {
  ok:      { label: "OK",       cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  soon:    { label: "Bientôt",  cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  urgent:  { label: "Urgent",   cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  overdue: { label: "En retard", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
};

function scoreColor(s: number): string {
  if (s >= 75) return "text-emerald-400";
  if (s >= 55) return "text-amber-400";
  return "text-red-400";
}

export default function ProfilePage() {
  const { toast } = useToast();
  // ─── Couche UX Avancée : prompt notifications affiché seulement à partir de la 3e session (§10.9) ───
  const { sessionCount } = useSessionCount();
  const showNotifPrompt = sessionCount >= 3;
  // Vague 2 - Feature 3 : édition de l'objectif journalier + affichage streak
  const { streakDays } = useDailyStreak();
  const [goalTargetInput, setGoalTargetInput] = useState<string>(() => String(getDailyGoalTarget()));
  // ── Couche Sécurité — mode silence total (feat/safety) ────────────────
  const [silentModeOn, setSilentModeOn] = useState<boolean>(() => isSilentModeActive());
  // ── Couche ML Personnel — mode « pas d'IA aujourd'hui » ────────────────
  const [aiDisabledOn, setAiDisabledOn] = useState<boolean>(() => isAiDisabledToday());
  // Couche Wow Factor — toggle gamification (RGPD, 100% facultatif)
  const [gamificationOn, setGamificationOn] = useState<boolean>(true);
  const [form, setForm] = useState<any>({ fuelConsumptionPer100km: 7, fuelPricePerLiter: 1.85, platformCommissionPct: 25, hourlyTargetIncome: 35, wearCostPerKm: 0.08, vehicleType: "berline", preferLongRides: true,
    preferredZones: [], workHoursStart: 6, workHoursEnd: 22, avoidHighway: false, vehicleBrand: "", vehicleModel: "", vehicleYear: 2020, totalKmDriven: 0,
    // Couche Économie & Fiscalité (additif) — coût réel du véhicule tout inclus
    insuranceAnnualEur: 1800, maintenanceYearlyEur: 1200, vehicleAmortizationYearlyEur: 4800, tireYearlyEur: 600,
    cvoUrssafPct: 21.2, tvaRegime: "franchise", electricMode: false, kwhPer100km: 18, kwhPrice: 0.25, vehicleCvFiscaux: 5 });
  const { data: profile, isLoading } = useQuery({ queryKey: ["/api/driver-profile"], queryFn: () => apiRequest("GET", "/api/driver-profile").then(r => r.json()), refetchInterval: 3_000 });
  const { data: stats } = useQuery({ queryKey: ["/api/rides/stats"], queryFn: () => apiRequest("GET", "/api/rides/stats").then(r => r.json()), refetchInterval: 3_000 });
  const { data: maintenance } = useQuery<{ maintenance: any[] }>({ queryKey: ["/api/maintenance"], queryFn: () => apiRequest("GET", "/api/maintenance").then(r => r.json()), refetchInterval: 3_000 });
  const { data: performance } = useQuery<any>({ queryKey: ["/api/driver-performance"], queryFn: () => apiRequest("GET", "/api/driver-performance").then(r => r.json()), refetchInterval: 3_000 });

  const [platformKeys, setPlatformKeys] = useState<Record<string, string>>({ tomtom: "", gigdata: "" });
  const [platformTesting, setPlatformTesting] = useState<Record<string, boolean>>({});
  const { data: platformCreds, refetch: refetchCreds } = useQuery({
    queryKey: ["/api/platforms/credentials"],
    queryFn: () => apiRequest("GET", "/api/platforms/credentials").then(r => r.json()),
    refetchInterval: 3_000,
  });

  useEffect(() => {
    if (!profile) return;
    const p: any = profile;
    setGamificationOn(p.gamification_enabled === undefined ? true : Boolean(p.gamification_enabled));
    let pref: string[] = [];
    try { pref = Array.isArray(p.preferred_zones) ? p.preferred_zones : JSON.parse(p.preferred_zones ?? "[]"); } catch { pref = []; }
    setForm({
      fuelConsumptionPer100km: p.fuel_consumption_per100km ?? p.fuelConsumptionPer100km ?? 7,
      fuelPricePerLiter: p.fuel_price_per_liter ?? p.fuelPricePerLiter ?? 1.85,
      platformCommissionPct: p.platform_commission_pct ?? p.platformCommissionPct ?? 25,
      hourlyTargetIncome: p.hourly_target_income ?? p.hourlyTargetIncome ?? 35,
      wearCostPerKm: p.wear_cost_per_km ?? p.wearCostPerKm ?? 0.08,
      vehicleType: p.vehicle_type ?? p.vehicleType ?? "berline",
      preferLongRides: Boolean(p.prefer_long_rides ?? p.preferLongRides ?? true),
      preferredZones: pref,
      workHoursStart: p.work_hours_start ?? 6,
      workHoursEnd: p.work_hours_end ?? 22,
      avoidHighway: Boolean(p.avoid_highway ?? false),
      vehicleBrand: p.vehicle_brand ?? "",
      vehicleModel: p.vehicle_model ?? "",
      vehicleYear: p.vehicle_year ?? 2020,
      totalKmDriven: p.total_km_driven ?? 0,
      insuranceAnnualEur: p.insurance_annual_eur ?? 1800,
      maintenanceYearlyEur: p.maintenance_yearly_eur ?? 1200,
      vehicleAmortizationYearlyEur: p.vehicle_amortization_yearly_eur ?? 4800,
      tireYearlyEur: p.tire_yearly_eur ?? 600,
      cvoUrssafPct: p.cvo_urssaf_pct ?? 21.2,
      tvaRegime: p.tva_regime ?? "franchise",
      electricMode: Boolean(p.electric_mode ?? false),
      kwhPer100km: p.kwh_per_100km ?? 18,
      kwhPrice: p.kwh_price ?? 0.25,
      vehicleCvFiscaux: p.vehicle_cv_fiscaux ?? 5,
    });
  }, [profile]);

  const saveMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", "/api/driver-profile", data).then(r => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/driver-profile"] }); toast({ title: "Profil sauvegardé" }); },
  });

  const doneMutation = useMutation({
    mutationFn: (component: string) => apiRequest("PUT", `/api/maintenance/${component}/done`).then(r => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/maintenance"] }); toast({ title: "Entretien marqué effectué" }); },
  });

  const toggleZone = (zoneId: string) => {
    setForm((f: any) => {
      const has = f.preferredZones.includes(zoneId);
      return { ...f, preferredZones: has ? f.preferredZones.filter((z: string) => z !== zoneId) : [...f.preferredZones, zoneId] };
    });
  };

  const maintItems = maintenance?.maintenance ?? [];
  const hasUrgent = maintItems.some((m: any) => m.urgency === "urgent" || m.urgency === "overdue");

  const costPerKm = ((form.fuelConsumptionPer100km / 100) * form.fuelPricePerLiter + form.wearCostPerKm).toFixed(3);
  const minFarePerKm = ((1 + parseFloat(costPerKm)) / (1 - form.platformCommissionPct / 100)).toFixed(2);

  if (isLoading) return <div className="p-4 space-y-4">{[...Array(3)].map((_,i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}</div>;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div><h2 className="font-bold text-lg flex items-center gap-2"><User size={18} className="text-primary" />Profil chauffeur</h2><p className="text-sm text-muted-foreground">Paramètres de calcul personnalisés</p></div>
        {/* ─── Couche Communautaire : badge Karma + niveau (Novice/Confirmé/Vétéran) ─── */}
        <ReputationBadge />
      </div>

      {/* ─── Couche UX Avancée : prompt notifications intelligent — jamais au premier chargement (§10.9) ─── */}
      {showNotifPrompt && <NotifPermissionPrompt />}
      {stats && stats.totalRides > 0 && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="py-3 px-4">
            <p className="text-xs font-semibold text-primary mb-2 flex items-center gap-1.5"><BarChart size={12} />Vos statistiques</p>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div><p className="text-lg font-bold">{stats.totalRides}</p><p className="text-[10px] text-muted-foreground">Courses</p></div>
              <div><p className="text-lg font-bold text-green-400">{stats.avgHourlyRate.toFixed(0)}€</p><p className="text-[10px] text-muted-foreground">Moy./h</p></div>
              <div><p className="text-lg font-bold">{stats.profitableRatio}%</p><p className="text-[10px] text-muted-foreground">Rentables</p></div>
              <div><p className="text-lg font-bold">{stats.avgDistance}km</p><p className="text-[10px] text-muted-foreground">Dist. moy.</p></div>
            </div>
          </CardContent>
        </Card>
      )}
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="py-3 px-4">
          <p className="text-xs font-semibold mb-2">Seuils calculés avec vos paramètres</p>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div><p className="text-sm font-bold text-primary">{costPerKm} €</p><p className="text-[10px] text-muted-foreground">Coût réel/km</p></div>
            <div><p className="text-sm font-bold text-amber-400">{minFarePerKm} €</p><p className="text-[10px] text-muted-foreground">Tarif min./km</p></div>
            <div><p className="text-sm font-bold text-green-400">{form.hourlyTargetIncome} €</p><p className="text-[10px] text-muted-foreground">Objectif/h</p></div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Véhicule</CardTitle></CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <div>
            <Label className="text-xs">Type de véhicule</Label>
            <Select value={form.vehicleType} onValueChange={v => {
              // Valeurs par défaut selon le type de véhicule
              const VEHICLE_DEFAULTS: Record<string, { fuel: number; wear: number }> = {
                citadine:  { fuel: 5.0, wear: 0.06 },
                berline:   { fuel: 7.0, wear: 0.08 },
                suv:       { fuel: 9.0, wear: 0.10 },
                electrique:{ fuel: 0.0, wear: 0.04 },
                hybride:   { fuel: 5.0, wear: 0.06 },
              };
              const def = VEHICLE_DEFAULTS[v];
              setForm((f: any) => ({
                ...f,
                vehicleType: v,
                ...(def ? { fuelConsumptionPer100km: def.fuel, wearCostPerKm: def.wear } : {}),
              }));
            }}>
              <SelectTrigger className="mt-1 h-9 text-sm" data-testid="select-vehicle"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="citadine">Citadine (5L/100)</SelectItem>
                <SelectItem value="berline">Berline (7L/100)</SelectItem>
                <SelectItem value="suv">SUV (9L/100)</SelectItem>
                <SelectItem value="electrique">Électrique</SelectItem>
                <SelectItem value="hybride">Hybride (5L/100)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs">Conso. (L/100km)</Label><Input type="number" step="0.5" value={form.fuelConsumptionPer100km} onChange={e => setForm((f: any) => ({ ...f, fuelConsumptionPer100km: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-fuel-consumption" /></div>
            <div><Label className="text-xs">Prix carburant (€/L)</Label><Input type="number" step="0.01" value={form.fuelPricePerLiter} onChange={e => setForm((f: any) => ({ ...f, fuelPricePerLiter: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-fuel-price" /></div>
            <div><Label className="text-xs">Usure (€/km)</Label><Input type="number" step="0.01" value={form.wearCostPerKm} onChange={e => setForm((f: any) => ({ ...f, wearCostPerKm: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-wear" /></div>
          </div>
        </CardContent>
      </Card>
      {/* ── Couche Économie & Fiscalité (additif) : Coût réel du véhicule ── */}
      <Card className="border-teal-500/30 bg-teal-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wallet size={14} className="text-teal-400" />
            Coût réel du véhicule
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Tous les postes de coût annuels, ramenés au km pour un calcul de marge exact.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ZapIcon size={14} className="text-teal-400" />
              <span className="text-sm font-medium">Véhicule électrique</span>
            </div>
            <Switch
              checked={form.electricMode}
              onCheckedChange={v => setForm((f: any) => ({ ...f, electricMode: v }))}
              data-testid="switch-electric-mode"
            />
          </div>
          {form.electricMode ? (
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Conso. (kWh/100km)</Label><Input type="number" step="0.5" value={form.kwhPer100km} onChange={e => setForm((f: any) => ({ ...f, kwhPer100km: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-kwh-per-100km" /></div>
              <div><Label className="text-xs">Prix électricité (€/kWh)</Label><Input type="number" step="0.01" value={form.kwhPrice} onChange={e => setForm((f: any) => ({ ...f, kwhPrice: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-kwh-price" /></div>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs">Assurance (€/an)</Label><Input type="number" step="50" value={form.insuranceAnnualEur} onChange={e => setForm((f: any) => ({ ...f, insuranceAnnualEur: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-insurance-annual" /></div>
            <div><Label className="text-xs">Entretien (€/an)</Label><Input type="number" step="50" value={form.maintenanceYearlyEur} onChange={e => setForm((f: any) => ({ ...f, maintenanceYearlyEur: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-maintenance-yearly" /></div>
            <div><Label className="text-xs">Amortissement (€/an)</Label><Input type="number" step="100" value={form.vehicleAmortizationYearlyEur} onChange={e => setForm((f: any) => ({ ...f, vehicleAmortizationYearlyEur: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-amortization-yearly" /></div>
            <div><Label className="text-xs">Pneus (€/an)</Label><Input type="number" step="50" value={form.tireYearlyEur} onChange={e => setForm((f: any) => ({ ...f, tireYearlyEur: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-tire-yearly" /></div>
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Régime TVA</Label>
              <Select value={form.tvaRegime} onValueChange={v => setForm((f: any) => ({ ...f, tvaRegime: v }))}>
                <SelectTrigger className="mt-1 h-9 text-sm" data-testid="select-tva-regime"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="franchise">Franchise en base</SelectItem>
                  <SelectItem value="reel">Régime réel</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">CV fiscaux du véhicule</Label><Input type="number" step="1" min="3" value={form.vehicleCvFiscaux} onChange={e => setForm((f: any) => ({ ...f, vehicleCvFiscaux: parseInt(e.target.value) || 5 }))} className="h-9 text-sm mt-1" data-testid="input-vehicle-cv" /></div>
          </div>
          <div>
            <Label className="text-xs">Taux CVO / URSSAF (%)</Label>
            <Input type="number" step="0.1" value={form.cvoUrssafPct} onChange={e => setForm((f: any) => ({ ...f, cvoUrssafPct: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-cvo-urssaf" />
            <p className="text-[10px] text-muted-foreground mt-1">
              Taux 2026 pour VTC (BIC prestations de services) : 21,2 % — <a href="https://www.urssaf.fr" target="_blank" rel="noreferrer" className="text-primary underline">urssaf.fr</a>
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="w-full h-9 text-xs gap-1.5"
            onClick={() => setForm((f: any) => ({
              ...f,
              insuranceAnnualEur: 1800,
              maintenanceYearlyEur: 1200,
              vehicleAmortizationYearlyEur: 4800,
              tireYearlyEur: 600,
              cvoUrssafPct: 21.2,
              tvaRegime: "franchise",
              kwhPer100km: 18,
              kwhPrice: 0.25,
            }))}
            data-testid="button-reset-idf-defaults"
          >
            <RotateCcw size={12} /> Réinitialiser avec valeurs par défaut IDF
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Paramètres économiques</CardTitle></CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs">Commission plateforme (%)</Label><Input type="number" step="1" min="0" max="50" value={form.platformCommissionPct} onChange={e => setForm((f: any) => ({ ...f, platformCommissionPct: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-commission" /></div>
            <div><Label className="text-xs">Objectif horaire (€/h)</Label><Input type="number" step="5" min="15" value={form.hourlyTargetIncome} onChange={e => setForm((f: any) => ({ ...f, hourlyTargetIncome: parseFloat(e.target.value) }))} className="h-9 text-sm mt-1" data-testid="input-hourly-target" /></div>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div><p className="text-sm font-medium">Préférer les longues courses</p><p className="text-xs text-muted-foreground">Score pondéré vers les destinations éloignées</p></div>
            <Switch checked={form.preferLongRides} onCheckedChange={v => setForm((f: any) => ({ ...f, preferLongRides: v }))} data-testid="switch-long-rides" />
          </div>
        </CardContent>
      </Card>
      {/* ── THÈME 4 : Préférences personnalisées ── */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><MapPin size={14} className="text-teal-400" />Préférences personnalisées</CardTitle></CardHeader>
        <CardContent className="space-y-4 px-4 pb-4">
          <div className="grid grid-cols-3 gap-2">
            <div><Label className="text-xs">Marque</Label><Input value={form.vehicleBrand} onChange={e => setForm((f: any) => ({ ...f, vehicleBrand: e.target.value }))} className="h-9 text-sm mt-1" placeholder="Peugeot" data-testid="input-vehicle-brand" /></div>
            <div><Label className="text-xs">Modèle</Label><Input value={form.vehicleModel} onChange={e => setForm((f: any) => ({ ...f, vehicleModel: e.target.value }))} className="h-9 text-sm mt-1" placeholder="508" data-testid="input-vehicle-model" /></div>
            <div><Label className="text-xs">Année</Label><Input type="number" value={form.vehicleYear} onChange={e => setForm((f: any) => ({ ...f, vehicleYear: parseInt(e.target.value) || 2020 }))} className="h-9 text-sm mt-1" data-testid="input-vehicle-year" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs flex items-center gap-1"><Clock size={11} />Début de service</Label>
              <Select value={String(form.workHoursStart)} onValueChange={v => setForm((f: any) => ({ ...f, workHoursStart: parseInt(v) }))}>
                <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{Array.from({ length: 24 }, (_, i) => <SelectItem key={i} value={String(i)}>{String(i).padStart(2, "0")}:00</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs flex items-center gap-1"><Clock size={11} />Fin de service</Label>
              <Select value={String(form.workHoursEnd)} onValueChange={v => setForm((f: any) => ({ ...f, workHoursEnd: parseInt(v) }))}>
                <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{Array.from({ length: 24 }, (_, i) => <SelectItem key={i} value={String(i)}>{String(i).padStart(2, "0")}:00</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div><p className="text-sm font-medium">Éviter les autoroutes</p><p className="text-xs text-muted-foreground">Signalé dans les recommandations de trajet</p></div>
            <Switch checked={form.avoidHighway} onCheckedChange={v => setForm((f: any) => ({ ...f, avoidHighway: v }))} data-testid="switch-avoid-highway" />
          </div>
          <Separator />
          <div>
            <Label className="text-xs mb-2 block">Zones favorites ({form.preferredZones.length})</Label>
            <div className="grid grid-cols-2 gap-2">
              {ZONES_93.map(z => (
                <label key={z.id} className="flex items-center gap-2 text-xs cursor-pointer py-1.5 min-h-[44px]">
                  <Checkbox checked={form.preferredZones.includes(z.id)} onCheckedChange={() => toggleZone(z.id)} data-testid={`checkbox-zone-${z.id}`} />
                  <span className="truncate">{z.name}</span>
                </label>
              ))}
            </div>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Total kilométrage parcouru</p>
            <p className="text-lg font-bold">{Math.round(form.totalKmDriven).toLocaleString("fr-FR")} km</p>
          </div>
        </CardContent>
      </Card>

      {/* ── CONNEXIONS PLATEFORMES ── */}
      <Card className="border-violet-500/30 bg-violet-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Plug size={14} className="text-violet-400" />
            Connexions plateformes
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Connectez vos comptes pour afficher la demande temps réel dans chaque zone
          </p>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4">
          {/* TOMTOM */}
          {(() => {
            const cred = Array.isArray(platformCreds) ? platformCreds.find((c: any) => c.platform === "tomtom") : null;
            const status = cred?.status ?? "unconfigured";
            const hasKey = cred?.has_key;
            return (
              <div className="rounded-lg border border-border/50 bg-card/50 p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded bg-[#df1b12] flex items-center justify-center text-white text-[10px] font-black">TT</div>
                    <div>
                      <p className="text-sm font-medium">TomTom Traffic</p>
                      <p className="text-[10px] text-muted-foreground">Congestion temps réel — proxy demande VTC</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {status === "connected" && <><CheckCircle2 size={14} className="text-emerald-400" /><span className="text-[11px] text-emerald-400">Connecté</span></>}
                    {status === "error"     && <><XCircle size={14} className="text-red-400" /><span className="text-[11px] text-red-400">Erreur</span></>}
                    {(status === "unconfigured" || !hasKey) && <span className="text-[11px] text-muted-foreground">Non configuré</span>}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Clé API TomTom</Label>
                  <Input
                    type="password"
                    placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    value={platformKeys.tomtom}
                    onChange={e => setPlatformKeys(k => ({ ...k, tomtom: e.target.value }))}
                    className="h-9 text-sm mt-1 font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Clé gratuite (2500 req/j, sans CB) sur <a href="https://developer.tomtom.com" target="_blank" rel="noreferrer" className="text-primary underline">developer.tomtom.com</a>
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="flex-1 h-8 text-xs"
                    disabled={!platformKeys.tomtom || platformTesting.tomtom}
                    onClick={async () => {
                      setPlatformTesting(t => ({ ...t, tomtom: true }));
                      await apiRequest("PUT", "/api/platforms/credentials/tomtom", { api_key: platformKeys.tomtom });
                      await apiRequest("POST", "/api/platforms/test/tomtom", {});
                      await refetchCreds();
                      setPlatformKeys(k => ({ ...k, tomtom: "" }));
                      setPlatformTesting(t => ({ ...t, tomtom: false }));
                    }}>
                    {platformTesting.tomtom ? <><RefreshCw size={11} className="animate-spin mr-1" />Test...</> : "Sauvegarder & tester"}
                  </Button>
                  {status === "connected" && (
                    <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-muted-foreground"
                      onClick={async () => {
                        await apiRequest("PUT", "/api/platforms/credentials/tomtom", { api_key: "" });
                        await refetchCreds();
                      }}>
                      Déconnecter
                    </Button>
                  )}
                </div>
                {cred?.error_msg && status === "error" && (
                  <p className="text-[10px] text-red-400 flex items-start gap-1"><AlertCircle size={10} className="mt-0.5 shrink-0" />{cred.error_msg}</p>
                )}
              </div>
            );
          })()}

          {/* GIGDATA */}
          {(() => {
            const cred = Array.isArray(platformCreds) ? platformCreds.find((c: any) => c.platform === "gigdata") : null;
            const status = cred?.status ?? "unconfigured";
            const hasKey = cred?.has_key;
            return (
              <div className="rounded-lg border border-border/50 bg-card/50 p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded bg-violet-600 flex items-center justify-center text-white text-[10px] font-bold">G</div>
                    <div>
                      <p className="text-sm font-medium">GigData</p>
                      <p className="text-[10px] text-muted-foreground">Uber + Bolt + Heetch + FreeNow agrégés</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {status === "connected" && <><CheckCircle2 size={14} className="text-emerald-400" /><span className="text-[11px] text-emerald-400">Connecté</span></>}
                    {status === "error"     && <><XCircle size={14} className="text-red-400" /><span className="text-[11px] text-red-400">Erreur</span></>}
                    {(status === "unconfigured" || !hasKey) && <span className="text-[11px] text-muted-foreground">Non configuré</span>}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Clé API GigData</Label>
                  <Input
                    type="password"
                    placeholder="sk_live_xxxxxxxxxxxx"
                    value={platformKeys.gigdata}
                    onChange={e => setPlatformKeys(k => ({ ...k, gigdata: e.target.value }))}
                    className="h-9 text-sm mt-1 font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Obtenez votre clé sur <a href="https://gigdata.fr" target="_blank" rel="noreferrer" className="text-primary underline">gigdata.fr</a> — agrège Uber, Bolt, Heetch, FreeNow
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="flex-1 h-8 text-xs"
                    disabled={!platformKeys.gigdata || platformTesting.gigdata}
                    onClick={async () => {
                      setPlatformTesting(t => ({ ...t, gigdata: true }));
                      await apiRequest("PUT", "/api/platforms/credentials/gigdata", { api_key: platformKeys.gigdata });
                      await apiRequest("POST", "/api/platforms/test/gigdata", {});
                      await refetchCreds();
                      setPlatformKeys(k => ({ ...k, gigdata: "" }));
                      setPlatformTesting(t => ({ ...t, gigdata: false }));
                    }}>
                    {platformTesting.gigdata ? <><RefreshCw size={11} className="animate-spin mr-1" />Test...</> : "Sauvegarder & tester"}
                  </Button>
                  {status === "connected" && (
                    <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-muted-foreground"
                      onClick={async () => {
                        await apiRequest("PUT", "/api/platforms/credentials/gigdata", { api_key: "" });
                        await refetchCreds();
                      }}>
                      Déconnecter
                    </Button>
                  )}
                </div>
                {cred?.error_msg && status === "error" && (
                  <p className="text-[10px] text-red-400 flex items-start gap-1"><AlertCircle size={10} className="mt-0.5 shrink-0" />{cred.error_msg}</p>
                )}
              </div>
            );
          })()}

          {/* Résumé si au moins une plateforme connectée */}
          {Array.isArray(platformCreds) && platformCreds.some((c: any) => c.status === "connected") && (
            <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2.5 text-xs text-emerald-400">
              ✅ Données de demande temps réel actives — visibles dans la carte et les alertes
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Vague 2 - Feature 3 : Objectif journalier & série ── */}
      <Card className="border-amber-400/30 bg-amber-400/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Flame size={14} className="text-amber-400" />
            Objectif journalier
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Label className="text-xs">Cible du jour (€)</Label>
              <Input
                type="number"
                step="10"
                min="1"
                inputMode="numeric"
                value={goalTargetInput}
                onChange={e => setGoalTargetInput(e.target.value)}
                onBlur={() => {
                  const n = parseFloat(goalTargetInput);
                  if (Number.isFinite(n) && n > 0) {
                    setDailyGoalTarget(n);
                    // Le storage event natif ne se déclenche pas dans le même onglet ;
                    // on l'émet manuellement pour que useDailyStreak (FocusBubble) se
                    // mette à jour immédiatement sans rechargement de page.
                    window.dispatchEvent(new StorageEvent("storage", { key: "vtc.dailyGoal.target" }));
                    toast({ title: "Objectif mis à jour" });
                  } else {
                    setGoalTargetInput(String(getDailyGoalTarget()));
                  }
                }}
                className="h-11 text-sm mt-1"
                data-testid="input-daily-goal-target"
              />
            </div>
            <div className="flex flex-col items-center justify-center pt-4">
              <span className="text-lg font-bold text-amber-400" data-testid="text-daily-streak">{streakDays}</span>
              <span className="text-[10px] text-muted-foreground">jour{streakDays > 1 ? "s" : ""} de série</span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Visible sous forme d'anneau de progression autour de la bulle Focus.
          </p>
        </CardContent>
      </Card>

      {/* Couche Wow Factor : série active + quêtes de la semaine */}
      {gamificationOn && (
        <div className="space-y-4">
          <StreakBadge />
          <QuestsCard />
        </div>
      )}

      {/* Couche Wow Factor : toggle gamification (RGPD — 100% facultatif) */}
      <Card className="border-slate-500/30 bg-slate-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Gamepad2 size={14} className="text-slate-400" />
            Gamification
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Gamepad2 size={16} className="text-slate-300 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Désactiver gamification</div>
                <div className="text-[11px] text-muted-foreground">
                  Masque séries, quêtes, records et succès. Aucune récompense monétaire n'est jamais impliquée.
                </div>
              </div>
            </div>
            <Switch
              checked={gamificationOn}
              onCheckedChange={(val) => {
                setGamificationOn(val);
                apiRequest("PUT", "/api/wow/gamification-toggle", { enabled: val });
                toast({ title: val ? "Gamification activée" : "Gamification désactivée" });
              }}
              data-testid="switch-gamification-enabled"
            />
          </div>
        </CardContent>
      </Card>

      {/* ─────────────────────── Préférences mobile ─────────────────────── */}
      <MobileSettings />

      <Button className="w-full h-12" onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending} data-testid="button-save-profile">{saveMutation.isPending ? "Sauvegarde..." : "Sauvegarder le profil"}</Button>

      {/* ── THÈME 3 : Score IA ── */}
      {performance?.weekly && (
        <Card className="border-cyan-500/20">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Brain size={15} className="text-cyan-400" />Analyse IA de vos performances</CardTitle></CardHeader>
          <CardContent className="space-y-4 px-4 pb-4">
            <div className="flex items-center justify-center py-2">
              <div className="relative w-28 h-28 flex items-center justify-center">
                <svg viewBox="0 0 100 100" className="w-28 h-28 -rotate-90">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="8" className="text-muted/30" />
                  <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"
                    className={scoreColor(performance.weekly.global_score)}
                    strokeDasharray={`${(performance.weekly.global_score / 100) * 263.9} 263.9`} />
                </svg>
                <div className="absolute flex flex-col items-center">
                  <span className={`text-3xl font-bold ${scoreColor(performance.weekly.global_score)}`}>{performance.weekly.global_score}</span>
                  <span className="text-[10px] text-muted-foreground">/ 100</span>
                </div>
              </div>
            </div>
            {[
              { label: "Efficacité", value: performance.weekly.efficiency_score, icon: Gauge },
              { label: "Rentabilité", value: performance.weekly.profitability_score, icon: BarChart },
              { label: "Positionnement", value: performance.weekly.positioning_score, icon: MapPin },
              { label: "Régularité", value: performance.weekly.consistency_score, icon: Clock },
            ].map(s => (
              <div key={s.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5"><s.icon size={12} className="text-muted-foreground" />{s.label}</span>
                  <span className={`font-bold ${scoreColor(s.value)}`}>{s.value}</span>
                </div>
                <Progress value={s.value} className="h-2" />
              </div>
            ))}
            {Array.isArray(performance.weekly.ai_tips) && performance.weekly.ai_tips.length > 0 && (
              <div className="space-y-2 pt-1">
                {performance.weekly.ai_tips.map((tip: string, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-[11px] rounded-lg bg-cyan-500/5 border border-cyan-500/20 p-2.5">
                    <Lightbulb size={13} className="text-cyan-400 mt-0.5 shrink-0" />
                    <span>{tip}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground text-center pt-1">
              Basé sur {performance.weekly.total_rides} course{performance.weekly.total_rides > 1 ? "s" : ""} cette semaine
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── THÈME 2 : Maintenance prédictive ── */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Wrench size={14} className="text-amber-400" />Maintenance prédictive</CardTitle></CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          {hasUrgent && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/30 p-2.5 text-xs text-red-400">
              <AlertTriangle size={14} className="shrink-0" />
              <span>Entretien requis — vérifiez les composants en alerte ci-dessous</span>
            </div>
          )}
          {maintItems.length === 0 && <p className="text-xs text-muted-foreground">Aucun composant suivi.</p>}
          {maintItems.map((m: any) => {
            const meta = URGENCY_META[m.urgency] ?? URGENCY_META.ok;
            const elapsed = m.total_km_driven - m.last_done_km;
            const pct = Math.max(0, Math.min(100, (elapsed / m.interval_km) * 100));
            const remaining = m.next_due_km - m.total_km_driven;
            return (
              <div key={m.id} className="rounded-lg border border-border/50 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{m.label_fr}</span>
                  <Badge variant="outline" className={`text-[10px] ${meta.cls}`}>{meta.label}</Badge>
                </div>
                <Progress value={pct} className="h-2" />
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{remaining > 0 ? `${Math.round(remaining).toLocaleString("fr-FR")} km restants` : `Dépassé de ${Math.abs(Math.round(remaining)).toLocaleString("fr-FR")} km`}</span>
                  <span>~{m.estimated_cost_eur}€</span>
                </div>
                <Button size="sm" variant="outline" className="w-full h-9 text-xs" onClick={() => doneMutation.mutate(m.component)} disabled={doneMutation.isPending} data-testid={`button-maint-done-${m.component}`}>
                  Marquer fait
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── THÈME SÉCURITÉ : Mode silence total ── */}
      <Card className="border-purple-500/30 bg-purple-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlert size={14} className="text-purple-400" />
            Sécurité &amp; conduite
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <BellOff size={16} className="text-purple-300 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Mode silence total</div>
                <div className="text-[11px] text-muted-foreground">
                  Coupe les notifications non-critiques (SOS, fatigue et courses non-rentables restent actifs)
                </div>
              </div>
            </div>
            <Switch
              checked={silentModeOn}
              onCheckedChange={(val) => {
                if (val) {
                  setSilentModeFor(60);
                  setSilentModeOn(true);
                  toast({ title: "Silence total activé", description: "Pendant 1 heure — désactivable à tout moment." });
                } else {
                  clearSilentMode();
                  setSilentModeOn(false);
                  toast({ title: "Silence total désactivé" });
                }
              }}
              data-testid="switch-silent-mode"
            />
          </div>
          {silentModeOn && getSilentModeUntil() && (
            <p className="text-[11px] text-purple-300">
              Actif jusqu'à {getSilentModeUntil()!.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
            </p>
          )}
          <Separator />
          <div>
            <div className="text-sm font-medium mb-1">Mode nuit ambre</div>
            <div className="text-[11px] text-muted-foreground mb-2">
              Réglable aussi dans les paramètres mobiles ci-dessous — bascule automatique au coucher du soleil.
            </div>
            <AmberNightToggle />
          </div>
          <p className="text-[10px] text-muted-foreground pt-1">
            Estimations statistiques de fatigue et de risque — ce ne sont pas des diagnostics médicaux.
          </p>
        </CardContent>
      </Card>

      {/* ── Couche ML Personnel : mode « pas d'IA aujourd'hui » ── */}
      <Card className="border-slate-500/30 bg-slate-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BrainCircuit size={14} className="text-slate-400" />
            IA &amp; prédictions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <BrainCircuit size={16} className="text-slate-300 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Pas d'IA aujourd'hui</div>
                <div className="text-[11px] text-muted-foreground">
                  Désactive les suggestions ML personnalisées (patterns, meilleure zone, simulateur) jusqu'à minuit
                </div>
              </div>
            </div>
            <Switch
              checked={aiDisabledOn}
              onCheckedChange={(val) => {
                if (val) {
                  enableAiDisabledToday();
                  setAiDisabledOn(true);
                  toast({ title: "Mode sans IA activé", description: "Jusqu'à minuit — réactivable à tout moment depuis Focus." });
                } else {
                  disableAiDisabledToday();
                  setAiDisabledOn(false);
                  toast({ title: "IA réactivée" });
                }
              }}
              data-testid="switch-ai-disabled-today"
            />
          </div>
          {aiDisabledOn && (
            <p className="text-[11px] text-slate-400">
              Actif pour la journée en cours — réinitialisation automatique à minuit.
            </p>
          )}
          <p className="text-[10px] text-muted-foreground pt-1">
            Le résultat du jour sera comparé a posteriori à votre moyenne habituelle avec IA.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
