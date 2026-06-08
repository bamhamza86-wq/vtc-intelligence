import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Calculator, Info, CheckCircle, XCircle } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from "recharts";

const SCENARIOS = [
  { name: "CDG → Paris", distanceKm: 40, durationMin: 38, fare: 55 },
  { name: "Orly → La Défense", distanceKm: 28, durationMin: 32, fare: 40 },
  { name: "Stade de France sortie", distanceKm: 14, durationMin: 22, fare: 22 },
  { name: "Seuil rentabilité", distanceKm: 16, durationMin: 16, fare: 16 },
  { name: "Embouteillage IDF", distanceKm: 16, durationMin: 45, fare: 18 },
  { name: "93 → Paris Business", distanceKm: 22, durationMin: 28, fare: 32 },
];

export default function SimulatorPage() {
  const [dist, setDist] = useState("16");
  const [dur, setDur] = useState("16");
  const [fare, setFare] = useState("");
  const [result, setResult] = useState<any>(null);

  const calc = useMutation({
    mutationFn: (d: any) => apiRequest("POST", "/api/calculate", d).then(r => r.json()),
    onSuccess: setResult,
  });

  const loadScenario = (s: typeof SCENARIOS[0]) => {
    setDist(s.distanceKm.toString()); setDur(s.durationMin.toString()); setFare(s.fare.toString());
    calc.mutate({ distanceKm: s.distanceKm, durationMin: s.durationMin, fare: s.fare });
  };

  const chartData = result ? [
    { name: "Tarif", value: result.fare, fill: "#6366f1" },
    { name: "Commission", value: -result.commission, fill: "#ef4444" },
    { name: "Carburant", value: -result.fuelCost, fill: "#f97316" },
    { name: "Usure", value: -result.wearCost, fill: "#eab308" },
    { name: "Net", value: result.netProfit, fill: result.netProfit > 0 ? "#22c55e" : "#ef4444" },
  ] : [];

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div>
        <h2 className="font-bold text-lg">Simulateur de rentabilité</h2>
        <p className="text-sm text-muted-foreground">Calcul du profit réel selon votre modèle économique</p>
      </div>
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="py-3 px-4">
          <div className="flex gap-4 text-sm">
            <span><strong className="text-primary">1 €/km</strong> <span className="text-muted-foreground">— tarif min.</span></span>
            <span><strong className="text-primary">1 min/km</strong> <span className="text-muted-foreground">— durée max.</span></span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Au-delà de ces deux seuils simultanément → rentabilité positive</p>
        </CardContent>
      </Card>
      <div>
        <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">Scénarios rapides</p>
        <div className="flex flex-wrap gap-2">
          {SCENARIOS.map(s => (
            <button key={s.name} onClick={() => loadScenario(s)} className="text-xs border border-border rounded-full px-3 py-1 hover:border-primary hover:text-primary transition-colors" data-testid={`button-scenario-${s.name.replace(/\s/g,"-")}`}>{s.name}</button>
          ))}
        </div>
      </div>
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Calculator size={15} />Paramètres course</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div><Label className="text-xs">Distance (km)</Label><Input type="number" value={dist} onChange={e => setDist(e.target.value)} className="h-9 text-sm mt-1" min="0" step="0.5" data-testid="input-distance" /></div>
            <div><Label className="text-xs">Durée (min)</Label><Input type="number" value={dur} onChange={e => setDur(e.target.value)} className="h-9 text-sm mt-1" min="0" step="1" data-testid="input-duration" /></div>
            <div><Label className="text-xs">Tarif (€) <span className="text-muted-foreground">(opt.)</span></Label><Input type="number" value={fare} onChange={e => setFare(e.target.value)} className="h-9 text-sm mt-1" min="0" step="0.5" placeholder="Auto" data-testid="input-fare" /></div>
          </div>
          <Button onClick={() => calc.mutate({ distanceKm: parseFloat(dist)||0, durationMin: parseFloat(dur)||0, fare: fare ? parseFloat(fare) : null })} disabled={calc.isPending || !dist} className="w-full" data-testid="button-calculate">
            {calc.isPending ? "Calcul..." : "Calculer la rentabilité"}
          </Button>
        </CardContent>
      </Card>
      {result && (
        <>
          <Card className={`border-2 ${result.isProfitable ? "border-green-500/50 bg-green-500/5" : "border-red-500/50 bg-red-500/5"}`}>
            <CardContent className="py-4 px-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {result.isProfitable ? <CheckCircle size={20} className="text-green-500" /> : <XCircle size={20} className="text-red-500" />}
                  <span className="font-bold text-sm">{result.isProfitable ? "Course rentable" : "En dessous du seuil"}</span>
                </div>
                <Badge variant="outline" className={result.isProfitable ? "border-green-500/40 text-green-400" : "border-red-500/40 text-red-400"}>{result.profitabilityScore}/100</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-background/60 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground">Profit net</p>
                  <p className={`text-xl font-bold ${result.netProfit >= 0 ? "text-green-400" : "text-red-400"}`}>{result.netProfit >= 0 ? "+" : ""}{result.netProfit.toFixed(2)} €</p>
                </div>
                <div className="bg-background/60 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground">Taux horaire</p>
                  <p className={`text-xl font-bold ${result.hourlyRate >= 30 ? "text-green-400" : result.hourlyRate >= 20 ? "text-amber-400" : "text-red-400"}`}>{result.hourlyRate.toFixed(0)} €/h</p>
                </div>
              </div>
              <div className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Tarif vs seuil 1€/km</span><span className={result.fare >= result.thresholdFare ? "text-green-400" : "text-red-400"}>{result.fare.toFixed(2)}€ vs {result.thresholdFare}€ {result.fare >= result.thresholdFare ? "✓" : "✗"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Durée vs seuil 1min/km</span><span className={result.durationMin <= result.thresholdDuration ? "text-green-400" : "text-amber-400"}>{result.durationMin}min vs {result.thresholdDuration}min {result.durationMin <= result.thresholdDuration ? "✓" : "⚠"}</span></div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Décomposition financière</CardTitle></CardHeader>
            <CardContent>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${v}€`} />
                    <Tooltip formatter={(v: any) => [`${Number(v).toFixed(2)} €`]} />
                    <ReferenceLine y={0} stroke="#666" />
                    <Bar dataKey="value" radius={[4,4,0,0]}>
                      {chartData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Separator className="my-3" />
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Tarif brut</span><span className="font-medium text-indigo-400">+{result.fare.toFixed(2)} €</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Commission (25%)</span><span className="font-medium text-red-400">−{result.commission.toFixed(2)} €</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Carburant</span><span className="font-medium text-orange-400">−{result.fuelCost.toFixed(2)} €</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Usure véhicule</span><span className="font-medium text-yellow-400">−{result.wearCost.toFixed(2)} €</span></div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1.5"><Info size={13} className="text-primary" />Recommandations</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {result.hourlyRate < 30 && result.durationMin > result.thresholdDuration && <li className="flex gap-2"><span className="text-amber-500">⚠</span><span>Durée trop longue : cherchez des axes fluides (périphérique)</span></li>}
                {result.fare < result.thresholdFare && <li className="flex gap-2"><span className="text-red-500">✗</span><span>Tarif insuffisant : attendez le surge pricing ou repositionnez-vous</span></li>}
                {result.hourlyRate >= 40 && <li className="flex gap-2"><span className="text-green-500">✓</span><span>Excellente course — taux horaire optimal atteint</span></li>}
                {parseFloat(dist) >= 20 && <li className="flex gap-2"><span className="text-green-500">✓</span><span>Longue course — impact carburant absorbé par le tarif</span></li>}
                {result.hourlyRate < 20 && <li className="flex gap-2"><span className="text-red-500">✗</span><span>Taux horaire trop bas : refus recommandé sauf si créneau creux</span></li>}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
