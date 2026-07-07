/**
 * FocusCountdown — Compte à rebours de fenêtre rentable (Vague 1 - Levier 4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche "Fenêtre optimale ferme dans Xm" pour indiquer au chauffeur combien
 * de temps la reco courante reste valide. À intégrer dans FocusPage.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";

interface Props {
  validUntil: number; // epoch ms
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

export default function FocusCountdown({ validUntil }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = validUntil - now;
  if (remaining <= 0) return null;

  // Couleur adaptée au temps restant : ambre < 60s, vert sinon
  const critical = remaining < 60_000;
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium tabular-nums ${
        critical
          ? "bg-amber-500/20 text-amber-100 border border-amber-400/40"
          : "bg-white/10 text-white/90 border border-white/20"
      }`}
      data-testid="focus-countdown"
      aria-label={`Fenêtre optimale ferme dans ${fmt(remaining)}`}
    >
      <Hourglass size={12} className={critical ? "animate-pulse" : ""} />
      <span>Fenêtre {fmt(remaining)}</span>
    </div>
  );
}
