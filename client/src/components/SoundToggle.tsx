/**
 * SoundToggle — Bascule globale mute/unmute du sound design léger
 * ─────────────────────────────────────────────────────────────────────────────
 * Petit bouton compact (icône seule) branché sur lib/audio.ts
 * (isSoundEnabled / setSoundEnabled). Prévu pour le header (desktop) et le
 * menu « Plus » (mobile), à côté du bouton thème.
 *
 * Joue un "ping" de confirmation à l'activation (retour immédiat que le son
 * fonctionne), rien à la désactivation.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { isSoundEnabled, setSoundEnabled, playSound } from "@/lib/audio";

export function SoundToggle({ compact = false }: { compact?: boolean }) {
  const [enabled, setEnabled] = useState(() => isSoundEnabled());

  function toggle() {
    const next = !enabled;
    setSoundEnabled(next);
    setEnabled(next);
    if (next) {
      // Petit ping immédiat pour confirmer que le son est audible
      setTimeout(() => playSound("ping"), 30);
    }
  }

  return (
    <button
      onClick={toggle}
      data-testid="button-sound-toggle"
      className={`flex items-center justify-center rounded-md hover:bg-accent transition-colors ${compact ? "p-2" : "p-2"}`}
      style={{ minWidth: 44, minHeight: 44 }}
      aria-label={enabled ? "Couper les sons" : "Activer les sons"}
      aria-pressed={enabled}
      title={enabled ? "Sons activés" : "Sons désactivés"}
    >
      {enabled ? <Volume2 size={16} /> : <VolumeX size={16} className="text-muted-foreground" />}
    </button>
  );
}

export default SoundToggle;
