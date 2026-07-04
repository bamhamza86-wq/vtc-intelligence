/**
 * ShiftRhythm.tsx — Bandeau « rythme du shift » compact (Lot C)
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche en haut du Focus : durée conduite, gains cumulés, progression
 * objectif, et alerte si fin de shift optimale approche.
 */
import { useQuery } from "@tanstack/react-query";
import { Clock, Euro, TrendingDown } from "lucide-react";
import { API_BASE, getAuthToken } from "@/lib/queryClient";

interface ShiftRhythmData {
  elapsedMin: number;
  activeMin: number;
  earningsEur: number;
  targetEur: number;
  targetPct: number;
  rideCount: number;
  hourlyRate: number;
  endShiftSuggestionMin: number | null;
}

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${String(m).padStart(2, "0")}`;
}

export default function ShiftRhythm() {
  const { data } = useQuery<ShiftRhythmData>({
    queryKey: ["focus-rhythm"],
    queryFn: async () => {
      const token = getAuthToken();
      const res = await fetch(`${API_BASE}/api/focus/rhythm`, {
        headers: token ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token } : {},
      });
      if (!res.ok) throw new Error("rhythm fetch failed");
      return res.json();
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  if (!data) return null;

  const pct = Math.min(100, Math.max(0, data.targetPct || 0));
  const nearEnd = data.endShiftSuggestionMin !== null && data.endShiftSuggestionMin > 0 && data.endShiftSuggestionMin < 60;

  return (
    <div className="w-full rounded-2xl border border-white/10 bg-slate-900/70 backdrop-blur px-4 py-3 text-white">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-1.5">
          <Clock className="w-4 h-4 text-slate-400" />
          <span className="font-semibold">{fmtDuration(data.activeMin)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Euro className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold">{data.earningsEur.toFixed(0)}€</span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-300">
          <span>{data.rideCount} courses</span>
          <span className="text-slate-500">·</span>
          <span>{data.hourlyRate.toFixed(0)}€/h</span>
        </div>
      </div>

      <div className="mt-2 relative h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-500 to-blue-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-1 text-xs text-slate-400">
        <span>{pct.toFixed(0)}% de l'objectif ({data.targetEur.toFixed(0)}€)</span>
        {nearEnd && (
          <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
            <TrendingDown className="w-3 h-3" />
            Fin optimale dans {data.endShiftSuggestionMin} min
          </span>
        )}
      </div>
    </div>
  );
}
