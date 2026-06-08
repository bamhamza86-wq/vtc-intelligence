import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, Clock, Zap } from "lucide-react";

const COLORS = { ultraHigh: "#22c55e", high: "#86efac", medium: "#fbbf24", low: "#f97316", veryLow: "#ef4444" };

function getProfitColor(idx: number) {
  if (idx >= 75) return COLORS.ultraHigh;
  if (idx >= 60) return COLORS.high;
  if (idx >= 40) return COLORS.medium;
  if (idx >= 25) return COLORS.low;
  return COLORS.veryLow;
}
function getProfitLabel(idx: number) {
  if (idx >= 75) return "Ultra rentable";
  if (idx >= 60) return "Rentable";
  if (idx >= 40) return "Neutre";
  if (idx >= 25) return "Faible";
  return "Saturé";
}

function MapLoader() {
  useEffect(() => {
    if ((window as any).L) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    document.head.appendChild(script);
  }, []);
  return null;
}

export default function MapPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const eventMarkersRef = useRef<any[]>([]);
  const now = new Date();
  const [selectedHour, setSelectedHour] = useState(now.getHours());
  const [dayType, setDayType] = useState([0,6].includes(now.getDay()) ? "weekend" : "weekday");
  const [selectedZone, setSelectedZone] = useState<any>(null);

  const { data: zones = [] } = useQuery({ queryKey: ["/api/zones"], queryFn: () => apiRequest("GET", "/api/zones").then(r => r.json()) });
  const { data: profitability = [] } = useQuery({ queryKey: ["/api/profitability", selectedHour, dayType], queryFn: () => apiRequest("GET", `/api/profitability?hour=${selectedHour}&dayType=${dayType}`).then(r => r.json()) });
  const { data: topZones = [] } = useQuery({ queryKey: ["/api/top-zones", selectedHour, dayType], queryFn: () => apiRequest("GET", `/api/top-zones?hour=${selectedHour}&dayType=${dayType}&limit=5`).then(r => r.json()) });
  const { data: events = [] } = useQuery({ queryKey: ["/api/events"], queryFn: () => apiRequest("GET", "/api/events").then(r => r.json()), refetchInterval: 60000 });

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    const tryInit = () => {
      const L = (window as any).L;
      if (!L) { setTimeout(tryInit, 300); return; }
      const map = L.map(mapRef.current, { center: [48.9180, 2.4350], zoom: 11, zoomControl: true });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { attribution: "© OpenStreetMap © CARTO", subdomains: "abcd", maxZoom: 19 }).addTo(map);
      mapInstance.current = map;
    };
    setTimeout(tryInit, 500);
  }, []);

  useEffect(() => {
    const L = (window as any).L;
    if (!L || !mapInstance.current || !zones.length || !profitability.length) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    const profMap: any = Object.fromEntries((profitability as any[]).map((p: any) => [p.zone_id, p]));
    (zones as any[]).forEach((zone: any) => {
      const prof = profMap[zone.id];
      if (!prof) return;
      const idx = prof.profitability_index;
      const color = getProfitColor(idx);
      const radius = 20 + (idx / 100) * 30;
      const circle = L.circleMarker([zone.lat, zone.lng], { radius, fillColor: color, fillOpacity: 0.65, color, weight: 2, opacity: 0.9 }).addTo(mapInstance.current);
      circle.on("click", () => setSelectedZone({ zone, prof }));
      const label = L.divIcon({ className: "", html: `<div style="background:rgba(0,0,0,0.75);color:white;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid ${color};line-height:1.3;">${zone.name.split(" ").slice(0,2).join(" ")}<br><span style="color:${color}">${Math.round(idx)}%</span></div>`, iconAnchor: [0,0] });
      const lm = L.marker([zone.lat + 0.002, zone.lng], { icon: label, interactive: false }).addTo(mapInstance.current);
      markersRef.current.push(circle, lm);
    });
  }, [zones, profitability]);

  useEffect(() => {
    const L = (window as any).L;
    if (!L || !mapInstance.current) return;
    eventMarkersRef.current.forEach(m => m.remove());
    eventMarkersRef.current = [];
    (events as any[]).forEach((event: any) => {
      if (!event.zone) return;
      const icon = L.divIcon({ className: "", html: `<div style="background:#f59e0b;color:#000;padding:4px 9px;border-radius:14px;font-size:11px;font-weight:800;white-space:nowrap;box-shadow:0 3px 12px rgba(245,158,11,0.8);border:2px solid #fff;">⚡ ${event.name.substring(0,22)}</div>`, iconAnchor: [0, 0] });
      const m = L.marker([event.zone.lat + 0.006, event.zone.lng + 0.005], { icon, zIndexOffset: 1000 }).addTo(mapInstance.current);
      eventMarkersRef.current.push(m);
    });
  }, [events, profitability]);

  const fmtH = (h: number) => `${h.toString().padStart(2,"0")}:00`;

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8.5rem)" }}>
      <MapLoader />
      <div className="bg-card border-b border-border px-3 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-48">
          <Clock size={14} className="text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground w-10 shrink-0">{fmtH(selectedHour)}</span>
          <Slider value={[selectedHour]} min={0} max={23} step={1} onValueChange={([v]) => setSelectedHour(v)} className="flex-1" data-testid="slider-hour" />
        </div>
        <Select value={dayType} onValueChange={setDayType}>
          <SelectTrigger className="w-32 h-8 text-xs" data-testid="select-day-type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="weekday">Semaine</SelectItem>
            <SelectItem value="weekend">Weekend</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="bg-card/80 px-3 py-1.5 flex items-center gap-3 text-xs border-b border-border flex-wrap">
        {Object.entries({ "Ultra rentable": COLORS.ultraHigh, "Rentable": COLORS.high, "Neutre": COLORS.medium, "Faible": COLORS.low, "Saturé": COLORS.veryLow }).map(([label, color]) => (
          <div key={label} className="flex items-center gap-1"><span className="w-3 h-3 rounded-full inline-block" style={{ background: color }} /><span className="text-muted-foreground">{label}</span></div>
        ))}
        <div className="flex items-center gap-1 ml-auto"><span className="w-3 h-3 rounded inline-block bg-amber-400" /><span className="text-muted-foreground">Événement</span></div>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 relative">
          <div ref={mapRef} style={{ width: "100%", height: "100%" }} data-testid="map-container" />
          {selectedZone && (() => {
            const p = selectedZone.prof;
            const profIdx = p.profitability_index ?? 0;
            const ratioDs = p.ratio_ds ?? 0;
            const avgDist = p.avg_distance_km ?? 0;
            const longRide = p.long_ride_probability ?? 0;
            const surge = p.surge_multiplier ?? 1;
            return (
              <div className="absolute bottom-4 left-4 right-4 z-[1000] max-w-sm">
                <Card className="shadow-2xl border-primary/30">
                  <CardHeader className="pb-2 pt-3 px-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-sm">{selectedZone.zone.name}</CardTitle>
                        <p className="text-xs text-muted-foreground capitalize">{selectedZone.zone.type}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full" style={{ background: getProfitColor(profIdx) }} />
                        <Badge variant="outline" className="text-xs py-0" style={{ borderColor: getProfitColor(profIdx), color: getProfitColor(profIdx) }}>{getProfitLabel(profIdx)}</Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-3">
                    <div className="grid grid-cols-3 gap-2 text-center mb-2">
                      <div className="bg-muted rounded p-1.5"><p className="text-[10px] text-muted-foreground">D/O ratio</p><p className="text-sm font-bold text-primary">{ratioDs.toFixed(1)}x</p></div>
                      <div className="bg-muted rounded p-1.5"><p className="text-[10px] text-muted-foreground">Dist. moy.</p><p className="text-sm font-bold">{avgDist.toFixed(1)} km</p></div>
                      <div className="bg-muted rounded p-1.5"><p className="text-[10px] text-muted-foreground">Longue</p><p className="text-sm font-bold text-green-500">{Math.round(longRide * 100)}%</p></div>
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Score: <strong className="text-foreground">{Math.round(profIdx)}/100</strong></span>
                      {surge > 1 && <span className="text-amber-500 font-medium">⚡ Surge x{surge}</span>}
                    </div>
                    <button className="text-xs text-muted-foreground mt-2 hover:text-foreground" onClick={() => setSelectedZone(null)}>Fermer</button>
                  </CardContent>
                </Card>
              </div>
            );
          })()}
        </div>
        <div className="w-56 border-l border-border bg-card overflow-y-auto hidden md:block">
          <div className="p-3 border-b border-border"><p className="text-xs font-semibold flex items-center gap-1.5"><TrendingUp size={13} className="text-primary" />Top zones — {fmtH(selectedHour)}</p></div>
          <div className="divide-y divide-border">
            {(topZones as any[]).map((item: any, i: number) => {
              const idx = item.profitability_index ?? 0;
              const lrp = item.long_ride_probability ?? 0;
              return (
                <button key={item.zone_id} className="w-full p-3 text-left hover:bg-muted/50 transition-colors" onClick={() => setSelectedZone({ zone: item.zone, prof: item })} data-testid={`button-zone-${item.zone_id}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-muted-foreground font-mono">#{i+1}</span>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: getProfitColor(idx) }} />
                    <span className="text-xs font-medium truncate">{item.zone?.name}</span>
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>{Math.round(idx)}/100</span>
                    <span className="text-green-500">{Math.round(lrp * 100)}% longue</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-muted rounded-full overflow-hidden"><div className="h-full rounded-full transition-all" style={{ width: `${idx}%`, background: getProfitColor(idx) }} /></div>
                </button>
              );
            })}
          </div>
          {(events as any[]).length > 0 && (
            <>
              <div className="p-3 border-t border-b border-border mt-2"><p className="text-xs font-semibold flex items-center gap-1.5"><Zap size={13} className="text-amber-500" />Événements actifs</p></div>
              <div className="divide-y divide-border">
                {(events as any[]).map((event: any) => (
                  <div key={event.id} className="p-3">
                    <p className="text-xs font-medium">{event.name}</p>
                    <p className="text-[10px] text-muted-foreground">{event.zone?.name}</p>
                    <Badge className="text-[10px] mt-1 py-0" variant="secondary">⚡ Boost x{event.demand_boost}</Badge>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
