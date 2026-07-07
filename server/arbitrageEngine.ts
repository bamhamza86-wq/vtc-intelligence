/**
 * arbitrageEngine.ts — Couche ARBITRAGE MULTI-PLATEFORME AUTOMATIQUE
 * ═════════════════════════════════════════════════════════════════════════════
 * Inspiré des gaps benchmark (voir vtc_rentabilite/benchmark.md) :
 *   - Para     : révélation pourboire, historique offres, geo/restaurant filter
 *   - Mystro   : auto-accept/refuse selon règles, historique offres refusées
 *   - Gridwise : carte Pulse temps réel où les autres chauffeurs reçoivent des offres
 *   - Solo     : garantie de revenu horaire prédictif
 *   - inDrive  : négociation tarif chauffeur/passager
 *
 * ZÉRO nouvelle dépendance npm — connexion SQLite dédiée (better-sqlite3, déjà
 * présent), même pattern additif que fatigueCoach.ts / crmEngine.ts.
 * Toutes les tables sont créées en CREATE TABLE IF NOT EXISTS (additif pur).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";
import { computeRideMargin, computePlatformKpiComparison } from "./economicsEngine";

// Connexion séparée au même fichier data.db (WAL supporte le multi-connexion),
// même pattern que fatigueCoach.ts / crmEngine.ts.
const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const DEFAULT_USER = "root"; // app single-tenant

// ─────────────────────────────────────────────────────────────────────────────
// Schéma
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS auto_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    name TEXT NOT NULL,
    min_fare REAL,
    min_per_km REAL,
    min_per_min REAL,
    avoid_zones TEXT NOT NULL DEFAULT '[]',
    force_zones TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_auto_rules_user ON auto_rules(user_id, active);

  CREATE TABLE IF NOT EXISTS offer_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    platform TEXT NOT NULL,
    fare REAL NOT NULL,
    distance_km REAL NOT NULL,
    duration_min REAL NOT NULL,
    from_label TEXT,
    to_label TEXT,
    decision TEXT NOT NULL,
    actual_gain REAL
  );
  CREATE INDEX IF NOT EXISTS idx_offer_history_user_ts ON offer_history(user_id, ts);

  CREATE TABLE IF NOT EXISTS zone_filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'blacklist',
    geojson_bbox TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS custom_pricing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    client_type TEXT NOT NULL,
    base_fare REAL NOT NULL DEFAULT 0,
    per_km REAL NOT NULL DEFAULT 0,
    per_min REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface AutoRule {
  id: number;
  name: string;
  min_fare: number | null;
  min_per_km: number | null;
  min_per_min: number | null;
  avoid_zones: string[];
  force_zones: string[];
  active: boolean;
  priority: number;
  created_at: string;
}

export interface AutoRuleInput {
  name: string;
  min_fare?: number | null;
  min_per_km?: number | null;
  min_per_min?: number | null;
  avoid_zones?: string[];
  force_zones?: string[];
  active?: boolean;
  priority?: number;
}

export interface OfferSimInput {
  platform: string;
  fare: number;
  distanceKm: number;
  durationMin: number;
  from?: string;
  to?: string;
}

export interface OfferDecision {
  decision: "accept" | "refuse" | "consider";
  reasons: string[];
  score: number; // 0-100
  alternative: string | null;
  per_km: number;
  per_min: number;
  reserve_price: number;
  net_estimate: number;
}

export interface OfferHistoryRow {
  id: number;
  ts: string;
  platform: string;
  fare: number;
  distance_km: number;
  duration_min: number;
  from_label: string | null;
  to_label: string | null;
  decision: string;
  actual_gain: number | null;
}

export interface ZoneFilter {
  id: number;
  name: string;
  type: "blacklist" | "whitelist";
  geojson_bbox: any;
  active: boolean;
  created_at: string;
}

export interface CustomPricingRow {
  id: number;
  client_type: string;
  base_fare: number;
  per_km: number;
  per_min: number;
  notes: string | null;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function nowIso(): string {
  return new Date().toISOString();
}

function currentHourParis(): number {
  return (new Date().getUTCHours() + 2) % 24;
}

function rowToRule(r: any): AutoRule {
  return {
    id: r.id,
    name: r.name,
    min_fare: r.min_fare,
    min_per_km: r.min_per_km,
    min_per_min: r.min_per_min,
    avoid_zones: JSON.parse(r.avoid_zones || "[]"),
    force_zones: JSON.parse(r.force_zones || "[]"),
    active: !!r.active,
    priority: r.priority,
    created_at: r.created_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Règles d'auto-décision — CRUD
// ─────────────────────────────────────────────────────────────────────────────
export function listAutoRules(userId = DEFAULT_USER): AutoRule[] {
  const rows = db
    .prepare(`SELECT * FROM auto_rules WHERE user_id = ? ORDER BY priority DESC, id ASC`)
    .all(userId) as any[];
  return rows.map(rowToRule);
}

export function createAutoRule(userId: string, input: AutoRuleInput): AutoRule {
  const info = db
    .prepare(
      `INSERT INTO auto_rules (user_id, name, min_fare, min_per_km, min_per_min, avoid_zones, force_zones, active, priority)
       VALUES (@user_id, @name, @min_fare, @min_per_km, @min_per_min, @avoid_zones, @force_zones, @active, @priority)`
    )
    .run({
      user_id: userId,
      name: input.name,
      min_fare: input.min_fare ?? null,
      min_per_km: input.min_per_km ?? null,
      min_per_min: input.min_per_min ?? null,
      avoid_zones: JSON.stringify(input.avoid_zones ?? []),
      force_zones: JSON.stringify(input.force_zones ?? []),
      active: input.active === false ? 0 : 1,
      priority: input.priority ?? 0,
    });
  const row = db.prepare(`SELECT * FROM auto_rules WHERE id = ?`).get(info.lastInsertRowid);
  return rowToRule(row);
}

export function updateAutoRule(userId: string, id: number, input: Partial<AutoRuleInput>): AutoRule | null {
  const existing = db.prepare(`SELECT * FROM auto_rules WHERE id = ? AND user_id = ?`).get(id, userId) as any;
  if (!existing) return null;
  const merged = {
    name: input.name ?? existing.name,
    min_fare: input.min_fare !== undefined ? input.min_fare : existing.min_fare,
    min_per_km: input.min_per_km !== undefined ? input.min_per_km : existing.min_per_km,
    min_per_min: input.min_per_min !== undefined ? input.min_per_min : existing.min_per_min,
    avoid_zones: input.avoid_zones !== undefined ? JSON.stringify(input.avoid_zones) : existing.avoid_zones,
    force_zones: input.force_zones !== undefined ? JSON.stringify(input.force_zones) : existing.force_zones,
    active: input.active !== undefined ? (input.active ? 1 : 0) : existing.active,
    priority: input.priority !== undefined ? input.priority : existing.priority,
  };
  db.prepare(
    `UPDATE auto_rules SET name=@name, min_fare=@min_fare, min_per_km=@min_per_km, min_per_min=@min_per_min,
       avoid_zones=@avoid_zones, force_zones=@force_zones, active=@active, priority=@priority WHERE id=@id`
  ).run({ ...merged, id });
  const row = db.prepare(`SELECT * FROM auto_rules WHERE id = ?`).get(id);
  return rowToRule(row);
}

export function deleteAutoRule(userId: string, id: number): boolean {
  const info = db.prepare(`DELETE FROM auto_rules WHERE id = ? AND user_id = ?`).run(id, userId);
  return info.changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Simulateur d'offre — décision selon règles + prix de réserve dynamique
// ─────────────────────────────────────────────────────────────────────────────

/** Prix de réserve dynamique : seuil minimal acceptable, ajusté selon l'heure
 *  (heures creuses → réserve plus basse pour ne pas rester à vide ; heures de
 *  pointe → réserve plus haute, la demande est plus forte). */
