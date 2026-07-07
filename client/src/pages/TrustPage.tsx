/**
 * TrustPage.tsx — Couche TRUST & TRANSPARENCE (gaps benchmark)
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspiré de : Para (pourboire, flags client), Mystro (historique offres
 * complet), Everlance (garantie audit fiscal), Stride (comparateur
 * commissions plateformes).
 *
 * Sections :
 *   1. Prévision pourboire (formulaire → estimation)
 *   2. Clients flaggés (liste éditable rouge/vert)
 *   3. Zones flaggées (liste simplifiée type carte)
 *   4. Historique offres complet (tableau avec filtres)
 *   5. Bouclier fiscal (checklist conformité)
 *   6. Journal d'incidents (liste + bouton +Nouveau)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ShieldCheck,
  Flag,
  MapPin,
  History,
  FileCheck,
  AlertTriangle,
  Coins,
  Search,
  Plus,
  Trash2,
  ThumbsUp,
  ThumbsDown,
  CheckCircle2,
  XCircle,
  Clock,
  Gauge,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface ClientFlag {
  id: number;
  client_ref: string;
  type: "positif" | "negatif";
  tag: string;
  note: string | null;
  ts: string;
  source: string;
}

interface LocationFlag {
  id: number;
  address: string;
  lat: number | null;
  lng: number | null;
  type: "hotspot" | "safe" | "dangereux" | "zone_morte" | "contrôle_police";
  note: string | null;
  votes: number;
  ts: string;
}

interface OfferRow {
  id: number;
  ts: string;
  platform: string;
  zone_pickup: string | null;
  zone_dropoff: string | null;
  fare: number;
  distance_km: number | null;
  duration_min: number | null;
  status: "acceptée" | "refusée" | "expirée";
  reason: string | null;
}

interface AllOffersResult {
  offers: OfferRow[];
  stats: {
    total: number;
    acceptées: number;
    refusées: number;
    expirées: number;
    ca_total_accepte: number;
    ca_manque_estime_refuse: number;
    meilleur_taux_horaire_zone: string | null;
  };
  analyse_fr: string;
}

interface AuditShieldResult {
  score_conformite: number;
  statut: "protégé" | "vigilance" | "risque";
  inventaire: { categorie: string; ok: boolean; detail_fr: string }[];
  actions_recommandees_fr: string[];
}

interface IncidentRow {
  id: number;
  ts: string;
  type: "agression" | "arnaque" | "impayé" | "dispute" | "autre";
  description: string | null;
  plateforme: string | null;
  montant: number | null;
  resolu: number;
}

interface TipForecast {
  probable_tip_eur: number;
  probable_tip_pct: number;
  confidence: number;
  sample_size: number;
  basis_fr: string;
}

const TAG_LABELS: Record<string, string> = {
  ponctuel: "Ponctuel",
  pourboire: "Pourboire",
  agressif: "Agressif",
  malpoli: "Malpoli",
  généreux: "Généreux",
  prof: "Professionnel",
};

const LOCATION_TYPE_LABELS: Record<string, string> = {
  hotspot: "Hotspot",
  safe: "Zone sûre",
  dangereux: "Dangereux",
  zone_morte: "Zone morte",
  contrôle_police: "Contrôle police",
};

const LOCATION_TYPE_COLOR: Record<string, string> = {
  hotspot: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  safe: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
  dangereux: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  zone_morte: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30",
  contrôle_police: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
};

const INCIDENT_TYPE_LABELS: Record<string, string> = {
  agression: "Agression",
  arnaque: "Arnaque",
  "impayé": "Impayé",
  dispute: "Dispute",
  autre: "Autre",
};

const OFFER_STATUS_COLOR: Record<string, string> = {
  "acceptée": "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "refusée": "bg-red-500/15 text-red-600 dark:text-red-400",
  "expirée": "bg-slate-500/15 text-slate-600 dark:text-slate-400",
};

function fmtDate(ts: string) {
  try {
    return new Date(ts).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return ts;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Prévision pourboire
// ─────────────────────────────────────────────────────────────────────────────
function TipForecastSection() {
  const [zonePickup, setZonePickup] = useState("Gare de Lyon");
  const [zoneDropoff, setZoneDropoff] = useState("La Défense");
  const [hour, setHour] = useState(String(new Date().getHours()));
  const [day, setDay] = useState("vendredi");
  const [fare, setFare] = useState("25");
  const [result, setResult] = useState<TipForecast | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleForecast() {
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/trust/tip-forecast", {
        zone_pickup: zonePickup,
        zone_dropoff: zoneDropoff,
        hour: Number(hour),
        day,
        fare: Number(fare),
      });
      setResult(await res.json());
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card data-testid="card-tip-forecast">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins size={18} className="text-amber-500" />
          Prévision pourboire
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Estimation statistique basée sur ton historique local — jamais une garantie.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder="Zone de prise en charge"
            value={zonePickup}
            onChange={(e) => setZonePickup(e.target.value)}
            className="h-11"
            data-testid="input-tip-zone-pickup"
          />
          <Input
            placeholder="Zone de dépose"
            value={zoneDropoff}
            onChange={(e) => setZoneDropoff(e.target.value)}
            className="h-11"
            data-testid="input-tip-zone-dropoff"
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Input
            type="number"
            placeholder="Heure"
            value={hour}
            onChange={(e) => setHour(e.target.value)}
            className="h-11"
            data-testid="input-tip-hour"
          />
          <Select value={day} onValueChange={setDay}>
            <SelectTrigger className="h-11" data-testid="select-tip-day">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"].map((d) => (
                <SelectItem key={d} value={d}>
                  {d.charAt(0).toUpperCase() + d.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            placeholder="Prix course €"
            value={fare}
            onChange={(e) => setFare(e.target.value)}
            className="h-11"
            data-testid="input-tip-fare"
          />
        </div>
        <Button
          onClick={handleForecast}
          disabled={loading}
          className="w-full h-11"
          data-testid="button-tip-forecast"
        >
          {loading ? "Calcul…" : "Estimer le pourboire probable"}
        </Button>

        {result && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1" data-testid="result-tip-forecast">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-amber-500">{result.probable_tip_eur.toFixed(2)} €</span>
              <span className="text-sm text-muted-foreground">≈ {result.probable_tip_pct.toFixed(1)}% du prix</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Gauge size={12} />
              Confiance : {Math.round(result.confidence * 100)}% ({result.sample_size} observation{result.sample_size > 1 ? "s" : ""})
            </div>
            <p className="text-xs text-muted-foreground">{result.basis_fr}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Clients flaggés
// ─────────────────────────────────────────────────────────────────────────────
function ClientFlagsSection() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [lookupPhone, setLookupPhone] = useState("");
  const [lookupResult, setLookupResult] = useState<any>(null);

  const { data: flags = [], isLoading } = useQuery<ClientFlag[]>({
    queryKey: ["/api/trust/flags"],
    queryFn: async () => (await apiRequest("GET", "/api/trust/flags")).json(),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/trust/flags/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/trust/flags"] }),
  });

  async function handleLookup() {
    if (!lookupPhone) return;
    const res = await apiRequest("GET", `/api/trust/passenger-lookup?phone=${encodeURIComponent(lookupPhone)}`);
    setLookupResult(await res.json());
  }

  return (
    <Card data-testid="card-client-flags">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Flag size={18} className="text-rose-500" />
          Clients flaggés
        </CardTitle>
        <Button size="sm" onClick={() => setShowNew(true)} className="h-9" data-testid="button-new-flag">
          <Plus size={14} className="mr-1" />
          Nouveau
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Vérification passager instantanée */}
        <div className="flex gap-2">
          <Input
            placeholder="Rechercher un numéro (vérification instantanée)"
            value={lookupPhone}
            onChange={(e) => setLookupPhone(e.target.value)}
            className="h-11"
            data-testid="input-passenger-lookup"
          />
          <Button variant="outline" onClick={handleLookup} className="h-11 px-3" data-testid="button-passenger-lookup">
            <Search size={16} />
          </Button>
        </div>
        {lookupResult && (
          <div className="rounded-lg border border-border p-2 text-xs" data-testid="result-passenger-lookup">
            {lookupResult.verdict_fr}
          </div>
        )}

        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : flags.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Aucun client flaggé pour l'instant.</p>
        ) : (
          <div className="space-y-2">
            {flags.map((f) => (
              <div
                key={f.id}
                className={`flex items-center justify-between gap-2 rounded-lg border p-3 ${
                  f.type === "positif"
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-red-500/30 bg-red-500/5"
                }`}
                data-testid={`row-flag-${f.id}`}
              >
                <div className="flex items-start gap-2 min-w-0">
                  {f.type === "positif" ? (
                    <ThumbsUp size={16} className="text-emerald-500 mt-0.5 shrink-0" />
                  ) : (
                    <ThumbsDown size={16} className="text-red-500 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{f.client_ref}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {TAG_LABELS[f.tag] || f.tag}
                      </Badge>
                      {f.source === "community" && (
                        <Badge variant="secondary" className="text-[10px]">
                          Communauté
                        </Badge>
                      )}
                    </div>
                    {f.note && <p className="text-xs text-muted-foreground mt-0.5">{f.note}</p>}
                  </div>
                </div>
                <button
                  onClick={() => deleteMut.mutate(f.id)}
                  className="tap-target shrink-0 p-2 text-muted-foreground hover:text-destructive"
                  aria-label="Supprimer le flag"
                  data-testid={`button-delete-flag-${f.id}`}
                  style={{ minWidth: 44, minHeight: 44 }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {showNew && <NewFlagDialog onClose={() => setShowNew(false)} />}
    </Card>
  );
}

function NewFlagDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [clientRef, setClientRef] = useState("");
  const [type, setType] = useState<"positif" | "negatif">("positif");
  const [tag, setTag] = useState("ponctuel");
  const [note, setNote] = useState("");

  const mutation = useMutation({
    mutationFn: async () =>
      apiRequest("POST", "/api/trust/flags", { client_ref: clientRef, type, tag, note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/trust/flags"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nouveau flag client</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Téléphone ou identifiant client *"
            value={clientRef}
            onChange={(e) => setClientRef(e.target.value)}
            className="h-11"
            data-testid="input-flag-client-ref"
          />
          <div className="grid grid-cols-2 gap-2">
            <Select value={type} onValueChange={(v) => setType(v as any)}>
              <SelectTrigger className="h-11" data-testid="select-flag-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="positif">Positif</SelectItem>
                <SelectItem value="negatif">Négatif</SelectItem>
              </SelectContent>
            </Select>
            <Select value={tag} onValueChange={setTag}>
              <SelectTrigger className="h-11" data-testid="select-flag-tag">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TAG_LABELS).map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea placeholder="Note (optionnel)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="h-11">
            Annuler
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!clientRef || mutation.isPending}
            className="h-11"
            data-testid="button-save-flag"
          >
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Zones flaggées
// ─────────────────────────────────────────────────────────────────────────────
function LocationFlagsSection() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);

  const { data: locations = [], isLoading } = useQuery<LocationFlag[]>({
    queryKey: ["/api/trust/locations"],
    queryFn: async () => (await apiRequest("GET", "/api/trust/locations")).json(),
  });

  const voteMut = useMutation({
    mutationFn: async ({ id, delta }: { id: number; delta: number }) =>
      apiRequest("POST", `/api/trust/locations/${id}/vote`, { delta }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/trust/locations"] }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/trust/locations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/trust/locations"] }),
  });

  return (
    <Card data-testid="card-location-flags">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin size={18} className="text-sky-500" />
          Zones flaggées
        </CardTitle>
        <Button size="sm" onClick={() => setShowNew(true)} className="h-9" data-testid="button-new-location">
          <Plus size={14} className="mr-1" />
          Nouveau
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Carte simplifiée : grille de pastilles positionnées relativement (pas de dépendance carto) */}
        <div className="relative w-full h-32 rounded-lg border border-border bg-muted/30 overflow-hidden">
          {locations.map((loc, i) => (
            <div
              key={loc.id}
              title={loc.address}
              className={`absolute w-3 h-3 rounded-full border ${LOCATION_TYPE_COLOR[loc.type]}`}
              style={{
                left: `${10 + ((i * 37) % 80)}%`,
                top: `${15 + ((i * 53) % 70)}%`,
              }}
            />
          ))}
          <span className="absolute bottom-1 right-2 text-[10px] text-muted-foreground">Carte simplifiée (positions indicatives)</span>
        </div>

        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : locations.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Aucune zone flaggée pour l'instant.</p>
        ) : (
          <div className="space-y-2">
            {locations.map((loc) => (
              <div
                key={loc.id}
                className={`rounded-lg border p-3 ${LOCATION_TYPE_COLOR[loc.type]}`}
                data-testid={`row-location-${loc.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{loc.address}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {LOCATION_TYPE_LABELS[loc.type]}
                      </Badge>
                    </div>
                    {loc.note && <p className="text-xs mt-0.5 opacity-80">{loc.note}</p>}
                  </div>
                  <button
                    onClick={() => deleteMut.mutate(loc.id)}
                    className="tap-target shrink-0 p-2 opacity-70 hover:opacity-100"
                    aria-label="Supprimer la zone"
                    style={{ minWidth: 44, minHeight: 44 }}
                    data-testid={`button-delete-location-${loc.id}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={() => voteMut.mutate({ id: loc.id, delta: 1 })}
                    className="tap-target flex items-center gap-1 px-2 py-1 rounded bg-black/5 dark:bg-white/10 text-xs"
                    style={{ minHeight: 32 }}
                    data-testid={`button-upvote-location-${loc.id}`}
                  >
                    <ThumbsUp size={12} /> {loc.votes}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {showNew && <NewLocationDialog onClose={() => setShowNew(false)} />}
    </Card>
  );
}

function NewLocationDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [address, setAddress] = useState("");
  const [type, setType] = useState<LocationFlag["type"]>("hotspot");
  const [note, setNote] = useState("");

  const mutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/trust/locations", { address, type, note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/trust/locations"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nouvelle zone flaggée</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Adresse ou lieu *"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="h-11"
            data-testid="input-location-address"
          />
          <Select value={type} onValueChange={(v) => setType(v as any)}>
            <SelectTrigger className="h-11" data-testid="select-location-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(LOCATION_TYPE_LABELS).map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea placeholder="Note (optionnel)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="h-11">
            Annuler
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!address || mutation.isPending}
            className="h-11"
            data-testid="button-save-location"
          >
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Historique offres complet
// ─────────────────────────────────────────────────────────────────────────────
function AllOffersSection() {
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, isLoading } = useQuery<AllOffersResult>({
    queryKey: ["/api/trust/all-offers", statusFilter],
    queryFn: async () =>
      (
        await apiRequest(
          "GET",
          `/api/trust/all-offers${statusFilter !== "all" ? `?status=${encodeURIComponent(statusFilter)}` : ""}`
        )
      ).json(),
  });

  return (
    <Card data-testid="card-all-offers">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History size={18} className="text-indigo-500" />
          Historique offres complet
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : data ? (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-border p-2">
                <div className="text-lg font-bold">{data.stats.total}</div>
                <div className="text-[10px] text-muted-foreground">Total offres</div>
              </div>
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2">
                <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{data.stats.acceptées}</div>
                <div className="text-[10px] text-muted-foreground">Acceptées</div>
              </div>
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2">
                <div className="text-lg font-bold text-red-600 dark:text-red-400">{data.stats.refusées}</div>
                <div className="text-[10px] text-muted-foreground">Refusées</div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{data.analyse_fr}</p>

            {/* Filtres */}
            <div className="flex gap-2 flex-wrap">
              {["all", "acceptée", "refusée", "expirée"].map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`tap-target px-3 py-2 rounded-full text-xs border transition-colors ${
                    statusFilter === s
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground"
                  }`}
                  style={{ minHeight: 36 }}
                  data-testid={`button-filter-offers-${s}`}
                >
                  {s === "all" ? "Toutes" : s.charAt(0).toUpperCase() + s.slice(1) + "s"}
                </button>
              ))}
            </div>

            {/* Tableau */}
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-xs min-w-[520px]">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="px-2 py-1.5 font-medium">Date</th>
                    <th className="px-2 py-1.5 font-medium">Plateforme</th>
                    <th className="px-2 py-1.5 font-medium">Trajet</th>
                    <th className="px-2 py-1.5 font-medium">Prix</th>
                    <th className="px-2 py-1.5 font-medium">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {data.offers.map((o) => (
                    <tr key={o.id} className="border-b border-border/50" data-testid={`row-offer-${o.id}`}>
                      <td className="px-2 py-1.5 whitespace-nowrap">{fmtDate(o.ts)}</td>
                      <td className="px-2 py-1.5">{o.platform}</td>
                      <td className="px-2 py-1.5 truncate max-w-[140px]">
                        {o.zone_pickup} → {o.zone_dropoff}
                      </td>
                      <td className="px-2 py-1.5 font-medium">{o.fare.toFixed(2)} €</td>
                      <td className="px-2 py-1.5">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] ${OFFER_STATUS_COLOR[o.status]}`}>
                          {o.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Bouclier fiscal
// ─────────────────────────────────────────────────────────────────────────────
function AuditShieldSection() {
  const { data, isLoading } = useQuery<AuditShieldResult>({
    queryKey: ["/api/trust/audit-shield"],
    queryFn: async () => (await apiRequest("GET", "/api/trust/audit-shield")).json(),
  });

  const statutColor: Record<string, string> = {
    "protégé": "text-emerald-500",
    vigilance: "text-amber-500",
    risque: "text-red-500",
  };

  return (
    <Card data-testid="card-audit-shield">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileCheck size={18} className="text-emerald-500" />
          Bouclier fiscal
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : data ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold">{data.score_conformite}%</div>
                <div className={`text-sm font-medium ${statutColor[data.statut]}`}>
                  Statut : {data.statut === "protégé" ? "Protégé" : data.statut === "vigilance" ? "Vigilance" : "Risque"}
                </div>
              </div>
              <ShieldCheck size={40} className={statutColor[data.statut]} />
            </div>

            <div className="space-y-1.5">
              {data.inventaire.map((item) => (
                <div key={item.categorie} className="flex items-start gap-2 text-sm" data-testid={`row-audit-${item.categorie}`}>
                  {item.ok ? (
                    <CheckCircle2 size={16} className="text-emerald-500 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
                  )}
                  <div>
                    <span className="font-medium">{item.categorie}</span>
                    <p className="text-xs text-muted-foreground">{item.detail_fr}</p>
                  </div>
                </div>
              ))}
            </div>

            {data.actions_recommandees_fr.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-xs font-medium mb-1">Actions recommandées :</p>
                <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                  {data.actions_recommandees_fr.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparateur commissions plateformes
// ─────────────────────────────────────────────────────────────────────────────
function CommissionComparatorSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/trust/commission-comparator"],
    queryFn: async () => (await apiRequest("GET", "/api/trust/commission-comparator")).json(),
  });

  return (
    <Card data-testid="card-commission-comparator">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge size={18} className="text-violet-500" />
          Comparateur commissions plateformes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : data ? (
          <>
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-xs min-w-[420px]">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="px-2 py-1.5 font-medium">Plateforme</th>
                    <th className="px-2 py-1.5 font-medium">Normale</th>
                    <th className="px-2 py-1.5 font-medium">Ce créneau</th>
                    <th className="px-2 py-1.5 font-medium">Net / 100€</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tableau.map((row: any) => (
                    <tr key={row.plateforme} className="border-b border-border/50">
                      <td className="px-2 py-1.5 font-medium">{row.plateforme}</td>
                      <td className="px-2 py-1.5">{row.commission_pct_normale}%</td>
                      <td className="px-2 py-1.5">{row.commission_pct_creneau_actuel}%</td>
                      <td className="px-2 py-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                        {row.net_pour_100e_course.toFixed(2)} €
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{data.conseil_fr}</p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Journal d'incidents
// ─────────────────────────────────────────────────────────────────────────────
function IncidentsSection() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);

  const { data: incidents = [], isLoading } = useQuery<IncidentRow[]>({
    queryKey: ["/api/trust/incidents"],
    queryFn: async () => (await apiRequest("GET", "/api/trust/incidents")).json(),
  });

  const toggleResolved = useMutation({
    mutationFn: async (row: IncidentRow) =>
      apiRequest("PUT", `/api/trust/incidents/${row.id}`, { resolu: row.resolu ? 0 : 1 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/trust/incidents"] }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/trust/incidents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/trust/incidents"] }),
  });

  return (
    <Card data-testid="card-incidents">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle size={18} className="text-orange-500" />
          Journal d'incidents
        </CardTitle>
        <Button size="sm" onClick={() => setShowNew(true)} className="h-9" data-testid="button-new-incident">
          <Plus size={14} className="mr-1" />
          Nouveau
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Aucun incident journalisé.</p>
        ) : (
          incidents.map((inc) => (
            <div
              key={inc.id}
              className={`rounded-lg border p-3 ${
                inc.resolu ? "border-border opacity-60" : "border-orange-500/30 bg-orange-500/5"
              }`}
              data-testid={`row-incident-${inc.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-[10px]">
                      {INCIDENT_TYPE_LABELS[inc.type]}
                    </Badge>
                    {inc.plateforme && <span className="text-xs text-muted-foreground">{inc.plateforme}</span>}
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Clock size={10} />
                      {fmtDate(inc.ts)}
                    </span>
                  </div>
                  {inc.description && <p className="text-xs mt-1">{inc.description}</p>}
                  {inc.montant != null && inc.montant > 0 && (
                    <p className="text-xs font-medium mt-0.5">Montant concerné : {inc.montant.toFixed(2)} €</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => toggleResolved.mutate(inc)}
                    className="tap-target p-2 text-muted-foreground hover:text-emerald-500"
                    style={{ minWidth: 44, minHeight: 44 }}
                    aria-label="Marquer résolu"
                    data-testid={`button-resolve-incident-${inc.id}`}
                  >
                    <CheckCircle2 size={16} className={inc.resolu ? "text-emerald-500" : ""} />
                  </button>
                  <button
                    onClick={() => deleteMut.mutate(inc.id)}
                    className="tap-target p-2 text-muted-foreground hover:text-destructive"
                    style={{ minWidth: 44, minHeight: 44 }}
                    aria-label="Supprimer"
                    data-testid={`button-delete-incident-${inc.id}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
      {showNew && <NewIncidentDialog onClose={() => setShowNew(false)} />}
    </Card>
  );
}

function NewIncidentDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<IncidentRow["type"]>("dispute");
  const [description, setDescription] = useState("");
  const [plateforme, setPlateforme] = useState("");
  const [montant, setMontant] = useState("");

  const mutation = useMutation({
    mutationFn: async () =>
      apiRequest("POST", "/api/trust/incidents", {
        type,
        description,
        plateforme,
        montant: montant ? Number(montant) : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/trust/incidents"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nouvel incident</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={type} onValueChange={(v) => setType(v as any)}>
            <SelectTrigger className="h-11" data-testid="select-incident-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(INCIDENT_TYPE_LABELS).map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Plateforme (Uber, Bolt…)"
            value={plateforme}
            onChange={(e) => setPlateforme(e.target.value)}
            className="h-11"
          />
          <Input
            type="number"
            placeholder="Montant concerné (€)"
            value={montant}
            onChange={(e) => setMontant(e.target.value)}
            className="h-11"
          />
          <Textarea
            placeholder="Description de l'incident"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="h-11">
            Annuler
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="h-11" data-testid="button-save-incident">
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Preuve géolocalisée (bonus, rattaché au journal d'incidents pour litiges)
// ─────────────────────────────────────────────────────────────────────────────
function GeoProofSection() {
  const [creating, setCreating] = useState(false);
  const [lastProof, setLastProof] = useState<any>(null);

  async function handleCreate() {
    setCreating(true);
    try {
      if (!navigator.geolocation) {
        const res = await apiRequest("POST", "/api/trust/geo-proof", { lat: 48.8566, lng: 2.3522, context: "Position par défaut (GPS indisponible)" });
        setLastProof(await res.json());
        return;
      }
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const res = await apiRequest("POST", "/api/trust/geo-proof", {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            context: "Preuve manuelle générée depuis Trust & Transparence",
          });
          setLastProof(await res.json());
          setCreating(false);
        },
        async () => {
          const res = await apiRequest("POST", "/api/trust/geo-proof", { lat: 48.8566, lng: 2.3522, context: "Position refusée par le navigateur" });
          setLastProof(await res.json());
          setCreating(false);
        }
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card data-testid="card-geo-proof">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin size={18} className="text-cyan-500" />
          Preuve géolocalisée
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Génère un horodatage signé de ta position actuelle, utile en cas de litige avec un client ou une plateforme.
        </p>
        <Button onClick={handleCreate} disabled={creating} className="w-full h-11" data-testid="button-create-geo-proof">
          {creating ? "Capture…" : "Capturer une preuve maintenant"}
        </Button>
        {lastProof && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs space-y-1" data-testid="result-geo-proof">
            <p>
              Signature : <span className="font-mono">{lastProof.signature}</span>
            </p>
            <p>Horodatage : {fmtDate(lastProof.ts)}</p>
            <p className="text-muted-foreground">{lastProof.verification_note_fr}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page principale
// ─────────────────────────────────────────────────────────────────────────────
export default function TrustPage() {
  return (
    <div className="p-3 sm:p-4 max-w-3xl mx-auto space-y-4 pb-24">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={24} className="text-primary" />
        <div>
          <h1 className="text-lg font-bold leading-none">Trust & Transparence</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Pourboires, flags, historique complet, fiscalité, incidents — tout ce qui protège ta relation de confiance.
          </p>
        </div>
      </div>

      <TipForecastSection />
      <ClientFlagsSection />
      <LocationFlagsSection />
      <AllOffersSection />
      <AuditShieldSection />
      <CommissionComparatorSection />
      <IncidentsSection />
      <GeoProofSection />
    </div>
  );
}
