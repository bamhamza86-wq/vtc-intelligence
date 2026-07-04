/**
 * StationOverlay.tsx — Overlay contextuel gare/aéroport (Lot C)
 * ─────────────────────────────────────────────────────────────────────────────
 * S'affiche automatiquement en bas d'écran quand useGeofenceStation détecte
 * une entrée en zone. Persist dismissal 20 min via localStorage.
 */
import { useEffect, useState } from "react";
import { X, Plane, Train, MapPin } from "lucide-react";
import { useGeofenceStation } from "@/hooks/useGeofenceStation";

const DISMISS_KEY = "vtc.stationOverlay.dismissedUntil";
const DISMISS_MS = 20 * 60 * 1000;

export default function StationOverlay() {
  const { station, label, context, isInside } = useGeofenceStation();
  const [dismissedUntil, setDismissedUntil] = useState<number>(() => {
    const v = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return isNaN(v) ? 0 : v;
  });

  useEffect(() => {
    // Reset dismissal si on quitte la zone
    if (!isInside) setDismissedUntil(0);
  }, [isInside]);

  if (!isInside || !station) return null;
  if (Date.now() < dismissedUntil) return null;

  const isAirport = station.startsWith("CDG") || station === "ORY";
  const Icon = isAirport ? Plane : Train;

  const dismiss = () => {
    const until = Date.now() + DISMISS_MS;
    localStorage.setItem(DISMISS_KEY, String(until));
    setDismissedUntil(until);
  };

  const arrivals = context?.nextArrivals ?? [];
  const dropoffs = context?.recommendedDropoffZones ?? [];

  return (
    <div
      className="fixed bottom-24 left-3 right-3 z-40 rounded-2xl shadow-lg border border-white/10 bg-slate-900/95 backdrop-blur text-white p-4 animate-in slide-in-from-bottom"
      role="dialog"
      aria-label={`Contexte ${label}`}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-blue-500/20 p-2 shrink-0">
          <Icon className="w-6 h-6 text-blue-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-base">{label}</h3>
            <button
              onClick={dismiss}
              aria-label="Fermer"
              className="tap-target flex items-center justify-center rounded-lg hover:bg-white/10 active:bg-white/20"
              style={{ minWidth: 40, minHeight: 40 }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {context?.queueEstimate !== undefined && (
            <p className="text-sm text-slate-300 mt-1">
              File estimée : <span className="font-semibold text-white">~{context.queueEstimate} chauffeurs</span>
            </p>
          )}

          {arrivals.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs uppercase tracking-wide text-slate-400">Prochaines arrivées</p>
              {arrivals.slice(0, 3).map((a, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="truncate mr-2">{a.label}</span>
                  <span className="font-mono text-blue-300 shrink-0">{a.time}</span>
                </div>
              ))}
            </div>
          )}

          {dropoffs.length > 0 && (
            <div className="mt-3">
              <p className="text-xs uppercase tracking-wide text-slate-400 mb-1.5">
                Zones de retour recommandées
              </p>
              <div className="flex flex-wrap gap-1.5">
                {dropoffs.slice(0, 4).map((z, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-blue-500/20 text-blue-200"
                  >
                    <MapPin className="w-3 h-3" />
                    {z}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
