/**
 * SilenceRadioBadge — Couche Wow Factor : silence radio recommandé
 * ─────────────────────────────────────────────────────────────────────────────
 * Quand GET /api/wow/wait-here indique should_wait=true, affiche une carte
 * "Attendez ici N min" avec compte à rebours + bouton "Y aller quand même".
 * Composé dans FocusPage (n'entrave jamais l'action principale du chauffeur).
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Radio, ArrowRightCircle } from "lucide-react";

interface WaitHere {
  should_wait: boolean;
  wait_minutes: number;
  reason_fr: string;
  confidence: number;
}

export function SilenceRadioBadge({ zoneId, hour }: { zoneId: string | null; hour: number }) {
  const [dismissed, setDismissed] = useState(false);
  const [remainingSec, setRemainingSec] = useState(0);

  const { data } = useQuery<WaitHere>({
    queryKey: ["/api/wow/wait-here", zoneId, hour],
    queryFn: () => apiRequest("GET", `/api/wow/wait-here?zone_id=${encodeURIComponent(zoneId ?? "")}&hour=${hour}`).then((r) => r.json()),
    enabled: !!zoneId,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (data?.should_wait) {
      setRemainingSec(data.wait_minutes * 60);
      setDismissed(false);
    }
  }, [data?.should_wait, data?.wait_minutes]);

  useEffect(() => {
    if (remainingSec <= 0) return;
    const t = setInterval(() => setRemainingSec((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [remainingSec > 0]);

  if (!data?.should_wait || dismissed || remainingSec <= 0) return null;

  const mm = Math.floor(remainingSec / 60);
  const ss = remainingSec % 60;

  return (
    <div
      className="rounded-2xl border border-indigo-400/30 bg-indigo-500/10 p-4 space-y-2.5"
      data-testid="silence-radio-badge"
    >
      <div className="flex items-center gap-2 text-indigo-300 text-xs uppercase tracking-widest">
        <Radio size={14} className="animate-pulse" />
        Silence radio recommandé
      </div>
      <div className="flex items-center justify-between">
        <p className="text-lg font-bold text-white">
          Attendez ici <span className="tabular-nums text-indigo-300">{mm}:{String(ss).padStart(2, "0")}</span>
        </p>
        <span className="text-[11px] text-indigo-300/80">{Math.round(data.confidence * 100)}% confiance</span>
      </div>
      <p className="text-sm text-white/80 leading-snug">{data.reason_fr}</p>
      <button
        onClick={() => setDismissed(true)}
        className="tap-target w-full rounded-xl border border-white/20 bg-white/5 text-white text-sm font-medium py-2.5 flex items-center justify-center gap-1.5 active:scale-95 transition-transform"
        style={{ minHeight: 44 }}
        data-testid="button-go-anyway"
      >
        <ArrowRightCircle size={15} />
        Y aller quand même
      </button>
    </div>
  );
}

export default SilenceRadioBadge;
