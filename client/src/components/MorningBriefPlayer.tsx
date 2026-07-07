/**
 * MorningBriefPlayer — Couche Wow Factor : brief vocal matinal
 * ─────────────────────────────────────────────────────────────────────────────
 * Bouton "Écouter" ≥60px, appelle GET /api/wow/morning-brief puis lit le texte
 * via window.speechSynthesis (voix française). Génération 100% déterministe
 * côté serveur — aucun appel LLM. Placé en haut de FocusPage.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Mic, Square, ChevronDown, ChevronUp } from "lucide-react";

interface MorningBrief {
  text: string;
  generated_at: string;
  word_count: number;
}

function speakFrench(text: string, onEnd: () => void) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    onEnd();
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "fr-FR";
  utter.rate = 1;
  const voices = window.speechSynthesis.getVoices();
  const frVoice = voices.find((v) => v.lang.startsWith("fr"));
  if (frVoice) utter.voice = frVoice;
  utter.onend = onEnd;
  utter.onerror = onEnd;
  window.speechSynthesis.speak(utter);
}

export function MorningBriefPlayer() {
  const [expanded, setExpanded] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const { data, refetch, isFetching } = useQuery<MorningBrief>({
    queryKey: ["/api/wow/morning-brief"],
    queryFn: () => apiRequest("GET", "/api/wow/morning-brief").then((r) => r.json()),
    staleTime: 30 * 60_000,
    enabled: false,
  });

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const handlePlay = async () => {
    if (speaking) {
      window.speechSynthesis?.cancel();
      setSpeaking(false);
      return;
    }
    let brief = data;
    if (!brief) {
      const res = await refetch();
      brief = res.data;
    }
    if (!brief?.text) return;
    setExpanded(true);
    setSpeaking(true);
    speakFrench(brief.text, () => setSpeaking(false));
  };

  return (
    <div className="rounded-2xl border border-cyan-400/30 bg-cyan-500/5" data-testid="morning-brief-player">
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={handlePlay}
          disabled={isFetching}
          className="tap-target shrink-0 rounded-full bg-cyan-500 text-white flex items-center justify-center active:scale-95 transition-transform shadow-lg disabled:opacity-60"
          style={{ minWidth: 60, minHeight: 60 }}
          aria-label={speaking ? "Arrêter le brief vocal" : "Écouter le brief vocal du matin"}
          data-testid="button-play-morning-brief"
        >
          {speaking ? <Square size={22} /> : <Mic size={24} />}
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white">Brief vocal du matin</p>
          <p className="text-xs text-cyan-200/80">
            {isFetching ? "Préparation…" : speaking ? "Lecture en cours…" : "Appuyez pour écouter votre point du jour"}
          </p>
        </div>
        {data?.text && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-2 text-cyan-200"
            aria-label="Afficher le texte du brief"
            data-testid="button-toggle-brief-text"
          >
            {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        )}
      </div>
      {expanded && data?.text && (
        <p className="px-4 pb-3 text-xs text-cyan-100/90 leading-relaxed" data-testid="text-morning-brief">
          {data.text}
        </p>
      )}
    </div>
  );
}

export default MorningBriefPlayer;
