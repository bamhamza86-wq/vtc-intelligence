/**
 * DeadZoneAlert — Composant headless montant le hook useDeadZoneAlert
 * (Vague 2 - Feature 1). Ne rend rien à l'écran ; l'alerte passe par
 * toast.show() + speak() depuis le hook.
 */
import { useDeadZoneAlert } from "@/hooks/useDeadZoneAlert";

export default function DeadZoneAlert() {
  useDeadZoneAlert();
  return null;
}
