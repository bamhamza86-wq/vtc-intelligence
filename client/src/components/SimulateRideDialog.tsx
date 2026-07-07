/**
 * SimulateRideDialog.tsx — Couche ML Personnel
 * ─────────────────────────────────────────────────────────────────────────────
 * Widget « Simuler une course » : le chauffeur saisit les infos d'une course
 * entrante (zone, distance, durée, tarif) et obtient en moins de 3s un verdict
 * ACCEPTER / REFUSER basé sur /api/ml/predict-acceptance, avec explication
 * en français et alerte si le signal est contre-intuitif.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Sparkles, CheckCircle2, XCircle, AlertTriangle, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface AcceptanceResult {
  p_accept: number;
  expected_gain: number;
  explanation: { feature: string; weight: number; label_fr: string }[];
  model: "cold_start" | "personal";
  ride_count: number;
}

const FEATURE_LABEL: Record<string, string> = {
  fare: "tarif",
  distance_km: "distance",
  duration_min: "durée",
  hour_sin: "météo",
  hour_cos: "horaire",
  zone_known: "historique zone",
  fleet_avg: "moyenne flotte",
};

export function SimulateRideDialog() {
  const [open, setOpen] = useState(false);
  const [zoneId, setZoneId] = useState("z_cdg");
  const [distanceKm, setDistanceKm] = useState("8");
  const [durationMin, setDurationMin] = useState("18");
  const [fare, setFare] = useState("16");
  const [submitted, setSubmitted] = useState(false);

  const nowHour = new Date().getHours();

  const { data, isFetching, refetch } = useQuery<AcceptanceResult>({
    queryKey: ["ml-simulate", zoneId, distanceKm, durationMin, fare],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/ml/predict-acceptance", {
        zone_id: zoneId,
        distance_km: Number(distanceKm) || 0,
        duration_min: Number(durationMin) || 0,
        fare: Number(fare) || 0,
        hour: nowHour,
      });
      return res.json();
    },
    enabled: false,
    staleTime: 0,
  });

  const handleSimulate = async () => {
    setSubmitted(true);
    await refetch();
  };

  const verdict = data ? (data.p_accept >= 0.5 ? "ACCEPTER" : "REFUSER") : null;
  const isCounterIntuitive =
    data && ((verdict === "REFUSER" && Number(fare) >= 20) || (verdict === "ACCEPTER" && data.expected_gain < 0));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSubmitted(false);
      }}
    >
      <DialogTrigger asChild>
        <button
          className="tap-target w-full rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur px-4 py-3 flex items-center gap-3 text-left active:scale-[0.98] transition-transform"
          style={{ minHeight: 56 }}
          data-testid="button-simulate-ride"
        >
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-white text-sm font-semibold">Simuler une course</div>
            <div className="text-slate-400 text-xs">Vérifier l'IA avant d'accepter (&lt; 3s)</div>
          </div>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-violet-500" />
            Simuler une course
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="sim-zone">Zone</Label>
            <Input id="sim-zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)} placeholder="z_cdg" data-testid="input-sim-zone" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="sim-distance">Distance (km)</Label>
              <Input id="sim-distance" type="number" value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} data-testid="input-sim-distance" />
            </div>
            <div>
              <Label htmlFor="sim-duration">Durée (min)</Label>
              <Input id="sim-duration" type="number" value={durationMin} onChange={(e) => setDurationMin(e.target.value)} data-testid="input-sim-duration" />
            </div>
            <div>
              <Label htmlFor="sim-fare">Tarif (€)</Label>
              <Input id="sim-fare" type="number" value={fare} onChange={(e) => setFare(e.target.value)} data-testid="input-sim-fare" />
            </div>
          </div>

          <Button onClick={handleSimulate} disabled={isFetching} className="w-full" data-testid="button-run-simulation">
            {isFetching ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            Évaluer avec l'IA
          </Button>

          {submitted && data && (
            <div
              className={`rounded-xl p-3 border ${
                verdict === "ACCEPTER" ? "bg-emerald-500/10 border-emerald-500/30" : "bg-red-500/10 border-red-500/30"
              }`}
              data-testid="simulate-result"
            >
              <div className="flex items-center gap-2 font-bold text-lg">
                {verdict === "ACCEPTER" ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-500" />
                )}
                <span className={verdict === "ACCEPTER" ? "text-emerald-400" : "text-red-400"}>{verdict}</span>
                <Badge variant="outline" className="ml-auto text-xs">
                  {Math.round(data.p_accept * 100)}% confiance
                </Badge>
              </div>
              <div className="text-sm text-slate-300 mt-1">
                Gain estimé : <span className="font-semibold">{data.expected_gain >= 0 ? "+" : ""}{data.expected_gain.toFixed(2)}€</span>
              </div>
              {data.explanation?.length > 0 && (
                <div className="text-xs text-slate-400 mt-2">
                  Pourquoi :{" "}
                  {data.explanation
                    .slice(0, 3)
                    .map((f) => `${f.weight >= 0 ? "+" : ""}${FEATURE_LABEL[f.feature] ?? f.feature}`)
                    .join(", ")}
                </div>
              )}
              {isCounterIntuitive && (
                <div className="flex items-start gap-2 mt-2 text-xs text-amber-400 bg-amber-500/10 rounded-lg p-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>Cette course semble {verdict === "REFUSER" ? "correcte mais l'IA la déconseille" : "risquée mais l'IA la recommande"} — vérifiez le contexte.</span>
                </div>
              )}
              <div className="text-[10px] text-slate-500 mt-2 uppercase tracking-wide">
                {data.model === "cold_start" ? `Mode découverte (${data.ride_count} courses enregistrées)` : "Modèle personnalisé"}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
