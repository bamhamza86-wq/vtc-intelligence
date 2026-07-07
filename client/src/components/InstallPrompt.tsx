// ──────────────────────────────────────────────────────────────────────────────
// InstallPrompt — Bandeau discret d'installation PWA
// ──────────────────────────────────────────────────────────────────────────────
// S'affiche en bas d'écran uniquement si :
//  - l'événement `beforeinstallprompt` a été capturé (Chrome/Edge/Android) ET
//  - l'app n'est pas déjà installée (mode standalone) ET
//  - l'utilisateur n'a pas fermé le bandeau au cours des 30 derniers jours.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { ls } from "@/lib/storage";
import {
  isInstallAvailable,
  isStandalone,
  onInstallAvailabilityChange,
  promptInstall,
} from "@/lib/pwa";

const DISMISS_KEY = "vtc.installPrompt.dismissedUntil";
const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const until = Number(raw);
    if (Number.isNaN(until)) return false;
    return Date.now() < until;
  } catch {
    return false;
  }
}

function dismissFor30Days(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DURATION_MS));
  } catch {
    // localStorage indisponible (mode privé strict) — on ignore silencieusement
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Composant principal
// ──────────────────────────────────────────────────────────────────────────────
export function InstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    // État initial : disponible + pas déjà installée + pas dismiss récemment.
    const evaluate = (available: boolean) => {
      if (available && !isStandalone() && !isDismissed()) {
        setVisible(true);
      } else if (!available) {
        setVisible(false);
      }
    };

    evaluate(isInstallAvailable());
    const unsubscribe = onInstallAvailabilityChange(evaluate);
    return unsubscribe;
  }, []);

  if (!visible) return null;

  const handleInstall = async () => {
    setInstalling(true);
    const outcome = await promptInstall();
    setInstalling(false);
    if (outcome !== "unavailable") {
      setVisible(false);
    }
  };

  const handleDismiss = () => {
    dismissFor30Days();
    setVisible(false);
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 flex items-center gap-3 border-t border-white/10 bg-slate-900/95 px-4 py-3 text-white shadow-[0_-4px_16px_rgba(0,0,0,0.35)] backdrop-blur-sm sm:bottom-4 sm:left-1/2 sm:right-auto sm:w-[420px] sm:-translate-x-1/2 sm:rounded-2xl sm:border"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      role="dialog"
      aria-label="Proposition d'installation de l'application"
      data-testid="install-prompt-banner"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#ff6b2b]/15">
        <Download size={20} className="text-[#ff6b2b]" aria-hidden />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">Installer VTC Intelligence</p>
        <p className="truncate text-xs text-slate-300">
          Accès rapide hors ligne, plein écran, sans navigateur.
        </p>
      </div>

      <button
        type="button"
        onClick={handleInstall}
        disabled={installing}
        className="shrink-0 rounded-xl bg-[#ff6b2b] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#ff8a4c] active:bg-[#e65f26] disabled:opacity-60"
        style={{ minHeight: "44px" }}
        data-testid="install-prompt-confirm"
      >
        {installing ? "Installation…" : "Installer"}
      </button>

      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Fermer et ne plus proposer l'installation pendant 30 jours"
        className="shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
        style={{ minWidth: "44px", minHeight: "44px" }}
        data-testid="install-prompt-dismiss"
      >
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}

export default InstallPrompt;
