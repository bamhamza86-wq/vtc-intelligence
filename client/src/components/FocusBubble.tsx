/**
 * FocusBubble — Bulle Focus flottante globale (Vague 1 - Levier 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Widget flottant type "Messenger" qui affiche la recommandation Focus
 * courante en permanence, quelle que soit la page. Un tap → navigation /focus.
 * Se masque automatiquement sur /focus et /drive (déjà en 1er plan).
 * Draggable verticalement pour éviter les zones critiques.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Target, ChevronRight, Zap } from "lucide-react";
import { API_BASE, getAuthToken } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { useDailyStreak } from "@/hooks/useDailyStreak";
import { useBatteryStatus } from "@/hooks/useBatteryStatus";

interface FocusReco {
  verb: "aller" | "rester" | "pause" | "rentrer";
  zoneName?: string;
  reasonShort?: string;
  confidence?: number;
}

const LS_Y_POS = "vtc.focusBubble.y";
const LS_DISMISSED = "vtc.focusBubble.dismissed";

const VERB_COLOR: Record<string, string> = {
  aller: "bg-emerald-600",
  rester: "bg-sky-600",
  pause: "bg-amber-500",
  rentrer: "bg-slate-600",
};
const VERB_LABEL: Record<string, string> = {
  aller: "Aller",
  rester: "Rester",
  pause: "Pause",
  rentrer: "Rentrer",
};

export default function FocusBubble() {
  const [location] = useLocation();
  const { position } = useGpsPosition();
  // Vague 2 - Feature 3 : progression objectif journalier (anneau + streak)
  const { progress: dailyProgress, target: dailyTarget, currentEuros: dailyCurrentEuros, streakDays } = useDailyStreak();
  const [showGoalDetail, setShowGoalDetail] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  // Vague 2 - Feature 4 : indicateur mode performance dégradé (batterie faible)
  const { perfMode } = useBatteryStatus();
  const [yPos, setYPos] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(LS_Y_POS) || 0) || 200;
    } catch {
      return 200;
    }
  });
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(LS_DISMISSED) === "true";
    } catch {
      return false;
    }
  });
  const dragRef = useRef<{ startY: number; startPos: number } | null>(null);

  const { data: reco } = useQuery<FocusReco | null>({
    queryKey: ["focusBubble", position.lat, position.lng],
    enabled: !!position.lat && !!position.lng,
    refetchInterval: 60_000,
    queryFn: async () => {
      const token = getAuthToken();
      const url = `${API_BASE}/api/focus/recommendation?lat=${position.lat}&lng=${position.lng}`;
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token } : {},
      });
      if (!res.ok) return null;
      return res.json();
    },
  });

  // Masquer sur pages où l'info est déjà dominante
  const hidden =
    location === "/focus" || location === "/drive" || location === "/login" || dismissed;

  useEffect(() => {
    try {
      localStorage.setItem(LS_Y_POS, String(yPos));
    } catch {}
  }, [yPos]);

  if (hidden || !reco) return null;

  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startPos: yPos };
    // Vague 2 - Feature 3 : démarre le minuteur d'appui long (objectif du jour)
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => setShowGoalDetail(true), 500);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dy = e.clientY - dragRef.current.startY;
    const next = Math.max(80, Math.min(window.innerHeight - 200, dragRef.current.startPos + dy));
    setYPos(next);
    // Un déplacement annule l'appui long (c'est un drag, pas un long-press)
    if (Math.abs(dy) > 6 && longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }
  function onPointerUp() {
    dragRef.current = null;
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  // Vague 2 - Feature 3 : anneau de progression autour de la bulle (SVG additif)
  const RING_SIZE = 56;
  const RING_RADIUS = 26;
  const RING_CIRC = 2 * Math.PI * RING_RADIUS;
  const ringOffset = RING_CIRC * (1 - Math.min(1, Math.max(0, dailyProgress)));

  return (
    <div
      className="fixed right-2 z-40"
      style={{ top: yPos - 4, touchAction: "none" }}
    >
      {/* Anneau de progression objectif journalier — n'intercepte pas les clics */}
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="absolute -top-1 -left-1 -rotate-90 pointer-events-none"
        aria-hidden="true"
      >
        <circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="3" />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="#fbbf24"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={RING_CIRC}
          strokeDashoffset={ringOffset}
        />
      </svg>

      {/* Icône batterie faible / mode performance réduit — Vague 2 Feature 4 */}
      {perfMode === "low" && (
        <div
          className="absolute -top-1.5 -right-1.5 z-10 w-4 h-4 rounded-full bg-amber-500 flex items-center justify-center shadow"
          aria-label="Mode économie de batterie actif"
          title="Mode économie de batterie actif"
          data-testid="focus-bubble-perf-low"
        >
          <Zap size={10} className="text-slate-900" fill="currentColor" />
        </div>
      )}

      <a
        href="/#/focus"
        className={`flex items-center gap-2 pr-3 pl-2 rounded-full shadow-xl text-white font-semibold text-sm active:scale-95 transition-transform ${VERB_COLOR[reco.verb] || "bg-emerald-600"}`}
        style={{ minHeight: 48, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-testid="focus-bubble"
        aria-label={`Focus : ${VERB_LABEL[reco.verb]} ${reco.zoneName ?? ""}. Objectif du jour : ${Math.round(dailyProgress * 100)}%.`}
      >
        <div className="p-2 rounded-full bg-white/20">
          <Target size={16} />
        </div>
        <div className="flex flex-col items-start leading-tight">
          <span className="text-[10px] opacity-80 uppercase tracking-widest">Focus</span>
          <span className="truncate max-w-[9rem]">
            {VERB_LABEL[reco.verb]} {reco.zoneName ?? ""}
          </span>
        </div>
        <ChevronRight size={16} className="opacity-80" />
      </a>

      {/* Détail objectif journalier — affiché sur appui long, Vague 2 Feature 3 */}
      {showGoalDetail && (
        <div
          className="absolute right-0 top-full mt-2 w-52 rounded-lg bg-slate-900 text-white shadow-xl p-3 text-xs space-y-1 z-50"
          role="dialog"
          aria-label="Détail de l'objectif journalier"
          data-testid="focus-bubble-goal-detail"
          onClick={() => setShowGoalDetail(false)}
        >
          <p className="font-semibold text-sm">Objectif du jour</p>
          <p>
            {Math.round(dailyCurrentEuros)} € / {Math.round(dailyTarget)} €{" "}
            <span className="text-amber-400 font-semibold">({Math.round(dailyProgress * 100)}%)</span>
          </p>
          <p className="text-slate-300">
            🔥 Série : {streakDays} jour{streakDays > 1 ? "s" : ""} consécutif{streakDays > 1 ? "s" : ""}
          </p>
          <p className="text-[10px] text-slate-400 pt-1">Touchez pour fermer</p>
        </div>
      )}
    </div>
  );
}
