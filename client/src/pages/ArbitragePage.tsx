/**
 * ArbitragePage.tsx — Couche ARBITRAGE MULTI-PLATEFORME AUTOMATIQUE
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspiré des gaps benchmark (Para, Mystro, Gridwise, Solo, inDrive) :
 *   - Simulateur d'offre (accept/refuse/consider selon règles + prix de réserve)
 *   - Mes règles (CRUD, toggle actif)
 *   - Historique des offres reçues (acceptées + refusées)
 *   - Live Pulse (carte SSE — blips k-anonymisés d'offres reçues par d'autres chauffeurs)
 *   - Analyse rétrospective des refus
 *   - Garantie €/h prévue (jauge de confiance)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, API_BASE, getAuthToken } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Filter,
  Zap,
  History,
  Radar,
  TrendingUp,
  Settings,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Trash2,
  PlusCircle,
  Gauge,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types (reflètent server/arbitrageEngine.ts)
// ─────────────────────────────────────────────────────────────────────────────
interface AutoRule {
  id: number;
  name: string;
  min_fare: number | null;
  min_per_km: number | null;
  min_per_min: number | null;
  avoid_zones: string[];
  force_zones: string[];
  active: boolean;
  priority: number;
}

interface OfferDecision {
  decision: "accept" | "refuse" | "consider";
  reasons: string[];
  score: number;
  alternative: string | null;
  per_km: number;
  per_min: number;
  reserve_price: number;
  net_estimate: number;
}

interface OfferHistoryRow {
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

interface RefusedAnalysis {
  total_refused: number;
  avg_fare_refused: number;
  would_have_been_profitable: number;
  estimated_missed_gain: number;
  insight_fr: string;
}

interface HourlyGuarantee {
  guaranteed_min: number;
  guaranteed_median: number;
  confidence: number;
  sample_size: number;
  hour: number;
}

interface PulseBlip {
  zone: string;
  platform: string;
  fare_range: string;
  ts: number;
}

const PLATFORMS = ["Uber", "Bolt", "Heetch", "FreeNow"];

function decisionBadge(decision: string) {
  if (decision === "accept") {
    return (
      <Badge className="bg-green-600/15 text-green-600 border-green-600/30 gap-1">
        <CheckCircle2 size={12} /> Accepté
      </Badge>
    );
  }
  if (decision === "refuse") {
    return (
      <Badge className="bg-red-600/15 text-red-600 border-red-600/30 gap-1">
        <XCircle size={12} /> Refusé
      </Badge>
    );
  }
  return (
    <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 gap-1">
      <HelpCircle size={12} /> À considérer
    </Badge>
  );
}

export default function ArbitragePage() {
  const qc = useQueryClient();

  // ─── Simulateur d'offre ───────────────────────────────────────────────────
  const [simPlatform, setSimPlatform] = useState("Uber");
  const [simFare, setSimFare] = useState("15");
  const [simKm, setSimKm] = useState("8");
  const [simMin, setSimMin] = useState("15");
  const [simFrom, setSimFrom] = useState("");
  const [simTo, setSimTo] = useState("");
  const [simResult, setSimResult] = useState<OfferDecision | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  const runSimulation = async () => {
    setSimLoading(true);
    try {
      const res = await apiRequest("POST", "/api/arbitrage/simulate", {
        platform: simPlatform,
        fare: Number(simFare) || 0,
        distanceKm: Number(simKm) || 0,
        durationMin: Number(simMin) || 0,
        from: simFrom || undefined,
        to: simTo || undefined,
      });
      const data = await res.json();
      setSimResult(data);
    } finally {
      setSimLoading(false);
    }
  };

  const recordSimulatedOffer = async () => {
    if (!simResult) return;
    await apiRequest("POST", "/api/arbitrage/offers", {
      platform: simPlatform,
      fare: Number(simFare) || 0,
      distanceKm: Number(simKm) || 0,
      durationMin: Number(simMin) || 0,
      from: simFrom || undefined,
      to: simTo || undefined,
      decision: simResult.decision === "consider" ? "accept" : simResult.decision,
    });
    qc.invalidateQueries({ queryKey: ["/api/arbitrage/offers"] });
    qc.invalidateQueries({ queryKey: ["/api/arbitrage/refused-analysis"] });
  };

  // ─── Mes règles ───────────────────────────────────────────────────────────
  const { data: rules = [], isLoading: rulesLoading } = useQuery<AutoRule[]>({
    queryKey: ["/api/arbitrage/rules"],
    queryFn: () => apiRequest("GET", "/api/arbitrage/rules").then((r) => r.json()),
  });

  const [newRuleName, setNewRuleName] = useState("");
  const [newRuleMinPerKm, setNewRuleMinPerKm] = useState("");

  const toggleRule = async (rule: AutoRule) => {
    await apiRequest("PUT", `/api/arbitrage/rules/${rule.id}`, { active: !rule.active });
    qc.invalidateQueries({ queryKey: ["/api/arbitrage/rules"] });
  };

  const deleteRule = async (id: number) => {
    await apiRequest("DELETE", `/api/arbitrage/rules/${id}`);
    qc.invalidateQueries({ queryKey: ["/api/arbitrage/rules"] });
  };

  const addRule = async () => {
    if (!newRuleName.trim()) return;
    await apiRequest("POST", "/api/arbitrage/rules", {
      name: newRuleName,
      min_per_km: newRuleMinPerKm ? Number(newRuleMinPerKm) : null,
      active: true,
      priority: 0,
    });
    setNewRuleName("");
    setNewRuleMinPerKm("");
    qc.invalidateQueries({ queryKey: ["/api/arbitrage/rules"] });
  };

  // ─── Historique des offres ────────────────────────────────────────────────
  const { data: offers = [], isLoading: offersLoading } = useQuery<OfferHistoryRow[]>({
    queryKey: ["/api/arbitrage/offers"],
    queryFn: () => apiRequest("GET", "/api/arbitrage/offers?limit=20").then((r) => r.json()),
  });

  // ─── Analyse rétrospective ────────────────────────────────────────────────
  const { data: refusedAnalysis } = useQuery<RefusedAnalysis>({
    queryKey: ["/api/arbitrage/refused-analysis"],
    queryFn: () => apiRequest("GET", "/api/arbitrage/refused-analysis").then((r) => r.json()),
  });

  // ─── Garantie €/h ─────────────────────────────────────────────────────────
  const { data: guarantee } = useQuery<HourlyGuarantee>({
    queryKey: ["/api/arbitrage/hourly-guarantee"],
    queryFn: () => apiRequest("GET", "/api/arbitrage/hourly-guarantee").then((r) => r.json()),
  });

  // ─── Live Pulse (SSE dédié) ───────────────────────────────────────────────
  const [pulseBlips, setPulseBlips] = useState<PulseBlip[]>([]);
  const [pulseConnected, setPulseConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const token = getAuthToken();
    const url = `${API_BASE}/api/pulse/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    // EventSource ne supporte pas les headers custom : on s'appuie sur withCredentials
    // (le cookie/token en mémoire est géré côté fetch ailleurs ; ici la connexion
    // fonctionne car requireAuth accepte aussi la session déjà établie par l'app).
    const es = new EventSource(`${API_BASE}/api/pulse/stream`, { withCredentials: true });
    esRef.current = es;

    es.onopen = () => setPulseConnected(true);
    es.onerror = () => setPulseConnected(false);
    es.addEventListener("pulse:blip", (e: MessageEvent) => {
      try {
        const blip: PulseBlip = JSON.parse(e.data);
        setPulseBlips((prev) => [blip, ...prev].slice(0, 12));
      } catch {
        /* ignore */
      }
    });

    return () => {
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="p-3 sm:p-4 space-y-4 pb-24 max-w-3xl mx-auto">
      <div>
        <h1 className="text-lg font-bold flex items-center gap-2">
          <Zap size={20} className="text-primary" /> Arbitrage multi-plateforme
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Décidez automatiquement quelles courses accepter, comparez vos plateformes et suivez votre garantie €/h.
        </p>
      </div>

      {/* ─── 1. Simulateur d'offre ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Gauge size={16} /> Simulateur d'offre
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Plateforme</Label>
              <select
                value={simPlatform}
                onChange={(e) => setSimPlatform(e.target.value)}
                className="w-full mt-1 h-11 rounded-md border border-input bg-background px-3 text-sm"
              >
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Prix (€)</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={simFare}
                onChange={(e) => setSimFare(e.target.value)}
                className="mt-1 h-11"
              />
            </div>
            <div>
              <Label className="text-xs">Distance (km)</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={simKm}
                onChange={(e) => setSimKm(e.target.value)}
                className="mt-1 h-11"
              />
            </div>
            <div>
              <Label className="text-xs">Durée (min)</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={simMin}
                onChange={(e) => setSimMin(e.target.value)}
                className="mt-1 h-11"
              />
            </div>
            <div>
              <Label className="text-xs">Départ</Label>
              <Input value={simFrom} onChange={(e) => setSimFrom(e.target.value)} placeholder="Paris 15e" className="mt-1 h-11" />
            </div>
            <div>
              <Label className="text-xs">Arrivée</Label>
              <Input value={simTo} onChange={(e) => setSimTo(e.target.value)} placeholder="CDG Roissy" className="mt-1 h-11" />
            </div>
          </div>

          <Button onClick={runSimulation} disabled={simLoading} className="w-full h-11" data-testid="button-simulate-offer">
            {simLoading ? "Analyse…" : "Analyser cette offre"}
          </Button>

          {simResult && (
            <div className="rounded-lg border border-border p-3 space-y-2 bg-muted/30">
              <div className="flex items-center justify-between">
                {decisionBadge(simResult.decision)}
                <span className="text-xs text-muted-foreground">Score {simResult.score}/100</span>
              </div>
              <Progress value={simResult.score} className="h-2" />
              <div className="text-xs text-muted-foreground grid grid-cols-2 gap-1">
                <span>≈ {simResult.per_km}€/km</span>
                <span>≈ {simResult.per_min}€/min</span>
                <span>Réserve : {simResult.reserve_price}€</span>
                <span>Net estimé : {simResult.net_estimate}€</span>
              </div>
              {simResult.alternative && (
                <p className="text-xs text-amber-600">Alternative suggérée : {simResult.alternative}</p>
              )}
              <ul className="text-xs space-y-1 list-disc list-inside text-foreground/80">
                {simResult.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              <Button
                variant="outline"
                size="sm"
                className="w-full h-10"
                onClick={recordSimulatedOffer}
                data-testid="button-record-offer"
              >
                Enregistrer dans l'historique
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── 2. Mes règles ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Settings size={16} /> Mes règles d'auto-décision
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {rulesLoading && <Skeleton className="h-16 w-full" />}
          {!rulesLoading && rules.length === 0 && (
            <p className="text-xs text-muted-foreground">Aucune règle configurée.</p>
          )}
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border p-2.5"
              data-testid={`rule-row-${rule.id}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{rule.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {rule.min_fare != null && `min ${rule.min_fare}€ · `}
                  {rule.min_per_km != null && `${rule.min_per_km}€/km · `}
                  {rule.min_per_min != null && `${rule.min_per_min}€/min · `}
                  {rule.avoid_zones.length > 0 && `évite: ${rule.avoid_zones.join(", ")} · `}
                  {rule.force_zones.length > 0 && `priorité: ${rule.force_zones.join(", ")}`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Switch checked={rule.active} onCheckedChange={() => toggleRule(rule)} />
                <button
                  onClick={() => deleteRule(rule.id)}
                  className="tap-target p-2 text-muted-foreground hover:text-destructive"
                  aria-label="Supprimer la règle"
                  style={{ minWidth: 44, minHeight: 44 }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}

          <div className="flex gap-2 pt-2 border-t border-border">
            <Input
              placeholder="Nom de la règle"
              value={newRuleName}
              onChange={(e) => setNewRuleName(e.target.value)}
              className="h-11 flex-1"
            />
            <Input
              placeholder="€/km min"
              type="number"
              value={newRuleMinPerKm}
              onChange={(e) => setNewRuleMinPerKm(e.target.value)}
              className="h-11 w-24"
            />
            <Button onClick={addRule} className="h-11 px-3" aria-label="Ajouter la règle">
              <PlusCircle size={18} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ─── 3. Historique des offres ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <History size={16} /> Historique des offres
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {offersLoading && <Skeleton className="h-24 w-full" />}
          {!offersLoading && offers.length === 0 && (
            <p className="text-xs text-muted-foreground">Aucune offre enregistrée pour le moment.</p>
          )}
          <div className="space-y-1.5 max-h-80 overflow-auto">
            {offers.map((o) => (
              <div
                key={o.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-xs"
                data-testid={`offer-row-${o.id}`}
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {o.platform} · {o.fare}€ · {o.distance_km}km
                  </p>
                  <p className="text-muted-foreground truncate">
                    {o.from_label ?? "?"} → {o.to_label ?? "?"} · {new Date(o.ts).toLocaleString("fr-FR")}
                  </p>
                </div>
                {decisionBadge(o.decision)}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ─── 4. Live Pulse ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Radar size={16} /> Live Pulse communautaire
            <Badge variant={pulseConnected ? "default" : "outline"} className="ml-auto text-[10px]">
              {pulseConnected ? "En direct" : "Connexion…"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[11px] text-muted-foreground mb-2">
            Offres reçues par d'autres chauffeurs à proximité (anonymisées, zone large — démo/simulation).
          </p>
          {pulseBlips.length === 0 && (
            <p className="text-xs text-muted-foreground">En attente des premiers signaux…</p>
          )}
          <div className="space-y-1.5">
            {pulseBlips.map((b, i) => (
              <div
                key={`${b.ts}-${i}`}
                className="flex items-center justify-between text-xs rounded-md bg-muted/40 px-2.5 py-1.5"
              >
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  {b.zone}
                </span>
                <span className="text-muted-foreground">{b.platform} · {b.fare_range}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ─── 5. Analyse rétrospective ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Filter size={16} /> Analyse rétrospective des refus
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!refusedAnalysis && <Skeleton className="h-16 w-full" />}
          {refusedAnalysis && (
            <>
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg bg-muted/40 p-2">
                  <p className="text-lg font-bold">{refusedAnalysis.total_refused}</p>
                  <p className="text-[11px] text-muted-foreground">Offres refusées</p>
                </div>
                <div className="rounded-lg bg-muted/40 p-2">
                  <p className="text-lg font-bold">{refusedAnalysis.avg_fare_refused}€</p>
                  <p className="text-[11px] text-muted-foreground">Prix moyen refusé</p>
                </div>
                <div className="rounded-lg bg-muted/40 p-2">
                  <p className="text-lg font-bold text-amber-600">{refusedAnalysis.would_have_been_profitable}</p>
                  <p className="text-[11px] text-muted-foreground">Auraient été rentables</p>
                </div>
                <div className="rounded-lg bg-muted/40 p-2">
                  <p className="text-lg font-bold text-red-600">{refusedAnalysis.estimated_missed_gain}€</p>
                  <p className="text-[11px] text-muted-foreground">Manque à gagner estimé</p>
                </div>
              </div>
              <p className="text-xs text-foreground/80 pt-1">{refusedAnalysis.insight_fr}</p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ─── 6. Garantie €/h prévue ───────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp size={16} /> Garantie €/h prévue
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!guarantee && <Skeleton className="h-16 w-full" />}
          {guarantee && (
            <>
              <div className="flex items-baseline justify-between">
                <div>
                  <p className="text-2xl font-bold">{guarantee.guaranteed_min}€/h</p>
                  <p className="text-[11px] text-muted-foreground">Minimum garanti (heure actuelle)</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-muted-foreground">{guarantee.guaranteed_median}€/h</p>
                  <p className="text-[11px] text-muted-foreground">Médiane historique</p>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
                  <span>Confiance</span>
                  <span>{Math.round(guarantee.confidence * 100)}%</span>
                </div>
                <Progress value={guarantee.confidence * 100} className="h-2" />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Basé sur {guarantee.sample_size} course{guarantee.sample_size > 1 ? "s" : ""} historiques à {guarantee.hour}h ± 1h.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
