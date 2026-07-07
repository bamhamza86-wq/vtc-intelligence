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
import { Target, ChevronRight } from "lucide-react";
import { API_BASE, getAuthToken } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";

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
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dy = e.clientY - dragRef.current.startY;
    const next = Math.max(80, Math.min(window.innerHeight - 200, dragRef.current.startPos + dy));
    setYPos(next);
  }
  function onPointerUp() {
    dragRef.current = null;
  }

  return (
    <a
      href="/#/focus"
      className={`fixed right-2 z-40 flex items-center gap-2 pr-3 pl-2 rounded-full shadow-xl text-white font-semibold text-sm active:scale-95 transition-transform ${VERB_COLOR[reco.verb] || "bg-emerald-600"}`}
      style={{ top: yPos, minHeight: 48, touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-testid="focus-bubble"
      aria-label={`Focus : ${VERB_LABEL[reco.verb]} ${reco.zoneName ?? ""}`}
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
  );
}
