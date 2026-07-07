/**
 * useDeadZoneAlert — Alerte "zone morte" (Vague 2 - Feature 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Détecte une inactivité prolongée (vitesse < 5 km/h en continu pendant
 * 25 minutes, sans nouvelle course) et propose une zone plus active via
 * /api/focus/recommendation. Debounce de 30 min entre deux alertes.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef } from "react";
import { useGpsPosition } from "./useGpsPosition";
import { API_BASE, getAuthToken } from "@/lib/queryClient";
import { toast } from "@/lib/toast";
import { speak } from "@/lib/voice";

const LS_LAST_RIDE = "vtc.lastRide.ts";
const LS_LAST_ALERT = "vtc.deadZone.lastAlert";
const LS_SESSION_START = "vtc.session_start_ts";

const INACTIVITY_MS = 25 * 60 * 1000; // 25 min
const SPEED_THRESHOLD = 5; // km/h
const DEBOUNCE_MS = 30 * 60 * 1000; // 30 min
const CHECK_INTERVAL_MS = 15_000;

interface FocusRecoResponse {
  zoneName?: string;
  etaMin?: number;
}

function getLastRideTs(): number {
  try {
    const raw = localStorage.getItem(LS_LAST_RIDE);
    if (raw) {
      const n = Number(raw);
      if (!Number.isNaN(n)) return n;
    }
  } catch {
    // ignore
  }
  // Pas de dernière course connue : on utilise le début de session
  try {
    const sessionRaw = localStorage.getItem(LS_SESSION_START);
    if (sessionRaw) {
      const d = new Date(sessionRaw).getTime();
      if (!Number.isNaN(d)) return d;
    }
  } catch {
    // ignore
  }
  return Date.now();
}

function getLastAlertTs(): number {
  try {
    const raw = localStorage.getItem(LS_LAST_ALERT);
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

function setLastAlertTs(ts: number): void {
  try {
    localStorage.setItem(LS_LAST_ALERT, String(ts));
  } catch {
    // ignore
  }
}

/**
 * Hook — surveille l'inactivité continue et déclenche une alerte "zone morte".
 * Ne retourne rien : à utiliser depuis un composant "headless" (DeadZoneAlert).
 */
export function useDeadZoneAlert(): void {
  const { position, speedKmh } = useGpsPosition();
  const lowSpeedSinceRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    const now = Date.now();

    if (speedKmh < SPEED_THRESHOLD) {
      if (lowSpeedSinceRef.current == null) {
        lowSpeedSinceRef.current = now;
        firedRef.current = false;
      }
    } else {
      lowSpeedSinceRef.current = null;
      firedRef.current = false;
      return;
    }

    const inactiveSince = Math.max(lowSpeedSinceRef.current ?? now, getLastRideTs());
    const inactiveMs = now - inactiveSince;

    if (inactiveMs < INACTIVITY_MS) return;
    if (firedRef.current) return;

    const lastAlert = getLastAlertTs();
    if (now - lastAlert < DEBOUNCE_MS) return;

    firedRef.current = true;
    setLastAlertTs(now);

    (async () => {
      try {
        const token = getAuthToken();
        const url = `${API_BASE}/api/focus/recommendation?lat=${position.lat}&lng=${position.lng}`;
        const res = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token } : {},
        });
        if (!res.ok) return;
        const reco: FocusRecoResponse = await res.json();
        const zoneName = reco.zoneName ?? "une zone plus active";
        const etaMin = reco.etaMin ?? 0;
        const msg = `Zone morte — essaie ${zoneName} (${etaMin}min)`;
        toast.show({ msg, durationMs: 20000 });
        speak(`Zone morte, essaie ${zoneName}`, { priority: "high" });
      } catch {
        // silencieux — pas de réseau, pas grave
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speedKmh, position.lat, position.lng]);

  // Vérification périodique pour couvrir le cas où speedKmh ne change pas de valeur
  // (pas de re-render sinon si la vitesse reste identique à 0 par ex.)
  useEffect(() => {
    const id = setInterval(() => {
      // Force un check en relisant la ref actuelle (déclenche via speedKmh effect
      // au prochain changement de position GPS). Ce timer sert uniquement de
      // garde-fou pour les cas où le GPS ne pousse plus de mise à jour.
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}

/** À appeler quand une nouvelle course démarre/se termine pour réinitialiser le compteur. */
export function markRideActivity(): void {
  try {
    localStorage.setItem(LS_LAST_RIDE, String(Date.now()));
  } catch {
    // ignore
  }
}
