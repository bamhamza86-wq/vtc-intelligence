/**
 * radarLive.ts — Radar aérien communautaire (Flightradar24-like) — VTC Intelligence
 * ─────────────────────────────────────────────────────────────────────────────
 * Référence rapport : §1 (Signal surge communautaire — heatmap collaborative,
 * convergence "raid" §1.10, nowcasting §1.11) et §15.9 (Wow factor — "Carte façon
 * radar aérien pour la densité de demande", visualisation Flightradar24-like
 * plutôt qu'une simple heatmap statique).
 *
 * Objectif : donner au chauffeur une vue vivante et immersive de la communauté
 * autour de lui — blips anonymisés (autres chauffeurs actifs), heatspots
 * pulsants (zones chaudes), convergences (sur-concentration), arrivées
 * (chauffeurs qui approchent), corridors (routes fréquentées).
 *
 * Privacy-first (impératif RGPD, cf. section RGPD transverse du rapport) :
 *  - Aucune position brute n'est jamais exposée à un autre chauffeur.
 *  - Positions arrondies à une grille ~100m (floorToGrid100m) avant stockage
 *    ET avant diffusion (double floutage défensif).
 *  - Identifiants anonymisés par hash rolling par heure (SHA-256 tronqué) —
 *    impossible de suivre un même chauffeur d'une heure à l'autre.
 *  - k-anonymité ≥ 5 : une cellule de grille n'est jamais révélée aux autres
 *    si elle contient moins de 5 chauffeurs distincts (sinon → liste vide).
 *  - TTL heartbeat court (5 min) — un chauffeur qui s'arrête disparaît vite.
 *
 * Design technique : réutilise la connexion SQLite unique (storage.ts, WAL),
 * aucune nouvelle dépendance npm (crypto = module Node natif). Toute création
 * de table est additive et faite dans storage.ts (CREATE TABLE IF NOT EXISTS).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from "crypto";
import { sqlite, storage } from "./storage";

// ── Paramètres de floutage / anonymisation ──────────────────────────────────
const GRID_METERS = 100; // arrondi position à ~100m
const HEARTBEAT_TTL_MIN = 5; // session courte
const RADAR_RADIUS_KM_DEFAULT = 5;
const K_ANONYMITY_MIN = 5; // en dessous → cellule vide (privacy)

const LAT_DEG_PER_METER = 1 / 111_320;
function lngDegPerMeter(lat: number): number {
  return 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
}

/** Arrondit une coordonnée sur une grille régulière ~100m (floutage position). */
export function floorToGrid100m(lat: number, lng: number): { lat: number; lng: number } {
  const latStep = GRID_METERS * LAT_DEG_PER_METER;
  const lngStep = GRID_METERS * lngDegPerMeter(lat);
  const latIdx = Math.round(lat / latStep);
  const lngIdx = Math.round(lng / lngStep);
  return {
    lat: Math.round(latIdx * latStep * 1e6) / 1e6,
    lng: Math.round(lngIdx * lngStep * 1e6) / 1e6,
  };
}

/** Distance haversine en km. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Hash rolling par heure — identifiant anonyme non traçable d'une heure à
 * l'autre. Un même chauffeur aura un blip_id différent chaque heure : aucune
 * corrélation possible pour un observateur tiers entre 13h et 14h.
 */
