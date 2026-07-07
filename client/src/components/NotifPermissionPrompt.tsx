/**
 * NotifPermissionPrompt — Demande de permission notifications (rapport.md §10.9)
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiché dans ProfilePage si la permission Notification est "default" (jamais
 * demandée) ou "denied" (refusée). Explique clairement l'usage (RGPD) avant
 * de déclencher la demande native du navigateur — jamais de demande surprise
 * au chargement de l'app.
 *
 * Utilise la Notification API native — ZÉRO dépendance npm.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { Bell, BellRing, ShieldCheck, Info } from "lucide-react";

type PermState = "default" | "granted" | "denied" | "unsupported";

function readPermission(): PermState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as PermState;
}

export function NotifPermissionPrompt() {
  const [perm, setPerm] = useState<PermState>("default");

  useEffect(() => {
    setPerm(readPermission());
  }, []);

  async function requestPermission() {
    if (!("Notification" in window)) return;
    try {
      const result = await Notification.requestPermission();
      setPerm(result as PermState);
    } catch {
      // Ignoré — certains navigateurs (iOS Safari PWA non installée) ne supportent pas l'API
    }
  }

  if (perm === "unsupported") {
    return null;
  }

  if (perm === "granted") {
    return (
      <div
        className="flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3"
        data-testid="notif-permission-granted"
      >
        <ShieldCheck size={18} className="text-emerald-400 shrink-0" />
        <div>
          <div className="text-sm font-medium">Notifications activées</div>
          <div className="text-[11px] text-muted-foreground">
            Vous recevrez les alertes importantes (rentabilité, sécurité, résumés).
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-border bg-card p-4"
      data-testid="notif-permission-prompt"
    >
      <div className="flex items-start gap-2.5 mb-3">
        <BellRing size={18} className="text-primary shrink-0 mt-0.5" />
        <div>
          <div className="text-sm font-medium mb-1">
            {perm === "denied" ? "Notifications bloquées" : "Activer les notifications ?"}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {perm === "denied" ? (
              <>
                Vous avez précédemment refusé les notifications. Pour les réactiver, modifiez les
                réglages du site dans votre navigateur (icône cadenas dans la barre d'adresse).
              </>
            ) : (
              <>
                Recevez des résumés glancables (gains du jour, alertes de zone) sans avoir à ouvrir
                l'application. Vous pouvez désactiver à tout moment depuis votre navigateur.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 mb-3">
        <Info size={13} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          RGPD : aucune donnée personnelle n'est partagée avec un tiers pour l'envoi de ces
          notifications. Elles restent strictement fonctionnelles (rappels, alertes, résumés).
        </p>
      </div>

      {perm !== "denied" && (
        <button
          type="button"
          onClick={requestPermission}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground font-semibold text-sm py-2.5 hover:opacity-90 transition-opacity"
          style={{ minHeight: 44 }}
          data-testid="button-notif-permission-request"
        >
          <Bell size={15} />
          Activer les notifications
        </button>
      )}
    </div>
  );
}

export default NotifPermissionPrompt;
