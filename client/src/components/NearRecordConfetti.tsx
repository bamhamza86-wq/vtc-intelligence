/**
 * NearRecordConfetti — Couche Wow Factor : célébration CSS-only (SVG confetti)
 * ─────────────────────────────────────────────────────────────────────────────
 * Animation courte (1.5s) déclenchée quand un record personnel est battu.
 * Aucune dépendance externe — pur SVG + CSS keyframes.
 */
import { useEffect, useState } from "react";

const COLORS = ["#fbbf24", "#34d399", "#60a5fa", "#f472b6", "#a78bfa", "#f97316"];

export function NearRecordConfetti({ trigger }: { trigger: number }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (trigger <= 0) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1500);
    return () => clearTimeout(t);
  }, [trigger]);

  if (!visible) return null;

  const pieces = Array.from({ length: 24 }, (_, i) => ({
    id: i,
    left: Math.round(Math.random() * 100),
    delay: Math.round(Math.random() * 200),
    color: COLORS[i % COLORS.length],
    rotate: Math.round(Math.random() * 360),
    size: 6 + Math.round(Math.random() * 6),
  }));

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[200] overflow-hidden"
      aria-hidden="true"
      data-testid="near-record-confetti"
    >
      {pieces.map((p) => (
        <span
          key={p.id}
          className="wow-confetti-piece"
          style={{
            left: `${p.left}%`,
            backgroundColor: p.color,
            width: p.size,
            height: p.size * 0.4,
            animationDelay: `${p.delay}ms`,
            transform: `rotate(${p.rotate}deg)`,
          }}
        />
      ))}
      <style>{`
        .wow-confetti-piece {
          position: absolute;
          top: -5%;
          border-radius: 1px;
          animation: wow-confetti-fall 1.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
          opacity: 0.95;
        }
        @keyframes wow-confetti-fall {
          0% { top: -5%; opacity: 1; }
          100% { top: 105%; opacity: 0; }
        }
      `}</style>
    </div>
  );
}

export default NearRecordConfetti;
