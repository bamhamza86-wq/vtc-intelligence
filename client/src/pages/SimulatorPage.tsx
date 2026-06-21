import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { GpsFreshness } from "@/components/GpsFreshness";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Navigation, MapPin, Crosshair, RefreshCw, CheckCircle, XCircle,
  TrendingUp, Clock, Route as RouteIcon, Gauge, Info,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// SimulatorPage — Simulateur de trajet temps réel (TomTom / OSRM)
// ─────────────────────────────────────────────────────────────────────────────
// Plus aucun scénario hardcodé : toutes les ETAs / distances de repositionnement
// proviennent de /api/best-route (TomTom temps réel avec trafic, fallback OSRM,
// puis calibré). Rafraîchissement toutes les 3s (refetchInterval: 3000).
//
// Les distances de COURSE client (zone → Paris) restent fixes — c'est la course
// elle-même, pas le repositionnement. Le profil ci-dessous décrit ces courses.
// ─────────────────────────────────────────────────────────────────────────────

const ZONE_COURSE_PROFILE: Record<string, { avgDistKm: number; avgFare: number; label: string }> = {
  z_cdg:                  { avgDistKm: 37, avgFare: 55, label: "CDG → Paris" },
  z_orly:                 { avgDistKm: 24, avgFare: 38, label: "Orly → Paris" },
  z_le_bourget:           { avgDistKm: 14, avgFare: 22, label: "Bourget → Paris" },
  z_villepinte:           { avgDistKm: 20, avgFare: 28, label: "Villepinte → Paris" },
  z_tremblay:             { avgDistKm: 22, avgFare: 30, label: "Tremblay → Paris" },
  z_aulnay:               { avgDistKm: 18, avgFare: 24, label: "Aulnay → Paris" },
  z_saint_denis_gare:     { avgDistKm: 12, avgFare: 18, label: "St-Denis → Paris" },
  z_plaine_commune:       { avgDistKm: 11, avgFare: 16, label: "Plaine → Paris" },
  z_bobigny_gare:         { avgDistKm: 15, avgFare: 20, label: "Bobigny → Paris" },
  z_aubervilliers:        { avgDistKm: 11, avgFare: 16, label: "Aubervilliers → Paris" },
  z_epinay_gennevilliers: { avgDistKm: 14, avgFare: 20, label: "Épinay → Paris" },
  z_93_centre:            { avgDistKm: 13, avgFare: 18, label: "93 Centre → Paris" },
  z_montreuil:            { avgDistKm: 16, avgFare: 22, label: "Montreuil → Paris" },
  z_stade_france:         { avgDistKm: 10, avgFare: 15, label: "Stade → Paris" },
};

// Vitesse de course client moyenne (axes Paris intra/péri) pour estimer la durée
// quand aucune ETA temps réel exploitable n'est disponible. ~28 km/h en charge.
const COURSE_AVG_SPEED_KMH = 28;

// ── Badge coloré de la source de distance/ETA ───────────────────────────────
function SourceBadge({ source }: { source: string }) {
  if (source === "tomtom")
    return <Badge className="bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/20" data-testid={`badge-source-${source}`}>🚦 TomTom</Badge>;
  if (source === "google")
    return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20" data-testid={`badge-source-${source}`}>🚦 Trafic</Badge>;
  if (source === "osrm")
    return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/20" data-testid={`badge-source-${source}`}>🛣️ OSRM</Badge>;
  return <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30 hover:bg-gray-500/20" data-testid={`badge-source-${source}`}>📊 Calibré</Badge>;
}

