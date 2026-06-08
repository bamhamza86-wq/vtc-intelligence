import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, Car, Train, Cloud, Calendar, Map, Users, Fuel } from "lucide-react";

const ICON_MAP: any = { car: Car, train: Train, cloud: Cloud, calendar: Calendar, map: Map, users: Users, fuel: Fuel };
const STATUS_BADGE: any = {
  open: { label: "Open Data", className: "text-green-400 border-green-500/40" },
  free: { label: "Gratuit", className: "text-blue-400 border-blue-500/40" },
  freemium: { label: "Freemium", className: "text-amber-400 border-amber-500/40" },
  paid: { label: "Payant", className: "text-red-400 border-red-500/40" },
  proprietary: { label: "Propriétaire", className: "text-muted-foreground border-border" },
};

export default function DataSourcesPage() {
  const { data, isLoading } = useQuery({ queryKey: ["/api/data-sources"], queryFn: () => apiRequest("GET", "/api/data-sources").then(r => r.json()) });
  if (isLoading) return <div className="p-4 space-y-4">{[...Array(4)].map((_,i) => <Skeleton key={i} className="h-40 w-full rounded-xl" />)}</div>;
  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div><h2 className="font-bold text-lg">Sources de données</h2><p className="text-sm text-muted-foreground">APIs et jeux de données pour l'analyse VTC</p></div>
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="py-4 px-4">
          <p className="text-xs font-semibold text-primary mb-3">Architecture Data Pipeline</p>
          <div className="flex items-center gap-2 text-xs overflow-x-auto pb-1">
            {["APIs Temps Réel","→","Data Lake","→","Feature Store","→","Modèles ML","→","Score Zone"].map((s,i) => (
              <span key={i} className={s==="→" ? "text-muted-foreground shrink-0" : "bg-background border border-border rounded px-2 py-1 shrink-0 font-medium"}>{s}</span>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3 text-center text-xs">
            <div className="bg-background rounded p-2"><p className="text-muted-foreground">Latence cible</p><p className="font-bold text-primary">&lt; 300ms</p></div>
            <div className="bg-background rounded p-2"><p className="text-muted-foreground">Refresh map</p><p className="font-bold text-primary">5 min</p></div>
            <div className="bg-background rounded p-2"><p className="text-muted-foreground">Prédiction</p><p className="font-bold text-primary">30 min</p></div>
          </div>
        </CardContent>
      </Card>
      {(data?.categories || []).map((cat: any) => {
        const Icon = ICON_MAP[cat.icon] || Map;
        return (
          <Card key={cat.name}>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Icon size={15} className="text-primary" />{cat.name}</CardTitle></CardHeader>
            <CardContent className="px-4 pb-3">
              <div className="space-y-2">
                {cat.sources.map((src: any) => {
                  const sc = STATUS_BADGE[src.status] || STATUS_BADGE.paid;
                  return (
                    <div key={src.name} className="flex items-start gap-3 py-2 border-t border-border first:border-t-0 first:pt-0">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-xs">{src.name}</span>
                          <Badge variant="outline" className={`text-[10px] py-0 h-4 ${sc.className}`}>{sc.label}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{src.description}</p>
                      </div>
                      {src.url && <a href={src.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-primary transition-colors mt-0.5" data-testid={`link-source-${src.name}`}><ExternalLink size={12} /></a>}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Croisements clés</CardTitle></CardHeader>
        <CardContent className="px-4 pb-3">
          <div className="space-y-2 text-xs">
            {[
              ["Pluie forte","Zone bureau","+35% demande matin"],
              ["Match fini","Stade","Pic massif 20min, surge x2.5"],
              ["Retard TGV","Gare","Explosion immédiate demande"],
              ["Périph fluide","Banlieue éloignée","Courses 25km+ rentables"],
              ["Métro fermé","Centre-ville","Demande x3, toutes zones"],
              ["Vacances scolaires","Aéroport","Volume x1.8 longues courses"],
            ].map((row, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5 border-t border-border first:border-t-0 first:pt-0">
                <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] shrink-0">{row[0]}</span>
                <span className="text-muted-foreground">+</span>
                <span className="bg-blue-500/10 text-blue-400 rounded px-1.5 py-0.5 text-[10px] shrink-0">{row[1]}</span>
                <span className="text-muted-foreground mx-1">→</span>
                <span className="text-green-400 font-medium">{row[2]}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
