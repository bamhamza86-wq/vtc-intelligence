/**
 * RareEventBanner — Bandeau alerte événement rare haute valeur
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiché en sticky top lorsqu'un événement rare est détecté via useRareEventAlert.
 * Deux actions :
 *   GO    → dismiss local (localStorage 15 min)
 *   REJET → dismiss local + POST /api/reco/ignore + invalide /api/top-zones
 *
 * Lot 2 — Mobile responsive :
 *   - Layout flex-col sur mobile (texte + boutons empilés)
 *   - Boutons GO/REJET pleine largeur sur mobile, inline sur sm+
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useQueryClient } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { useRareEventAlert } from "@/hooks/useRareEventAlert";
import { apiRequest } from "@/lib/queryClient";

export function RareEventBanner() {
  const { rareEvent, dismissRareEvent } = useRareEventAlert();
  const qc = useQueryClient();

  if (!rareEvent) return null;

  // ─── Dismiss local uniquement (bouton GO) ──────────────────────────────────
  const handleGo = () => {
    dismissRareEvent();
  };

  // ─── Dismiss + ignore zone côté serveur (bouton REJET) ────────────────────
  const handleRejet = async () => {
    dismissRareEvent();
    if (rareEvent.zone_id) {
      try {
        await apiRequest("POST", "/api/reco/ignore", {
          zone_id: rareEvent.zone_id,
        });
        qc.invalidateQueries({ queryKey: ["/api/top-zones"] });
      } catch {
        /* silencieux — le dismiss local est déjà effectué */
      }
    }
  };

  return (
    // ─── Mobile : flex-col (texte + boutons empilés) | sm+ : flex-row ──────
    <div
      data-testid="rare-event-banner"
      className="w-full bg-red-600 text-white sticky top-0 z-50 px-3 py-2 sm:px-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 shadow-md"
    >
      {/* ─── Icône + texte ─────────────────────────────────────────────────── */}
      <div className="flex items-start gap-2 min-w-0">
        <Zap size={18} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold text-sm leading-tight truncate">
            Opportunité rare : {rareEvent.title}
          </p>
          <p className="text-xs text-red-100 leading-tight">
            gain estimé {rareEvent.estimated_gain_eur}€ · trajet{" "}
            {rareEvent.travel_min} min
          </p>
        </div>
      </div>

      {/* ─── Boutons d'action : pleine largeur mobile / inline desktop ──────── */}
      <div className="flex items-center gap-2 sm:shrink-0">
        <button
          onClick={handleGo}
          className="flex-1 sm:flex-none bg-white text-red-600 font-bold text-xs px-3 py-2 sm:py-1.5 rounded hover:bg-red-50 transition-colors"
          data-testid="rare-event-go"
        >
          GO
        </button>
        <button
          onClick={handleRejet}
          className="flex-1 sm:flex-none bg-red-700 text-white font-bold text-xs px-3 py-2 sm:py-1.5 rounded hover:bg-red-800 transition-colors border border-red-500"
          data-testid="rare-event-rejet"
        >
          REJET
        </button>
      </div>
    </div>
  );
}
