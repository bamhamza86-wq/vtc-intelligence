import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bell, BellOff, Clock, Euro, AlertTriangle, Zap, Cloud, Train } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

const PRIORITY_CONFIG: any = {
  critical: { label: "Critique", className: "text-red-400 border-red-500/40", border: "border-l-red-500" },
  high: { label: "Haute", className: "text-amber-400 border-amber-500/40", border: "border-l-amber-400" },
  medium: { label: "Moyenne", className: "text-blue-400 border-blue-500/40", border: "border-l-blue-400" },
  low: { label: "Faible", className: "text-muted-foreground border-border", border: "border-l-muted-foreground" },
};
const TYPE_ICONS: any = { demand_spike: Zap, event_ending: AlertTriangle, weather_boost: Cloud, transport_disruption: Train, long_ride_opportunity: Bell };

function timeLeft(expiresAt: string) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expiré";
  const mins = Math.floor(diff / 60000);
  return mins < 60 ? `${mins}min` : `${Math.floor(mins/60)}h${mins%60>0?`${mins%60}m`:""}`;
}

export default function AlertsPage() {
  const { data: alerts = [], isLoading } = useQuery({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then(r => r.json()),
    refetchInterval: 30000,
  });
  const markRead = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/alerts/${id}/read`).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/alerts"] }),
  });

  const unread = (alerts as any[]).filter(a => !a.is_read);
  const read = (alerts as any[]).filter(a => a.is_read);

  if (isLoading) return <div className="p-4 space-y-3">{[...Array(3)].map((_,i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>;
  if ((alerts as any[]).length === 0) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-center px-4">
      <BellOff size={40} className="text-muted-foreground/40" />
      <p className="font-medium">Aucune alerte active</p>
      <p className="text-sm text-muted-foreground">Les opportunités apparaîtront ici en temps réel</p>
    </div>
  );

  const AlertCard = ({ alert }: { alert: any }) => {
    const cfg = PRIORITY_CONFIG[alert.priority] || PRIORITY_CONFIG.low;
    const TypeIcon = TYPE_ICONS[alert.type] || Bell;
    return (
      <Card className={`border-l-4 ${cfg.border} ${alert.is_read ? "opacity-60" : ""}`} data-testid={`card-alert-${alert.id}`}>
        <CardContent className="py-3 px-4">
          <div className="flex items-start gap-3">
            <TypeIcon size={18} className={`mt-0.5 shrink-0 ${alert.is_read ? "text-muted-foreground" : "text-foreground"}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2 mb-1">
                <p className={`font-semibold text-sm ${alert.is_read ? "text-muted-foreground" : ""}`}>{alert.title}</p>
                <Badge variant="outline" className={`text-[10px] py-0 shrink-0 ${cfg.className}`}>{cfg.label}</Badge>
              </div>
              <p className="text-xs text-muted-foreground mb-2">{alert.message}</p>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
                {alert.estimated_revenue && <span className="flex items-center gap-1 text-green-400 font-medium"><Euro size={10} />~{alert.estimated_revenue}€ estimés</span>}
                <span className="flex items-center gap-1"><Clock size={10} />Expire dans {timeLeft(alert.expires_at)}</span>
              </div>
            </div>
          </div>
          {!alert.is_read && (
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => markRead.mutate(alert.id)} disabled={markRead.isPending} data-testid={`button-mark-read-${alert.id}`}>Marquer lu</Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between">
        <div><h2 className="font-bold text-lg">Alertes</h2><p className="text-sm text-muted-foreground">{unread.length} non lue{unread.length>1?"s":""}</p></div>
        {unread.length > 0 && <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute inline-flex h-2.5 w-2.5 rounded-full bg-red-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span></span>}
      </div>
      {unread.length > 0 && <div className="space-y-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Non lues</p>{unread.map(a => <AlertCard key={a.id} alert={a} />)}</div>}
      {read.length > 0 && <div className="space-y-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lues</p>{read.map(a => <AlertCard key={a.id} alert={a} />)}</div>}
      <Card className="border-primary/20 bg-primary/5 mt-4">
        <CardContent className="py-4 px-4">
          <p className="text-xs font-semibold mb-3 text-primary">Stratégies clés</p>
          <div className="space-y-2 text-xs text-muted-foreground">
            {[
              ["①","CDG/Orly — Flux arrivées","Positionnez-vous 30min avant atterrissage. Courses 35-55€ vers Paris/La Défense."],
              ["②","Stade de France sortie","80 000 spec. = surge x4. Rue Jules Rimet, 20min avant le coup de sifflet final."],
              ["③","Villepinte / Le Bourget","Salons pro = clients business → longues courses garanties. Tarifs 30-50€."],
              ["④","Pointe matinale 93 (6h-9h)","Plaine Commune, Aulnay, Tremblay vers La Défense/Paris. Ratio D/O > 2.5x."],
              ["⑤","Nuit IDF (22h-3h)","CDG actif 24h. Taxis rares = surge élevé. Courses 40-70€ depuis l'aéroport."],
            ].map(([num, title, desc]) => (
              <div key={num} className="flex gap-2"><span className="text-amber-400 font-bold shrink-0">{num}</span><span><strong>{title}</strong> — {desc}</span></div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
