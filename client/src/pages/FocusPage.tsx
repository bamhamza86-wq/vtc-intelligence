/**
 * FocusPage.tsx — Écran d'accueil « Focus » (Lot C)
 * ─────────────────────────────────────────────────────────────────────────────
 * Une seule mission à la fois, actions dans la zone du pouce, gros verbe,
 * haptique + voix française sur nouvelle recommandation.
 */
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowRight, Pause, Home as HomeIcon, MapPin, Timer, Euro, ShieldCheck, Zap } from "lucide-react";
import ShiftRhythm from "@/components/ShiftRhythm";
import StationOverlay from "@/components/StationOverlay";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { useSwipe } from "@/hooks/useSwipe";
import { API_BASE, getAuthToken } from "@/lib/queryClient";
import * as haptics from "@/lib/haptics";

// Voice module (Lot B) — import défensif, peut ne pas être présent en dev
async function tryVoice(text: string) {
  try {
    const mod = await import("@/lib/voice");
    if (mod?.speak) mod.speak(text, { priority: "high" });
  } catch {
    // silencieux
  }
}

type Verb = "aller" | "rester" | "pause" | "rentrer";

interface Alt {
  verb: string;
  zoneName: string;
  reasonShort: string;
}

interface FocusRecommendation {
  id: string;
  verb: Verb;
  zoneName: string;
  zoneId: string | null;
  distanceKm: number | null;
  etaMin: number | null;
  reasonShort: string;
  expectedGainEuros: number | null;
  confidence: number;
  validUntil: number;
  alternatives: Alt[];
}

const VERB_LABEL: Record<Verb, string> = {
  aller: "ALLER",
  rester: "RESTER",
  pause: "PAUSE",
  rentrer: "RENTRER",
};

const VERB_ICON: Record<Verb, React.ComponentType<{ className?: string }>> = {
  aller: ArrowRight,
  rester: MapPin,
  pause: Pause,
  rentrer: HomeIcon,
};

const VERB_COLOR: Record<Verb, string> = {
  aller: "from-blue-500 to-indigo-600",
  rester: "from-emerald-500 to-teal-600",
  pause: "from-amber-500 to-orange-600",
  rentrer: "from-slate-600 to-slate-800",
};

