/**
 * toast — Toast global avec stacking, icônes et swipe-to-dismiss (Polish itération 3)
 */
import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { Undo2, X, Info, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { shouldSuppressToast, type ToastKind as SilentToastKind } from "@/lib/silentMode";

export type ToastKind = "info" | "success" | "warning" | "error" | SilentToastKind;

interface ToastPayload {
  id: number;
  msg: string;
  onUndo?: () => void;
  durationMs?: number;
  /** Catégorie du toast — utilisée par le mode "silence total" */
  kind?: ToastKind;
}

type ToastFn = (p: Omit<ToastPayload, "id">) => void;

const ToastCtx = createContext<{ show: ToastFn } | null>(null);

let globalShow: ToastFn = () => {};

export const toast = {
  show: (p: Omit<ToastPayload, "id">) => globalShow(p),
};

const KIND_STYLES: Record<ToastKind, { bg: string; icon: typeof Info }> = {
  info: { bg: "bg-slate-900 dark:bg-surface-2 border-white/10", icon: Info },
  success: { bg: "bg-emerald-700 border-emerald-400/30", icon: CheckCircle2 },
  warning: { bg: "bg-amber-600 border-amber-300/30", icon: AlertTriangle },
  error: { bg: "bg-red-700 border-red-400/30", icon: XCircle },
};

function ToastCard({ t, onClose, index }: { t: ToastPayload; onClose: () => void; index: number }) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const timerRef = useRef<any>(null);

  useEffect(() => {
    timerRef.current = setTimeout(onClose, t.durationMs ?? 5000);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kind = (t.kind && (KIND_STYLES as any)[t.kind]) ? (t.kind as "info" | "success" | "warning" | "error") : "info";
  const { bg, icon: Icon } = KIND_STYLES[kind];

  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    setDragging(true);
    if (timerRef.current) clearTimeout(timerRef.current);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    setDragX(e.clientX - startX.current);
  }
  function onPointerUp() {
    setDragging(false);
    if (Math.abs(dragX) > 90) {
      onClose();
    } else {
      setDragX(0);
      timerRef.current = setTimeout(onClose, 2500);
    }
  }

  return (
    <div
      className={`pointer-events-auto rounded-xl text-white shadow-2xl border ${bg} animate-toast-in`}
      style={{
        transform: `translateX(${dragX}px)`,
        opacity: dragging ? Math.max(1 - Math.abs(dragX) / 200, 0.3) : 1,
        transition: dragging ? "none" : "transform 200ms ease, opacity 200ms ease",
        touchAction: "pan-y",
      }}
      role="status"
      aria-live="polite"
      data-testid={`global-toast-${index}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="flex items-center gap-3 p-3">
        <Icon size={18} className="shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0 text-sm">{t.msg}</div>
        {t.onUndo && (
          <button
            onClick={() => {
              t.onUndo?.();
              onClose();
            }}
            className="flex items-center gap-1 px-3 rounded-lg bg-white/15 hover:bg-white/25 font-semibold text-sm"
            style={{ minHeight: 40 }}
            data-testid="toast-undo"
          >
            <Undo2 size={14} />
            <span>Annuler</span>
          </button>
        )}
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-white/10"
          style={{ minHeight: 40, minWidth: 40 }}
          aria-label="Fermer"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ToastPayload[]>([]);

  const show = useCallback<ToastFn>((p) => {
    if (shouldSuppressToast(p.kind as any)) return;
    const t: ToastPayload = { id: Date.now() + Math.random(), ...p };
    setQueue((q) => [...q.slice(-2), t]); // max 3 empilés
  }, []);

  const close = useCallback((id: number) => {
    setQueue((q) => q.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    globalShow = show;
    return () => {
      globalShow = () => {};
    };
  }, [show]);

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div
        className="fixed left-3 right-3 z-[60] flex flex-col gap-2"
        style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom, 0px))" }}
      >
        {queue.map((t, i) => (
          <ToastCard key={t.id} t={t} index={i} onClose={() => close(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
