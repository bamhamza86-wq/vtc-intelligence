/**
 * EndOfShiftModal — Rétrospective de fin de shift (Vague 2 - Feature 2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Détecte un shift actif (>= 6h d'activité) suivi d'un arrêt (>= 15 min) et
 * propose un bilan de la journée : heures conduites, nb courses, revenu total,
 * km parcourus, meilleure heure, top zone. Données via GET /api/rides
 * (filtrées sur la journée en cours côté client — pas d'endpoint /api/journal
 * dédié dans cette version du backend).
 * Inclut aussi le score éco-conduite du jour (Feature 8).
 * Max 1 affichage / jour (LS `vtc.shift.retro.day`).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { X, Clock, Euro, Route, TrendingUp, MapPin, Leaf } from "lucide-react";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { apiRequest } from "@/lib/queryClient";
import { useEcoScore } from "@/hooks/useEcoScore";
import { confirm as hapticConfirm } from "@/lib/haptics";

const LS_SHIFT_START = "vtc.shift.startTs";
const LS_SHIFT_ENDED = "vtc.shift.endedTs";
const LS_RETRO_DAY = "vtc.shift.retro.day";
const LS_LAST_ACTIVITY = "vtc.shift.lastActivityTs";

const SHIFT_MIN_HOURS = 6;
const STOP_MIN_MS = 15 * 60 * 1000; // 15 min
const SPEED_STOPPED_THRESHOLD = 5;
const CHECK_INTERVAL_MS = 30_000;

interface RideRow {
  timestamp: string;
  net_profit?: number;
  fare?: number;
  distance_km?: number;
  duration_min?: number;
  pickup_zone_id?: string;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isToday(iso: string): boolean {
  try {
    const d = new Date(iso);
    const ref = new Date();
    return (
      d.getFullYear() === ref.getFullYear() &&
      d.getMonth() === ref.getMonth() &&
      d.getDate() === ref.getDate()
    );
  } catch {
    return false;
  }
}

function getShiftStart(): number | null {
  try {
    const raw = localStorage.getItem(LS_SHIFT_START);
    if (!raw) return null;
    const ts = Number(raw);
    // Effacer si le shift a démarré un autre jour (passage minuit)
    const d = new Date(ts);
    const ref = new Date();
    if (d.getFullYear() !== ref.getFullYear() || d.getMonth() !== ref.getMonth() || d.getDate() !== ref.getDate()) {
      localStorage.removeItem(LS_SHIFT_START);
      return null;
    }
    return ts;
  } catch {
    return null;
  }
}

function markActivity(): void {
  const now = Date.now();
  try {
    localStorage.setItem(LS_LAST_ACTIVITY, String(now));
    if (!getShiftStart()) {
      localStorage.setItem(LS_SHIFT_START, String(now));
    }
  } catch {
    // ignore
  }
}

function getLastActivity(): number {
  try {
    const raw = localStorage.getItem(LS_LAST_ACTIVITY);
    return raw ? Number(raw) : Date.now();
  } catch {
    return Date.now();
  }
}

function hasShownToday(): boolean {
  try {
    return localStorage.getItem(LS_RETRO_DAY) === todayStr();
  } catch {
    return false;
  }
}

function markShownToday(): void {
  try {
    localStorage.setItem(LS_RETRO_DAY, todayStr());
  } catch {
    // ignore
  }
}

interface Retro {
  hoursDriven: number;
  coursesCount: number;
  revenue: number;
  km: number;
  bestHour: string;
  topZone: string;
}

function buildRetro(rides: RideRow[], shiftStartMs: number): Retro {
  const todayRides = rides.filter((r) => r.timestamp && isToday(r.timestamp));
  const revenue = todayRides.reduce((s, r) => s + (r.net_profit ?? r.fare ?? 0), 0);
  const km = todayRides.reduce((s, r) => s + (r.distance_km ?? 0), 0);
  const hoursDriven = Math.max(0, (Date.now() - shiftStartMs) / 3_600_000);

  // Meilleure heure : regrouper par heure de la journée, sommer le revenu
  const byHour: Record<number, number> = {};
  todayRides.forEach((r) => {
    const h = new Date(r.timestamp).getHours();
    byHour[h] = (byHour[h] ?? 0) + (r.net_profit ?? r.fare ?? 0);
  });
  let bestHour = "—";
  let bestHourVal = -Infinity;
  Object.entries(byHour).forEach(([h, v]) => {
    if (v > bestHourVal) {
      bestHourVal = v;
      bestHour = `${h}h-${Number(h) + 1}h`;
    }
  });

  // Top zone : zone de prise en charge la plus fréquente
  const byZone: Record<string, number> = {};
  todayRides.forEach((r) => {
    const z = r.pickup_zone_id ?? "?";
    byZone[z] = (byZone[z] ?? 0) + 1;
  });
  let topZone = "—";
  let topZoneCount = -1;
  Object.entries(byZone).forEach(([z, c]) => {
    if (c > topZoneCount) {
      topZoneCount = c;
      topZone = z;
    }
  });

  return {
    hoursDriven,
    coursesCount: todayRides.length,
    revenue,
    km,
    bestHour,
    topZone,
  };
}

// Expose une fonction globale pour marquer l'activité — appelée par d'autres
// hooks (dead-zone, drive page, etc.) sans dépendance circulaire.
export function markShiftActivity(): void {
  markActivity();
}

export default function EndOfShiftModal() {
  const { speedKmh } = useGpsPosition();
  const [open, setOpen] = useState(false);
  const [retro, setRetro] = useState<Retro | null>(null);
  const eco = useEcoScore();

  const stoppedSinceRef = useRef<number | null>(null);

  const checkTrigger = useCallback(async () => {
    if (hasShownToday()) return;
    if (open) return;

    const shiftStart = getShiftStart();
    if (!shiftStart) return;

    const hoursActive = (Date.now() - shiftStart) / 3_600_000;
    if (hoursActive < SHIFT_MIN_HOURS) return;

    if (speedKmh < SPEED_STOPPED_THRESHOLD) {
      if (stoppedSinceRef.current == null) {
        stoppedSinceRef.current = Date.now();
      }
      const stoppedMs = Date.now() - stoppedSinceRef.current;
      if (stoppedMs >= STOP_MIN_MS) {
        try {
          const res = await apiRequest("GET", "/api/rides");
          const rides: RideRow[] = await res.json();
          setRetro(buildRetro(rides, shiftStart));
          setOpen(true);
          markShownToday();
        } catch {
          // silencieux si l'API échoue
        }
      }
    } else {
      stoppedSinceRef.current = null;
    }
  }, [speedKmh, open, stoppedSinceRef]);

  useEffect(() => {
    // Marque l'activité initiale (première visite de la journée)
    markActivity();
    const id = setInterval(checkTrigger, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [checkTrigger]);

  function handleEnd() {
    hapticConfirm();
    try {
      localStorage.setItem(LS_SHIFT_ENDED, String(Date.now()));
    } catch {
      // ignore
    }
    setOpen(false);
  }

  function handleContinue() {
    hapticConfirm();
    setOpen(false);
  }

  if (!open || !retro) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Bilan de fin de journée"
      data-testid="end-of-shift-modal"
    >
      <div
        className="w-full sm:max-w-md bg-card text-card-foreground rounded-t-3xl sm:rounded-3xl shadow-2xl border border-card-border p-5"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Bilan de la journée</h2>
          <button
            onClick={handleContinue}
            aria-label="Fermer"
            className="p-2 rounded-lg hover:bg-accent"
            style={{ minHeight: 44, minWidth: 44 }}
          >
            <X size={20} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="rounded-2xl bg-accent/50 p-3 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-medium">
              <Clock size={14} /> Heures conduites
            </div>
            <div className="text-xl font-black tabular-nums">{retro.hoursDriven.toFixed(1)}h</div>
          </div>
          <div className="rounded-2xl bg-accent/50 p-3 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-medium">
              <Euro size={14} /> Revenu net
            </div>
            <div className="text-xl font-black tabular-nums">{Math.round(retro.revenue)}€</div>
          </div>
          <div className="rounded-2xl bg-accent/50 p-3 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-medium">
              <TrendingUp size={14} /> Courses
            </div>
            <div className="text-xl font-black tabular-nums">{retro.coursesCount}</div>
          </div>
          <div className="rounded-2xl bg-accent/50 p-3 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-medium">
              <Route size={14} /> Km parcourus
            </div>
            <div className="text-xl font-black tabular-nums">{Math.round(retro.km)} km</div>
          </div>
          <div className="rounded-2xl bg-accent/50 p-3 flex flex-col gap-1">
            <div className="text-muted-foreground text-xs font-medium">Meilleure heure</div>
            <div className="text-lg font-bold">{retro.bestHour}</div>
          </div>
          <div className="rounded-2xl bg-accent/50 p-3 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-medium">
              <MapPin size={14} /> Top zone
            </div>
            <div className="text-lg font-bold truncate">{retro.topZone}</div>
          </div>
        </div>

        {/* Feature 8 — éco-conduite */}
        <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-3 mb-4 flex items-center gap-3">
          <div className="p-2 rounded-full bg-emerald-500/20 shrink-0">
            <Leaf size={20} className="text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground font-medium">Éco-conduite</div>
            <div className="text-sm font-bold">
              Score {eco.score}/100 · {eco.co2Kg} kg CO₂ estimés
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleContinue}
            className="flex-1 rounded-2xl bg-secondary text-secondary-foreground font-semibold py-3"
            style={{ minHeight: 48 }}
            data-testid="button-shift-continue"
          >
            Continuer
          </button>
          <button
            onClick={handleEnd}
            className="flex-1 rounded-2xl bg-primary text-primary-foreground font-semibold py-3"
            style={{ minHeight: 48 }}
            data-testid="button-shift-end"
          >
            Terminer la journée
          </button>
        </div>
      </div>
    </div>
  );
}
