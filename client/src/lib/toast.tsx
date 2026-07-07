/**
 * toast — Toast global léger avec Undo 5s (Vague 1 - Levier 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * API : import { toast } from '@/lib/toast'; toast.show({ msg, onUndo })
 * Un seul toast à la fois (le nouveau remplace l'ancien).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { Undo2, X } from "lucide-react";
import { shouldSuppressToast, type ToastKind } from "@/lib/silentMode";

interface ToastPayload {
  id: number;
  msg: string;
  onUndo?: () => void;
  durationMs?: number;
  /** Catégorie du toast — utilisée par le mode "silence total" pour filtrer
   *  tout sauf sos / fatigue_red / unprofitable_red (défaut : "generic"). */
  kind?: ToastKind;
}

type ToastFn = (p: Omit<ToastPayload, "id">) => void;

const ToastCtx = createContext<{ show: ToastFn } | null>(null);

let globalShow: ToastFn = () => {};

export const toast = {
  show: (p: Omit<ToastPayload, "id">) => globalShow(p),
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ToastPayload | null>(null);
  const timerRef = useRef<any>(null);

  const show = useCallback<ToastFn>((p) => {
    // Mode "silence total" — filtre tout toast non-critique (garde SOS,
    // fatigue rouge, course non-rentable rouge).
    if (shouldSuppressToast(p.kind)) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const t: ToastPayload = { id: Date.now(), ...p };
    setCurrent(t);
    timerRef.current = setTimeout(() => setCurrent(null), p.durationMs ?? 5000);
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
      {current && (
        <div
          className="fixed left-3 right-3 z-[60] rounded-xl bg-slate-900 text-white shadow-2xl border border-white/10 animate-slide-up"
          style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom, 0px))" }}
          role="status"
          aria-live="polite"
          data-testid="global-toast"
        >
          <div className="flex items-center gap-3 p-3">
            <div className="flex-1 min-w-0 text-sm">{current.msg}</div>
            {current.onUndo && (
              <button
                onClick={() => {
                  current.onUndo?.();
                  setCurrent(null);
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
              onClick={() => setCurrent(null)}
              className="p-2 rounded-lg hover:bg-white/10"
              style={{ minHeight: 40, minWidth: 40 }}
              aria-label="Fermer"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