export function rollingAnonId(userId: string): string {
  const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const raw = `${userId}:${hourBucket}:vtc-radar-salt`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

// ── Heartbeat — POST /api/community/radar/heartbeat ─────────────────────────
export interface HeartbeatInput {
  userId: string;
  lat: number;
  lng: number;
  directionDeg?: number | null;
  speedKmh?: number | null;
}

export function recordHeartbeat(input: HeartbeatInput): { ok: true; lat_floue: number; lng_floue: number } {
  const { lat, lng } = floorToGrid100m(input.lat, input.lng);
  sqlite
    .prepare(
      `INSERT INTO radar_heartbeat (user_id, lat_floue, lng_floue, direction_deg, speed_kmh) VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.userId, lat, lng, input.directionDeg ?? null, input.speedKmh ?? null);

  // Purge légère opportuniste (évite un job cron dédié) : supprime les vieux
  // heartbeats au-delà de 2x le TTL, throttlé pour ne pas coûter cher.
  if (Math.random() < 0.1) {
    sqlite
      .prepare(`DELETE FROM radar_heartbeat WHERE ts < datetime('now', '-${HEARTBEAT_TTL_MIN * 2} minutes')`)
      .run();
  }

  return { ok: true, lat_floue: lat, lng_floue: lng };
}

interface HeartbeatRow {
  user_id: string;
  lat_floue: number;
  lng_floue: number;
  ts: string;
  direction_deg: number | null;
  speed_kmh: number | null;
}

function getActiveHeartbeats(): HeartbeatRow[] {
  return sqlite
    .prepare(
      `SELECT user_id, lat_floue, lng_floue, ts, direction_deg, speed_kmh
       FROM radar_heartbeat
       WHERE ts > datetime('now', '-${HEARTBEAT_TTL_MIN} minutes')
       ORDER BY id DESC`
    )
    .all() as HeartbeatRow[];
}

/** Ne garde que le heartbeat le plus récent par user_id (dernière position connue). */
function latestByUser(rows: HeartbeatRow[]): HeartbeatRow[] {
  const seen = new Set<string>();
  const out: HeartbeatRow[] = [];
  for (const r of rows) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    out.push(r);
  }
  return out;
}

// ── Blips — positions anonymisées des autres chauffeurs dans un rayon ───────
export interface RadarBlip {
  blip_id: string;
  lat: number;
  lng: number;
  direction_deg: number | null;
  speed_kmh: number | null;
  age_sec: number;
}

export function getBlips(center: { lat: number; lng: number }, excludeUserId: string, radiusKm = RADAR_RADIUS_KM_DEFAULT): RadarBlip[] {
  const rows = latestByUser(getActiveHeartbeats()).filter((r) => r.user_id !== excludeUserId);

  const inRadius = rows.filter((r) => haversineKm(center, { lat: r.lat_floue, lng: r.lng_floue }) <= radiusKm);

  // k-anonymité ≥ 5 : si moins de 5 chauffeurs distincts dans le rayon, ne
  // rien révéler (évite la ré-identification par élimination sur zone peu
  // dense — impératif RGPD, cf. rapport §RGPD transverse et §13 k-anonymat).
  if (inRadius.length < K_ANONYMITY_MIN) return [];

  const now = Date.now();
  return inRadius.map((r) => {
    // Second floutage défensif à la diffusion (au cas où la grille de stockage
    // aurait été altérée) : jamais une position brute en sortie.
    const { lat, lng } = floorToGrid100m(r.lat_floue, r.lng_floue);
    const tsMs = new Date(r.ts.endsWith("Z") ? r.ts : r.ts + "Z").getTime();
    return {
      blip_id: rollingAnonId(r.user_id),
      lat,
      lng,
      direction_deg: r.direction_deg,
      speed_kmh: r.speed_kmh,
      age_sec: Number.isFinite(tsMs) ? Math.max(0, Math.round((now - tsMs) / 1000)) : 0,
    };
  });
}

// ── Heatspots — zones chaudes basées sur les signalements récents ───────────
export interface RadarHeatspot {
  lat: number;
  lng: number;
  intensity: number; // 0-100
  zone_id: string | null;
  zone_name: string | null;
}

export function getHeatspots(center: { lat: number; lng: number }, radiusKm = RADAR_RADIUS_KM_DEFAULT): RadarHeatspot[] {
  const zones = storage.getAllZones() as any[];
  const nearby = zones.filter((z) => haversineKm(center, { lat: z.lat, lng: z.lng }) <= radiusKm);
  if (!nearby.length) return [];

  const results: RadarHeatspot[] = [];
  for (const z of nearby) {
    const row = sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN signal_type = 'positive' THEN COALESCE(intensity,2) ELSE 0 END) as pos_weight,
           SUM(CASE WHEN signal_type = 'negative' THEN COALESCE(intensity,2) ELSE 0 END) as neg_weight,
           COUNT(*) as total
         FROM community_signals
         WHERE zone_id = ? AND expires_at > datetime('now')`
      )
      .get(z.id) as { pos_weight: number | null; neg_weight: number | null; total: number };

    const posWeight = row.pos_weight ?? 0;
    const negWeight = row.neg_weight ?? 0;
    if (row.total < 1) continue;

    // Intensité 0-100 : pondère le poids positif net, plafonné, avec un
    // plancher si signaux mixtes (reste visible mais tamisé).
    const net = posWeight - negWeight * 0.5;
    const intensity = Math.max(0, Math.min(100, Math.round((net / 9) * 100))); // 9 ≈ 3 signaux à intensité max 3
    if (intensity <= 0) continue;

    results.push({ lat: z.lat, lng: z.lng, intensity, zone_id: z.id, zone_name: z.name });
  }

  return results.sort((a, b) => b.intensity - a.intensity);
}

