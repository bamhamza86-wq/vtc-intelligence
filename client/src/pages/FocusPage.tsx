/**
 * FocusPage.tsx — Écran d'accueil « Focus » (Lot C)
 * ─────────────────────────────────────────────────────────────────────────────
 * Une seule mission à la fois, actions dans la zone du pouce, gros verbe,
 * haptique + voix française sur nouvelle recommandation.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowRight, Pause, Home as HomeIcon, MapPin, Timer, Euro, ShieldCheck, Zap } from "lucide-react";
import ShiftRhythm from "@/components/ShiftRhythm";
import StationOverlay from "@/components/StationOverlay";
import AirportWaitCard from "@/components/AirportWaitCard";
import WeatherAlert from "@/components/WeatherAlert";
import FocusCountdown from "@/components/FocusCountdown";
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
  zoneId?: string | null;
  distanceKm?: number | null;
  etaMin?: number | null;
  expectedGainEuros?: number | null;
  confidence?: number;
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
  // Index de rotation : 0 = recommandation principale, 1..N = alternatives[i-1]
  const [altIndex, setAltIndex] = useState(0);
  const [isRotating, setIsRotating] = useState(false);
  const lastRecoId = useRef<string | null>(null);

  // Quantification GPS à ~110m pour la queryKey uniquement (pas pour l'API).
  // Évite qu'un micro-bruit GPS ne génère une nouvelle query → flicker.
  const roundedLat = useMemo(
    () => (position ? Math.round(position.lat * 1000) / 1000 : undefined),
    [position?.lat],
  );
  const roundedLng = useMemo(
    () => (position ? Math.round(position.lng * 1000) / 1000 : undefined),
    [position?.lng],
  );

  const { data: reco, isLoading } = useQuery<FocusRecommendation>({
    queryKey: ["focus-reco", roundedLat, roundedLng],
    placeholderData: keepPreviousData,
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
    // Nouvelle reco du serveur → on revient toujours à l'option principale
    // pour ne jamais afficher une alternative devenue périmée.
    setAltIndex(0);
    if (reco.confidence > 0.6) {
      try { haptics.opportunity(); } catch { try { haptics.haptic("tap"); } catch {} }
      tryVoice(`${VERB_LABEL[reco.verb]} ${reco.zoneName}. ${reco.reasonShort}`);
    }
  }, [reco?.id]);

  // Nombre total d'options disponibles pour la rotation (principale + alternatives)
  const totalOptions = reco ? 1 + reco.alternatives.length : 1;

  // Objet actuellement affiché dans la grande carte : la reco principale (index 0)
  // ou l'une des alternatives (index >= 1). Toujours dérivé de `reco`, jamais
  // un state séparé, pour rester en synchro avec le serveur et éviter le flicker.
  const displayed = useMemo(() => {
    if (!reco) return null;
    if (altIndex === 0 || !reco.alternatives[altIndex - 1]) {
      return {
        verb: reco.verb,
        zoneName: reco.zoneName,
        zoneId: reco.zoneId,
        distanceKm: reco.distanceKm,
        etaMin: reco.etaMin,
        reasonShort: reco.reasonShort,
        expectedGainEuros: reco.expectedGainEuros,
        confidence: reco.confidence,
        isAlternative: false,
      };
    }
    const alt = reco.alternatives[altIndex - 1];
    const altVerb = (alt.verb as Verb) in VERB_LABEL ? (alt.verb as Verb) : "aller";
    return {
      verb: altVerb,
      zoneName: alt.zoneName,
      zoneId: alt.zoneId ?? null,
      distanceKm: alt.distanceKm ?? null,
      etaMin: alt.etaMin ?? null,
      reasonShort: alt.reasonShort,
      expectedGainEuros: alt.expectedGainEuros ?? null,
      confidence: alt.confidence ?? reco.confidence,
      isAlternative: true,
    };
  }, [reco, altIndex]);

  const handleAlternative = () => {
    if (!reco || totalOptions <= 1) return;
    try { haptics.haptic("tap"); } catch {}
    setIsRotating(true);
    setAltIndex((i) => (i + 1) % totalOptions);
    // Petit délai pour donner un feedback visuel clair (spinner) sans flicker,
    // même si le changement est instantané côté client (pas d'appel réseau nécessaire
    // puisque les alternatives sont déjà incluses dans le payload initial).
    window.setTimeout(() => setIsRotating(false), 250);
  };

  // Swipe up = alternatives, swipe down = fermer
  const swipeRef = useRef<HTMLDivElement>(null);
  useSwipe(swipeRef as RefObject<HTMLDivElement>, {
    onSwipeUp: () => setShowAlts(true),
    onSwipeDown: () => setShowAlts(false),
  });

  const handleGo = () => {
    try { haptics.confirm(); } catch {}
    if (!displayed) return;
    if (displayed.verb === "pause") {
      // Ouvre Google Maps aire de repos
      const url = position
        ? `https://www.google.com/maps/search/aire+de+repos/@${position.lat},${position.lng},13z`
        : "https://www.google.com/maps/search/aire+de+repos";
      window.open(url, "_blank");
      return;
    }
    if (displayed.verb === "aller" && displayed.zoneName) {
      // Ouvre Google Maps navigation vers zone
      const q = encodeURIComponent(displayed.zoneName + ", Île-de-France");
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

  if (!displayed) return null;

  const VerbIcon = VERB_ICON[displayed.verb];
  const gradient = VERB_COLOR[displayed.verb];
  // Options restantes (hors celle actuellement affichée) pour le panneau "swipe up"
  const otherOptionsCount = Math.max(0, totalOptions - 1);

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
          {displayed.isAlternative && (
            <span className="text-[10px] font-semibold uppercase tracking-wide bg-white/20 rounded-full px-2 py-0.5">
              Alternative {altIndex}/{otherOptionsCount}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {!displayed.isAlternative && reco.validUntil && (
              <FocusCountdown key={reco.id} validUntil={reco.validUntil} />
            )}
            <div className="flex items-center gap-1 text-xs bg-white/15 rounded-full px-2 py-0.5">
              <ShieldCheck className="w-3 h-3" />
              {Math.round((displayed.confidence ?? 0) * 100)}%
            </div>
          </div>
        </div>

        <div className="mt-4">
          <div className="text-5xl md:text-6xl font-black leading-none tracking-tight">
            {VERB_LABEL[displayed.verb]}
          </div>
          <div className="text-2xl md:text-3xl font-semibold mt-2">
            {displayed.zoneName}
          </div>
          <p className="text-white/90 mt-3 text-base leading-snug">
            {displayed.reasonShort}
          </p>
        </div>

        <div className="mt-auto pt-6 grid grid-cols-3 gap-2 text-sm">
          {displayed.etaMin !== null && (
            <div className="bg-white/15 rounded-xl px-3 py-2 flex flex-col items-start">
              <div className="flex items-center gap-1 text-white/70 text-xs">
                <Timer className="w-3 h-3" /> ETA
              </div>
              <div className="font-bold text-lg">{displayed.etaMin} min</div>
            </div>
          )}
          {displayed.distanceKm !== null && (
            <div className="bg-white/15 rounded-xl px-3 py-2 flex flex-col items-start">
              <div className="flex items-center gap-1 text-white/70 text-xs">
                <MapPin className="w-3 h-3" /> Distance
              </div>
              <div className="font-bold text-lg">{displayed.distanceKm} km</div>
            </div>
          )}
          {displayed.expectedGainEuros !== null && (
            <div className="bg-white/15 rounded-xl px-3 py-2 flex flex-col items-start">
              <div className="flex items-center gap-1 text-white/70 text-xs">
                <Euro className="w-3 h-3" /> Gain estimé
              </div>
              <div className="font-bold text-lg">+{displayed.expectedGainEuros}€</div>
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
          {displayed.verb === "pause" ? "Trouver une aire" : displayed.verb === "rentrer" ? "Voir la carte" : "J'y vais"}
        </button>
        <button
          onClick={handleAlternative}
          disabled={isRotating || otherOptionsCount === 0}
          className="tap-target rounded-2xl border-2 border-white/20 bg-slate-900/50 text-white font-semibold text-lg py-4 active:scale-95 transition-transform disabled:opacity-60 disabled:active:scale-100 flex items-center justify-center gap-2"
          style={{ minHeight: 64 }}
          aria-label="Voir une autre option"
          aria-busy={isRotating}
        >
          {isRotating && (
            <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          )}
          Autre option
        </button>
      </div>

      {/* Liste des autres options restantes (swipe up ou état ouvert) — informatif, ne remplace pas le clic direct */}
      {showAlts && reco.alternatives.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/80 backdrop-blur p-3 space-y-2">
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Autres options</div>
          {[{ verb: reco.verb, zoneName: reco.zoneName, reasonShort: reco.reasonShort, key: -1 }, ...reco.alternatives.map((a, i) => ({ ...a, key: i }))]
            .filter((opt) => opt.zoneName !== displayed.zoneName)
            .slice(0, 2)
            .map((alt) => (
              <div key={alt.key} className="flex items-start gap-3 p-2 rounded-xl bg-white/5">
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
      <div className="space-y-3">
        <WeatherAlert />
        <AirportWaitCard />
      </div>
      <StationOverlay />
    </div>
  );
}
