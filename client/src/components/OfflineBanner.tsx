// ──────────────────────────────────────────────────────────────────────────────
// OfflineBanner — Bandeau discret affiché en haut d'écran quand le réseau est
// indisponible (navigator.onLine === false). Affiche l'heure de dernière
// synchronisation connue pour rassurer le chauffeur sur la fraîcheur des données.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { queueLength, replayQueue } from "@/lib/queueOffline";

const LAST_ONLINE_KEY = "vtc.lastOnlineAt";

function readLastOnline(): number | null {
  try {
    const raw = localStorage.getItem(LAST_ONLINE_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function writeLastOnline(timestamp: number): void {
  try {
    localStorage.setItem(LAST_ONLINE_KEY, String(timestamp));
  } catch {
    // localStorage indisponible — on ignore silencieusement
  }
}

function formatHeure(timestamp: number | null): string {
  if (!timestamp) return "inconnue";
  const date = new Date(timestamp);
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// ──────────────────────────────────────────────────────────────────────────────
// Composant principal
// ──────────────────────────────────────────────────────────────────────────────
export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== "undefined" ? !navigator.onLine : false
  );
  const [lastOnlineAt, setLastOnlineAt] = useState<number | null>(readLastOnline);
  const [pending, setPending] = useState<number>(() => queueLength());

  useEffect(() => {
    // Si on démarre déjà en ligne, on marque tout de suite un point de sync.
    if (typeof navigator !== "undefined" && navigator.onLine) {
      const now = Date.now();
      writeLastOnline(now);
      setLastOnlineAt(now);
    }

    const handleOffline = () => {
      setIsOffline(true);
      setPending(queueLength());
    };

    const handleOnline = () => {
      const now = Date.now();
      writeLastOnline(now);
      setLastOnlineAt(now);
      setIsOffline(false);
      // Rejoue la file des requêtes en attente, puis met à jour le compteur affiché.
      replayQueue().finally(() => setPending(queueLength()));
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-amber-500 px-3 py-2 text-xs font-semibold text-slate-950 shadow-md sm:text-sm"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
    >
      <WifiOff size={16} className="shrink-0" aria-hidden />
      <span className="truncate">
        Hors ligne — dernière donnée : {formatHeure(lastOnlineAt)}.
        {pending > 0 ? ` ${pending} action${pending > 1 ? "s" : ""} mise${pending > 1 ? "s" : ""} en file.` : " Actions mises en file."}
      </span>
    </div>
  );
}

export default OfflineBanner;