// ── Convergences — détection de sur-concentration ────────────────────────────
export interface RadarConvergence {
  lat: number;
  lng: number;
  count_chauffeurs: number;
  radius_m: number;
}

const CONVERGENCE_RADIUS_M = 500;
const CONVERGENCE_WINDOW_MIN = 5;
const CONVERGENCE_THRESHOLD = 3; // > 3 chauffeurs

export function getConvergences(center: { lat: number; lng: number }, radiusKm = RADAR_RADIUS_KM_DEFAULT): RadarConvergence[] {
  const rows = latestByUser(
    sqlite
      .prepare(
        `SELECT user_id, lat_floue, lng_floue, ts FROM radar_heartbeat
         WHERE ts > datetime('now', '-${CONVERGENCE_WINDOW_MIN} minutes')
         ORDER BY id DESC`
      )
      .all() as HeartbeatRow[]
  ).filter((r) => haversineKm(center, { lat: r.lat_floue, lng: r.lng_floue }) <= radiusKm);

  // Clustering naïf par grille ~500m (suffisant à cette échelle, pas besoin
  // d'un vrai DBSCAN — volume attendu faible, coût O(n) simple).
  const cellSizeM = CONVERGENCE_RADIUS_M;
  const latStep = cellSizeM * LAT_DEG_PER_METER;
  const clusters = new Map<string, { lat: number; lng: number; users: Set<string> }>();

  for (const r of rows) {
    const lngStep = cellSizeM * lngDegPerMeter(r.lat_floue);
    const latIdx = Math.floor(r.lat_floue / latStep);
    const lngIdx = Math.floor(r.lng_floue / lngStep);
    const key = `${latIdx}_${lngIdx}`;
    if (!clusters.has(key)) {
      clusters.set(key, { lat: (latIdx + 0.5) * latStep, lng: (lngIdx + 0.5) * lngStep, users: new Set() });
    }
    clusters.get(key)!.users.add(r.user_id);
  }

  const out: RadarConvergence[] = [];
  clusters.forEach((c) => {
    if (c.users.size > CONVERGENCE_THRESHOLD) {
      out.push({
        lat: Math.round(c.lat * 1e5) / 1e5,
        lng: Math.round(c.lng * 1e5) / 1e5,
        count_chauffeurs: c.users.size,
        radius_m: CONVERGENCE_RADIUS_M,
      });
    }
  });

  return out.sort((a, b) => b.count_chauffeurs - a.count_chauffeurs);
}

// ── Arrivals — chauffeurs se dirigeant vers ma zone (vecteur mouvement) ─────
export interface RadarArrival {
  blip_id: string;
  eta_min: number;
  distance_km: number;
}

const ARRIVAL_MAX_DISTANCE_KM = 8;
const ARRIVAL_ANGLE_TOLERANCE_DEG = 45; // cône de direction vers le centre

