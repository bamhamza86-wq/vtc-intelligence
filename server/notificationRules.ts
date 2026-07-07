/**
 * notificationRules.ts — Couche « Délivrance intelligente des notifications » (rapport.md §21)
 * ─────────────────────────────────────────────────────────────────────────────
 * Implémente :
 *   21.1 Notifications adaptatives — jamais de notification non urgente pendant
 *        la conduite (seuil DRIVE_ENTER_KMH=20, cohérent avec Layout.tsx côté client)
 *   21.2 Digest notifications — regroupe les alertes non-urgentes en un résumé
 *        périodique plutôt que de spammer en temps réel
 *   21.5 Préférences notifications par catégorie — table notification_prefs
 *        (activation/désactivation fine par type d'alerte)
 *
 * ZÉRO nouvelle dépendance npm. Additive uniquement.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sqlite, storage } from "./storage";

const DEFAULT_USER_ID = "driver_default";

// Seuil identique à client/src/components/Layout.tsx (DRIVE_ENTER_KMH)
const DRIVE_ENTER_KMH = 20;

// Catégories de notification connues (mappées depuis alerts.type existants + nouvelles catégories)
export const NOTIFICATION_CATEGORIES = [
  "opportunity", // zone chaude, pic de demande
  "safety", // fatigue, sécurité — TOUJOURS délivré même en conduite
  "financial", // achievements, objectifs, défis
  "record_hunt", // proche d'un record personnel
  "system", // maintenance, informations générales
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

const CATEGORY_LABELS_FR: Record<NotificationCategory, string> = {
  opportunity: "Opportunités (zones, pics de demande)",
  safety: "Sécurité & fatigue",
  financial: "Finances (objectifs, défis, achievements)",
  record_hunt: "Chasse aux records personnels",
  system: "Système & informations générales",
};

// ═════════════════════════════════════════════════════════════════════════════
// Schéma DB
// ═════════════════════════════════════════════════════════════════════════════

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    digest_only INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, category)
  );
`);

function ensureDefaultPrefs(userId: string = DEFAULT_USER_ID): void {
  for (const cat of NOTIFICATION_CATEGORIES) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO notification_prefs (user_id, category, enabled, digest_only, updated_at)
         VALUES (?,?,1,0,?)`
      )
      .run(userId, cat, new Date().toISOString());
  }
}

export interface NotificationPref {
  category: NotificationCategory;
  label_fr: string;
  enabled: boolean;
  digest_only: boolean;
}

export function getNotificationPrefs(userId: string = DEFAULT_USER_ID): NotificationPref[] {
  ensureDefaultPrefs(userId);
  const rows = sqlite.prepare("SELECT * FROM notification_prefs WHERE user_id=?").all(userId) as any[];
  return NOTIFICATION_CATEGORIES.map((cat) => {
    const row = rows.find((r) => r.category === cat);
    return {
      category: cat,
      label_fr: CATEGORY_LABELS_FR[cat],
      enabled: row ? !!row.enabled : true,
      digest_only: row ? !!row.digest_only : false,
    };
  });
}

export function setNotificationPref(
  category: NotificationCategory,
  enabled: boolean,
  digestOnly: boolean,
  userId: string = DEFAULT_USER_ID
): NotificationPref {
  ensureDefaultPrefs(userId);
  sqlite
    .prepare(
      `UPDATE notification_prefs SET enabled=?, digest_only=?, updated_at=? WHERE user_id=? AND category=?`
    )
    .run(enabled ? 1 : 0, digestOnly ? 1 : 0, new Date().toISOString(), userId, category);
  return {
    category,
    label_fr: CATEGORY_LABELS_FR[category],
    enabled,
    digest_only: digestOnly,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 21.1 — Règle de délivrance adaptative ("jamais en conduite" sauf sécurité)
// ═════════════════════════════════════════════════════════════════════════════

/** Déduit la catégorie d'une alerte à partir de son `type` existant (alerts.type). */
export function inferCategory(alertType: string): NotificationCategory {
  const t = (alertType || "").toLowerCase();
  if (t.includes("fatigue") || t.includes("safety") || t.includes("sos")) return "safety";
  if (t.includes("record")) return "record_hunt";
  if (t.includes("achievement") || t.includes("challenge") || t.includes("goal") || t.includes("unprofitable")) return "financial";
  if (t.includes("system") || t.includes("maintenance")) return "system";
  return "opportunity";
}

