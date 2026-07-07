/**
 * ZoneChat — Couche Communautaire : signalement enrichi + fil des signaux
 * ─────────────────────────────────────────────────────────────────────────────
 * Remplace/étend ZoneSignalPanel : boutons contexte (surge/dead/traffic/event/
 * safety/wc/charging), champ commentaire court (<=60 car), et affichage des
 * 5 derniers signaux avec temps relatif + intensité.
 *
 * POST /api/zones/:id/signal { type, intensity, context, comment }
 * GET  /api/community/zones/:id/recent
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap, Ghost, Car, PartyPopper, ShieldAlert, Droplets, BatteryCharging, Users } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { haptic } from "@/lib/haptics";
import { toast } from "@/lib/toast";

export type SignalContext = "surge" | "dead" | "traffic" | "event" | "safety" | "wc" | "charging";

const CONTEXT_META: Record<SignalContext, { label: string; Icon: typeof Zap; type: "positive" | "negative"; cls: string }> = {
  surge:    { label: "Forte demande", Icon: Zap,            type: "positive", cls: "border-green-500/40 bg-green-500/10 text-green-500" },
  dead:     { label: "Zone morte",    Icon: Ghost,           type: "negative", cls: "border-gray-500/40 bg-gray-500/10 text-gray-400" },
  traffic:  { label: "Trafic dense",  Icon: Car,             type: "negative", cls: "border-orange-500/40 bg-orange-500/10 text-orange-400" },
  event:    { label: "Événement",     Icon: PartyPopper,     type: "positive", cls: "border-purple-500/40 bg-purple-500/10 text-purple-400" },
  safety:   { label: "Sécurité",      Icon: ShieldAlert,     type: "negative", cls: "border-red-500/40 bg-red-500/10 text-red-500" },
  wc:       { label: "WC",            Icon: Droplets,        type: "positive", cls: "border-sky-500/40 bg-sky-500/10 text-sky-400" },
  charging: { label: "Recharge",      Icon: BatteryCharging, type: "positive", cls: "border-yellow-500/40 bg-yellow-500/10 text-yellow-500" },
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return `il y a ${h}h`;
}

interface RecentSignal {
  id: number;
  signal_type: string;
  context: string;
  intensity: number;
  comment_short: string;
  timestamp: string;
  user_id: string;
  trust_level: string;
}

export interface ZoneChatProps {
  zoneId: string;
  compact?: boolean;
}

export function ZoneChat({ zoneId, compact = false }: ZoneChatProps) {
  const qc = useQueryClient();
  const [selectedContext, setSelectedContext] = useState<SignalContext | null>(null);
  const [intensity, setIntensity] = useState<number>(2);
  const [comment, setComment] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [sending, setSending] = useState(false);

  const { data } = useQuery<{ signals: RecentSignal[]; fresh_ratio: number }>({
    queryKey: ["/api/community/zones", zoneId, "recent"],
    queryFn: () => apiRequest("GET", `/api/community/zones/${zoneId}/recent?limit=5`).then((r) => r.json()),
    refetchInterval: 8_000,
  });

  const disabled = sending || Date.now() < cooldownUntil;

  const sendSignal = async (context: SignalContext) => {
    if (disabled) return;
    setSelectedContext(context);
    setSending(true);
    const meta = CONTEXT_META[context];
    haptic(meta.type === "positive" ? "success" : "warning");
    try {
      const res = await apiRequest("POST", `/api/zones/${zoneId}/signal`, {
        type: meta.type,
        intensity,
        context,
        comment: comment.slice(0, 60) || undefined,
      });
      const body = await res.json();
      setComment("");
      qc.invalidateQueries({ queryKey: ["/api/top-zones"] });
      qc.invalidateQueries({ queryKey: ["/api/community/impact"] });
      qc.invalidateQueries({ queryKey: ["/api/community/zones", zoneId, "recent"] });
      qc.invalidateQueries({ queryKey: ["/api/community/heatmap"] });
      qc.invalidateQueries({ queryKey: ["/api/community/avoid-zones"] });
      qc.invalidateQueries({ queryKey: ["/api/community/me/reputation"] });
      setCooldownUntil(Date.now() + 5 * 60 * 1000); // aligné rate-limit backend 5min
      toast.show({ msg: `Signal envoyé : ${meta.label}` });
    } catch (err: any) {
      // 429 explicite backend anti-troll
      const msg = String(err?.message || "");
      if (msg.startsWith("429")) {
        toast.show({ msg: "Trop de signalements sur cette zone — patientez un peu." });
      } else {
        toast.show({ msg: "Échec de l'envoi du signal." });
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-testid="zone-chat" className="mt-2 rounded-lg border border-primary/20 bg-muted/40 px-2 py-2">
      <p className="flex items-center gap-1 text-[10px] font-bold text-muted-foreground mb-1.5">
        <Users size={10} /> Signalement terrain
      </p>

      {/* Boutons contexte — grille 4 colonnes, tap targets ≥44px */}
      <div className="grid grid-cols-4 gap-1.5 mb-2">
        {(Object.keys(CONTEXT_META) as SignalContext[]).map((ctx) => {
          const meta = CONTEXT_META[ctx];
          const Icon = meta.Icon;
          const active = selectedContext === ctx;
          return (
            <button
              key={ctx}
              type="button"
              data-testid={`zonechat-context-${ctx}`}
              onClick={() => sendSignal(ctx)}
              disabled={disabled}
              aria-label={meta.label}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-lg border p-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${meta.cls} ${active ? "ring-2 ring-offset-1 ring-offset-background" : ""}`}
              style={{ minHeight: 44 }}
            >
              <Icon size={16} />
              <span className="text-[9px] font-semibold leading-tight text-center">{meta.label}</span>
            </button>
          );
        })}
      </div>

      {/* Intensité 1-3 */}
      {!compact && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] text-muted-foreground">Intensité :</span>
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              data-testid={`zonechat-intensity-${n}`}
              onClick={() => setIntensity(n)}
              className={`rounded-md border px-2 text-[10px] font-bold ${intensity === n ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground"}`}
              style={{ minHeight: 28 }}
            >
              {n}
            </button>
          ))}
        </div>
      )}

      {/* Commentaire court */}
      {!compact && (
        <input
          type="text"
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, 60))}
          placeholder="Commentaire court (facultatif)"
          maxLength={60}
          data-testid="zonechat-comment-input"
          className="w-full rounded-md border border-border bg-background px-2 py-2 text-xs mb-2"
          style={{ minHeight: 36 }}
        />
      )}

      {/* Fil des 5 derniers signaux */}
      {!!data?.signals?.length && (
        <ul className="space-y-1 border-t border-border/50 pt-1.5" data-testid="zonechat-recent-list">
          {data.signals.map((s) => {
            const meta = CONTEXT_META[(s.context as SignalContext) || "surge"] ?? CONTEXT_META.surge;
            return (
              <li key={s.id} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <meta.Icon size={10} className={meta.cls.split(" ").find((c) => c.startsWith("text-"))} />
                <span className="font-medium text-foreground">{meta.label}</span>
                {s.comment_short && <span className="italic truncate">"{s.comment_short}"</span>}
                <span className="ml-auto shrink-0 tabular-nums">{"●".repeat(s.intensity || 1)}</span>
                <span className="shrink-0">{relativeTime(s.timestamp)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default ZoneChat;
