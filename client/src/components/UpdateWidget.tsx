import { useState, useEffect } from "react";
import { RefreshCw, Clock } from "lucide-react";
import { apiRequest, API_BASE } from "@/lib/queryClient";

interface CacheStatus {
  lastUpdated: string;
  nextUpdate: string;
  secondsUntilNext: number;
  updateCount: number;
}

interface UpdateWidgetProps {
  compact?: boolean;          // version mini (juste les temps)
  showCount?: boolean;        // afficher le compteur de MAJ
  className?: string;
}

export function UpdateWidget({ compact = false, showCount = false, className = "" }: UpdateWidgetProps) {
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(180);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Fetch du statut cache
  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/gmaps-distances/status`, {
        headers: { "Authorization": `Bearer ${localStorage.getItem("vtc_token") || ""}` }
      });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        setSecondsLeft(data.secondsUntilNext ?? 180);
      }
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
    // Rafraîchit le statut toutes les 10s
    const interval = setInterval(fetchStatus, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Compte à rebours local
  useEffect(() => {
    const tick = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          fetchStatus(); // resync quand le timer arrive à 0
          return 180;
        }
        return s - 1;
      });
    }, 1_000);
    return () => clearInterval(tick);
  }, []);

  const fmtTime = (iso: string | undefined) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const fmtCountdown = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const progressPct = Math.max(0, Math.min(100, ((180 - secondsLeft) / 180) * 100));
  const isUrgent = secondsLeft <= 30;

  const forceRefresh = async () => {
    setIsRefreshing(true);
    try {
      await fetch(`${API_BASE}/api/analytics/force-refresh`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${localStorage.getItem("vtc_token") || ""}` }
      });
      await fetchStatus();
      setSecondsLeft(180);
    } catch {}
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  if (compact) {
    return (
      <div className={`flex items-center gap-2 text-xs ${className}`}>
        <div className="flex items-center gap-1 text-muted-foreground">
          <Clock size={11} className="shrink-0" />
          <span>MAJ: <strong className="text-foreground">{fmtTime(status?.lastUpdated)}</strong></span>
        </div>
        <div
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono font-bold"
          style={{
            background: isUrgent ? "rgba(234,179,8,0.15)" : "rgba(59,130,246,0.10)",
            color: isUrgent ? "#eab308" : "#60a5fa",
            border: `1px solid ${isUrgent ? "#eab30833" : "#3b82f620"}`,
          }}
        >
          <RefreshCw size={9} className={isRefreshing ? "animate-spin" : ""} />
          <span>{fmtCountdown(secondsLeft)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-card border border-border rounded-xl p-3 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <RefreshCw size={11} className={isRefreshing ? "animate-spin text-blue-400" : "text-muted-foreground"} />
          Données Google Maps
        </div>
        <button
          onClick={forceRefresh}
          disabled={isRefreshing}
          className="text-[10px] text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors"
        >
          Forcer MAJ
        </button>
      </div>

      {/* Barre de progression */}
      <div className="h-1 bg-muted rounded-full overflow-hidden mb-2">
        <div
          className="h-full rounded-full transition-all duration-1000"
          style={{
            width: `${progressPct}%`,
            background: isUrgent
              ? "linear-gradient(90deg, #eab308, #f97316)"
              : "linear-gradient(90deg, #3b82f6, #06b6d4)",
          }}
        />
      </div>

      {/* Timestamps */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-muted/50 rounded-lg px-2 py-1.5">
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide mb-0.5">Dernière MAJ</p>
          <p className="text-xs font-mono font-bold text-foreground">{fmtTime(status?.lastUpdated)}</p>
          {showCount && status?.updateCount && (
            <p className="text-[9px] text-muted-foreground">#{status.updateCount} depuis démarrage</p>
          )}
        </div>
        <div
          className="rounded-lg px-2 py-1.5"
          style={{
            background: isUrgent ? "rgba(234,179,8,0.08)" : "rgba(59,130,246,0.08)",
            border: `1px solid ${isUrgent ? "#eab30820" : "#3b82f620"}`,
          }}
        >
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide mb-0.5">Prochaine MAJ</p>
          <p
            className="text-xs font-mono font-bold"
            style={{ color: isUrgent ? "#eab308" : "#60a5fa" }}
          >
            {fmtTime(status?.nextUpdate)}
          </p>
          <p
            className="text-[9px] font-mono font-bold"
            style={{ color: isUrgent ? "#f97316" : "#94a3b8" }}
          >
            dans {fmtCountdown(secondsLeft)}
          </p>
        </div>
      </div>

      {/* Source */}
      <p className="text-[9px] text-muted-foreground mt-1.5 text-center">
        Distances routières calibrées Google Maps · Refresh automatique ×3min
      </p>
    </div>
  );
}
