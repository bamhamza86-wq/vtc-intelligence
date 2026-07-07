/**
 * AirportQueueCard — Carte "File d'attente" communautaire aéroport
 * ─────────────────────────────────────────────────────────────────────────────
 * S'affiche dans FocusPage et MapPage lorsque le chauffeur est à moins de 2 km
 * d'un aéroport (CDG / Orly / Le Bourget). Propose de rejoindre la file
 * d'attente communautaire, affiche la position et l'estimation d'attente.
 * Bouton "Rejoindre la queue" ≥60px (tap target renforcé).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useGpsPosition } from "@/hooks/useGpsPosition";
import {
  findNearbyAirport,
  useAirportQueueStatus,
  useJoinAirportQueue,
  useLeaveAirportQueue,
} from "@/hooks/useAirportQueue";
import { Plane, Users, Clock, LogOut } from "lucide-react";
import { haptic } from "@/lib/haptics";
import { Link } from "wouter";

export default function AirportQueueCard() {
  const { position } = useGpsPosition();
  const nearby = findNearbyAirport(position.lat, position.lng);
  const { status } = useAirportQueueStatus();
  const joinMutation = useJoinAirportQueue();
  const leaveMutation = useLeaveAirportQueue();

  // Rien à afficher si aucun aéroport dans le rayon de 2km ET pas déjà en file ailleurs
  if (!nearby && !status.in_queue) return null;

  const airportCode = status.in_queue ? status.airport! : nearby!.code;
  const airportName = nearby?.name ?? (status.airport ? `Aéroport ${status.airport}` : "");

  const handleJoin = () => {
    haptic("tap");
    joinMutation.mutate({ airport: airportCode });
  };

  const handleLeave = () => {
    haptic("tap");
    leaveMutation.mutate();
  };

  return (
    <div
      className="rounded-2xl border-2 shadow-lg p-4"
      style={{
        background: "linear-gradient(135deg, rgba(99,102,241,0.18) 0%, rgba(79,70,229,0.15) 100%)",
        borderColor: "rgba(99,102,241,0.4)",
      }}
      data-testid="airport-queue-card"
    >
      <div className="flex items-center gap-2 mb-3">
        <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-200">
          <Plane size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-widest text-indigo-300/80 font-bold">
            File d'attente
          </div>
          <div className="text-white font-semibold text-sm">{airportName || airportCode}</div>
        </div>
      </div>

      {status.in_queue ? (
        <>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="rounded-lg bg-black/25 p-3">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-white/60 font-bold">
                <Users size={11} />
                <span>Ma position</span>
              </div>
              <div className="text-2xl font-bold text-white tabular-nums mt-1">
                {status.my_position} / {status.total_queue}
              </div>
            </div>
            <div className="rounded-lg bg-black/25 p-3">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-white/60 font-bold">
                <Clock size={11} />
                <span>Attente estimée</span>
              </div>
              <div className="text-2xl font-bold text-white tabular-nums mt-1">
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
            className="w-full flex items-center justify-center gap-2 rounded-xl font-bold text-white bg-white/10 hover:bg-white/20 active:scale-[0.98] transition"
            style={{ minHeight: 60 }}
            data-testid="btn-leave-queue"
          >
            <LogOut size={20} />
            Quitter la file
          </button>
        </>
      ) : (
        <button
          onClick={handleJoin}
          disabled={joinMutation.isPending}
          className="w-full flex items-center justify-center gap-2 rounded-xl font-bold text-white bg-indigo-500 hover:bg-indigo-400 active:scale-[0.98] transition text-lg"
          style={{ minHeight: 60 }}
          data-testid="btn-join-queue"
        >
          <Users size={22} />
          Rejoindre la queue
        </button>
      )}

      <Link
        href="/airport"
        className="block text-center text-xs text-indigo-300/80 mt-3 underline underline-offset-2"
      >
        Voir tous les aéroports
      </Link>
    </div>
  );
}
