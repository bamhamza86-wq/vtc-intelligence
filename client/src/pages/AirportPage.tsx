/**
 * AirportPage.tsx — Écran "Aéroports" (/#/airport)
 * ─────────────────────────────────────────────────────────────────────────────
 * 3 onglets CDG / Orly / Le Bourget. Chaque onglet affiche :
 *   - Ma position dans la queue + temps d'attente estimé
 *   - Bouton "Rejoindre la queue" (grand, ≥60px)
 *   - Timer priorité 10 min si actif
 *   - Prochains vols majeurs (via /api/flights existant)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plane, Users, Clock, PlaneTakeoff, PlaneLanding } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { haptic } from "@/lib/haptics";
import {
  useAirportQueueStatus,
  useJoinAirportQueue,
  useLeaveAirportQueue,
  type AirportCode,
} from "@/hooks/useAirportQueue";
import PriorityTimer from "@/components/PriorityTimer";

interface FlightStatsRaw {
  airport: "CDG" | "ORLY";
  arrivals_next_hour: number;
  departures_next_hour: number;
  total_active: number;
  peak_level: "low" | "medium" | "high" | "surge";
  vtc_demand_boost: number;
  next_wave_eta?: string;
  passenger_volume_estimate: number;
}

interface FlightDataRaw {
  cdg: FlightStatsRaw;
  orly: FlightStatsRaw;
  flights: any[];
  source: string;
}

const TABS: { code: AirportCode; label: string; fullName: string }[] = [
  { code: "CDG", label: "CDG", fullName: "Roissy — Charles de Gaulle" },
  { code: "ORY", label: "Orly", fullName: "Orly" },
  { code: "LBG", label: "Le Bourget", fullName: "Le Bourget" },
];

const PEAK_LABEL: Record<string, string> = {
  low: "Calme",
  medium: "Modéré",
  high: "Élevé",
  surge: "Pic",
};

const PEAK_COLOR: Record<string, string> = {
  low: "#6b7280",
  medium: "#fbbf24",
  high: "#f97316",
  surge: "#ef4444",
};

function useFlightData() {
  return useQuery<FlightDataRaw>({
    queryKey: ["/api/flights"],
    queryFn: () => apiRequest("GET", "/api/flights").then((r) => r.json()),
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 1,
  });
}

export default function AirportPage() {
  const [activeTab, setActiveTab] = useState<AirportCode>("CDG");
  const { status } = useAirportQueueStatus();
  const joinMutation = useJoinAirportQueue();
  const leaveMutation = useLeaveAirportQueue();
  const { data: flightData, isLoading: flightsLoading } = useFlightData();

  const stats: FlightStatsRaw | null =
    activeTab === "CDG" ? flightData?.cdg ?? null : activeTab === "ORY" ? flightData?.orly ?? null : null;

  const isInThisQueue = status.in_queue && status.airport === activeTab;

  const handleJoin = () => {
    haptic("tap");
    joinMutation.mutate({ airport: activeTab });
  };

  const handleLeave = () => {
    haptic("tap");
    leaveMutation.mutate();
  };

  return (
    <div className="min-h-[calc(100vh-140px)] px-4 py-4 space-y-4" data-testid="airport-page">
      <div className="flex items-center gap-2">
        <Plane size={22} className="text-indigo-300" />
        <h1 className="text-xl font-bold text-white">Aéroports</h1>
      </div>

      {/* ── Onglets CDG / Orly / Le Bourget ─────────────────────────────── */}
      <div className="flex gap-2" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.code}
            role="tab"
            aria-selected={activeTab === tab.code}
            onClick={() => {
              haptic("tap");
              setActiveTab(tab.code);
            }}
            className={`flex-1 rounded-xl font-bold text-sm transition ${
              activeTab === tab.code
                ? "bg-indigo-500 text-white"
                : "bg-white/5 text-white/60 hover:bg-white/10"
            }`}
            style={{ minHeight: 48 }}
            data-testid={`airport-tab-${tab.code}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="text-sm text-white/50">
        {TABS.find((t) => t.code === activeTab)?.fullName}
      </div>

      {/* ── Timer priorité si actif pour cet aéroport ───────────────────── */}
      <PriorityTimer />

      {/* ── Ma position dans la queue + temps d'attente ─────────────────── */}
      <div
        className="rounded-2xl border-2 shadow-lg p-4"
        style={{
          background: "linear-gradient(135deg, rgba(99,102,241,0.18) 0%, rgba(79,70,229,0.15) 100%)",
          borderColor: "rgba(99,102,241,0.4)",
        }}
      >
        <div className="flex items-center gap-2 mb-3">
          <Users size={18} className="text-indigo-200" />
          <h2 className="text-sm font-bold text-white uppercase tracking-wide">
            File d'attente communautaire
          </h2>
        </div>

        {isInThisQueue ? (
          <>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="rounded-lg bg-black/25 p-3">
                <div className="text-[10px] uppercase tracking-widest text-white/60 font-bold">
                  Ma position
                </div>
                <div className="text-3xl font-bold text-white tabular-nums mt-1" data-testid="queue-my-position">
                  {status.my_position} / {status.total_queue}
                </div>
              </div>
              <div className="rounded-lg bg-black/25 p-3">
                <div className="text-[10px] uppercase tracking-widest text-white/60 font-bold">
                  Attente estimée
                </div>
                <div className="text-3xl font-bold text-white tabular-nums mt-1" data-testid="queue-wait-estimate">
                  {status.wait_min_estimated != null ? `${status.wait_min_estimated} min` : "—"}
                </div>
              </div>
            </div>
            {status.detail_fr && (
              <p className="text-xs text-white/60 mb-3 leading-relaxed">{status.detail_fr}</p>
            )}
            <button
              onClick={handleLeave}
              disabled={leaveMutation.isPending}
              className="w-full rounded-xl font-bold text-white bg-white/10 hover:bg-white/20 active:scale-[0.98] transition"
              style={{ minHeight: 60 }}
              data-testid="btn-leave-queue-page"
            >
              Quitter la file
            </button>
          </>
        ) : (
          <button
            onClick={handleJoin}
            disabled={joinMutation.isPending}
            className="w-full flex items-center justify-center gap-2 rounded-xl font-bold text-white bg-indigo-500 hover:bg-indigo-400 active:scale-[0.98] transition text-lg"
            style={{ minHeight: 60 }}
            data-testid="btn-join-queue-page"
          >
            <Users size={22} />
            Rejoindre la queue
          </button>
        )}
      </div>

      {/* ── Prochains vols majeurs ───────────────────────────────────────── */}
      {activeTab !== "LBG" && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
          <h2 className="text-sm font-bold text-white uppercase tracking-wide mb-3">
            Vols — prochaine heure
          </h2>
          {flightsLoading ? (
            <div className="h-16 animate-pulse bg-white/5 rounded-lg" />
          ) : stats ? (
            <>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className="rounded-lg bg-white/5 p-3 flex items-center gap-2">
                  <PlaneLanding size={18} className="text-sky-300" />
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold">
                      Arrivées
                    </div>
                    <div className="text-xl font-bold text-white tabular-nums">
                      {stats.arrivals_next_hour}
                    </div>
                  </div>
                </div>
                <div className="rounded-lg bg-white/5 p-3 flex items-center gap-2">
                  <PlaneTakeoff size={18} className="text-orange-300" />
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold">
                      Départs
                    </div>
                    <div className="text-xl font-bold text-white tabular-nums">
                      {stats.departures_next_hour}
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/60">Niveau de trafic</span>
                <span className="font-bold" style={{ color: PEAK_COLOR[stats.peak_level] }}>
                  {PEAK_LABEL[stats.peak_level]}
                </span>
              </div>
              {stats.next_wave_eta && (
                <div className="flex items-center gap-1.5 text-xs text-white/50 mt-2">
                  <Clock size={12} />
                  Prochaine vague : {new Date(stats.next_wave_eta).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-white/50">Données vols indisponibles</div>
          )}
        </div>
      )}

      {activeTab === "LBG" && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4 text-sm text-white/60">
          Le Bourget — trafic aviation d'affaires, pas de suivi vols commerciaux temps réel.
        </div>
      )}
    </div>
  );
}
