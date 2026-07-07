/**
 * RecordAlertToast — Couche Wow Factor : "vous êtes sur le point de battre votre record"
 * ─────────────────────────────────────────────────────────────────────────────
 * Écoute /api/alerts filtré sur type === 'record_hunt'. Affiche une bannière
 * discrète en bas d'écran + déclenche le confetti quand une nouvelle alerte
 * de ce type apparaît. Monté globalement (App.tsx), ne rend rien si RAS.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Trophy, X } from "lucide-react";
import { NearRecordConfetti } from "./NearRecordConfetti";

interface Alert {
  id: string | number;
  type: string;
  priority: string;
  message?: string;
  message_fr?: string;
  is_read?: boolean;
}

export function RecordAlertToast() {
  const { data: alerts = [] } = useQuery<Alert[]>({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then((r) => r.json()),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const recordAlerts = (Array.isArray(alerts) ? alerts : []).filter(
    (a) => a.type === "record_hunt" && !a.is_read
  );
  const current = recordAlerts[0] ?? null;

  const [dismissedId, setDismissedId] = useState<string | number | null>(null);
  const [confettiTrigger, setConfettiTrigger] = useState(0);
  const lastSeenId = useRef<string | number | null>(null);

  useEffect(() => {
    if (current && current.id !== lastSeenId.current) {
      lastSeenId.current = current.id;
      setConfettiTrigger((n) => n + 1);
    }
  }, [current?.id]);

  if (!current || current.id === dismissedId) return null;

  return (
    <>
      <NearRecordConfetti trigger={confettiTrigger} />
      <div
        className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[150] w-[92%] max-w-sm"
        data-testid="record-alert-toast"
      >
        <div className="rounded-2xl border border-amber-400/40 bg-gradient-to-br from-amber-500/95 to-orange-600/95 text-white shadow-2xl p-4 flex items-start gap-3">
          <Trophy size={22} className="shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold">Vous êtes proche de votre record !</p>
            <p className="text-xs text-white/90 mt-0.5">
              {current.message_fr ?? current.message ?? "Continuez, un record personnel est à portée de main."}
            </p>
          </div>
          <button
            onClick={() => setDismissedId(current.id)}
            className="shrink-0 p-1 rounded-full hover:bg-white/20 transition-colors"
            aria-label="Fermer"
            data-testid="button-dismiss-record-alert"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </>
  );
}

export default RecordAlertToast;
