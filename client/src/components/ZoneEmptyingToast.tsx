/**
 * ZoneEmptyingToast — Couche Communautaire : bandeau "zone en train de se vider"
 * ─────────────────────────────────────────────────────────────────────────────
 * Consomme useZoneEmptyingAlert() et affiche un toast dismissible quand une
 * alerte 'zone_emptying' est détectée (backend : communityEngine.ts).
 * À monter dans DrivePage et FocusPage.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { X, TrendingDown } from "lucide-react";
import { useZoneEmptyingAlert } from "@/hooks/useZoneEmptyingAlert";

export function ZoneEmptyingToast() {
  const { alert, dismiss } = useZoneEmptyingAlert();
  if (!alert) return null;

  return (
    <div
      data-testid="toast-zone-emptying"
      role="status"
      aria-live="polite"
      className="fixed left-3 right-3 z-[70] rounded-xl bg-orange-950/95 text-white shadow-2xl border border-orange-500/40 animate-slide-up"
      style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <div className="flex items-center gap-3 p-3">
        <TrendingDown size={18} className="text-orange-400 shrink-0" />
        <div className="flex-1 min-w-0 text-sm">
          <p className="font-semibold truncate">{alert.title}</p>
          <p className="text-xs text-orange-200/90 truncate">{alert.message}</p>
        </div>
        <button
          onClick={dismiss}
          aria-label="Fermer"
          data-testid="toast-zone-emptying-dismiss"
          className="p-2 rounded-lg hover:bg-white/10 shrink-0"
          style={{ minHeight: 44, minWidth: 44 }}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

export default ZoneEmptyingToast;
