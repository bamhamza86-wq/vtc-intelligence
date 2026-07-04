/**
 * useFatigueCoach — Coach anti-fatigue vocal (Lot D)
 * ─────────────────────────────────────────────────────────────────────────────
 * Surveille la session de conduite et déclenche un rappel vocal fatigue :
 *   - 4h+ de conduite continue (règle légale)
 *   - Zones somnolence : 13h-15h et 2h-6h (creux circadiens)
 * Debounce 30 min via localStorage `vtc.fatigueCoach.lastTs`.
 * Expose `{ shouldShow, dismiss, reason }` pour l'UI (banner).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState, useCallback } from "react";
import { useDrivingSession } from "./useDrivingSession";
import { speak } from "@/lib/voice";
import { fatigue as fatigueHaptic } from "@/lib/haptics";

const LS_LAST_TS = "vtc.fatigueCoach.lastTs";
const DEBOUNCE_MS = 30 * 60 * 1000; // 30 min

export type FatigueReason = "hours" | "circadian_afternoon" | "circadian_night" | null;

function getLastTs(): number {
  try {
    const v = localStorage.getItem(LS_LAST_TS);
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

function setLastTs(ts: number) {
  try {
    localStorage.setItem(LS_LAST_TS, String(ts));
  } catch {
    // ignore
  }
}

function computeReason(hoursDriven: number, hour: number): FatigueReason {
  if (hoursDriven >= 4) return "hours";
  if (hour >= 13 && hour < 15) return "circadian_afternoon";
  if (hour >= 2 && hour < 6) return "circadian_night";
  return null;
}

function messageFor(reason: FatigueReason, hoursDriven: number): string {
  if (reason === "hours") {
    return `Vous conduisez depuis ${hoursDriven.toFixed(1)} heures. Une pause de 15 minutes est recommandée.`;
  }
  if (reason === "circadian_afternoon") {
    return "Zone de somnolence — creux de l'après-midi. Pensez à faire une pause café.";
  }
  if (reason === "circadian_night") {
    return "Nuit profonde — vigilance réduite. Prenez une pause dès que possible.";
  }
  return "";
}

export function useFatigueCoach() {
  const { hoursDriven } = useDrivingSession();
  const [shouldShow, setShouldShow] = useState(false);
  const [reason, setReason] = useState<FatigueReason>(null);

  useEffect(() => {
    const now = Date.now();
    const hour = new Date().getHours();
    const r = computeReason(hoursDriven, hour);

    if (!r) {
      setShouldShow(false);
      setReason(null);
      return;
    }

    // Debounce 30 min
    const last = getLastTs();
    if (now - last < DEBOUNCE_MS) {
      // Le banner reste visible si toujours actif, mais pas de nouvel appel vocal
      setReason(r);
      setShouldShow(true);
      return;
    }

    // Déclenchement : voix + haptique + banner
    const msg = messageFor(r, hoursDriven);
    speak(msg, { priority: "high" });
    fatigueHaptic();
    setLastTs(now);
    setReason(r);
    setShouldShow(true);
  }, [hoursDriven]);

  // Rafraîchit périodiquement pour capturer les créneaux horaires
  useEffect(() => {
    const id = setInterval(() => {
      const hour = new Date().getHours();
      const r = computeReason(hoursDriven, hour);
      setReason(r);
      setShouldShow(!!r);
    }, 60_000);
    return () => clearInterval(id);
  }, [hoursDriven]);

  const dismiss = useCallback(() => {
    setShouldShow(false);
    // Snooze 30 min : on met à jour lastTs pour bloquer les prochaines relances
    setLastTs(Date.now());
  }, []);

  return { shouldShow, dismiss, reason, hoursDriven };
}
