/**
 * DiversificationPage.tsx — Couche DIVERSIFICATION DE REVENUS
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspiré benchmark : Roadie (colis intercités), LeCab/Marcel (B2B forfaitaire
 * garanti hors plateforme), Bonsai (devis/contrats), Solo Pay Guarantee,
 * cashback carburant Uber Pro Card.
 *
 * 6 sections :
 *   - Missions du jour  : colis + B2B + événements disponibles, CTA "Prendre"
 *   - Générer un devis  : formulaire → aperçu HTML imprimable
 *   - Réservations B2B  : liste + détail
 *   - Forfaits aéroport : grille tarifs
 *   - Cashback carburant: partenaires + économie mensuelle estimée
 *   - Mix revenu        : donut CSS pur, % par source
 *
 * Mobile-first, tap targets ≥ 44px, UI 100% française.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, API_BASE, getAuthToken } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Package, Building2, FileText, Plane, Fuel, PieChart,
  Truck, CalendarHeart, Check, Plus, Trash2, Printer, MapPin,
  Clock, Users as UsersIcon, TrendingUp, ShieldCheck, Store,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface ParcelMission {
  id: number;
  from_city: string;
  to_city: string;
  distance_km: number;
  price: number;
  deadline: string;
  notes: string | null;
  status: string;
}
interface B2bBooking {
  id: number;
  company: string;
  contact: string | null;
  date_time: string;
  from_addr: string;
  to_addr: string;
  passengers: number;
  forfait: number;
  statut: string;
  invoice_id: number | null;
}
interface EventMission {
  id: number;
  event_type: string;
  date: string;
  duration_hours: number;
  price: number;
  notes: string | null;
  status: string;
}
interface MarketplaceMission {
  id: number;
  source_platform: string;
  description: string;
  price: number;
  distance: number;
  commission_pct: number;
  net_estime: number;
  active: boolean;
}
interface AirportForfait {
  id: number;
  from_zone: string;
  to_airport: string;
  price: number;
  notes: string | null;
}
interface FuelCashback {
  id: number;
  nom: string;
  station: string;
  cashback_pct: number;
  conditions: string | null;
  economie_mensuelle_estimee: number;
}
interface RevenueMixItem {
  source: string;
  label: string;
  montant: number;
  pourcentage: number;
}
interface RevenueMix {
  period_days: number;
  breakdown: RevenueMixItem[];
  total_estime: number;
  diversification_score: number;
}
interface TodayMissions {
  parcels: (ParcelMission & { kind: string })[];
  b2b: (B2bBooking & { kind: string })[];
  events: (EventMission & { kind: string })[];
  total: number;
}

const TABS = [
  { key: "today", label: "Missions du jour", icon: Truck },
  { key: "quote", label: "Générer un devis", icon: FileText },
  { key: "b2b", label: "Réservations B2B", icon: Building2 },
  { key: "airport", label: "Forfaits aéroport", icon: Plane },
  { key: "cashback", label: "Cashback carburant", icon: Fuel },
  { key: "mix", label: "Mix revenu", icon: PieChart },
] as const;
type TabKey = typeof TABS[number]["key"];

const STATUT_COLORS: Record<string, string> = {
  disponible: "bg-blue-500/15 text-blue-500",
  prise: "bg-amber-500/15 text-amber-500",
  livree: "bg-green-500/15 text-green-500",
  terminee: "bg-green-500/15 text-green-500",
  annulee: "bg-red-500/15 text-red-500",
  en_attente: "bg-amber-500/15 text-amber-500",
  confirmee: "bg-blue-500/15 text-blue-500",
};
const STATUT_LABELS: Record<string, string> = {
  disponible: "Disponible", prise: "Prise", livree: "Livrée",
  terminee: "Terminée", annulee: "Annulée", en_attente: "En attente", confirmee: "Confirmée",
};
const EVENT_LABELS: Record<string, string> = {
  mariage: "Mariage", salon: "Salon", congres: "Congrès",
};
const OPTION_CHOICES: Array<{ key: string; label: string }> = [
  { key: "bagages_supplementaires", label: "Bagages supplémentaires (+8€)" },
  { key: "siege_bebe", label: "Siège bébé (+10€)" },
  { key: "attente_incluse", label: "Attente incluse 15 min (+15€)" },
  { key: "vehicule_premium", label: "Véhicule premium (+25€)" },
  { key: "trajet_nuit", label: "Majoration trajet de nuit (+12€)" },
  { key: "accueil_pancarte", label: "Accueil avec pancarte (+5€)" },
];

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function DiversificationPage() {
  const [tab, setTab] = useState<TabKey>("today");
  const qc = useQueryClient();

  // ─── Missions du jour ─────────────────────────────────────────────────────
  const { data: today, isLoading: loadingToday } = useQuery<TodayMissions>({
    queryKey: ["/api/diversification/today"],
    queryFn: () => apiRequest("GET", "/api/diversification/today").then((r) => r.json()),
  });

  const takeParcelMutation = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/diversification/parcels/${id}/status`, { status: "prise" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/diversification/today"] });
      qc.invalidateQueries({ queryKey: ["/api/diversification/parcels"] });
    },
  });
  const confirmB2bMutation = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/diversification/b2b/${id}/statut`, { statut: "confirmee" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/diversification/today"] });
      qc.invalidateQueries({ queryKey: ["/api/diversification/b2b"] });
    },
  });
  const takeEventMutation = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/diversification/events/${id}/status`, { status: "prise" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/diversification/today"] });
    },
  });

  // ─── Marketplace missions (affiché aussi dans "Missions du jour") ─────────
  const { data: marketplace = [] } = useQuery<MarketplaceMission[]>({
    queryKey: ["/api/diversification/marketplace", "active"],
    queryFn: () => apiRequest("GET", "/api/diversification/marketplace?active=1").then((r) => r.json()),
  });

  // ─── Devis ────────────────────────────────────────────────────────────────
  const [quoteForm, setQuoteForm] = useState({
    client: "", date: "", from: "", to: "", passagers: 1, options: [] as string[],
  });
  const [quoteHtml, setQuoteHtml] = useState<string | null>(null);
  const [quoteNumero, setQuoteNumero] = useState<string | null>(null);

  const generateQuoteMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/diversification/quote", quoteForm).then((r) => r.json()),
    onSuccess: (data) => {
      setQuoteHtml(data.html);
      setQuoteNumero(data.numero);
    },
  });

  function toggleOption(key: string) {
    setQuoteForm((f) => ({
      ...f,
      options: f.options.includes(key) ? f.options.filter((o) => o !== key) : [...f.options, key],
    }));
  }

  function printQuote() {
    if (!quoteHtml) return;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(quoteHtml);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }

  // ─── Contrat (déclenché depuis le devis, mission ponctuelle B2B) ──────────
  const [contractForm, setContractForm] = useState({
    company: "", contact: "", mission_desc: "", date_mission: "", forfait: 0, conditions: "",
  });
  const [contractHtml, setContractHtml] = useState<string | null>(null);
  const [showContractForm, setShowContractForm] = useState(false);

  const generateContractMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/diversification/contract", contractForm).then((r) => r.json()),
    onSuccess: (data) => setContractHtml(data.html),
  });

  function printContract() {
    if (!contractHtml) return;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(contractHtml);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }

  // ─── Réservations B2B ───────────────────────────────────────────────────
  const { data: bookings = [], isLoading: loadingBookings } = useQuery<B2bBooking[]>({
    queryKey: ["/api/diversification/b2b"],
    queryFn: () => apiRequest("GET", "/api/diversification/b2b").then((r) => r.json()),
  });
  const [selectedBooking, setSelectedBooking] = useState<B2bBooking | null>(null);

  // ─── Forfaits aéroport ──────────────────────────────────────────────────
  const { data: airportForfaits = [] } = useQuery<AirportForfait[]>({
    queryKey: ["/api/diversification/airport-forfait"],
    queryFn: () => apiRequest("GET", "/api/diversification/airport-forfait").then((r) => r.json()),
  });
  const [airportFilter, setAirportFilter] = useState<string>("Tous");
  const airportOptions = ["Tous", ...Array.from(new Set(airportForfaits.map((a) => a.to_airport)))];
  const filteredAirport = airportFilter === "Tous" ? airportForfaits : airportForfaits.filter((a) => a.to_airport === airportFilter);

  // ─── Cashback carburant ─────────────────────────────────────────────────
  const { data: cashbackPartners = [] } = useQuery<FuelCashback[]>({
    queryKey: ["/api/diversification/fuel-cashback"],
    queryFn: () => apiRequest("GET", "/api/diversification/fuel-cashback").then((r) => r.json()),
  });
  const bestCashback = cashbackPartners.length
    ? cashbackPartners.reduce((a, b) => (a.cashback_pct > b.cashback_pct ? a : b))
    : null;

  // ─── Mix revenu ─────────────────────────────────────────────────────────
  const { data: revenueMix } = useQuery<RevenueMix>({
    queryKey: ["/api/diversification/revenue-mix"],
    queryFn: () => apiRequest("GET", "/api/diversification/revenue-mix?days=30").then((r) => r.json()),
  });

  const DONUT_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#a855f7", "#ef4444"];

  function buildDonutGradient(items: RevenueMixItem[]): string {
    let acc = 0;
    const stops: string[] = [];
    items.forEach((it, i) => {
      const start = acc;
      const end = acc + it.pourcentage;
      stops.push(`${DONUT_COLORS[i % DONUT_COLORS.length]} ${start}% ${end}%`);
      acc = end;
    });
    if (acc < 100) stops.push(`#e5e7eb ${acc}% 100%`);
    return `conic-gradient(${stops.join(", ")})`;
  }

  return (
    <div className="p-3 sm:p-4 max-w-4xl mx-auto space-y-4 pb-24" data-testid="page-diversification">
      <div>
        <h2 className="font-bold text-lg flex items-center gap-2">
          <Package size={18} className="text-primary" />
          Diversification de revenus
        </h2>
        <p className="text-sm text-muted-foreground">
          Colis intercités, B2B forfaitaire, devis/contrats, marketplace missions, forfaits aéroport et cashback carburant — hors dépendance à une seule plateforme.
        </p>
      </div>

      {/* ─── Onglets (scroll horizontal mobile) ────────────────────────── */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-3 px-3 sm:mx-0 sm:px-0 scrollbar-hide">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            data-testid={`diversification-tab-${key}`}
            className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors min-h-[44px] ${
              tab === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {/* ══════════════════════════ MISSIONS DU JOUR ══════════════════════ */}
      {tab === "today" && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Total disponible aujourd'hui</span>
                <Badge className="bg-primary/15 text-primary">{today?.total ?? 0} missions</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Colis intercités, réservations B2B en attente et événements spéciaux à prendre pendant vos temps morts.
              </p>
            </CardContent>
          </Card>

          {/* Colis */}
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
              <Package size={15} className="text-blue-500" /> Missions colis intercités
            </h3>
            <div className="space-y-2">
              {loadingToday && <p className="text-xs text-muted-foreground">Chargement…</p>}
              {!loadingToday && (today?.parcels.length ?? 0) === 0 && (
                <p className="text-xs text-muted-foreground">Aucun colis disponible pour le moment.</p>
              )}
              {today?.parcels.map((p) => (
                <Card key={p.id} data-testid={`parcel-mission-${p.id}`}>
                  <CardContent className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium flex items-center gap-1 truncate">
                        <MapPin size={13} className="text-muted-foreground shrink-0" />
                        {p.from_city} → {p.to_city}
                        <span className="text-xs text-muted-foreground">({p.distance_km} km)</span>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock size={11} /> Avant le {fmtDate(p.deadline)}
                      </div>
                      {p.notes && <div className="text-xs text-muted-foreground mt-0.5 truncate">{p.notes}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-bold text-primary">{p.price.toFixed(0)} €</div>
                      <Button
                        size="sm"
                        className="mt-1 min-h-[36px]"
                        onClick={() => takeParcelMutation.mutate(p.id)}
                        disabled={takeParcelMutation.isPending}
                        data-testid={`button-take-parcel-${p.id}`}
                      >
                        <Check size={14} className="mr-1" /> Prendre
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* B2B en attente */}
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
              <Building2 size={15} className="text-amber-500" /> Réservations B2B en attente
            </h3>
            <div className="space-y-2">
              {(today?.b2b.length ?? 0) === 0 && (
                <p className="text-xs text-muted-foreground">Aucune réservation en attente.</p>
              )}
              {today?.b2b.map((b) => (
                <Card key={b.id} data-testid={`b2b-today-${b.id}`}>
                  <CardContent className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{b.company}</div>
                      <div className="text-xs text-muted-foreground truncate">{b.from_addr} → {b.to_addr}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock size={11} /> {fmtDate(b.date_time)} · <UsersIcon size={11} /> {b.passengers}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-bold text-primary">{b.forfait.toFixed(0)} €</div>
                      <Button
                        size="sm"
                        className="mt-1 min-h-[36px]"
                        onClick={() => confirmB2bMutation.mutate(b.id)}
                        disabled={confirmB2bMutation.isPending}
                        data-testid={`button-confirm-b2b-${b.id}`}
                      >
                        <Check size={14} className="mr-1" /> Confirmer
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* Événements */}
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
              <CalendarHeart size={15} className="text-pink-500" /> Événements spéciaux disponibles
            </h3>
            <div className="space-y-2">
              {(today?.events.length ?? 0) === 0 && (
                <p className="text-xs text-muted-foreground">Aucun événement disponible.</p>
              )}
              {today?.events.map((e) => (
                <Card key={e.id} data-testid={`event-mission-${e.id}`}>
                  <CardContent className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{EVENT_LABELS[e.event_type] || e.event_type}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock size={11} /> {fmtDate(e.date)} · {e.duration_hours}h
                      </div>
                      {e.notes && <div className="text-xs text-muted-foreground mt-0.5 truncate">{e.notes}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-bold text-primary">{e.price.toFixed(0)} €</div>
                      <Button
                        size="sm"
                        className="mt-1 min-h-[36px]"
                        onClick={() => takeEventMutation.mutate(e.id)}
                        disabled={takeEventMutation.isPending}
                        data-testid={`button-take-event-${e.id}`}
                      >
                        <Check size={14} className="mr-1" /> Prendre
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* Marketplace missions (comparateur commissions) */}
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
              <Store size={15} className="text-purple-500" /> Marketplace missions (comparatif commissions)
            </h3>
            <div className="space-y-2">
              {marketplace.map((m) => (
                <Card key={m.id} data-testid={`marketplace-mission-${m.id}`}>
                  <CardContent className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary" className="text-[10px]">{m.source_platform}</Badge>
                        <span className="text-xs text-muted-foreground">{m.distance} km</span>
                      </div>
                      <div className="text-sm truncate mt-0.5">{m.description}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-muted-foreground line-through">{m.price.toFixed(0)} €</div>
                      <div className="font-bold text-green-600">{m.net_estime.toFixed(0)} € net</div>
                      <div className="text-[10px] text-muted-foreground">commission {m.commission_pct}%</div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════ GÉNÉRER UN DEVIS ══════════════════════ */}
      {tab === "quote" && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <FileText size={15} /> Formulaire devis
              </h3>
              <Input
                placeholder="Nom du client / entreprise"
                value={quoteForm.client}
                onChange={(e) => setQuoteForm((f) => ({ ...f, client: e.target.value }))}
                data-testid="input-quote-client"
              />
              <Input
                type="datetime-local"
                value={quoteForm.date}
                onChange={(e) => setQuoteForm((f) => ({ ...f, date: e.target.value }))}
                data-testid="input-quote-date"
              />
              <Input
                placeholder="Adresse de départ"
                value={quoteForm.from}
                onChange={(e) => setQuoteForm((f) => ({ ...f, from: e.target.value }))}
                data-testid="input-quote-from"
              />
              <Input
                placeholder="Adresse d'arrivée"
                value={quoteForm.to}
                onChange={(e) => setQuoteForm((f) => ({ ...f, to: e.target.value }))}
                data-testid="input-quote-to"
              />
              <Input
                type="number"
                min={1}
                placeholder="Nombre de passagers"
                value={quoteForm.passagers}
                onChange={(e) => setQuoteForm((f) => ({ ...f, passagers: parseInt(e.target.value) || 1 }))}
                data-testid="input-quote-passagers"
              />
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Options</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {OPTION_CHOICES.map((o) => (
                    <button
                      key={o.key}
                      onClick={() => toggleOption(o.key)}
                      className={`text-left text-xs px-2.5 py-2 rounded-md border min-h-[44px] transition-colors ${
                        quoteForm.options.includes(o.key)
                          ? "bg-primary/10 border-primary text-primary"
                          : "border-border text-muted-foreground hover:bg-accent"
                      }`}
                      data-testid={`option-${o.key}`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <Button
                className="w-full min-h-[44px]"
                onClick={() => generateQuoteMutation.mutate()}
                disabled={!quoteForm.client || !quoteForm.from || !quoteForm.to || generateQuoteMutation.isPending}
                data-testid="button-generate-quote"
              >
                <FileText size={16} className="mr-1.5" /> Générer le devis
              </Button>
            </CardContent>
          </Card>

          {quoteHtml && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Aperçu devis {quoteNumero}</h3>
                  <Button size="sm" variant="outline" onClick={printQuote} data-testid="button-print-quote">
                    <Printer size={14} className="mr-1" /> Imprimer / PDF
                  </Button>
                </div>
                <div className="border border-border rounded-lg overflow-hidden bg-white">
                  <iframe
                    title="Aperçu devis"
                    srcDoc={quoteHtml}
                    className="w-full h-[420px]"
                    data-testid="iframe-quote-preview"
                  />
                </div>

                {/* Passage devis → contrat ponctuel B2B */}
                <div className="pt-2 border-t border-border">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-h-[40px]"
                    onClick={() => {
                      setShowContractForm(true);
                      setContractForm((f) => ({
                        ...f,
                        company: quoteForm.client,
                        mission_desc: `Course VTC de ${quoteForm.from} à ${quoteForm.to}`,
                        date_mission: quoteForm.date,
                      }));
                    }}
                    data-testid="button-show-contract-form"
                  >
                    <ShieldCheck size={14} className="mr-1" /> Transformer en contrat forfaitaire
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {showContractForm && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <ShieldCheck size={15} /> Contrat de prestation ponctuelle
                </h3>
                <Input
                  placeholder="Entreprise cliente"
                  value={contractForm.company}
                  onChange={(e) => setContractForm((f) => ({ ...f, company: e.target.value }))}
                  data-testid="input-contract-company"
                />
                <Input
                  placeholder="Contact (nom, téléphone)"
                  value={contractForm.contact}
                  onChange={(e) => setContractForm((f) => ({ ...f, contact: e.target.value }))}
                  data-testid="input-contract-contact"
                />
                <Textarea
                  placeholder="Description de la mission"
                  value={contractForm.mission_desc}
                  onChange={(e) => setContractForm((f) => ({ ...f, mission_desc: e.target.value }))}
                  data-testid="input-contract-mission"
                />
                <Input
                  type="datetime-local"
                  value={contractForm.date_mission}
                  onChange={(e) => setContractForm((f) => ({ ...f, date_mission: e.target.value }))}
                  data-testid="input-contract-date"
                />
                <Input
                  type="number"
                  placeholder="Forfait (€)"
                  value={contractForm.forfait}
                  onChange={(e) => setContractForm((f) => ({ ...f, forfait: parseFloat(e.target.value) || 0 }))}
                  data-testid="input-contract-forfait"
                />
                <Textarea
                  placeholder="Conditions particulières (optionnel)"
                  value={contractForm.conditions}
                  onChange={(e) => setContractForm((f) => ({ ...f, conditions: e.target.value }))}
                  data-testid="input-contract-conditions"
                />
                <Button
                  className="w-full min-h-[44px]"
                  onClick={() => generateContractMutation.mutate()}
                  disabled={!contractForm.company || !contractForm.mission_desc || generateContractMutation.isPending}
                  data-testid="button-generate-contract"
                >
                  Générer le contrat
                </Button>

                {contractHtml && (
                  <div className="space-y-2 pt-2 border-t border-border">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Aperçu contrat</span>
                      <Button size="sm" variant="outline" onClick={printContract} data-testid="button-print-contract">
                        <Printer size={14} className="mr-1" /> Imprimer / PDF
                      </Button>
                    </div>
                    <div className="border border-border rounded-lg overflow-hidden bg-white">
                      <iframe title="Aperçu contrat" srcDoc={contractHtml} className="w-full h-[420px]" />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ══════════════════════════ RÉSERVATIONS B2B ══════════════════════ */}
      {tab === "b2b" && (
        <div className="space-y-3">
          {loadingBookings && <p className="text-xs text-muted-foreground">Chargement…</p>}
          {bookings.map((b) => (
            <Card
              key={b.id}
              className="cursor-pointer"
              onClick={() => setSelectedBooking(b)}
              data-testid={`b2b-booking-${b.id}`}
            >
              <CardContent className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{b.company}</span>
                    <Badge className={`text-[10px] ${STATUT_COLORS[b.statut] || ""}`}>{STATUT_LABELS[b.statut] || b.statut}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{b.from_addr} → {b.to_addr}</div>
                  <div className="text-xs text-muted-foreground">{fmtDate(b.date_time)}</div>
                </div>
                <div className="text-right shrink-0 font-bold text-primary">{b.forfait.toFixed(0)} €</div>
              </CardContent>
            </Card>
          ))}

          {selectedBooking && (
            <Card>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">{selectedBooking.company}</h3>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedBooking(null)}>Fermer</Button>
                </div>
                <p className="text-xs text-muted-foreground">Contact : {selectedBooking.contact || "—"}</p>
                <p className="text-xs text-muted-foreground">Date : {fmtDate(selectedBooking.date_time)}</p>
                <p className="text-xs text-muted-foreground">Départ : {selectedBooking.from_addr}</p>
                <p className="text-xs text-muted-foreground">Arrivée : {selectedBooking.to_addr}</p>
                <p className="text-xs text-muted-foreground">Passagers : {selectedBooking.passengers}</p>
                <p className="text-sm font-bold text-primary">Forfait : {selectedBooking.forfait.toFixed(0)} €</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ══════════════════════════ FORFAITS AÉROPORT ══════════════════════ */}
      {tab === "airport" && (
        <div className="space-y-3">
          <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
            {airportOptions.map((opt) => (
              <button
                key={opt}
                onClick={() => setAirportFilter(opt)}
                className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap min-h-[40px] ${
                  airportFilter === opt ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
                data-testid={`airport-filter-${opt}`}
              >
                {opt}
              </button>
            ))}
          </div>
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="text-left p-2.5">Zone de départ</th>
                    <th className="text-left p-2.5">Aéroport</th>
                    <th className="text-right p-2.5">Prix</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAirport.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0" data-testid={`airport-forfait-${a.id}`}>
                      <td className="p-2.5">
                        {a.from_zone}
                        {a.notes && <div className="text-[11px] text-muted-foreground">{a.notes}</div>}
                      </td>
                      <td className="p-2.5">
                        <Badge variant="secondary" className="text-[10px]">{a.to_airport}</Badge>
                      </td>
                      <td className="p-2.5 text-right font-bold text-primary">{a.price.toFixed(0)} €</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ══════════════════════════ CASHBACK CARBURANT ══════════════════════ */}
      {tab === "cashback" && (
        <div className="space-y-3">
          {bestCashback && (
            <Card className="border-primary/40">
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Meilleur taux actuel</p>
                <p className="text-lg font-bold text-primary flex items-center gap-1.5">
                  <Fuel size={18} /> {bestCashback.nom} — {bestCashback.cashback_pct}% cashback
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Économie mensuelle estimée : <span className="font-semibold text-foreground">{bestCashback.economie_mensuelle_estimee.toFixed(0)} €</span> (sur un budget carburant moyen de 1100€/mois)
                </p>
              </CardContent>
            </Card>
          )}
          {cashbackPartners.map((p) => (
            <Card key={p.id} data-testid={`cashback-partner-${p.id}`}>
              <CardContent className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{p.nom}</div>
                  <div className="text-xs text-muted-foreground">{p.station}</div>
                  {p.conditions && <div className="text-[11px] text-muted-foreground mt-0.5">{p.conditions}</div>}
                </div>
                <div className="text-right shrink-0">
                  <div className="font-bold text-green-600">-{p.cashback_pct}%</div>
                  <div className="text-[11px] text-muted-foreground">~{p.economie_mensuelle_estimee.toFixed(0)} €/mois</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ══════════════════════════ MIX REVENU (donut CSS pur) ══════════════════════ */}
      {tab === "mix" && revenueMix && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4 flex flex-col sm:flex-row items-center gap-6">
              <div
                className="w-40 h-40 rounded-full shrink-0"
                style={{ background: buildDonutGradient(revenueMix.breakdown) }}
                data-testid="donut-revenue-mix"
              >
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-24 h-24 rounded-full bg-card flex flex-col items-center justify-center">
                    <span className="text-lg font-bold">{revenueMix.total_estime.toFixed(0)} €</span>
                    <span className="text-[10px] text-muted-foreground">/{revenueMix.period_days}j</span>
                  </div>
                </div>
              </div>
              <div className="flex-1 w-full space-y-1.5">
                {revenueMix.breakdown.map((item, i) => (
                  <div key={item.source} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}
                      />
                      {item.label}
                    </span>
                    <span className="text-muted-foreground whitespace-nowrap">
                      {item.montant.toFixed(0)} € · {item.pourcentage.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <TrendingUp size={16} className="text-primary" />
                <span className="text-sm font-medium">Score de diversification</span>
              </div>
              <p className="text-2xl font-bold text-primary mt-1">{revenueMix.diversification_score.toFixed(0)}%</p>
              <p className="text-xs text-muted-foreground mt-1">
                Part de vos revenus générée hors plateforme VTC principale (colis, B2B, forfaits, événements). Plus ce score est élevé, moins vous dépendez d'une seule source.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
