/**
 * CoachSidebar — Couche Décision Avancée : coach conversationnel VTC
 * ─────────────────────────────────────────────────────────────────────────────
 * Sidebar compacte : FAQ rapide (chips pré-remplies) + input libre →
 * POST /api/coach/ask (ou /api/coach/tax si le contexte fiscal est fourni).
 * Templates + regex mots-clés côté serveur (pas de LLM). Intégrée dans
 * EconomicsDashboard et TaxJournalPage.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MessageCircleQuestion, Send, ExternalLink } from "lucide-react";

interface CoachSource {
  label: string;
  url_or_data_ref: string;
}

interface CoachAnswer {
  answer_fr: string;
  sources: CoachSource[];
  confidence: number;
}

const FAQ_CHIPS = [
  "Franchise TVA, je suis proche ?",
  "Taux URSSAF micro-entrepreneur",
  "Barème indemnités kilométriques",
  "Micro-entreprise ou EI ?",
  "Commission Uber vs Bolt",
];

interface CoachSidebarProps {
  /** Si fourni, utilise /api/coach/tax avec ce contexte (ex: CA annuel connu) au lieu du coach générique */
  taxContext?: { ca_annuel?: number; activite_debut?: string };
  title?: string;
}

export function CoachSidebar({ taxContext, title = "Coach VTC" }: CoachSidebarProps) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<{ q: string; a: CoachAnswer }[]>([]);

  const mutation = useMutation({
    mutationFn: async (q: string) => {
      const endpoint = taxContext ? "/api/coach/tax" : "/api/coach/ask";
      const body = taxContext ? { question: q, context: taxContext } : { question: q };
      const res = await apiRequest("POST", endpoint, body);
      return (await res.json()) as CoachAnswer;
    },
    onSuccess: (data, q) => {
      setHistory((h) => [{ q, a: data }, ...h].slice(0, 5));
      setQuestion("");
    },
  });

  const ask = (q: string) => {
    if (!q.trim() || mutation.isPending) return;
    mutation.mutate(q);
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-3" data-testid="coach-sidebar">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <MessageCircleQuestion size={15} className="text-sky-400" />
        {title}
      </p>

      <div className="flex flex-wrap gap-1.5">
        {FAQ_CHIPS.map((chip) => (
          <button
            key={chip}
            onClick={() => ask(chip)}
            disabled={mutation.isPending}
            className="tap-target text-[11px] px-2.5 py-1.5 rounded-full border border-white/10 bg-slate-800/60 text-slate-300 hover:bg-slate-800 active:scale-95 transition-transform"
            style={{ minHeight: 32 }}
            data-testid={`chip-coach-${chip.slice(0, 10)}`}
          >
            {chip}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask(question)}
          placeholder="Posez votre question fiscale…"
          className="h-10 text-sm"
          data-testid="input-coach-question"
        />
        <Button
          size="icon"
          className="h-10 w-10 shrink-0"
          disabled={!question.trim() || mutation.isPending}
          onClick={() => ask(question)}
          data-testid="button-coach-ask"
        >
          <Send size={15} />
        </Button>
      </div>

      {mutation.isPending && <p className="text-xs text-slate-400 italic">Le coach réfléchit…</p>}

      <div className="space-y-2">
        {history.map((h, i) => (
          <div key={i} className="rounded-xl bg-slate-800/50 border border-white/5 p-3 text-sm" data-testid={`coach-answer-${i}`}>
            <p className="text-xs font-medium text-sky-300 mb-1">« {h.q} »</p>
            <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-line">{h.a.answer_fr}</p>
            {h.a.sources.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {h.a.sources.map((s, j) => (
                  <span key={j} className="text-[10px] text-slate-500 flex items-center gap-0.5">
                    <ExternalLink size={9} /> {s.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default CoachSidebar;