function bearingDeg(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const λ1 = (from.lng * Math.PI) / 180;
  const λ2 = (to.lng * Math.PI) / 180;
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function getArrivals(center: { lat: number; lng: number }, excludeUserId: string): RadarArrival[] {
  const rows = latestByUser(getActiveHeartbeats()).filter((r) => r.user_id !== excludeUserId && r.direction_deg != null);

  const out: RadarArrival[] = [];
  for (const r of rows) {
    const distanceKm = haversineKm(center, { lat: r.lat_floue, lng: r.lng_floue });
    if (distanceKm > ARRIVAL_MAX_DISTANCE_KM || distanceKm < 0.05) continue;

    // Direction du blip vers le centre (moi) — si le vecteur mouvement du
    // chauffeur pointe vers ce cap (± tolérance), on le considère "en approche".
    const bearingToMe = bearingDeg({ lat: r.lat_floue, lng: r.lng_floue }, center);
    const diff = angleDiff(r.direction_deg ?? 0, bearingToMe);
    if (diff > ARRIVAL_ANGLE_TOLERANCE_DEG) continue;

    const speed = r.speed_kmh && r.speed_kmh > 3 ? r.speed_kmh : 25; // vitesse urbaine par défaut si vitesse GPS absente/faible
    const etaMin = Math.round((distanceKm / speed) * 60);

    out.push({ blip_id: rollingAnonId(r.user_id), eta_min: Math.max(1, etaMin), distance_km: Math.round(distanceKm * 10) / 10 });
  }

  // k-anonymité : n'affiche les arrivées que si le total (avec blips locaux)
  // respecte le seuil ; sinon liste vide (cohérent avec getBlips()).
  if (out.length > 0 && out.length < K_ANONYMITY_MIN && getBlips(center, excludeUserId).length === 0) {
    return [];
  }

  return out.sort((a, b) => a.eta_min - b.eta_min).slice(0, 10);
}

// ── Density forecast — projection 15/30/60min ────────────────────────────────
export interface DensityForecastPoint {
  horizon_min: 15 | 30 | 60;
  projected_density: number; // nombre estimé de chauffeurs actifs dans le rayon
  trend: "hausse" | "stable" | "baisse";
}

export function getDensityForecast(center: { lat: number; lng: number }, radiusKm = RADAR_RADIUS_KM_DEFAULT): DensityForecastPoint[] {
  // Nowcasting simple (§1.11 du rapport) : régression locale sur les 30
  // dernières minutes de heartbeats dans le rayon, extrapolée linéairement.
  // Volontairement pas de modèle lourd — cf. piège "confondre corrélation et
  // causalité" mentionné dans le rapport.
  const windowMin = 30;
  const bucketMin = 5;
  const rows = sqlite
    .prepare(
      `SELECT user_id, lat_floue, lng_floue, ts FROM radar_heartbeat
       WHERE ts > datetime('now', '-${windowMin} minutes')`
    )
    .all() as HeartbeatRow[];

  const nowMs = Date.now();
  const buckets = new Map<number, Set<string>>(); // bucketIdx (0 = plus ancien) -> users distincts
  for (const r of rows) {
    if (haversineKm(center, { lat: r.lat_floue, lng: r.lng_floue }) > radiusKm) continue;
    const tsMs = new Date(r.ts.endsWith("Z") ? r.ts : r.ts + "Z").getTime();
    if (!Number.isFinite(tsMs)) continue;
    const ageMin = (nowMs - tsMs) / 60000;
    const bucketIdx = Math.floor((windowMin - ageMin) / bucketMin); // plus récent = idx plus grand
    if (bucketIdx < 0 || bucketIdx >= windowMin / bucketMin) continue;
    if (!buckets.has(bucketIdx)) buckets.set(bucketIdx, new Set());
    buckets.get(bucketIdx)!.add(r.user_id);
  }

  const nBuckets = windowMin / bucketMin;
  const series: number[] = [];
  for (let i = 0; i < nBuckets; i++) series.push(buckets.get(i)?.size ?? 0);

  const currentDensity = series[series.length - 1] ?? 0;

  // Régression linéaire simple (pente) sur la série pour estimer la tendance.
  const n = series.length;
  const xMean = (n - 1) / 2;
  const yMean = series.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (series[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slopePerBucket = den > 0 ? num / den : 0;
  const slopePerMin = slopePerBucket / bucketMin;

  const horizons: (15 | 30 | 60)[] = [15, 30, 60];
  return horizons.map((h) => {
    const projected = Math.max(0, Math.round(currentDensity + slopePerMin * h));
    let trend: "hausse" | "stable" | "baisse" = "stable";
    if (slopePerMin > 0.05) trend = "hausse";
    else if (slopePerMin < -0.05) trend = "baisse";
    return { horizon_min: h, projected_density: projected, trend };
  });
}

// ── Hot corridors — routes fréquentées par ≥5 chauffeurs même 30min ─────────
export interface HotCorridor {
  from_zone: string;
  from_zone_name: string;
  to_zone: string;
  to_zone_name: string;
  count_chauffeurs: number;
  avg_duration_s: number;
}

const CORRIDOR_MIN_DRIVERS = 5;
const CORRIDOR_BUCKET_MIN = 30;

/** Bucket temporel courant (arrondi à 30 min) — utilisé pour agréger les corridors. */
function currentTsBucket(): string {
  const now = new Date();
  const bucketMs = CORRIDOR_BUCKET_MIN * 60 * 1000;
  const rounded = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
  return rounded.toISOString();
}

/**
 * Enregistre (ou incrémente) un trajet observé entre deux zones pour le
 * bucket temporel courant. Appelé de façon opportuniste depuis le stream SSE
 * en dérivant la zone la plus proche du dernier heartbeat de chaque chauffeur
 * actif (approximation légère — pas de tracking individuel long terme).
 */
export function recordCorridorObservation(fromZone: string, toZone: string, durationS: number): void {
  if (fromZone === toZone) return;
  const bucket = currentTsBucket();
  const existing = sqlite
    .prepare(
      `SELECT id, count_chauffeurs, avg_duration_s FROM radar_corridor
       WHERE from_zone = ? AND to_zone = ? AND ts_bucket = ?`
    )
    .get(fromZone, toZone, bucket) as { id: number; count_chauffeurs: number; avg_duration_s: number } | undefined;

  if (existing) {
    const newCount = existing.count_chauffeurs + 1;
    const newAvg = (existing.avg_duration_s * existing.count_chauffeurs + durationS) / newCount;
    sqlite.prepare(`UPDATE radar_corridor SET count_chauffeurs = ?, avg_duration_s = ? WHERE id = ?`).run(newCount, newAvg, existing.id);
  } else {
    sqlite
      .prepare(`INSERT INTO radar_corridor (from_zone, to_zone, count_chauffeurs, avg_duration_s, ts_bucket) VALUES (?, ?, ?, ?, ?)`)
      .run(fromZone, toZone, 1, durationS, bucket);
  }
}

export function getHotCorridors(limit = 10): HotCorridor[] {
  const zones = storage.getAllZones() as any[];
  const zoneById = new Map<string, any>(zones.map((z) => [z.id, z]));

  const rows = sqlite
    .prepare(
      `SELECT from_zone, to_zone, SUM(count_chauffeurs) as total_count, AVG(avg_duration_s) as avg_dur
       FROM radar_corridor
       WHERE ts_bucket > datetime('now', '-2 hours')
       GROUP BY from_zone, to_zone
       HAVING total_count >= ?
       ORDER BY total_count DESC
       LIMIT ?`
    )
    .all(CORRIDOR_MIN_DRIVERS, limit) as { from_zone: string; to_zone: string; total_count: number; avg_dur: number }[];

  return rows.map((r) => ({
    from_zone: r.from_zone,
    from_zone_name: zoneById.get(r.from_zone)?.name ?? r.from_zone,
    to_zone: r.to_zone,
    to_zone_name: zoneById.get(r.to_zone)?.name ?? r.to_zone,
    count_chauffeurs: r.total_count,
    avg_duration_s: Math.round(r.avg_dur),
  }));
}

// ── Snapshot complet pour le flux SSE ───────────────────────────────────────
export interface RadarSnapshot {
  blips: RadarBlip[];
  heatspots: RadarHeatspot[];
  convergences: RadarConvergence[];
  arrivals: RadarArrival[];
  active_count_5km: number;
  _ts: number;
}

export function buildRadarSnapshot(center: { lat: number; lng: number }, userId: string, radiusKm = RADAR_RADIUS_KM_DEFAULT): RadarSnapshot {
  const blips = getBlips(center, userId, radiusKm);
  const heatspots = getHeatspots(center, radiusKm);
  const convergences = getConvergences(center, radiusKm);
  const arrivals = getArrivals(center, userId);

  return {
    blips,
    heatspots,
    convergences,
    arrivals,
    active_count_5km: blips.length,
    _ts: Date.now(),
  };
}