export interface ShouldDeliverResult {
  should_deliver: boolean;
  reason_fr: string;
  category: NotificationCategory;
  deferred_to_digest: boolean;
}

/**
 * Détermine si une notification donnée doit être délivrée immédiatement.
 * Règle non négociable (rapport.md §21.1) : aucune notification non-safety
 * pendant la conduite (vitesse ≥ DRIVE_ENTER_KMH). Les notifications "safety"
 * (fatigue, SOS) sont TOUJOURS délivrées, quel que soit le contexte.
 */
export function shouldDeliver(params: {
  alertType: string;
  speedKmh?: number | null;
  userId?: string;
}): ShouldDeliverResult {
  const userId = params.userId ?? DEFAULT_USER_ID;
  const category = inferCategory(params.alertType);
  const speed = params.speedKmh ?? 0;
  const isDriving = speed >= DRIVE_ENTER_KMH;

  // Préférence utilisateur — catégorie désactivée = jamais délivrée
  const prefs = getNotificationPrefs(userId);
  const pref = prefs.find((p) => p.category === category);
  if (pref && !pref.enabled) {
    return { should_deliver: false, reason_fr: `Catégorie "${pref.label_fr}" désactivée par l'utilisateur.`, category, deferred_to_digest: false };
  }

  if (category === "safety") {
    return { should_deliver: true, reason_fr: "Notification de sécurité — toujours délivrée immédiatement.", category, deferred_to_digest: false };
  }

  if (isDriving) {
    return {
      should_deliver: false,
      reason_fr: `Conduite détectée (${Math.round(speed)} km/h ≥ ${DRIVE_ENTER_KMH} km/h) — notification différée pour la sécurité.`,
      category,
      deferred_to_digest: true,
    };
  }

  if (pref && pref.digest_only) {
    return { should_deliver: false, reason_fr: `Catégorie "${pref.label_fr}" configurée en digest uniquement.`, category, deferred_to_digest: true };
  }

  return { should_deliver: true, reason_fr: "Aucune contrainte de sécurité ou de préférence ne bloque la délivrance.", category, deferred_to_digest: false };
}

// ═════════════════════════════════════════════════════════════════════════════
// 21.2 — Digest notifications (regroupement des alertes non-urgentes)
// ═════════════════════════════════════════════════════════════════════════════

export interface DigestResponse {
  generated_at: string;
  total_pending: number;
  by_category: { category: NotificationCategory; label_fr: string; count: number; items: { title: string; message: string; created_at: string }[] }[];
  summary_fr: string;
}

export function getNotificationDigest(userId: string = DEFAULT_USER_ID): DigestResponse {
  let alerts: any[] = [];
  try {
    alerts = storage.getActiveAlerts() as any[];
  } catch {
    alerts = [];
  }

  const prefs = getNotificationPrefs(userId);
  const enabledCats = new Set(prefs.filter((p) => p.enabled).map((p) => p.category));

  const grouped: Record<string, any[]> = {};
  for (const a of alerts) {
    const cat = inferCategory(a.type);
    if (!enabledCats.has(cat)) continue;
    // Safety n'entre jamais dans le digest — elle est toujours envoyée en direct.
    if (cat === "safety") continue;
    (grouped[cat] ??= []).push(a);
  }

  const by_category = NOTIFICATION_CATEGORIES.filter((c) => c !== "safety" && grouped[c]?.length).map((cat) => ({
    category: cat,
    label_fr: CATEGORY_LABELS_FR[cat],
    count: grouped[cat].length,
    items: grouped[cat].slice(0, 10).map((a) => ({ title: a.title, message: a.message, created_at: a.created_at })),
  }));

  const total_pending = by_category.reduce((s, c) => s + c.count, 0);
  const summary_fr =
    total_pending === 0
      ? "Aucune notification en attente — tout est à jour."
      : `${total_pending} notification${total_pending > 1 ? "s" : ""} en attente, réparties sur ${by_category.length} catégorie${by_category.length > 1 ? "s" : ""}.`;

  return {
    generated_at: new Date().toISOString(),
    total_pending,
    by_category,
    summary_fr,
  };
}
