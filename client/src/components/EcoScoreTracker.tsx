/**
 * EcoScoreTracker — Composant headless montant le hook useEcoScore
 * (Vague 2 - Feature 8). Ne rend rien à l'écran ; sert uniquement à garder
 * les compteurs éco-conduite du jour à jour en tâche de fond, pour que
 * EndOfShiftModal (et de futurs écrans) puissent lire `vtc.eco.today` à jour.
 */
import { useEcoScore } from "@/hooks/useEcoScore";

export default function EcoScoreTracker() {
  useEcoScore();
  return null;
}
