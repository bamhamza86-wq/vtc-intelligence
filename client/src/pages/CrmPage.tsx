/**
 * CrmPage.tsx — Couche CRM Chauffeur (clientèle privée & partenariats)
 * ─────────────────────────────────────────────────────────────────────────────
 * rapport.md §7 (Chaîne de valeur clients), §14.1 (Bourse d'échange courses),
 * §17.1/17.3/17.4 (Automatisation clientèle privée)
 *
 * 6 onglets :
 *   - Clients        : carnet clientèle privée, recherche, création, détail + historique
 *   - Récurrentes    : courses régulières avec prochaine occurrence
 *   - Factures       : facturation privée, statuts, impression PDF (window.print)
 *   - Partenariats   : hôtels/restos/salles partenaires
 *   - Bourse d'échanges : courses proposées par la communauté (démo)
 *   - Templates      : réponses auto SMS/WhatsApp en conduite
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Users, Repeat, FileText, Handshake, Send, MessageSquare,
  Plus, Search, Star, Ban, Printer, Trash2, Check, X, Clock,
  Phone, Mail, TrendingUp, AlertCircle,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface Client {
  id: number;
  nom: string;
  tel: string | null;
  email: string | null;
  notes: string | null;
  tags: string[];
  vip: boolean;
  created_at: string;
  last_ride_at: string | null;
}
interface Recurring {
  id: number;
  client_id: number;
  client_nom: string;
  jour_semaine: number;
  jour_label: string;
  heure: string;
  depart: string;
  arrivee: string;
  montant: number;
  next_occurrence: string;
  active: boolean;
}
interface Invoice {
  id: number;
  client_id: number;
  client_nom: string;
  ride_ids: number[];
  montant_ht: number;
  tva: number;
  montant_ttc: number;
  date_emission: string;
  statut: string;
  paid_at: string | null;
}
interface Partnership {
  id: number;
  nom: string;
  type: string;
  address: string | null;
  contact: string | null;
  commission_pct: number;
  notes: string | null;
  active: boolean;
}
interface RideExchange {
  id: number;
  from_user: string;
  from_ride: string;
  to_zone: string;
  price: number;
  status: string;
  created_at: string;
}
interface AutoReplyTemplate {
  id: number;
  trigger_type: string;
  message: string;
  active: boolean;
}

const TABS = [
  { key: "clients", label: "Clients", icon: Users },
  { key: "recurring", label: "Récurrentes", icon: Repeat },
  { key: "invoices", label: "Factures", icon: FileText },
  { key: "partnerships", label: "Partenariats", icon: Handshake },
  { key: "exchange", label: "Bourse d'échanges", icon: Send },
  { key: "templates", label: "Templates réponses auto", icon: MessageSquare },
] as const;
type TabKey = typeof TABS[number]["key"];

const JOURS = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];

const STATUT_LABELS: Record<string, string> = {
  brouillon: "Brouillon", envoyee: "Envoyée", payee: "Payée", en_retard: "En retard",
};
const STATUT_COLORS: Record<string, string> = {
  brouillon: "bg-muted text-muted-foreground",
  envoyee: "bg-blue-500/15 text-blue-500",
  payee: "bg-green-500/15 text-green-500",
  en_retard: "bg-red-500/15 text-red-500",
};

const TRIGGER_LABELS: Record<string, string> = {
  en_conduite: "En conduite",
  en_course: "En course",
  disponible: "Disponible",
  fin_course: "Fin de course",
  remerciement: "Remerciement",
};

export default function CrmPage() {
  const [tab, setTab] = useState<TabKey>("clients");

  return (
    <div className="p-3 sm:p-4 max-w-4xl mx-auto space-y-4 pb-24" data-testid="page-crm">
      <div>
        <h2 className="font-bold text-lg flex items-center gap-2">
          <Users size={18} className="text-primary" />
          CRM Chauffeur
        </h2>
        <p className="text-sm text-muted-foreground">
          Clientèle privée, partenariats et automatisation — hors commission plateforme.
        </p>
      </div>

      {/* ─── Onglets (scroll horizontal mobile) ────────────────────────── */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-3 px-3 sm:mx-0 sm:px-0 scrollbar-hide">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            data-testid={`crm-tab-${key}`}
            className={`shrink-0 flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors min-h-[44px] ${
              tab === key ? "bg-primary text-primary-foreground" : "bg-card border border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon size={15} />
            <span className="whitespace-nowrap">{label}</span>
          </button>
        ))}
      </div>

      {tab === "clients" && <ClientsTab />}
      {tab === "recurring" && <RecurringTab />}
      {tab === "invoices" && <InvoicesTab />}
      {tab === "partnerships" && <PartnershipsTab />}
      {tab === "exchange" && <ExchangeTab />}
      {tab === "templates" && <TemplatesTab />}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Onglet Clients
// ═════════════════════════════════════════════════════════════════════════════
function ClientsTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: clients = [], isLoading } = useQuery<Client[]>({
    queryKey: ["/api/crm/clients", search],
    queryFn: () => apiRequest("GET", `/api/crm/clients${search ? `?search=${encodeURIComponent(search)}` : ""}`).then((r) => r.json()),
    staleTime: 10_000,
  });

  const { data: vipData } = useQuery<{ summary: any }>({
    queryKey: ["/api/crm/vip-analytics"],
    queryFn: () => apiRequest("GET", "/api/crm/vip-analytics").then((r) => r.json()),
    staleTime: 30_000,
  });

  return (
    <div className="space-y-3">
      {vipData && (
        <Card>
          <CardContent className="p-3 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-lg font-bold">{vipData.summary.total_clients}</p>
              <p className="text-[10px] text-muted-foreground">Clients</p>
            </div>
            <div>
              <p className="text-lg font-bold text-amber-500">{vipData.summary.vip_count}</p>
              <p className="text-[10px] text-muted-foreground">VIP</p>
            </div>
            <div>
              <p className="text-lg font-bold text-green-500">{vipData.summary.ca_total.toFixed(0)}€</p>
              <p className="text-[10px] text-muted-foreground">CA privé total</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un client (nom, tél, email)…"
            className="pl-9 h-11"
            data-testid="input-client-search"
          />
        </div>
        <Button onClick={() => setShowNew(true)} className="h-11 min-w-[44px]" data-testid="button-new-client">
          <Plus size={16} className="sm:mr-1.5" />
          <span className="hidden sm:inline">Nouveau</span>
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground text-center py-8">Chargement…</p>}
      {!isLoading && clients.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">Aucun client trouvé.</p>
      )}

      <div className="space-y-2">
        {clients.map((c) => (
          <Card
            key={c.id}
            className="cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => setDetailId(c.id)}
            data-testid={`client-card-${c.id}`}
          >
            <CardContent className="p-3 flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="font-semibold text-sm truncate">{c.nom}</p>
                  {c.vip && <Star size={13} className="text-amber-400 fill-amber-400 shrink-0" />}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  {c.tel && <span className="flex items-center gap-1"><Phone size={11} />{c.tel}</span>}
                </div>
                {c.tags.length > 0 && (
                  <div className="flex gap-1 mt-1.5 flex-wrap">
                    {c.tags.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0">{t}</Badge>
                    ))}
                  </div>
                )}
              </div>
              {c.last_ride_at && (
                <p className="text-[10px] text-muted-foreground shrink-0">
                  {new Date(c.last_ride_at).toLocaleDateString("fr-FR")}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {showNew && <NewClientDialog onClose={() => setShowNew(false)} />}
      {detailId !== null && <ClientDetailDialog id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function NewClientDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [nom, setNom] = useState("");
  const [tel, setTel] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [vip, setVip] = useState(false);

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/crm/clients", { nom, tel, email, notes, vip, tags: [] }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/crm/clients"] });
      qc.invalidateQueries({ queryKey: ["/api/crm/vip-analytics"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nouveau client</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Nom complet *" value={nom} onChange={(e) => setNom(e.target.value)} className="h-11" data-testid="input-new-client-nom" />
          <Input placeholder="Téléphone" value={tel} onChange={(e) => setTel(e.target.value)} className="h-11" />
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-11" />
          <Textarea placeholder="Notes (préférences, habitudes…)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          <label className="flex items-center gap-2 text-sm cursor-pointer min-h-[44px]">
            <input type="checkbox" checked={vip} onChange={(e) => setVip(e.target.checked)} className="w-4 h-4" />
            Client VIP
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="h-11">Annuler</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!nom.trim() || mutation.isPending}
            className="h-11"
            data-testid="button-save-client"
          >
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClientDetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [newRideMontant, setNewRideMontant] = useState("");
  const [newRideDistance, setNewRideDistance] = useState("");
  const [newRideNote, setNewRideNote] = useState("");

  const { data: client, isLoading } = useQuery<Client & { rides: any[]; recurring: any[]; invoices: any[] }>({
    queryKey: ["/api/crm/clients", id],
    queryFn: () => apiRequest("GET", `/api/crm/clients/${id}`).then((r) => r.json()),
  });

  const addRide = useMutation({
    mutationFn: () => apiRequest("POST", "/api/crm/rides", {
      client_id: id, montant: parseFloat(newRideMontant) || 0, distance: parseFloat(newRideDistance) || 0, note: newRideNote,
    }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/crm/clients", id] });
      qc.invalidateQueries({ queryKey: ["/api/crm/vip-analytics"] });
      setNewRideMontant(""); setNewRideDistance(""); setNewRideNote("");
    },
  });

  const deleteClientMut = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/crm/clients/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/crm/clients"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {client?.vip && <Star size={16} className="text-amber-400 fill-amber-400" />}
            {client?.nom || "Chargement…"}
          </DialogTitle>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground py-4">Chargement…</p>}

        {client && (
          <div className="space-y-4">
            <div className="text-sm space-y-1">
              {client.tel && <p className="flex items-center gap-2"><Phone size={13} />{client.tel}</p>}
              {client.email && <p className="flex items-center gap-2"><Mail size={13} />{client.email}</p>}
              {client.notes && <p className="text-muted-foreground text-xs mt-1">{client.notes}</p>}
            </div>

            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1.5">Historique des courses privées</p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {(client.rides || []).length === 0 && <p className="text-xs text-muted-foreground">Aucune course enregistrée.</p>}
                {(client.rides || []).map((r: any) => (
                  <div key={r.id} className="flex justify-between items-center text-xs bg-muted/50 rounded px-2 py-1.5">
                    <span className="text-muted-foreground">{new Date(r.date).toLocaleDateString("fr-FR")} — {r.note || "Course"}</span>
                    <span className="font-medium">{r.montant.toFixed(2)}€{r.pourboire > 0 && ` (+${r.pourboire.toFixed(2)}€)`}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-border pt-3">
              <p className="text-xs font-semibold text-muted-foreground mb-1.5">Ajouter une course</p>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <Input placeholder="Montant €" type="number" value={newRideMontant} onChange={(e) => setNewRideMontant(e.target.value)} className="h-10" />
                <Input placeholder="Distance km" type="number" value={newRideDistance} onChange={(e) => setNewRideDistance(e.target.value)} className="h-10" />
              </div>
              <Input placeholder="Note (ex: Aéroport CDG)" value={newRideNote} onChange={(e) => setNewRideNote(e.target.value)} className="h-10 mb-2" />
              <Button size="sm" onClick={() => addRide.mutate()} disabled={!newRideMontant || addRide.isPending} className="w-full h-10">
                <Plus size={14} className="mr-1" /> Ajouter la course
              </Button>
            </div>

            <Button
              variant="destructive"
              size="sm"
              onClick={() => { if (confirm("Supprimer ce client et son historique ?")) deleteClientMut.mutate(); }}
              className="w-full h-10"
              data-testid="button-delete-client"
            >
              <Trash2 size={14} className="mr-1.5" /> Supprimer le client
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Onglet Récurrentes
// ═════════════════════════════════════════════════════════════════════════════
function RecurringTab() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);

  const { data: recurring = [], isLoading } = useQuery<Recurring[]>({
    queryKey: ["/api/crm/recurring"],
    queryFn: () => apiRequest("GET", "/api/crm/recurring").then((r) => r.json()),
    staleTime: 15_000,
  });

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["/api/crm/clients", ""],
    queryFn: () => apiRequest("GET", "/api/crm/clients").then((r) => r.json()),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiRequest("PUT", `/api/crm/recurring/${id}`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/crm/recurring"] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/crm/recurring/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/crm/recurring"] }),
  });

  return (
    <div className="space-y-3">
      <Button onClick={() => setShowNew(true)} className="w-full h-11" data-testid="button-new-recurring">
        <Plus size={16} className="mr-1.5" /> Nouvelle course récurrente
      </Button>

      {isLoading && <p className="text-sm text-muted-foreground text-center py-8">Chargement…</p>}
      {!isLoading && recurring.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">Aucune course récurrente configurée.</p>
      )}

      <div className="space-y-2">
        {recurring.map((r) => (
          <Card key={r.id} className={!r.active ? "opacity-50" : ""} data-testid={`recurring-card-${r.id}`}>
            <CardContent className="p-3">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-sm">{r.client_nom}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    <Clock size={11} /> {r.jour_label} à {r.heure}
                  </p>
                  {(r.depart || r.arrivee) && (
                    <p className="text-xs text-muted-foreground mt-0.5">{r.depart} → {r.arrivee}</p>
                  )}
                  <p className="text-xs mt-1">
                    Prochaine : <span className="font-medium">{new Date(r.next_occurrence).toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-bold text-sm">{r.montant.toFixed(0)}€</p>
                </div>
              </div>
              <div className="flex gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 flex-1 text-xs"
                  onClick={() => toggleActive.mutate({ id: r.id, active: !r.active })}
                >
                  {r.active ? "Désactiver" : "Réactiver"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-9 w-9 p-0"
                  onClick={() => { if (confirm("Supprimer cette course récurrente ?")) remove.mutate(r.id); }}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {showNew && <NewRecurringDialog clients={clients} onClose={() => setShowNew(false)} />}
    </div>
  );
}

function NewRecurringDialog({ clients, onClose }: { clients: Client[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState<number | "">("");
  const [jour, setJour] = useState(1);
  const [heure, setHeure] = useState("08:00");
  const [depart, setDepart] = useState("");
  const [arrivee, setArrivee] = useState("");
  const [montant, setMontant] = useState("");

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/crm/recurring", {
      client_id: clientId, jour_semaine: jour, heure, depart, arrivee, montant: parseFloat(montant) || 0,
    }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/crm/recurring"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Nouvelle course récurrente</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <select
            value={clientId}
            onChange={(e) => setClientId(Number(e.target.value))}
            className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Sélectionner un client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <select value={jour} onChange={(e) => setJour(Number(e.target.value))} className="h-11 rounded-md border border-input bg-background px-3 text-sm">
              {JOURS.map((j, i) => <option key={i} value={i}>{j}</option>)}
            </select>
            <Input type="time" value={heure} onChange={(e) => setHeure(e.target.value)} className="h-11" />
          </div>
          <Input placeholder="Adresse de départ" value={depart} onChange={(e) => setDepart(e.target.value)} className="h-11" />
          <Input placeholder="Adresse d'arrivée" value={arrivee} onChange={(e) => setArrivee(e.target.value)} className="h-11" />
          <Input placeholder="Montant habituel €" type="number" value={montant} onChange={(e) => setMontant(e.target.value)} className="h-11" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="h-11">Annuler</Button>
          <Button onClick={() => mutation.mutate()} disabled={!clientId || mutation.isPending} className="h-11">Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Onglet Factures
// ═════════════════════════════════════════════════════════════════════════════
function InvoicesTab() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);

  const { data: invoices = [], isLoading } = useQuery<Invoice[]>({
    queryKey: ["/api/crm/invoices"],
    queryFn: () => apiRequest("GET", "/api/crm/invoices").then((r) => r.json()),
    staleTime: 15_000,
  });

  const { data: reminders } = useQuery<{ j7: any[]; j15: any[]; j30: any[]; total_impaye: number }>({
    queryKey: ["/api/crm/invoice-reminders"],
    queryFn: () => apiRequest("GET", "/api/crm/invoice-reminders").then((r) => r.json()),
    staleTime: 30_000,
  });

  const markPaid = useMutation({
    mutationFn: (id: number) => apiRequest("PUT", `/api/crm/invoices/${id}/statut`, { statut: "payee" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/crm/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/crm/invoice-reminders"] });
    },
  });

  const printInvoice = (id: number) => {
    const token = getAuthToken();
    const url = `${API_BASE}/api/crm/invoice-pdf/${id}`;
    fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-Auth-Token": token || "" } })
      .then((r) => r.text())
      .then((html) => {
        const w = window.open("", "_blank");
        if (w) {
          w.document.write(html);
          w.document.close();
          setTimeout(() => w.print(), 300);
        }
      });
  };

  const hasReminders = reminders && (reminders.j7.length + reminders.j15.length + reminders.j30.length > 0);

  return (
    <div className="space-y-3">
      {hasReminders && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-3">
            <p className="text-xs font-semibold flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <AlertCircle size={14} /> Relances impayés — {reminders!.total_impaye.toFixed(2)}€ en attente
            </p>
            <div className="flex gap-3 mt-1.5 text-xs text-muted-foreground">
              <span>J+7 : {reminders!.j7.length}</span>
              <span>J+15 : {reminders!.j15.length}</span>
              <span>J+30 : {reminders!.j30.length}</span>
            </div>
          </CardContent>
        </Card>
      )}

      <Button onClick={() => setShowNew(true)} className="w-full h-11" data-testid="button-new-invoice">
        <Plus size={16} className="mr-1.5" /> Nouvelle facture
      </Button>

      {isLoading && <p className="text-sm text-muted-foreground text-center py-8">Chargement…</p>}
      {!isLoading && invoices.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">Aucune facture émise.</p>
      )}

      <div className="space-y-2">
        {invoices.map((inv) => (
          <Card key={inv.id} data-testid={`invoice-card-${inv.id}`}>
            <CardContent className="p-3">
              <div className="flex justify-between items-start gap-2">
                <div>
                  <p className="font-semibold text-sm">Facture n°{String(inv.id).padStart(5, "0")}</p>
                  <p className="text-xs text-muted-foreground">{inv.client_nom} — {new Date(inv.date_emission).toLocaleDateString("fr-FR")}</p>
                </div>
                <Badge className={`text-[10px] ${STATUT_COLORS[inv.statut] || ""}`}>{STATUT_LABELS[inv.statut] || inv.statut}</Badge>
              </div>
              <p className="text-lg font-bold mt-1">{inv.montant_ttc.toFixed(2)}€</p>
              <div className="flex gap-2 mt-2">
                <Button size="sm" variant="outline" className="h-9 flex-1 text-xs" onClick={() => printInvoice(inv.id)} data-testid={`button-print-invoice-${inv.id}`}>
                  <Printer size={13} className="mr-1" /> Imprimer
                </Button>
                {inv.statut !== "payee" && (
                  <Button size="sm" className="h-9 flex-1 text-xs" onClick={() => markPaid.mutate(inv.id)}>
                    <Check size={13} className="mr-1" /> Marquer payée
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {showNew && <NewInvoiceDialog onClose={() => setShowNew(false)} />}
    </div>
  );
}

function NewInvoiceDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState<number | "">("");
  const [selectedRides, setSelectedRides] = useState<number[]>([]);

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["/api/crm/clients", ""],
    queryFn: () => apiRequest("GET", "/api/crm/clients").then((r) => r.json()),
  });

  const { data: rides = [] } = useQuery<any[]>({
    queryKey: ["/api/crm/rides", clientId],
    queryFn: () => apiRequest("GET", `/api/crm/rides?client_id=${clientId}`).then((r) => r.json()),
    enabled: !!clientId,
  });

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/crm/invoices", { client_id: clientId, ride_ids: selectedRides }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/crm/invoices"] });
      onClose();
    },
  });

  const toggleRide = (id: number) => {
    setSelectedRides((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Nouvelle facture</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <select
            value={clientId}
            onChange={(e) => { setClientId(Number(e.target.value)); setSelectedRides([]); }}
            className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Sélectionner un client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
          </select>

          {clientId && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1.5">Sélectionner les courses à facturer</p>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {rides.length === 0 && <p className="text-xs text-muted-foreground">Aucune course enregistrée pour ce client.</p>}
                {rides.map((r: any) => (
                  <label key={r.id} className="flex items-center gap-2 text-xs bg-muted/50 rounded px-2 py-2 cursor-pointer min-h-[44px]">
                    <input type="checkbox" checked={selectedRides.includes(r.id)} onChange={() => toggleRide(r.id)} className="w-4 h-4" />
                    <span className="flex-1">{new Date(r.date).toLocaleDateString("fr-FR")} — {r.note || "Course"}</span>
                    <span className="font-medium">{r.montant.toFixed(2)}€</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="h-11">Annuler</Button>
          <Button onClick={() => mutation.mutate()} disabled={!clientId || selectedRides.length === 0 || mutation.isPending} className="h-11">
            Générer la facture
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Onglet Partenariats
// ═════════════════════════════════════════════════════════════════════════════
function PartnershipsTab() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);

  const { data: partnerships = [], isLoading } = useQuery<Partnership[]>({
    queryKey: ["/api/crm/partnerships"],
    queryFn: () => apiRequest("GET", "/api/crm/partnerships").then((r) => r.json()),
    staleTime: 30_000,
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/crm/partnerships/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/crm/partnerships"] }),
  });

  const TYPE_LABELS: Record<string, string> = {
    hotel: "Hôtel", restaurant: "Restaurant", salle: "Salle de réception", conciergerie: "Conciergerie", autre: "Autre",
  };

  return (
    <div className="space-y-3">
      <Button onClick={() => setShowNew(true)} className="w-full h-11" data-testid="button-new-partnership">
        <Plus size={16} className="mr-1.5" /> Nouveau partenariat
      </Button>

      {isLoading && <p className="text-sm text-muted-foreground text-center py-8">Chargement…</p>}
      {!isLoading && partnerships.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">Aucun partenariat enregistré.</p>
      )}

      <div className="space-y-2">
        {partnerships.map((p) => (
          <Card key={p.id} className={!p.active ? "opacity-50" : ""} data-testid={`partnership-card-${p.id}`}>
            <CardContent className="p-3">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-sm">{p.nom}</p>
                  <Badge variant="secondary" className="text-[10px] mt-1">{TYPE_LABELS[p.type] || p.type}</Badge>
                  {p.address && <p className="text-xs text-muted-foreground mt-1">{p.address}</p>}
                  {p.contact && <p className="text-xs text-muted-foreground">{p.contact}</p>}
                  {p.notes && <p className="text-xs text-muted-foreground mt-1 italic">{p.notes}</p>}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-medium">{p.commission_pct}% comm.</p>
                </div>
              </div>
              <Button
                size="sm"
                variant="destructive"
                className="h-9 w-full mt-2 text-xs"
                onClick={() => { if (confirm("Supprimer ce partenariat ?")) remove.mutate(p.id); }}
              >
                <Trash2 size={13} className="mr-1" /> Supprimer
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {showNew && <NewPartnershipDialog onClose={() => setShowNew(false)} />}
    </div>
  );
}

function NewPartnershipDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [nom, setNom] = useState("");
  const [type, setType] = useState("hotel");
  const [address, setAddress] = useState("");
  const [contact, setContact] = useState("");
  const [commission, setCommission] = useState("");
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/crm/partnerships", {
      nom, type, address, contact, commission_pct: parseFloat(commission) || 0, notes,
    }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/crm/partnerships"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Nouveau partenariat</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Nom de l'établissement *" value={nom} onChange={(e) => setNom(e.target.value)} className="h-11" />
          <select value={type} onChange={(e) => setType(e.target.value)} className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm">
            <option value="hotel">Hôtel</option>
            <option value="restaurant">Restaurant</option>
            <option value="salle">Salle de réception</option>
            <option value="conciergerie">Conciergerie</option>
            <option value="autre">Autre</option>
          </select>
          <Input placeholder="Adresse" value={address} onChange={(e) => setAddress(e.target.value)} className="h-11" />
          <Input placeholder="Contact (email/tél)" value={contact} onChange={(e) => setContact(e.target.value)} className="h-11" />
          <Input placeholder="Commission %" type="number" value={commission} onChange={(e) => setCommission(e.target.value)} className="h-11" />
          <Textarea placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="h-11">Annuler</Button>
          <Button onClick={() => mutation.mutate()} disabled={!nom.trim() || mutation.isPending} className="h-11">Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Onglet Bourse d'échanges (14.1)
// ═════════════════════════════════════════════════════════════════════════════
function ExchangeTab() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);

  const { data: offers = [], isLoading } = useQuery<RideExchange[]>({
    queryKey: ["/api/crm/ride-exchange"],
    queryFn: () => apiRequest("GET", "/api/crm/ride-exchange").then((r) => r.json()),
    staleTime: 15_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => apiRequest("PUT", `/api/crm/ride-exchange/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/crm/ride-exchange"] }),
  });

  const STATUS_LABELS: Record<string, string> = {
    ouverte: "Ouverte", reservee: "Réservée", terminee: "Terminée", annulee: "Annulée",
  };
  const STATUS_COLORS: Record<string, string> = {
    ouverte: "bg-green-500/15 text-green-500",
    reservee: "bg-blue-500/15 text-blue-500",
    terminee: "bg-muted text-muted-foreground",
    annulee: "bg-red-500/15 text-red-500",
  };

  return (
    <div className="space-y-3">
      <Card className="border-blue-500/30 bg-blue-500/5">
        <CardContent className="p-3 text-xs text-muted-foreground">
          Mode démo — les courses proposées ici simulent une bourse d'échange communautaire entre chauffeurs (sans vraie communauté connectée pour l'instant).
        </CardContent>
      </Card>

      <Button onClick={() => setShowNew(true)} className="w-full h-11" data-testid="button-new-exchange">
        <Plus size={16} className="mr-1.5" /> Proposer une course
      </Button>

      {isLoading && <p className="text-sm text-muted-foreground text-center py-8">Chargement…</p>}

      <div className="space-y-2">
        {offers.map((o) => (
          <Card key={o.id} data-testid={`exchange-card-${o.id}`}>
            <CardContent className="p-3">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0">
                  <p className="text-sm">{o.from_ride}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Zone : {o.to_zone} — proposé par {o.from_user} — {new Date(o.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                <Badge className={`text-[10px] shrink-0 ${STATUS_COLORS[o.status] || ""}`}>{STATUS_LABELS[o.status] || o.status}</Badge>
              </div>
              <div className="flex justify-between items-center mt-2">
                <p className="font-bold">{o.price.toFixed(2)}€</p>
                {o.status === "ouverte" && (
                  <Button size="sm" className="h-9 text-xs" onClick={() => updateStatus.mutate({ id: o.id, status: "reservee" })}>
                    Réserver
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {showNew && <NewExchangeDialog onClose={() => setShowNew(false)} />}
    </div>
  );
}

function NewExchangeDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [fromRide, setFromRide] = useState("");
  const [toZone, setToZone] = useState("");
  const [price, setPrice] = useState("");

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/crm/ride-exchange", { from_ride: fromRide, to_zone: toZone, price: parseFloat(price) || 0 }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/crm/ride-exchange"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Proposer une course</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Textarea placeholder="Description de la course (ex: Paris 8e → Roissy CDG, 2 bagages)" value={fromRide} onChange={(e) => setFromRide(e.target.value)} rows={2} />
          <Input placeholder="Zone d'arrivée" value={toZone} onChange={(e) => setToZone(e.target.value)} className="h-11" />
          <Input placeholder="Prix proposé €" type="number" value={price} onChange={(e) => setPrice(e.target.value)} className="h-11" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="h-11">Annuler</Button>
          <Button onClick={() => mutation.mutate()} disabled={!fromRide.trim() || !toZone.trim() || mutation.isPending} className="h-11">Publier</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Onglet Templates réponses auto (17.1)
// ═════════════════════════════════════════════════════════════════════════════
function TemplatesTab() {
  const qc = useQueryClient();

  const { data: templates = [], isLoading } = useQuery<AutoReplyTemplate[]>({
    queryKey: ["/api/crm/auto-reply-templates"],
    queryFn: () => apiRequest("GET", "/api/crm/auto-reply-templates").then((r) => r.json()),
    staleTime: 30_000,
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => apiRequest("PUT", `/api/crm/auto-reply-templates/${id}`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/crm/auto-reply-templates"] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/crm/auto-reply-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/crm/auto-reply-templates"] }),
  });

  return (
    <div className="space-y-3">
      <Card className="border-blue-500/30 bg-blue-500/5">
        <CardContent className="p-3 text-xs text-muted-foreground">
          Ces réponses types sont conçues pour répondre rapidement (copier/coller SMS ou WhatsApp) sans interaction complexe pendant la conduite.
        </CardContent>
      </Card>

      {isLoading && <p className="text-sm text-muted-foreground text-center py-8">Chargement…</p>}

      <div className="space-y-2">
        {templates.map((t) => (
          <Card key={t.id} className={!t.active ? "opacity-50" : ""} data-testid={`template-card-${t.id}`}>
            <CardContent className="p-3">
              <div className="flex justify-between items-start gap-2 mb-1.5">
                <Badge variant="secondary" className="text-[10px]">{TRIGGER_LABELS[t.trigger_type] || t.trigger_type}</Badge>
              </div>
              <p className="text-sm">{t.message}</p>
              <div className="flex gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 flex-1 text-xs"
                  onClick={() => { navigator.clipboard?.writeText(t.message); }}
                >
                  Copier
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 flex-1 text-xs"
                  onClick={() => toggleActive.mutate({ id: t.id, active: !t.active })}
                >
                  {t.active ? "Désactiver" : "Activer"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-9 w-9 p-0"
                  onClick={() => { if (confirm("Supprimer ce template ?")) remove.mutate(t.id); }}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
