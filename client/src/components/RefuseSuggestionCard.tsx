/**
 * RefuseSuggestionCard — Couche Wow Factor : refus de course intelligent
 * ─────────────────────────────────────────────────────────────────────────────
 * Formulaire compact (course proposée) → POST /api/wow/should-refuse.
 * Si refuse=true, affiche clairement le coût caché estimé. Ton informatif,
 * jamais directif : la décision finale reste toujours au chauffeur.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ShieldAlert, ThumbsUp } from "lucide-react";

interface RefuseResult {
  refuse: boolean;
  hidden_cost_fr: string;
  alternative_zone_fr: string;
  confidence: number;
}

export function RefuseSuggestionCard() {
  const [open, setOpen] = useState(false);
  const [fare, setFare] = useState("");
  const [distance, setDistance] = useState("");
  const [duration, setDuration] = useState("");
  const [dropoffZone, setDropoffZone] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/wow/should-refuse", {
        fare: parseFloat(fare),
        distance: parseFloat(distance),
        duration: parseFloat(duration),
        dropoff_zone: dropoffZone,
      }).then((r) => r.json()) as Promise<RefuseResult>,
  });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="tap-target w-full rounded-2xl border border-white/10 bg-slate-900/60 text-slate-200 text-sm font-medium py-3 flex items-center justify-center gap-2 active:scale-95 transition-transform"
        style={{ minHeight: 44 }}
        data-testid="button-open-refuse-check"
      >
        <ShieldAlert size={15} className="text-orange-400" />
        Vérifier une course avant d'accepter
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-orange-400/30 bg-slate-900/70 p-4 space-y-3" data-testid="refuse-suggestion-card">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <ShieldAlert size={15} className="text-orange-400" />
        Course proposée — vaut-elle le coup ?
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs text-slate-300">Prix (€)</Label>
          <Input type="number" inputMode="decimal" value={fare} onChange={(e) => setFare(e.target.value)} className="h-9 text-sm mt-1" data-testid="input-refuse-fare" />
        </div>
        <div>
          <Label className="text-xs text-slate-300">Distance (km)</Label>
          <Input type="number" inputMode="decimal" value={distance} onChange={(e) => setDistance(e.target.value)} className="h-9 text-sm mt-1" data-testid="input-refuse-distance" />
        </div>
        <div>
          <Label className="text-xs text-slate-300">Durée (min)</Label>
          <Input type="number" inputMode="decimal" value={duration} onChange={(e) => setDuration(e.target.value)} className="h-9 text-sm mt-1" data-testid="input-refuse-duration" />
        </div>
        <div>
          <Label className="text-xs text-slate-300">Zone de dépose</Label>
          <Input value={dropoffZone} onChange={(e) => setDropoffZone(e.target.value)} className="h-9 text-sm mt-1" placeholder="Nom de zone" data-testid="input-refuse-dropoff" />
        </div>
      </div>
      <Button
        className="w-full h-10"
        disabled={!fare || !distance || !duration || mutation.isPending}
        onClick={() => mutation.mutate()}
        data-testid="button-check-refuse"
      >
        {mutation.isPending ? "Analyse..." : "Analyser cette course"}
      </Button>

      {mutation.data && (
        <div
          className={`rounded-xl p-3 text-sm space-y-1 ${
            mutation.data.refuse ? "bg-red-500/10 border border-red-500/30 text-red-300" : "bg-emerald-500/10 border border-emerald-500/30 text-emerald-300"
          }`}
          data-testid="refuse-result"
        >
          <p className="font-semibold flex items-center gap-1.5">
            {mutation.data.refuse ? <><ShieldAlert size={14} /> Vigilance conseillée</> : <><ThumbsUp size={14} /> Course cohérente</>}
          </p>
          <p className="text-xs leading-snug opacity-90">{mutation.data.hidden_cost_fr}</p>
          {mutation.data.alternative_zone_fr && (
            <p className="text-xs italic opacity-80">{mutation.data.alternative_zone_fr}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default RefuseSuggestionCard;
