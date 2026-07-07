/**
 * CounterIntuitionCard — Couche Décision Avancée : alerte contre-intuition
 * ─────────────────────────────────────────────────────────────────────────────
 * Formulaire compact (course entrante) → GET /api/decision/counter-intuition.
 * Si verdict != "accept", affiche clairement le coût caché estimé et une
 * alternative. Ton informatif, jamais directif : la décision reste au chauffeur.
 * Réutilise le style de RefuseSuggestionCard (Couche Wow Factor) pour cohérence UI.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { API_BASE, getAuthToken } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ShieldAlert, ThumbsUp, AlertTriangle } from "lucide-react";

interface CounterIntuitionResult {
  verdict: "accept" | "refuse" | "careful";
  hidden_cost_eur: number;
  reason_fr: string;
  alternative_hint_fr: string;
}

async function fetchCounterIntuition(params: {
  fare: string;
  distance: string;
  duration: string;
  dropoffZone: string;
}): Promise<CounterIntuitionResult> {
  const token = getAuthToken();
  const qs = new URLSearchParams({
    fare: params.fare,
    distance: params.distance,
    duration: params.duration,
    ...(params.dropoffZone ? { dropoff_zone: params.dropoffZone } : {}),
  });
  const res = await fetch(`${API_BASE}/api/decision/counter-intuition?${qs.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token } : {},
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

const VERDICT_STYLE: Record<CounterIntuitionResult["verdict"], string> = {
  accept: "bg-emerald-500/10 border border-emerald-500/30 text-emerald-300",
  careful: "bg-amber-500/10 border border-amber-500/30 text-amber-300",
  refuse: "bg-red-500/10 border border-red-500/30 text-red-300",
};

const VERDICT_LABEL: Record<CounterIntuitionResult["verdict"], string> = {
  accept: "Course cohérente",
  careful: "Vigilance conseillée",
  refuse: "Coût caché important",
};

const VERDICT_ICON: Record<CounterIntuitionResult["verdict"], React.ComponentType<{ size?: number; className?: string }>> = {
  accept: ThumbsUp,
  careful: AlertTriangle,
  refuse: ShieldAlert,
};

export function CounterIntuitionCard() {
  const [open, setOpen] = useState(false);
  const [fare, setFare] = useState("");
  const [distance, setDistance] = useState("");
  const [duration, setDuration] = useState("");
  const [dropoffZone, setDropoffZone] = useState("");

  const mutation = useMutation({
    mutationFn: () => fetchCounterIntuition({ fare, distance, duration, dropoffZone }),
  });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="tap-target w-full rounded-2xl border border-white/10 bg-slate-900/60 text-slate-200 text-sm font-medium py-3 flex items-center justify-center gap-2 active:scale-95 transition-transform"
        style={{ minHeight: 44 }}
        data-testid="button-open-counter-intuition"
      >
        <AlertTriangle size={15} className="text-amber-400" />
        Cette course paraît bonne — vérifier le coût caché
      </button>
    );
  }

  const Icon = mutation.data ? VERDICT_ICON[mutation.data.verdict] : ShieldAlert;

  return (
    <div className="rounded-2xl border border-amber-400/30 bg-slate-900/70 p-4 space-y-3" data-testid="counter-intuition-card">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <AlertTriangle size={15} className="text-amber-400" />
        Course entrante — attention au coût caché
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs text-slate-300">Prix (€)</Label>
          <Input type="number" inputMode="decimal" value={fare} onChange={(e) => setFare(e.target.value)} className="h-9 text-sm mt-1" data-testid="input-ci-fare" />
        </div>
        <div>
          <Label className="text-xs text-slate-300">Distance (km)</Label>
          <Input type="number" inputMode="decimal" value={distance} onChange={(e) => setDistance(e.target.value)} className="h-9 text-sm mt-1" data-testid="input-ci-distance" />
        </div>
        <div>
          <Label className="text-xs text-slate-300">Durée (min)</Label>
          <Input type="number" inputMode="decimal" value={duration} onChange={(e) => setDuration(e.target.value)} className="h-9 text-sm mt-1" data-testid="input-ci-duration" />
        </div>
        <div>
          <Label className="text-xs text-slate-300">Zone de dépose</Label>
          <Input value={dropoffZone} onChange={(e) => setDropoffZone(e.target.value)} className="h-9 text-sm mt-1" placeholder="Nom de zone" data-testid="input-ci-dropoff" />
        </div>
      </div>
      <Button
        className="w-full h-10"
        disabled={!fare || !distance || !duration || mutation.isPending}
        onClick={() => mutation.mutate()}
        data-testid="button-check-counter-intuition"
      >
        {mutation.isPending ? "Analyse..." : "Analyser cette course"}
      </Button>

      {mutation.data && (
        <div className={`rounded-xl p-3 text-sm space-y-1 ${VERDICT_STYLE[mutation.data.verdict]}`} data-testid="counter-intuition-result">
          <p className="font-semibold flex items-center gap-1.5">
            <Icon size={14} /> {VERDICT_LABEL[mutation.data.verdict]}
          </p>
          <p className="text-xs leading-snug opacity-90">{mutation.data.reason_fr}</p>
          {mutation.data.hidden_cost_eur > 0 && (
            <p className="text-xs font-semibold opacity-95">
              Perte cachée estimée : −{mutation.data.hidden_cost_eur.toFixed(2)} €
            </p>
          )}
          {mutation.data.alternative_hint_fr && (
            <p className="text-xs italic opacity-80">{mutation.data.alternative_hint_fr}</p>
          )}
        </div>
      )}
      {mutation.isError && (
        <p className="text-xs text-red-400">Impossible d'analyser cette course pour le moment.</p>
      )}
    </div>
  );
}

export default CounterIntuitionCard;
