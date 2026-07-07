/**
 * StreakBadge — Couche Wow Factor (rapport.md §11, §12, §15)
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche la série quotidienne active (streak) du chauffeur avec une flamme
 * SVG animée. Deux tailles : `compact` (header) et pleine (ProfilePage).
 * Consomme GET /api/wow/streak → { current, best, next_milestone, freeze_available }.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface StreakStatus {
  current: number;
  best: number;
  next_milestone: number | null;
  freeze_available: number;
}

export function StreakBadge({ compact = false }: { compact?: boolean }) {
  const { data } = useQuery<StreakStatus>({
    queryKey: ["/api/wow/streak"],
    queryFn: () => apiRequest("GET", "/api/wow/streak").then((r) => r.json()),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const current = data?.current ?? 0;
  const isActive = current > 0;

  const Flame = ({ size }: { size: number }) => (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className={isActive ? "wow-flame-anim" : ""}
    >
      <path
        d="M12 2c1 3-2 4-2 7a4 4 0 0 0 8 0c0-1-.5-2-1-2.5.5 2-1 3-1 3 .5-3-2-4-2-6.5-1 1.5-3 2.5-3 5.5a4 4 0 0 0 1 2.6C9.5 10.8 8 9 8 6.5 8 4.5 10 3 12 2Z"
        fill={isActive ? "url(#wow-flame-grad)" : "currentColor"}
        className={isActive ? "" : "text-muted-foreground opacity-40"}
      />
      <path
        d="M9 15.5A4.5 4.5 0 0 0 12 20a4.5 4.5 0 0 0 4.5-4.5c0-1.2-.4-2-1-2.7.1 1.3-.7 2-1.5 2 .4-1.7-.7-2.5-1-3.8-1 .8-2.4 1.7-2.4 3.5 0 .2 0 .3.05.5-.6-.3-1.65-.9-1.65-2Z"
        fill={isActive ? "#fff7ed" : "none"}
        opacity="0.6"
      />
      <defs>
        <linearGradient id="wow-flame-grad" x1="8" y1="2" x2="16" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fbbf24" />
          <stop offset="1" stopColor="#f97316" />
        </linearGradient>
      </defs>
    </svg>
  );

  if (compact) {
    return (
      <div
        className="flex items-center gap-1 px-1.5 py-1 rounded-full text-xs font-semibold"
        data-testid="streak-badge-compact"
        title={isActive ? `${current} jour${current > 1 ? "s" : ""} de série active` : "Aucune série en cours"}
      >
        <Flame size={16} />
        {isActive && <span className="text-amber-400 tabular-nums">{current}</span>}
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-center gap-4"
      data-testid="streak-badge-full"
    >
      <Flame size={40} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-black text-amber-400 tabular-nums" data-testid="text-streak-current">
            {current}
          </span>
          <span className="text-sm text-muted-foreground">
            jour{current > 1 ? "s" : ""} de série
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Record perso : {data?.best ?? 0} jour{(data?.best ?? 0) > 1 ? "s" : ""}
          {data?.next_milestone ? ` · Prochain palier : ${data.next_milestone} jours` : ""}
        </p>
        {typeof data?.freeze_available === "number" && (
          <p className="text-[11px] text-cyan-400 mt-1">
            ❄️ {data.freeze_available} jeton{data.freeze_available > 1 ? "s" : ""} de protection restant{data.freeze_available > 1 ? "s" : ""}
          </p>
        )}
      </div>
      <style>{`
        @keyframes wow-flame-flicker {
          0%, 100% { transform: scale(1) rotate(0deg); }
          25% { transform: scale(1.05) rotate(-2deg); }
          50% { transform: scale(0.97) rotate(1deg); }
          75% { transform: scale(1.03) rotate(2deg); }
        }
        .wow-flame-anim {
          animation: wow-flame-flicker 1.8s ease-in-out infinite;
          transform-origin: center bottom;
        }
      `}</style>
    </div>
  );
}

export default StreakBadge;
