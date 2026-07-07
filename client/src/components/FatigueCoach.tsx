/**
 * FatigueCoach — Bulle contextuelle discrète du coach anti-fatigue (Itération 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Complète FatigueBanner / FatigueCoachBanner existants avec un coach
 * CONVERSATIONNEL proactif basé sur le score de micro-sommeil comportemental
 * (rapport.md §5.2, §5.3, §5.7).
 *
 * Design : bulle discrète en bas à gauche (pour ne pas superposer FocusBubble
 * à droite), tutoiement chaleureux, jamais anxiogène. Ne s'affiche PAS :
 *   - en mode conduite actif (/drive) — le glancable existant (FatigueCoachBanner)
 *     couvre déjà ce cas avec un affichage adapté à la conduite
 *   - si le risque est très faible (rien à signaler, on ne dérange pas)
 *   - plus d'une fois toutes les 20 minutes (debounce localStorage)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { useHashLocation } from "wouter/use-hash-location";
import { useQuery } from "@tanstack/react-query";
import { Moon, X, Coffee } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { ls } from "@/lib/storage";

interface MicrosleepRisk {
  risk: number;
  indicators: string[];
  confidence: number;
  next_break_recommended_min: number;
}

interface CoachMessage {
  message_fr: string;
  urgency: "info" | "attention" | "urgent";
  action_fr: string;
  expected_gain_fr: string;
}

const LS_DISMISS_TS = "vtc.fatigueCoachBubble.dismissTs";
const DISMISS_COOLDOWN_MS = 20 * 60 * 1000; // 20 min

const URGENCY_STYLE: Record<CoachMessage["urgency"], { bg: string; border: string; text: string; icon: string }> = {
  info: { bg: "bg-slate-800/95", border: "border-slate-600", text: "text-slate-100", icon: "text-sky-300" },
  attention: { bg: "bg-amber-900/95", border: "border-amber-500", text: "text-amber-50", icon: "text-amber-300" },
  urgent: { bg: "bg-red-900/95", border: "border-red-500", text: "text-red-50", icon: "text-red-300" },
};

function getDismissTs(): number {
  try {
    return Number(ls.getItem(LS_DISMISS_TS) || 0);
  } catch {
    return 0;
  }
}

function setDismissTs(ts: number) {
  try {
    ls.setItem(LS_DISMISS_TS, String(ts));
  } catch {
    // ignore
  }
}

export default function FatigueCoach() {
  const [location] = useHashLocation();
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Ne jamais afficher en mode conduite actif — le glancable FatigueCoachBanner
  // gère déjà ce contexte avec un affichage optimisé pour la route.
  const isDriveMode = location === "/drive";

  const { data: risk } = useQuery<MicrosleepRisk>({
    queryKey: ["/api/fatigue/microsleep-risk"],
    queryFn: () => apiRequest("GET", "/api/fatigue/microsleep-risk").then((r) => r.json()),
    enabled: !isDriveMode,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: false,
  });

  const shouldFetchMessage = !isDriveMode && !!risk && risk.risk >= 0.25;
  const { data: coachMsg } = useQuery<CoachMessage>({
    queryKey: ["/api/fatigue/coach-message"],
    queryFn: () => apiRequest("GET", "/api/fatigue/coach-message").then((r) => r.json()),
    enabled: shouldFetchMessage,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    // Réinitialise l'état "dismissed" si le cooldown est passé, pour permettre
    // une nouvelle apparition (mais jamais plus fréquent que 20 min).
    const last = getDismissTs();
    if (Date.now() - last > DISMISS_COOLDOWN_MS) {
      setDismissed(false);
    }
  }, [risk?.risk]);

  if (isDriveMode) return null;
  if (!risk || risk.risk < 0.25) return null;
  if (!coachMsg) return null;
  if (dismissed) return null;

  const style = URGENCY_STYLE[coachMsg.urgency];

  function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    setDismissed(true);
    setExpanded(false);
    setDismissTs(Date.now());
  }

  return (
    <div
      className="fixed left-2 z-40"
      style={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))", maxWidth: "min(88vw, 22rem)" }}
      data-testid="fatigue-coach-bubble"
    >
      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          className={`flex items-center gap-2 rounded-full shadow-xl border ${style.bg} ${style.border} ${style.text} pl-3 pr-4 active:scale-95 transition-transform`}
          style={{ minHeight: 44 }}
          aria-label="Ouvrir le coach fatigue — un message t'attend"
          data-testid="button-open-fatigue-coach"
        >
          <Moon size={18} className={style.icon} />
          <span className="text-xs font-medium truncate max-w-[10rem]">Petit mot de ton coach fatigue</span>
        </button>
      ) : (
        <div
          className={`rounded-2xl shadow-2xl border ${style.bg} ${style.border} ${style.text} p-4`}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-full bg-white/10 shrink-0">
              <Moon size={18} className={style.icon} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm leading-snug">{coachMsg.message_fr}</p>
              <div className="mt-2 flex items-start gap-1.5 text-xs opacity-90">
                <Coffee size={14} className="shrink-0 mt-0.5" />
                <span>{coachMsg.action_fr}</span>
              </div>
              <p className="mt-1.5 text-[11px] opacity-70 italic">{coachMsg.expected_gain_fr}</p>
              <a
                href="/#/fatigue"
                className="inline-block mt-2 text-xs font-semibold underline decoration-white/40 hover:decoration-white"
                style={{ minHeight: 44, display: "inline-flex", alignItems: "center" }}
                data-testid="link-fatigue-page"
              >
                Voir ma courbe personnelle →
              </a>
            </div>
            <button
              onClick={handleDismiss}
              className="p-2 -mr-1 -mt-1 rounded-lg hover:bg-white/10 shrink-0"
              style={{ minWidth: 44, minHeight: 44 }}
              aria-label="Fermer le message du coach"
              data-testid="button-dismiss-fatigue-coach"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