function computeDynamicReservePrice(distanceKm: number, durationMin: number): number {
  let costPerKm = 0.35; // fallback si le profil driver n'est pas dispo
  try {
    const margin = computeRideMargin(10, 10); // sonde à 10€/10km pour dériver un ratio de coût
    costPerKm = margin.fuel_cost && margin.fuel_cost > 0 ? margin.fuel_cost / 10 + 0.1 : costPerKm;
  } catch { /* garde le fallback */ }

  const hour = currentHourParis();
  const isRush = (hour >= 6 && hour <= 9) || (hour >= 17 && hour <= 20);
  const isNight = hour >= 0 && hour < 5;

  let hourlyTarget = 22; // €/h plancher par défaut
  if (isRush) hourlyTarget = 27;
  if (isNight) hourlyTarget = 30; // nuit : réserve plus haute (pénibilité + faible fréquentation)

  const timeCost = (durationMin / 60) * hourlyTarget;
  const kmCost = distanceKm * costPerKm;
  return r2(Math.max(timeCost, kmCost, 4)); // jamais sous 4€ (course minimale)
}

export function simulateOffer(userId: string, input: OfferSimInput): OfferDecision {
  const { platform, fare, distanceKm, durationMin, from, to } = input;
  const per_km = distanceKm > 0 ? r2(fare / distanceKm) : 0;
  const per_min = durationMin > 0 ? r2(fare / durationMin) : 0;

  const reasons: string[] = [];
  let score = 50; // score neutre de départ

  const reserve_price = computeDynamicReservePrice(distanceKm, durationMin);

  // Estimation nette via le moteur économique existant (réutilisation)
  let net_estimate = fare;
  try {
    net_estimate = computeRideMargin(fare, distanceKm).net_final;
  } catch { /* garde fare brut si le profil n'est pas configuré */ }

  const rules = listAutoRules(userId).filter((r) => r.active);

  let hardRefuse = false;
  let hardAccept = false;

  for (const rule of rules) {
    // Zones à éviter (texte simple, comparaison insensible à la casse sur from/to)
    const haystack = `${from ?? ""} ${to ?? ""}`.toLowerCase();
    const inAvoidZone = rule.avoid_zones.some((z) => haystack.includes(String(z).toLowerCase()));
    const inForceZone = rule.force_zones.some((z) => haystack.includes(String(z).toLowerCase()));

    if (inAvoidZone) {
      const hour = currentHourParis();
      const isOffPeak = hour >= 10 && hour <= 16; // heures creuses génériques
      if (isOffPeak) {
        hardRefuse = true;
        reasons.push(`Règle « ${rule.name} » : zone à éviter en heures creuses (${from ?? "?"} → ${to ?? "?"})`);
      }
    }
    if (inForceZone) {
      hardAccept = true;
      score += 25;
      reasons.push(`Règle « ${rule.name} » : zone prioritaire — acceptation favorisée`);
    }
    if (rule.min_fare != null && fare < rule.min_fare) {
      hardRefuse = true;
      reasons.push(`Règle « ${rule.name} » : tarif ${fare}€ < minimum requis ${rule.min_fare}€`);
    }
    if (rule.min_per_km != null && per_km < rule.min_per_km) {
      hardRefuse = true;
      reasons.push(`Règle « ${rule.name} » : ${per_km}€/km < minimum requis ${rule.min_per_km}€/km`);
    }
    if (rule.min_per_min != null && per_min < rule.min_per_min) {
      reasons.push(`Règle « ${rule.name} » : ${per_min}€/min sous le seuil ${rule.min_per_min}€/min`);
      score -= 10;
    }
  }

  // Comparaison au prix de réserve dynamique
  if (fare >= reserve_price * 1.15) {
    score += 20;
    reasons.push(`Offre nettement au-dessus du prix de réserve dynamique (${reserve_price}€)`);
  } else if (fare < reserve_price) {
    score -= 20;
    reasons.push(`Offre sous le prix de réserve dynamique (${reserve_price}€ attendu pour ce trajet)`);
  }

  // Comparatif plateforme (réutilise computePlatformKpiComparison)
  let alternative: string | null = null;
  try {
    const kpis = computePlatformKpiComparison(30);
    const better = kpis.find((k) => k.platform !== platform && k.net_hourly > 0);
    if (better && better.net_hourly > 0) {
      const impliedHourly = durationMin > 0 ? (net_estimate / durationMin) * 60 : 0;
      if (impliedHourly < better.net_hourly * 0.85) {
        alternative = better.platform;
        reasons.push(`${better.platform} affiche un meilleur rendement horaire historique (${better.net_hourly}€/h)`);
      }
    }
  } catch { /* pas grave si pas de données historiques */ }

  // Un refus dur (règle non négociable) plafonne le score affiché pour rester
  // cohérent avec la décision finale (évite un score élevé sur une offre refusée).
  if (hardRefuse && !hardAccept) score = Math.min(score, 30);

  score = Math.max(0, Math.min(100, score));

  let decision: OfferDecision["decision"];
  if (hardRefuse && !hardAccept) decision = "refuse";
  else if (hardAccept || score >= 65) decision = "accept";
  else if (score < 35) decision = "refuse";
  else decision = "consider";

  if (reasons.length === 0) {
    reasons.push("Aucune règle spécifique déclenchée — décision basée sur le score global.");
  }

  return {
    decision,
    reasons,
    score,
    alternative,
    per_km,
    per_min,
    reserve_price,
    net_estimate: r2(net_estimate),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Historique offres reçues (acceptées + refusées)
// ─────────────────────────────────────────────────────────────────────────────
export function recordOffer(
  userId: string,
  offer: OfferSimInput & { decision: string; actual_gain?: number | null }
): OfferHistoryRow {
  const info = db
    .prepare(
      `INSERT INTO offer_history (user_id, ts, platform, fare, distance_km, duration_min, from_label, to_label, decision, actual_gain)
       VALUES (@user_id, @ts, @platform, @fare, @distance_km, @duration_min, @from_label, @to_label, @decision, @actual_gain)`
    )
    .run({
      user_id: userId,
      ts: nowIso(),
      platform: offer.platform,
      fare: offer.fare,
      distance_km: offer.distanceKm,
      duration_min: offer.durationMin,
      from_label: offer.from ?? null,
      to_label: offer.to ?? null,
      decision: offer.decision,
      actual_gain: offer.actual_gain ?? null,
    });
  const row = db.prepare(`SELECT * FROM offer_history WHERE id = ?`).get(info.lastInsertRowid);
  return row as OfferHistoryRow;
}

export function listOfferHistory(userId: string, limit = 50): OfferHistoryRow[] {
  return db
    .prepare(`SELECT * FROM offer_history WHERE user_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(userId, limit) as OfferHistoryRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Analyse rétrospective des offres refusées
// ─────────────────────────────────────────────────────────────────────────────
export interface RefusedAnalysis {
  total_refused: number;
  avg_fare_refused: number;
  would_have_been_profitable: number;
  estimated_missed_gain: number;
  insight_fr: string;
}

export function analyzeRefusedOffers(userId: string): RefusedAnalysis {
  const rows = db
    .prepare(`SELECT * FROM offer_history WHERE user_id = ? AND decision = 'refuse'`)
    .all(userId) as OfferHistoryRow[];

  if (rows.length === 0) {
    return {
      total_refused: 0,
      avg_fare_refused: 0,
      would_have_been_profitable: 0,
      estimated_missed_gain: 0,
      insight_fr: "Aucune offre refusée enregistrée pour le moment.",
    };
  }

  const avgFare = rows.reduce((s, r) => s + r.fare, 0) / rows.length;
  let profitableCount = 0;
  let missedGain = 0;

  for (const r of rows) {
    let net = r.fare;
    try {
      net = computeRideMargin(r.fare, r.distance_km).net_final;
    } catch { /* fallback brut */ }
    const impliedHourly = r.duration_min > 0 ? (net / r.duration_min) * 60 : 0;
    if (impliedHourly >= 18) { // seuil générique de rentabilité horaire minimale
      profitableCount++;
      missedGain += net;
    }
  }

  const insight = `Vous avez refusé ${rows.length} offre${rows.length > 1 ? "s" : ""} à ${r2(avgFare)}€ en moyenne, dont ${profitableCount} auraient été rentables (manque à gagner estimé : ${r2(missedGain)}€).`;

  return {
    total_refused: rows.length,
    avg_fare_refused: r2(avgFare),
    would_have_been_profitable: profitableCount,
    estimated_missed_gain: r2(missedGain),
    insight_fr: insight,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Geo/restaurant filter — zones blacklist/whitelist
// ─────────────────────────────────────────────────────────────────────────────
function rowToZoneFilter(r: any): ZoneFilter {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    geojson_bbox: JSON.parse(r.geojson_bbox || "{}"),
    active: !!r.active,
    created_at: r.created_at,
  };
}

export function listZoneFilters(userId = DEFAULT_USER): ZoneFilter[] {
  const rows = db.prepare(`SELECT * FROM zone_filters WHERE user_id = ? ORDER BY id DESC`).all(userId) as any[];
  return rows.map(rowToZoneFilter);
}

export function createZoneFilter(
  userId: string,
  input: { name: string; type?: "blacklist" | "whitelist"; geojson_bbox?: any; active?: boolean }
): ZoneFilter {
  const info = db
    .prepare(
      `INSERT INTO zone_filters (user_id, name, type, geojson_bbox, active) VALUES (@user_id, @name, @type, @geojson_bbox, @active)`
    )
    .run({
      user_id: userId,
      name: input.name,
      type: input.type ?? "blacklist",
      geojson_bbox: JSON.stringify(input.geojson_bbox ?? {}),
      active: input.active === false ? 0 : 1,
    });
  const row = db.prepare(`SELECT * FROM zone_filters WHERE id = ?`).get(info.lastInsertRowid);
  return rowToZoneFilter(row);
}

export function updateZoneFilter(
  userId: string,
  id: number,
  input: Partial<{ name: string; type: "blacklist" | "whitelist"; geojson_bbox: any; active: boolean }>
): ZoneFilter | null {
  const existing = db.prepare(`SELECT * FROM zone_filters WHERE id = ? AND user_id = ?`).get(id, userId) as any;
  if (!existing) return null;
  const merged = {
    name: input.name ?? existing.name,
    type: input.type ?? existing.type,
    geojson_bbox: input.geojson_bbox !== undefined ? JSON.stringify(input.geojson_bbox) : existing.geojson_bbox,
    active: input.active !== undefined ? (input.active ? 1 : 0) : existing.active,
  };
  db.prepare(`UPDATE zone_filters SET name=@name, type=@type, geojson_bbox=@geojson_bbox, active=@active WHERE id=@id`).run({
    ...merged,
    id,
  });
  const row = db.prepare(`SELECT * FROM zone_filters WHERE id = ?`).get(id);
  return rowToZoneFilter(row);
}

export function deleteZoneFilter(userId: string, id: number): boolean {
  const info = db.prepare(`DELETE FROM zone_filters WHERE id = ? AND user_id = ?`).run(id, userId);
  return info.changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Live Pulse — génération de blips k-anonymisés (simulation communautaire)
// ─────────────────────────────────────────────────────────────────────────────
const PULSE_ZONES = [
  { name: "Paris Centre", lat: 48.8566, lng: 2.3522 },
  { name: "La Défense", lat: 48.8918, lng: 2.2388 },
  { name: "CDG Roissy", lat: 49.0097, lng: 2.5479 },
  { name: "Orly", lat: 48.7262, lng: 2.3652 },
  { name: "Boulogne-Billancourt", lat: 48.8352, lng: 2.2410 },
  { name: "Créteil", lat: 48.7904, lng: 2.4556 },
  { name: "Saint-Denis", lat: 48.9362, lng: 2.3574 },
  { name: "Versailles", lat: 48.8049, lng: 2.1204 },
];
const PULSE_PLATFORMS = ["Uber", "Bolt", "Heetch", "FreeNow"];

/** Génère un blip anonymisé plausible : aucune donnée personnelle, k-anonymat
 *  garanti par construction (zone large, pas d'identifiant chauffeur). */
export function generatePulseBlip(): {
  zone: string;
  lat: number;
  lng: number;
  platform: string;
  fare_range: string;
  ts: number;
} {
  const zone = PULSE_ZONES[Math.floor(Math.random() * PULSE_ZONES.length)];
  const platform = PULSE_PLATFORMS[Math.floor(Math.random() * PULSE_PLATFORMS.length)];
  const jitterLat = zone.lat + (Math.random() - 0.5) * 0.02;
  const jitterLng = zone.lng + (Math.random() - 0.5) * 0.02;
  const fareBuckets = ["8-12€", "12-18€", "18-25€", "25-40€", "40€+"];
  const fare_range = fareBuckets[Math.floor(Math.random() * fareBuckets.length)];
  return { zone: zone.name, lat: r2(jitterLat), lng: r2(jitterLng), platform, fare_range, ts: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Prédicteur de garantie €/h
// ─────────────────────────────────────────────────────────────────────────────
export interface HourlyGuarantee {
  guaranteed_min: number;
  guaranteed_median: number;
  confidence: number; // 0-1
  sample_size: number;
  hour: number;
}

export function predictHourlyGuarantee(userId: string): HourlyGuarantee {
  const hour = currentHourParis();

  // Historique perso : offres acceptées sur les 60 derniers jours à une heure proche (±1h)
  const rows = db
    .prepare(
      `SELECT fare, distance_km, duration_min, ts FROM offer_history
       WHERE user_id = ? AND decision = 'accept' AND ts >= datetime('now', '-60 days')`
    )
    .all(userId) as { fare: number; distance_km: number; duration_min: number; ts: string }[];

  const sameHour = rows.filter((r) => {
    const h = (new Date(r.ts).getUTCHours() + 2) % 24;
    return Math.abs(h - hour) <= 1 || Math.abs(h - hour) >= 23;
  });

  const hourlyRates: number[] = sameHour
    .filter((r) => r.duration_min > 0)
    .map((r) => {
      let net = r.fare;
      try {
        net = computeRideMargin(r.fare, r.distance_km).net_final;
      } catch { /* fallback brut */ }
      return (net / r.duration_min) * 60;
    })
    .sort((a, b) => a - b);

  if (hourlyRates.length < 3) {
    return {
      guaranteed_min: 15,
      guaranteed_median: 20,
      confidence: 0.2,
      sample_size: hourlyRates.length,
      hour,
    };
  }

  const p20idx = Math.floor(hourlyRates.length * 0.2);
  const medIdx = Math.floor(hourlyRates.length * 0.5);
  const guaranteed_min = r2(hourlyRates[p20idx]);
  const guaranteed_median = r2(hourlyRates[medIdx]);
  const confidence = Math.min(1, 0.3 + hourlyRates.length * 0.05);

  return { guaranteed_min, guaranteed_median, confidence: r2(confidence), sample_size: hourlyRates.length, hour };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Cashout tracker — €/h cumulés dispo + prévisionnel fin de shift
// ─────────────────────────────────────────────────────────────────────────────
export interface CashoutForecast {
  earned_so_far: number;
  hours_elapsed: number;
  current_hourly_rate: number;
  projected_end_of_shift: number;
  shift_target_hours: number;
}

export function computeCashoutForecast(userId: string, shiftTargetHours = 8): CashoutForecast {
  const rows = db
    .prepare(
      `SELECT fare, distance_km, duration_min, ts FROM offer_history
       WHERE user_id = ? AND decision = 'accept' AND ts >= datetime('now', 'start of day')`
    )
    .all(userId) as { fare: number; distance_km: number; duration_min: number; ts: string }[];

  let earned = 0;
  let minutes = 0;
  for (const r of rows) {
    let net = r.fare;
    try {
      net = computeRideMargin(r.fare, r.distance_km).net_final;
    } catch { /* fallback brut */ }
    earned += net;
    minutes += r.duration_min;
  }

  const hoursElapsed = minutes / 60;
  const currentHourly = hoursElapsed > 0 ? earned / hoursElapsed : 0;
  const projected = r2(currentHourly * shiftTargetHours);

  return {
    earned_so_far: r2(earned),
    hours_elapsed: r2(hoursElapsed),
    current_hourly_rate: r2(currentHourly),
    projected_end_of_shift: projected,
    shift_target_hours: shiftTargetHours,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Négociation tarif (compteur perso) — grille personnelle clientèle privée
// ─────────────────────────────────────────────────────────────────────────────
export function listCustomPricing(userId = DEFAULT_USER): CustomPricingRow[] {
  return db.prepare(`SELECT * FROM custom_pricing WHERE user_id = ? ORDER BY id DESC`).all(userId) as CustomPricingRow[];
}

export function createCustomPricing(
  userId: string,
  input: { client_type: string; base_fare: number; per_km: number; per_min: number; notes?: string }
): CustomPricingRow {
  const info = db
    .prepare(
      `INSERT INTO custom_pricing (user_id, client_type, base_fare, per_km, per_min, notes)
       VALUES (@user_id, @client_type, @base_fare, @per_km, @per_min, @notes)`
    )
    .run({
      user_id: userId,
      client_type: input.client_type,
      base_fare: input.base_fare,
      per_km: input.per_km,
      per_min: input.per_min,
      notes: input.notes ?? null,
    });
  const row = db.prepare(`SELECT * FROM custom_pricing WHERE id = ?`).get(info.lastInsertRowid);
  return row as CustomPricingRow;
}

export function updateCustomPricing(
  userId: string,
  id: number,
  input: Partial<{ client_type: string; base_fare: number; per_km: number; per_min: number; notes: string }>
): CustomPricingRow | null {
  const existing = db.prepare(`SELECT * FROM custom_pricing WHERE id = ? AND user_id = ?`).get(id, userId) as any;
  if (!existing) return null;
  const merged = {
    client_type: input.client_type ?? existing.client_type,
    base_fare: input.base_fare !== undefined ? input.base_fare : existing.base_fare,
    per_km: input.per_km !== undefined ? input.per_km : existing.per_km,
    per_min: input.per_min !== undefined ? input.per_min : existing.per_min,
    notes: input.notes !== undefined ? input.notes : existing.notes,
  };
  db.prepare(
    `UPDATE custom_pricing SET client_type=@client_type, base_fare=@base_fare, per_km=@per_km, per_min=@per_min, notes=@notes WHERE id=@id`
  ).run({ ...merged, id });
  const row = db.prepare(`SELECT * FROM custom_pricing WHERE id = ?`).get(id);
  return row as CustomPricingRow;
}

export function deleteCustomPricing(userId: string, id: number): boolean {
  const info = db.prepare(`DELETE FROM custom_pricing WHERE id = ? AND user_id = ?`).run(id, userId);
  return info.changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed data — 3 règles démo + 10 offres historiques mixtes
// ─────────────────────────────────────────────────────────────────────────────
export function seedArbitrageDemoData(): void {
  const seedKey = "arbitrage_demo_seeded_v1";
  const already = db.prepare(`SELECT value FROM seed_meta WHERE key = ?`).get(seedKey) as { value: string } | undefined;
  if (already) return;

  const ruleCount = db.prepare(`SELECT COUNT(*) as n FROM auto_rules WHERE user_id = ?`).get(DEFAULT_USER) as { n: number };
  if (ruleCount.n === 0) {
    createAutoRule(DEFAULT_USER, {
      name: "Rentabilité minimale 2€/km",
      min_per_km: 2,
      priority: 10,
    });
    createAutoRule(DEFAULT_USER, {
      name: "Éviter Créteil en heures creuses",
      avoid_zones: ["Créteil"],
      priority: 5,
    });
    createAutoRule(DEFAULT_USER, {
      name: "Prioriser CDG le matin",
      force_zones: ["CDG", "Roissy"],
      priority: 8,
    });
  }

  const offerCount = db.prepare(`SELECT COUNT(*) as n FROM offer_history WHERE user_id = ?`).get(DEFAULT_USER) as { n: number };
  if (offerCount.n === 0) {
    const demoOffers: Array<{
      platform: string; fare: number; distance_km: number; duration_min: number;
      from_label: string; to_label: string; decision: string; actual_gain: number | null; daysAgo: number;
    }> = [
      { platform: "Uber", fare: 28, distance_km: 12, duration_min: 22, from_label: "Paris 15e", to_label: "CDG Roissy", decision: "accept", actual_gain: 24, daysAgo: 0 },
      { platform: "Bolt", fare: 9, distance_km: 6, duration_min: 18, from_label: "Créteil", to_label: "Créteil L'Échat", decision: "refuse", actual_gain: null, daysAgo: 0 },
      { platform: "Heetch", fare: 14, distance_km: 5, duration_min: 12, from_label: "Bastille", to_label: "République", decision: "accept", actual_gain: 12, daysAgo: 1 },
      { platform: "Uber", fare: 45, distance_km: 28, duration_min: 35, from_label: "La Défense", to_label: "Orly", decision: "accept", actual_gain: 38, daysAgo: 1 },
      { platform: "Bolt", fare: 7, distance_km: 4, duration_min: 15, from_label: "Créteil Préfecture", to_label: "Créteil L'Échat", decision: "refuse", actual_gain: null, daysAgo: 2 },
      { platform: "FreeNow", fare: 22, distance_km: 9, duration_min: 19, from_label: "Montparnasse", to_label: "Boulogne", decision: "accept", actual_gain: 18, daysAgo: 2 },
      { platform: "Uber", fare: 11, distance_km: 8, duration_min: 20, from_label: "Saint-Denis", to_label: "Pantin", decision: "refuse", actual_gain: null, daysAgo: 3 },
      { platform: "Bolt", fare: 33, distance_km: 15, duration_min: 25, from_label: "Paris 8e", to_label: "Versailles", decision: "accept", actual_gain: 27, daysAgo: 3 },
      { platform: "Heetch", fare: 8, distance_km: 5, duration_min: 14, from_label: "Créteil", to_label: "Maisons-Alfort", decision: "refuse", actual_gain: null, daysAgo: 4 },
      { platform: "Uber", fare: 52, distance_km: 32, duration_min: 40, from_label: "Paris Gare de Lyon", to_label: "CDG Roissy", decision: "accept", actual_gain: 44, daysAgo: 5 },
    ];

    const stmt = db.prepare(
      `INSERT INTO offer_history (user_id, ts, platform, fare, distance_km, duration_min, from_label, to_label, decision, actual_gain)
       VALUES (@user_id, @ts, @platform, @fare, @distance_km, @duration_min, @from_label, @to_label, @decision, @actual_gain)`
    );
    const tx = db.transaction((offers: typeof demoOffers) => {
      for (const o of offers) {
        const ts = new Date(Date.now() - o.daysAgo * 24 * 3600_000).toISOString();
        stmt.run({ user_id: DEFAULT_USER, ts, ...o });
      }
    });
    tx(demoOffers);
  }

  const filterCount = db.prepare(`SELECT COUNT(*) as n FROM zone_filters WHERE user_id = ?`).get(DEFAULT_USER) as { n: number };
  if (filterCount.n === 0) {
    createZoneFilter(DEFAULT_USER, {
      name: "Créteil (heures creuses)",
      type: "blacklist",
      geojson_bbox: { bbox: [2.42, 48.77, 2.49, 48.81] },
    });
  }

  const pricingCount = db.prepare(`SELECT COUNT(*) as n FROM custom_pricing WHERE user_id = ?`).get(DEFAULT_USER) as { n: number };
  if (pricingCount.n === 0) {
    createCustomPricing(DEFAULT_USER, {
      client_type: "Clientèle privée régulière",
      base_fare: 8,
      per_km: 1.8,
      per_min: 0.35,
      notes: "Grille pour clients fidèles hors plateforme",
    });
  }

  db.prepare(`INSERT OR REPLACE INTO seed_meta (key, value) VALUES (?, ?)`).run(seedKey, nowIso());
}

export { DEFAULT_USER };
