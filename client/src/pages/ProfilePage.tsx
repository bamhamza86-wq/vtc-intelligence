import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { User, BarChart } from "lucide-react";

export default function ProfilePage() {
  const { toast } = useToast();
  const [form, setForm] = useState<any>({ fuelConsumptionPer100km: 7, fuelPricePerLiter: 1.85, platformCommissionPct: 25, hourlyTargetIncome: 35, wearCostPerKm: 0.08, vehicleType: "berline", preferLongRides: true });
  const { data: profile, isLoading } = useQuery({ queryKey: ["/api/driver-profile"], queryFn: () => apiRequest("GET", "/api/driver-profile").then(r => r.json()) });
  const { data: stats } = useQuery({ queryKey: ["/api/rides/stats"], queryFn: () => apiRequest("GET", "/api/rides/stats").then(r => r.json()) });

  useEffect(() => {
    if (!profile) return;
    const p: any = profile;
    setForm({
      fuelConsumptionPer100km: p.fuel_consumption_per100km ?? p.fuelConsumptionPer100km ?? 7,
      fuelPricePerLiter: p.fuel_price_per_liter ?? p.fuelPricePerLiter ?? 1.85,
      platformCommissionPct: p.platform_commission_pct ?? p.platformCommissionPct ?? 25,
      hourlyTargetIncome: p.hourly_target_income ?? p.hourlyTargetIncome ?? 35,
      wearCostPerKm: p.wear_cost_per_km ?? p.wearCostPerKm ?? 0.08,
      vehicleType: p.vehicle_type ?? p.vehicleType ?? "berline",
      preferLongRides: Boolean(p.prefer_long_rides ?? p.preferLongRides ?? true),
    });
  }, [profile]);

  const saveMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", "/api/driver-profile", data).then(r => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/driver-profile"] }); toast({ title: "Profil sauvegardé" }); },
  });

  const costPerKm = ((form.fuelConsumptionPer100km / 100) * form.fuelPricePerLiter + form.wearCostPerKm).toFixed(3);
  const minFarePerKm = ((1 + parseFloat(costPerKm)) / (1 - form.platformCommissionPct / 100)).toFixed(2);

  if (isLoading) return <div className="p-4 space-y-4">{[...Array(3)].map((_,i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}</div>;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div><h2 className="font-bold text-lg flex items-center gap-2"><User size={18} className="text-primary" />Profil chauffeur</h2><p className="text-sm text-muted-foreground">Paramètres de calcul personnalisés</p></div>
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
            <Select value={form.vehicleType} onValueChange={v => setForm((f: any) => ({ ...f, vehicleType: v }))}>
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
      <Button className="w-full" onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending} data-testid="button-save-profile">{saveMutation.isPending ? "Sauvegarde..." : "Sauvegarder le profil"}</Button>
    </div>
  );
}