// ── Petit ticker pour afficher l'âge de la dernière donnée best-route ─────────
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ── Géocodage simple d'une saisie "lat,lng" (saisie manuelle de coordonnée) ──
function parseLatLng(text: string): { lat: number; lng: number } | null {
  const m = text.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

export default function SimulatorPage() {
  // ── GPS temps réel (origine par défaut du repositionnement) ─────────────────
  const { position: gpsPosition, isFallback, lastUpdatedAt } = useGpsPosition();

  // Mode origine : "gps" (suit le GPS) ou "manual" (coordonnée saisie)
  const [originMode, setOriginMode] = useState<"gps" | "manual">("gps");
  const [manualInput, setManualInput] = useState("");
  const [manualOrigin, setManualOrigin] = useState<{ lat: number; lng: number } | null>(null);

  // Origine effective utilisée pour /api/best-route
  const origin = originMode === "manual" && manualOrigin ? manualOrigin : gpsPosition;

  // Zone sélectionnée pour la simulation de rentabilité de course
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);

  const now = useNow(1000);

  // ── Query best-route temps réel — refetch toutes les 3s ─────────────────────
  const { data: routeData, dataUpdatedAt, isFetching, refetch } = useQuery<any>({
    queryKey: ["/api/best-route", origin.lat.toFixed(3), origin.lng.toFixed(3)],
    queryFn: () =>
      apiRequest("POST", "/api/best-route", { lat: origin.lat, lng: origin.lng }).then(r => r.json()),
    refetchInterval: 3000,
    enabled: true,
  });

  // ── Liste des zones (triée par score décroissant — déjà fait côté serveur) ──
  const allZones: any[] = useMemo(() => routeData?.all ?? [], [routeData]);
  const best = routeData?.recommendation ?? routeData?.best ?? (allZones[0] ?? null);

  // Donnée de la zone sélectionnée
  const selectedZone = useMemo(
    () => allZones.find(z => z.zone?.id === selectedZoneId) ?? null,
    [allZones, selectedZoneId],
  );

  // ── Calcul rentabilité de la course (zone sélectionnée → Paris) ─────────────
  const calc = useMutation<any, Error, any>({
    mutationFn: (d: any) => apiRequest("POST", "/api/calculate", d).then(r => r.json()),
  });

  // Déclencher automatiquement le calcul quand une zone est choisie / réactualisée.
  useEffect(() => {
    if (!selectedZone) return;
    const id: string = selectedZone.zone?.id;
    const profile = ZONE_COURSE_PROFILE[id];
    if (!profile) return;

    // Durée de course estimée : on s'appuie sur l'ETA temps réel de repositionnement
    // comme proxy du trafic ambiant, sinon vitesse moyenne course.
    const realtimeUsable = selectedZone.distanceSource === "tomtom" || selectedZone.distanceSource === "google";
    const courseDurationMin = realtimeUsable && selectedZone.etaMinutes > 0
      // Mise à l'échelle : durée course ≈ ETA repositionnement × (distCourse / distRepos)
      ? Math.max(1, Math.round(selectedZone.etaMinutes * (profile.avgDistKm / Math.max(1, selectedZone.distanceKm))))
      : Math.max(1, Math.round((profile.avgDistKm / COURSE_AVG_SPEED_KMH) * 60));

    calc.mutate({
      distanceKm: profile.avgDistKm,
      durationMin: courseDurationMin,
      fare: profile.avgFare,
      lat: origin.lat,
      lng: origin.lng,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedZoneId, selectedZone?.distanceSource, selectedZone?.etaMinutes]);

  // ── Comparaison des sources (TomTom temps réel vs OSRM vs calibré) ──────────
  // L'API renvoie une seule source effective par zone. On reconstruit les
  // références : OSRM (routes sans trafic) ≈ distance / 30 km/h ; calibré ≈
  // distance / 22 km/h (réf. Bd Ney avec congestion type). L'écart % indique
  // l'impact du trafic temps réel mesuré par TomTom.
  const sourceComparison = useMemo(() => {
    if (!selectedZone) return null;
    const distKm: number = selectedZone.distanceKm ?? 0;
    const etaReal: number = selectedZone.etaMinutes ?? 0;
    const src: string = selectedZone.distanceSource ?? "calibrated";

    // ETA OSRM (routes nominales, sans trafic) — référence ~30 km/h périurbain
    const etaOsrm = Math.max(1, Math.round((distKm / 30) * 60));
    // ETA calibré (référence Bd Ney, congestion type) — ~22 km/h
    const etaCalibrated = Math.max(1, Math.round((distKm / 22) * 60));
    // ETA temps réel (TomTom) — valeur API si source temps réel, sinon estimée
    const etaTomtom = (src === "tomtom" || src === "google") && etaReal > 0
      ? etaReal
      : null;

    const ref = etaOsrm; // OSRM = référence "sans trafic"
    const ecartPct = etaTomtom != null
      ? Math.round(((etaTomtom - ref) / ref) * 100)
      : null;

    return { distKm, src, etaTomtom, etaOsrm, etaCalibrated, etaReal, ref, ecartPct };
  }, [selectedZone]);

  // ── Fraîcheur de la donnée best-route ───────────────────────────────────────
  const dataAgeSec = dataUpdatedAt ? Math.max(0, Math.round((now - dataUpdatedAt) / 1000)) : null;
  const isFresh = dataAgeSec != null && dataAgeSec < 10;

  // ── Indicateur surestimation/sous-estimation vs référence OSRM (>10%) ───────
  function estimationFlag(z: any): { label: string; cls: string } | null {
    const dist = z.distanceKm ?? 0;
    if (dist <= 0 || z.etaMinutes <= 0) return null;
    const refOsrm = (dist / 30) * 60; // référence routes sans trafic
    const deltaPct = ((z.etaMinutes - refOsrm) / refOsrm) * 100;
    if (deltaPct > 10) return { label: `↑ +${Math.round(deltaPct)}% trafic`, cls: "text-amber-400" };
    if (deltaPct < -10) return { label: `↓ ${Math.round(deltaPct)}% fluide`, cls: "text-emerald-400" };
    return null;
  }

  const applyManual = () => {
    const parsed = parseLatLng(manualInput);
    if (parsed) {
      setManualOrigin(parsed);
      setOriginMode("manual");
    }
  };

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      {/* ── En-tête ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-bold text-lg flex items-center gap-2">
            <Navigation size={18} className="text-primary" />
            Simulateur de trajet temps réel
          </h2>
          <p className="text-sm text-muted-foreground">
            Repositionnement TomTom (trafic temps réel) → rentabilité de course
          </p>
        </div>
        <GpsFreshness lastUpdatedAt={lastUpdatedAt} isFallback={isFallback} className="mt-1" />
      </div>

      {/* ── Fraîcheur des données best-route ─────────────────────────────────── */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="py-2.5 px-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${isFresh ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
            {dataAgeSec == null ? (
              <span className="text-muted-foreground">En attente des données…</span>
            ) : isFresh ? (
              <span className="text-emerald-400 font-medium" data-testid="text-data-fresh">Données fraîches · {dataAgeSec}s</span>
            ) : (
              <span className="text-amber-400 font-medium" data-testid="text-data-stale">Actualisé il y a {dataAgeSec}s</span>
            )}
            <span className="text-muted-foreground">· refresh auto 3s</span>
          </div>
          <Button
            size="sm" variant="ghost" className="h-7 px-2 text-xs"
            onClick={() => refetch()} disabled={isFetching}
            data-testid="button-refresh-route"
          >
            <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} />
          </Button>
        </CardContent>
      </Card>

      {/* ── 1. Origine du repositionnement (GPS ou manuel) ───────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Crosshair size={15} /> Zone de départ (origine)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <button
              onClick={() => setOriginMode("gps")}
              className={`flex-1 text-xs rounded-lg border px-3 py-2 transition-colors flex items-center justify-center gap-1.5 ${originMode === "gps" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/50"}`}
              data-testid="button-origin-gps"
            >
              <MapPin size={13} /> Ma position GPS
            </button>
            <button
              onClick={() => setOriginMode("manual")}
              className={`flex-1 text-xs rounded-lg border px-3 py-2 transition-colors flex items-center justify-center gap-1.5 ${originMode === "manual" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/50"}`}
              data-testid="button-origin-manual"
            >
              <Navigation size={13} /> Coordonnée manuelle
            </button>
          </div>

          {originMode === "manual" && (
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Label className="text-xs">Coordonnée « lat, lng »</Label>
                <Input
                  value={manualInput}
                  onChange={e => setManualInput(e.target.value)}
                  placeholder="48.8976, 2.3299"
                  className="h-9 text-sm mt-1"
                  data-testid="input-manual-origin"
                />
              </div>
              <Button onClick={applyManual} className="h-9" data-testid="button-apply-manual">Valider</Button>
            </div>
          )}

          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <MapPin size={12} className="text-primary" />
            Origine active :{" "}
            <span className="font-mono text-foreground" data-testid="text-active-origin">
              {origin.lat.toFixed(4)}, {origin.lng.toFixed(4)}
            </span>
            {originMode === "gps" && isFallback && <span className="text-slate-400">(fallback Bd Ney)</span>}
          </div>
        </CardContent>
      </Card>

      {/* ── 2. Tableau des 14 zones (repositionnement temps réel) ────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <RouteIcon size={15} /> Repositionnement vers toutes les zones
            <span className="text-xs font-normal text-muted-foreground ml-auto">{allZones.length} zones</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2">
          {allZones.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">Chargement des trajets temps réel…</p>
          ) : (
            <div className="space-y-1.5">
              {/* En-têtes */}
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-2 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                <span>Zone</span>
                <span className="text-right w-12">ETA</span>
                <span className="text-right w-12">Dist.</span>
                <span className="text-right w-12">Score</span>
              </div>
              {allZones.map((z: any) => {
                const id = z.zone?.id;
                const flag = estimationFlag(z);
                const isSel = id === selectedZoneId;
                return (
                  <button
                    key={id}
                    onClick={() => setSelectedZoneId(id)}
                    className={`w-full grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center px-2 py-2 rounded-lg border text-left transition-colors ${isSel ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted/50"}`}
                    data-testid={`row-zone-${id}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">{z.zone?.name}</span>
                        {best?.zone?.id === id && (
                          <Badge variant="outline" className="border-green-500/40 text-green-400 text-[9px] px-1 py-0 h-4">TOP</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <SourceBadge source={z.distanceSource} />
                        {flag && <span className={`text-[10px] font-medium ${flag.cls}`}>{flag.label}</span>}
                      </div>
                    </div>
                    <span className="text-right w-12 text-sm font-mono tabular-nums">
                      <span className="font-semibold">{z.etaMinutes}</span>
                      <span className="text-[10px] text-muted-foreground">min</span>
                    </span>
                    <span className="text-right w-12 text-sm font-mono tabular-nums text-muted-foreground">
                      {z.distanceKm}<span className="text-[10px]">km</span>
                    </span>
                    <span className="text-right w-12">
                      <Badge variant="outline" className="text-[10px] px-1 tabular-nums">{z.globalScore}</Badge>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 3. Rentabilité de la course depuis la zone sélectionnée ──────────── */}
      {selectedZone && (() => {
        const id = selectedZone.zone?.id;
        const profile = ZONE_COURSE_PROFILE[id];
        const r = calc.data;
        return (
          <Card className="border-primary/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp size={15} className="text-primary" />
                Rentabilité course — {profile?.label ?? selectedZone.zone?.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Récap repositionnement + course */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-muted/40 rounded-lg p-2.5">
                  <p className="text-muted-foreground flex items-center gap-1"><Navigation size={11} /> Repositionnement</p>
                  <p className="font-semibold mt-0.5">
                    {selectedZone.etaMinutes} min · {selectedZone.distanceKm} km
                  </p>
                  <div className="mt-1"><SourceBadge source={selectedZone.distanceSource} /></div>
                </div>
                <div className="bg-muted/40 rounded-lg p-2.5">
                  <p className="text-muted-foreground flex items-center gap-1"><RouteIcon size={11} /> Course client</p>
                  <p className="font-semibold mt-0.5">
                    {profile?.avgDistKm} km · {r ? `${r.durationMin} min` : "…"}
                  </p>
                  <p className="text-muted-foreground mt-0.5">Tarif réf. {profile?.avgFare} €</p>
                </div>
              </div>

              {!r ? (
                <p className="text-sm text-muted-foreground text-center py-3">
                  {calc.isPending ? "Calcul de la rentabilité…" : "Sélectionnez une zone"}
                </p>
              ) : (
                <>
                  <div className={`rounded-lg border-2 p-3 ${r.isProfitable ? "border-green-500/50 bg-green-500/5" : "border-red-500/50 bg-red-500/5"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {r.isProfitable
                          ? <CheckCircle size={18} className="text-green-500" />
                          : <XCircle size={18} className="text-red-500" />}
                        <span className="font-bold text-sm">{r.isProfitable ? "Course rentable" : "En dessous du seuil"}</span>
                      </div>
                      <Badge variant="outline" className={r.isProfitable ? "border-green-500/40 text-green-400" : "border-red-500/40 text-red-400"}>
                        {r.profitabilityScore}/100
                      </Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-background/60 rounded-lg p-2 text-center">
                        <p className="text-[10px] text-muted-foreground">Tarif</p>
                        <p className="text-base font-bold text-indigo-400" data-testid="text-fare">{r.fare.toFixed(0)} €</p>
                      </div>
                      <div className="bg-background/60 rounded-lg p-2 text-center">
                        <p className="text-[10px] text-muted-foreground">Profit net</p>
                        <p className={`text-base font-bold ${r.netProfit >= 0 ? "text-green-400" : "text-red-400"}`} data-testid="text-net-profit">
                          {r.netProfit >= 0 ? "+" : ""}{r.netProfit.toFixed(1)} €
                        </p>
                      </div>
                      <div className="bg-background/60 rounded-lg p-2 text-center">
                        <p className="text-[10px] text-muted-foreground">Taux horaire</p>
                        <p className={`text-base font-bold ${r.hourlyRate >= 30 ? "text-green-400" : r.hourlyRate >= 20 ? "text-amber-400" : "text-red-400"}`} data-testid="text-hourly-rate">
                          {r.hourlyRate.toFixed(0)} €/h
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="flex justify-between"><span className="text-muted-foreground">Tarif brut</span><span className="font-medium text-indigo-400">+{r.fare.toFixed(2)} €</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Commission</span><span className="font-medium text-red-400">−{r.commission.toFixed(2)} €</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Carburant</span><span className="font-medium text-orange-400">−{r.fuelCost.toFixed(2)} €</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Usure</span><span className="font-medium text-yellow-400">−{r.wearCost.toFixed(2)} €</span></div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* ── 4. Comparaison des sources (TomTom vs OSRM vs calibré) ───────────── */}
      {selectedZone && sourceComparison && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Gauge size={15} /> Comparaison des sources de routing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                <span className="flex items-center gap-2"><SourceBadge source="tomtom" /> <span className="text-xs text-muted-foreground">temps réel + trafic</span></span>
                <span className="font-mono font-semibold tabular-nums" data-testid="text-eta-tomtom">
                  {sourceComparison.etaTomtom != null ? `${sourceComparison.etaTomtom} min` : "n/a"}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                <span className="flex items-center gap-2"><SourceBadge source="osrm" /> <span className="text-xs text-muted-foreground">routes sans trafic</span></span>
                <span className="font-mono font-semibold tabular-nums" data-testid="text-eta-osrm">{sourceComparison.etaOsrm} min</span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                <span className="flex items-center gap-2"><SourceBadge source="calibrated" /> <span className="text-xs text-muted-foreground">réf. Bd Ney</span></span>
                <span className="font-mono font-semibold tabular-nums" data-testid="text-eta-calibrated">{sourceComparison.etaCalibrated} min</span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock size={12} /> Écart trafic (TomTom vs OSRM)</span>
                <span className={`font-mono font-semibold tabular-nums ${
                  sourceComparison.ecartPct == null ? "text-muted-foreground"
                  : sourceComparison.ecartPct > 10 ? "text-amber-400"
                  : sourceComparison.ecartPct < -10 ? "text-emerald-400"
                  : "text-foreground"
                }`} data-testid="text-ecart-pct">
                  {sourceComparison.ecartPct == null ? "n/a" : `${sourceComparison.ecartPct > 0 ? "+" : ""}${sourceComparison.ecartPct}%`}
                </span>
              </div>
            </div>
            <Separator className="my-3" />
            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <Info size={12} className="mt-0.5 shrink-0 text-primary" />
              La source effective de cette zone est <strong className="text-foreground">{sourceComparison.src}</strong>.
              L'ETA peut légèrement sous-estimer mais jamais surestimer (× 0.93 anti-surestimation appliqué côté serveur).
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
