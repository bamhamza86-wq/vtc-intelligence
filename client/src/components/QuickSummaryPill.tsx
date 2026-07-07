/**
 * QuickSummaryPill — Widget résumé glancable (rapport.md §10.9)
 * ─────────────────────────────────────────────────────────────────────────────
 * Pastille très compacte épinglée en haut du header Layout : "148€ · 8 courses
 * · série 5j". Un tap ouvre EconomicsDashboard (/economics).
 * Consomme GET /api/ux/quick-summary, rafraîchi toutes les 60s.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Flame } from "lucide-react";

interface QuickSummary {
  net_today: number;
  rides_today: number;
  current_hourly: number;
  streak: number;
  next_event_hint: string | null;
}

export function QuickSummaryPill({ compact = false }: { compact?: boolean }) {
  const { data } = useQuery<QuickSummary>({
    queryKey: ["/api/ux/quick-summary"],
    queryFn: () => apiRequest("GET", "/api/ux/quick-summary").then((r) => r.json()),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (!data) return null;

  const label = compact
    ? `${data.net_today.toFixed(0)}€ · ${data.rides_today}`
    : `${data.net_today.toFixed(0)}€ · ${data.rides_today} course${data.rides_today > 1 ? "s" : ""}${
        data.streak > 0 ? ` · série ${data.streak}j` : ""
      }`;

  return (
    <Link
      href="/economics"
      data-testid="pill-quick-summary"
      title="Voir le tableau de bord économique"
      className="flex items-center gap-1.5 rounded-full bg-primary/10 hover:bg-primary/20 active:scale-95 transition-all px-2.5 py-1.5 text-[11px] font-semibold text-primary whitespace-nowrap"
      style={{ minHeight: 32 }}
    >
      {data.streak > 0 && <Flame size={12} className="text-orange-500 shrink-0" />}
      <span className="tabular-nums">{label}</span>
    </Link>
  );
}

export default QuickSummaryPill;
