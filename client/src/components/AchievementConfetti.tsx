/**
 * AchievementConfetti — Confetti canvas 60fps + haptique + chime sonore
 * ─────────────────────────────────────────────────────────────────────────────
 * Surveille GET /api/wow/achievements (poll léger 20s) et détecte les
 * nouveaux succès débloqués depuis la dernière visite (comparaison avec la
 * liste des clés vues, mémorisée en localStorage). Au premier rendu où un
 * nouveau succès apparaît : explosion de confetti en canvas (particules
 * physiques simples, aucune dépendance), haptique "success", chime Web Audio.
 *
 * Aucune dépendance externe : canvas 2D natif, requestAnimationFrame, capé à
 * ~2s de durée de vie, se nettoie automatiquement. Respecte
 * prefers-reduced-motion (désactive l'animation, garde juste le son/haptique).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { haptic } from "@/lib/haptics";
import { playSound } from "@/lib/audio";

interface Achievement {
  key: string;
  label_fr: string;
  description_fr: string;
  icon: string;
  unlocked: boolean;
  unlocked_at: string | null;
}

const SEEN_KEY = "vtc.achievements_seen";
const COLORS = ["#fbbf24", "#34d399", "#60a5fa", "#f472b6", "#a78bfa", "#f97316", "#facc15"];

interface Particle {
  x: number; y: number; vx: number; vy: number;
  size: number; color: string; rotation: number; vr: number; life: number;
}

function getSeenKeys(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeenKeys(keys: Set<string>): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(keys)));
  } catch { /* ignore quota errors */ }
}

export function AchievementConfetti() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const [toast, setToast] = useState<Achievement | null>(null);
  const initializedRef = useRef(false);

  const { data } = useQuery<{ achievements: Achievement[] }>({
    queryKey: ["/api/wow/achievements"],
    queryFn: () => apiRequest("GET", "/api/wow/achievements").then((r) => r.json()),
    refetchInterval: 20_000,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!data) return;
    const achievements = data.achievements ?? [];
    const seen = getSeenKeys();

    // Premier chargement : on marque tout comme vu sans célébrer (évite un
    // feu d'artifice au premier login avec des succès déjà anciens).
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (seen.size === 0) {
        saveSeenKeys(new Set(achievements.filter(a => a.unlocked).map(a => a.key)));
        return;
      }
    }

    const newlyUnlocked = achievements.filter((a) => a.unlocked && !seen.has(a.key));
    if (newlyUnlocked.length === 0) return;

    // Marquer tous comme vus immédiatement (évite double-célébration)
    achievements.filter(a => a.unlocked).forEach(a => seen.add(a.key));
    saveSeenKeys(seen);

    // Célébrer le premier nouveau succès détecté
    const achievement = newlyUnlocked[0];
    setToast(achievement);
    haptic("success");
    playSound("chime");

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduceMotion) {
      fireConfetti();
    }

    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  function fireConfetti() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.scale(dpr, dpr);

    const particles: Particle[] = Array.from({ length: 90 }, () => ({
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 80,
      y: window.innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 9,
      vy: -Math.random() * 8 - 4,
      size: 4 + Math.random() * 5,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      rotation: Math.random() * 360,
      vr: (Math.random() - 0.5) * 14,
      life: 1,
    }));

    const gravity = 0.28;
    const startTime = performance.now();
    const durationMs = 2000;

    function tick(now: number) {
      const elapsed = now - startTime;
      ctx!.clearRect(0, 0, window.innerWidth, window.innerHeight);

      for (const p of particles) {
        p.vy += gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.vr;
        p.life = Math.max(0, 1 - elapsed / durationMs);

        ctx!.save();
        ctx!.globalAlpha = p.life;
        ctx!.translate(p.x, p.y);
        ctx!.rotate((p.rotation * Math.PI) / 180);
        ctx!.fillStyle = p.color;
        ctx!.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx!.restore();
      }

      if (elapsed < durationMs) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        ctx!.clearRect(0, 0, window.innerWidth, window.innerHeight);
      }
    }

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="fixed inset-0 pointer-events-none z-[210]"
        aria-hidden="true"
        data-testid="achievement-confetti-canvas"
      />
      {toast && (
        <div
          className="fixed top-4 inset-x-0 z-[211] flex justify-center px-3 pointer-events-none"
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          <div
            className="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl bg-amber-400/95 text-amber-950 shadow-2xl border border-amber-300 max-w-sm achievement-toast-in"
            role="status"
            aria-live="polite"
            data-testid="achievement-unlock-toast"
          >
            <span className="text-2xl leading-none" aria-hidden="true">{toast.icon}</span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">Succès débloqué</p>
              <p className="text-sm font-bold leading-tight truncate">{toast.label_fr}</p>
            </div>
          </div>
        </div>
      )}
      <style>{`
        @keyframes achievement-toast-in {
          from { opacity: 0; transform: translateY(-16px) scale(0.95); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .achievement-toast-in { animation: achievement-toast-in 320ms cubic-bezier(.2,.9,.3,1.2); }
        @media (prefers-reduced-motion: reduce) {
          .achievement-toast-in { animation: none; }
        }
      `}</style>
    </>
  );
}

export default AchievementConfetti;
