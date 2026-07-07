/**
 * ReputationBadge — Couche Communautaire : Karma + niveau de confiance
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche le karma du chauffeur et son niveau (Novice / Confirmé / Vétéran)
 * dans le header de ProfilePage, via GET /api/community/me/reputation.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { Award, Shield, Star } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface ReputationResponse {
  user_id: string;
  karma_score: number;
  signals_correct: number;
  signals_wrong: number;
  trust_level: "novice" | "trusted" | "veteran";
  next_level_at: number | null;
}

const LEVEL_META: Record<string, { label: string; cls: string; Icon: typeof Award }> = {
  novice: { label: "Novice", cls: "bg-slate-500/15 text-slate-300 border-slate-500/30", Icon: Star },
  trusted: { label: "Confirmé", cls: "bg-sky-500/15 text-sky-400 border-sky-500/30", Icon: Shield },
  veteran: { label: "Vétéran", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30", Icon: Award },
};

export function ReputationBadge({ className = "" }: { className?: string }) {
  const { data } = useQuery<ReputationResponse>({
    queryKey: ["/api/community/me/reputation"],
    queryFn: () => apiRequest("GET", "/api/community/me/reputation").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  if (!data) return null;
  const meta = LEVEL_META[data.trust_level] ?? LEVEL_META.novice;
  const { Icon } = meta;

  return (
    <div
      data-testid="reputation-badge"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${meta.cls} ${className}`}
      title={`Karma : ${data.karma_score} · ${data.signals_correct} confirmés / ${data.signals_wrong} erronés`}
    >
      <Icon size={14} />
      <span className="text-xs font-bold">{meta.label}</span>
      <span className="text-[10px] opacity-80 tabular-nums">Karma {data.karma_score}</span>
    </div>
  );
}

export default ReputationBadge;