export default function FocusPage() {
  const { position } = useGpsPosition();
  const [, setLocation] = useLocation();
  const [showAlts, setShowAlts] = useState(false);
  const lastRecoId = useRef<string | null>(null);

  const { data: reco, isLoading } = useQuery<FocusRecommendation>({
    queryKey: ["focus-reco", position?.lat, position?.lng],
    queryFn: async () => {
      const token = getAuthToken();
      const params = position ? `?lat=${position.lat}&lng=${position.lng}` : "";
      const res = await fetch(`${API_BASE}/api/focus/recommendation${params}`, {
        headers: token ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token } : {},
      });
      if (!res.ok) throw new Error("focus fetch failed");
      return res.json();
    },
    staleTime: 25_000,
    refetchInterval: 30_000,
    enabled: !!position,
  });

  // Haptique + voix sur changement de recommandation avec confidence > 0.6
  useEffect(() => {
    if (!reco) return;
    if (reco.id === lastRecoId.current) return;
    lastRecoId.current = reco.id;
    if (reco.confidence > 0.6) {
      try { haptics.opportunity(); } catch { try { haptics.haptic("tap"); } catch {} }
      tryVoice(`${VERB_LABEL[reco.verb]} ${reco.zoneName}. ${reco.reasonShort}`);
    }
  }, [reco?.id]);

  // Swipe up = alternatives, swipe down = fermer
  const swipeRef = useRef<HTMLDivElement>(null);
  useSwipe(swipeRef as RefObject<HTMLDivElement>, {
    onSwipeUp: () => setShowAlts(true),
    onSwipeDown: () => setShowAlts(false),
  });

  const handleGo = () => {
    try { haptics.confirm(); } catch {}
    if (reco?.verb === "pause") {
      // Ouvre Google Maps aire de repos
      const url = position
        ? `https://www.google.com/maps/search/aire+de+repos/@${position.lat},${position.lng},13z`
        : "https://www.google.com/maps/search/aire+de+repos";
      window.open(url, "_blank");
      return;
    }
    if (reco?.verb === "aller" && reco.zoneName) {
      // Ouvre Google Maps navigation vers zone
      const q = encodeURIComponent(reco.zoneName + ", Île-de-France");
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`, "_blank");
      return;
    }
    // rester / rentrer → juste retour à la carte
    setLocation("/");
  };

  if (isLoading && !reco) {
    return (
      <div className="min-h-[calc(100vh-140px)] flex items-center justify-center text-slate-400">
        Analyse en cours…
      </div>
    );
  }

  if (!reco) {
    return (
      <div className="min-h-[calc(100vh-140px)] px-4 py-4 space-y-4">
        <ShiftRhythm />
        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-6 text-center text-slate-300">
          <p>En attente du GPS pour te recommander une action.</p>
        </div>
      </div>
    );
  }

  const VerbIcon = VERB_ICON[reco.verb];
  const gradient = VERB_COLOR[reco.verb];

  return (
    <div
      ref={swipeRef}
      className="min-h-[calc(100vh-140px)] px-3 pt-3 pb-6 flex flex-col gap-3 select-none"
    >
      {/* Rythme du shift en haut */}
      <ShiftRhythm />

      {/* Carte de mission — centre visuel */}
      <div className={`flex-1 rounded-3xl border border-white/10 bg-gradient-to-br ${gradient} p-5 text-white shadow-xl flex flex-col`}>
        <div className="flex items-center gap-2 text-white/80 text-sm">
          <VerbIcon className="w-4 h-4" />
          <span className="uppercase tracking-widest text-xs">Recommandation</span>
          <div className="ml-auto flex items-center gap-1 text-xs bg-white/15 rounded-full px-2 py-0.5">
            <ShieldCheck className="w-3 h-3" />
            {Math.round(reco.confidence * 100)}%
          </div>
        </div>

        <div className="mt-4">
          <div className="text-5xl md:text-6xl font-black leading-none tracking-tight">
            {VERB_LABEL[reco.verb]}
          </div>
          <div className="text-2xl md:text-3xl font-semibold mt-2">
            {reco.zoneName}
          </div>
          <p className="text-white/90 mt-3 text-base leading-snug">
            {reco.reasonShort}
          </p>
        </div>

        <div className="mt-auto pt-6 grid grid-cols-3 gap-2 text-sm">
          {reco.etaMin !== null && (
            <div className="bg-white/15 rounded-xl px-3 py-2 flex flex-col items-start">
              <div className="flex items-center gap-1 text-white/70 text-xs">
                <Timer className="w-3 h-3" /> ETA
              </div>
              <div className="font-bold text-lg">{reco.etaMin} min</div>
            </div>
          )}
          {reco.distanceKm !== null && (
            <div className="bg-white/15 rounded-xl px-3 py-2 flex flex-col items-start">
              <div className="flex items-center gap-1 text-white/70 text-xs">
                <MapPin className="w-3 h-3" /> Distance
              </div>
              <div className="font-bold text-lg">{reco.distanceKm} km</div>
            </div>
          )}
          {reco.expectedGainEuros !== null && (
            <div className="bg-white/15 rounded-xl px-3 py-2 flex flex-col items-start">
              <div className="flex items-center gap-1 text-white/70 text-xs">
                <Euro className="w-3 h-3" /> Gain estimé
              </div>
              <div className="font-bold text-lg">+{reco.expectedGainEuros}€</div>
            </div>
          )}
        </div>
      </div>

      {/* Actions primaires — zone du pouce */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={handleGo}
          className="tap-target rounded-2xl bg-white text-slate-900 font-bold text-lg py-4 shadow-lg active:scale-95 transition-transform"
          style={{ minHeight: 64 }}
          aria-label="Suivre cette recommandation"
        >
          {reco.verb === "pause" ? "Trouver une aire" : reco.verb === "rentrer" ? "Voir la carte" : "J'y vais"}
        </button>
        <button
          onClick={() => { try { haptics.haptic("tap"); } catch {}; setShowAlts((s) => !s); }}
          className="tap-target rounded-2xl border-2 border-white/20 bg-slate-900/50 text-white font-semibold text-lg py-4 active:scale-95 transition-transform"
          style={{ minHeight: 64 }}
          aria-label="Voir les alternatives"
          aria-expanded={showAlts}
        >
          Autre option
        </button>
      </div>

      {/* Alternatives (swipe up ou clic sur "Autre option") */}
      {showAlts && reco.alternatives.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/80 backdrop-blur p-3 space-y-2">
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Alternatives</div>
          {reco.alternatives.slice(0, 2).map((alt, i) => (
            <div key={i} className="flex items-start gap-3 p-2 rounded-xl bg-white/5">
              <Zap className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-white text-sm">
                  <span className="font-semibold uppercase text-xs text-slate-400">{alt.verb}</span>{" "}
                  <span className="font-semibold">{alt.zoneName}</span>
                </div>
                <div className="text-slate-300 text-sm">{alt.reasonShort}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Overlay gare/aéroport auto */}
      <StationOverlay />
    </div>
  );
}
