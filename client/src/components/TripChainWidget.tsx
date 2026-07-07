/**
 * TripChainWidget — Couche Décision Avancée : « Vos prochaines courses idéales »
 * ─────────────────────────────────────────────────────────────────────────────
 * Carrousel horizontal compact des chaînes de courses (A → B → C) calculées
 * à partir de la position GPS actuelle. GET /api/decision/trip-chain.
 * Affiché en bas de FocusPage.
 */
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Sparkles, Euro, Timer } from "lucide-react";
import { API_BASE, getAuthToken } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";

interface TripChainStep {
  zone_id: string | null;
  zone_name: string;
  distance_km: number;
  eta_min: number;
  expected_net_eur: number;
  score: number;
}

interface TripChain {
  zone_a: TripChainStep;
  zone_b: TripChainStep;
  zone_c: TripChainStep | null;
  total_expected_net: number;
  total_duration_min: number;
  confidence: number;
  reasoning_fr: string;
}

interface TripChainResponse {
  chains: TripChain[];
  best_chain_index: number;
}

async function fetchTripChains(lat: number, lng: number): Promise<TripChainResponse> {
  const token = getAuthToken();
  const qs = new URLSearchParams({ origin_zone: `${lat},${lng}`, horizon_min: "90" });
  const res = await fetch(`${API_BASE}/api/decision/trip-chain?${qs.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token } : {},
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

function StepPill({ step }: { step: TripChainStep }) {
  return (
    <div className="flex flex-col items-center gap-0.5 min-w-[74px]">
      <span className="text-[11px] font-semibold text-white truncate max-w-[80px]">{step.zone_name}</span>
      <span className="text-[10px] text-emerald-300 tabular-nums">+{step.expected_net_eur.toFixed(0)}€</span>
      <span className="text-[9px] text-slate-400 tabular-nums">{step.eta_min} min</span>
    </div>
  );
}

export function TripChainWidget() {
  const { position } = useGpsPosition();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["decision-trip-chain", position.lat, position.lng],
    queryFn: () => fetchTripChains(position.lat, position.lng),
    staleTime: 60_000,
    enabled: !!position,
  });

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 text-xs text-slate-400" data-testid="trip-chain-loading">
        Calcul de vos prochaines courses idéales…
      </div>
    );
  }

  if (isError || !data || data.chains.length === 0) {
    return null;
  }

  const chains = data.chains.slice(0, 2); // "Vos 2 prochaines courses idéales"

  return (
    <div className="rounded-2xl border border-indigo-400/20 bg-slate-900/60 p-4 space-y-3" data-testid="trip-chain-widget">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <Sparkles size={15} className="text-indigo-400" />
        Vos {chains.length === 1 ? "prochaine course idéale" : `${chains.length} prochaines courses idéales`}
      </p>
      <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1 snap-x">
        {chains.map((chain, i) => (
          <div
            key={i}
            className={`snap-start shrink-0 rounded-xl border p-3 min-w-[220px] ${
              i === data.best_chain_index ? "border-emerald-400/40 bg-emerald-500/5" : "border-white/10 bg-slate-800/40"
            }`}
            data-testid={`trip-chain-card-${i}`}
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <StepPill step={chain.zone_a} />
              <ArrowRight size={12} className="text-slate-500 shrink-0" />
              <StepPill step={chain.zone_b} />
              {chain.zone_c && (
                <>
                  <ArrowRight size={12} className="text-slate-500 shrink-0" />
                  <StepPill step={chain.zone_c} />
                </>
              )}
            </div>
            <div className="flex items-center gap-3 mt-2 pt-2 border-t border-white/10 text-[11px]">
              <span className="flex items-center gap-1 text-emerald-300 font-semibold tabular-nums">
                <Euro size={11} /> {chain.total_expected_net.toFixed(0)}€
              </span>
              <span className="flex items-center gap-1 text-slate-400 tabular-nums">
                <Timer size={11} /> {chain.total_duration_min} min
              </span>
              <span className="ml-auto text-slate-500 tabular-nums">{Math.round(chain.confidence * 100)}%</span>
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5 leading-snug">{chain.reasoning_fr}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default TripChainWidget;
