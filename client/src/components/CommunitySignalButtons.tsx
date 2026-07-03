/**
 * CommunitySignalButtons — Levier 9 : Signalement communautaire 1-tap
 * ─────────────────────────────────────────────────────────────────────────────
 * Deux boutons de remontée terrain pour une zone donnée :
 *   • 🟢 ThumbsUp  → signal positif (zone rentable / demande forte)
 *   • 🔴 ThumbsDown → signal négatif (zone morte / trop de concurrence)
 *
 * Au clic :
 *   1. POST /api/zones/:id/signal { type }
 *   2. Invalide /api/top-zones + /api/community/impact (rafraîchit le score pondéré)
 *   3. Retour haptique ("success" | "warning")
 *   4. Désactivation locale 30s pour éviter le spam d'un même chauffeur
 *
 * Le boost communautaire est borné ±8% côté serveur sur profitability_index.
 *
 * Props :
 *   • zoneId  — identifiant de la zone signalée (obligatoire)
 *   • compact — masque le compteur positive/negative si true (défaut false)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { haptic } from "@/lib/haptics";
import { useCommunityImpact } from "@/hooks/useCommunityImpact";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface CommunitySignalButtonsProps {
  /** Identifiant de la zone concernée par le signalement. */
  zoneId: string;
  /** Mode compact : masque le compteur positive/negative. */
  compact?: boolean;
}

// ── Constantes ──────────────────────────────────────────────────────────────────
const COOLDOWN_MS = 30_000; // 30s de désactivation anti-spam après un clic

export function CommunitySignalButtons({ zoneId, compact = false }: CommunitySignalButtonsProps) {
  const qc = useQueryClient();
  const { impact } = useCommunityImpact(zoneId);

  // État local : timestamp de fin de cooldown (0 = actif)
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
  const [now, setNow] = useState<number>(Date.now());

  // Tick pour réactiver les boutons à la fin du cooldown
  useEffect(() => {
    if (cooldownUntil === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const disabled = cooldownUntil > now;

  // ── Envoi d'un signalement ────────────────────────────────────────────────
  const sendSignal = async (type: "positive" | "negative") => {
    if (disabled) return;
    // Désactive immédiatement pour éviter les doubles clics
    setCooldownUntil(Date.now() + COOLDOWN_MS);
    setNow(Date.now());
    haptic(type === "positive" ? "success" : "warning");
    try {
      await apiRequest("POST", `/api/zones/${zoneId}/signal`, { type });
      // Rafraîchit le score pondéré + la carte des impacts
      qc.invalidateQueries({ queryKey: ["/api/top-zones"] });
      qc.invalidateQueries({ queryKey: ["/api/community/impact"] });
    } catch {
      /* silencieux — le cooldown local reste actif */
    }
  };

  return (
    <div
      data-testid="community-signal-buttons"
      className="flex items-center gap-2"
    >
      {/* ─── Bouton signal positif 🟢 ─────────────────────────────────────── */}
      <button
        data-testid="signal-btn-positive"
        onClick={() => sendSignal("positive")}
        disabled={disabled}
        aria-label="Signaler une zone rentable"
        className="flex items-center justify-center rounded-lg border border-green-500/40 bg-green-500/10 p-2 text-green-500 transition-colors hover:bg-green-500/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ThumbsUp size={18} />
      </button>

      {/* ─── Bouton signal négatif 🔴 ─────────────────────────────────────── */}
      <button
        data-testid="signal-btn-negative"
        onClick={() => sendSignal("negative")}
        disabled={disabled}
        aria-label="Signaler une zone morte"
        className="flex items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-red-500 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ThumbsDown size={18} />
      </button>

      {/* ─── Compteur positive/negative (masqué en mode compact) ──────────── */}
      {!compact && (
        <span
          data-testid="signal-counter"
          className="ml-1 text-xs text-muted-foreground tabular-nums"
        >
          <span className="font-semibold text-green-500">{impact?.positive ?? 0}</span>
          <span className="mx-0.5">/</span>
          <span className="font-semibold text-red-500">{impact?.negative ?? 0}</span>
        </span>
      )}
    </div>
  );
}

export default CommunitySignalButtons;
