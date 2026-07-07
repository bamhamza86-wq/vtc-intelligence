/**
 * AutoDriveToast — Toast bascule mode conduite (Vague 1 - Levier 5)
 * ─────────────────────────────────────────────────────────────────────────────
 * Suggère au chauffeur de rentrer/sortir du mode conduite selon la vitesse GPS.
 * Position : bas de l'écran, au-dessus de la barre de nav.
 * Undo : 5s auto-dismiss (levier 7 aussi).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect } from "react";
import { useAutoDriveMode } from "@/hooks/useAutoDriveMode";
import { Car, X, ArrowLeft } from "lucide-react";
import { opportunity as hapticOpportunity } from "@/lib/haptics";

export default function AutoDriveToast() {
  const { suggestion, accept, dismiss, speedKmh } = useAutoDriveMode();

  useEffect(() => {
    if (suggestion) {
      hapticOpportunity();
      const t = setTimeout(dismiss, 8_000);
      return () => clearTimeout(t);
    }
  }, [suggestion]);

  if (!suggestion) return null;

  const isEnter = suggestion === "enter";
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-3 right-3 z-50 rounded-xl shadow-2xl animate-slide-up"
      style={{
        bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))",
        background: isEnter
          ? "linear-gradient(135deg, #059669 0%, #10b981 100%)"
          : "linear-gradient(135deg, #334155 0%, #475569 100%)",
        color: "white",
      }}
      data-testid="autodrive-toast"
    >
      <div className="flex items-center gap-3 p-3">
        <div className="p-2 rounded-lg bg-white/20 flex-shrink-0">
          {isEnter ? <Car size={22} /> : <ArrowLeft size={22} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm">
            {isEnter ? "Mode conduite ?" : "Arrêté depuis 30s"}
          </div>
          <div className="text-xs opacity-90 mt-0.5">
            {isEnter
              ? `Détection ${Math.round(speedKmh)} km/h — activer le mode XXL ?`
              : "Retour à l'écran Focus ?"}
          </div>
        </div>
        <button
          onClick={accept}
          className="px-3 rounded-lg bg-white/25 hover:bg-white/35 font-semibold text-sm"
          style={{ minHeight: 44 }}
          data-testid="button-autodrive-accept"
        >
          Oui
        </button>
        <button
          onClick={dismiss}
          className="p-2 rounded-lg hover:bg-white/20"
          style={{ minHeight: 44, minWidth: 44 }}
          aria-label="Ignorer"
          data-testid="button-autodrive-dismiss"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
