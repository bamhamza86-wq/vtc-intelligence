import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, Clock, Zap, Plane, ChevronDown, ChevronUp } from "lucide-react";
import { UpdateWidget } from "@/components/UpdateWidget";

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
function getPeakColor(level: string) {
  return { low: "#6b7280", medium: "#fbbf24", high: "#f97316", surge: "#ef4444" }[level] || "#6b7280";
}
function getPeakLabel(level: string) {
  return { low: "Flux faible", medium: "Flux modéré", high: "Flux élevé", surge: "SURGE" }[level] || level;
}
function fmtTime(iso: string | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
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

// ─── Panel vols compact ───────────────────────────────────────────────────────
function FlightPanel({ flightData }: { flightData: any }) {
  const [expanded, setExpanded] = useState(false);
  if (!flightData) return null;
  const { cdg, orly, flights, source } = flightData;

  return (
    <div className="bg-card border-b border-border px-3 py-2">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between text-xs font-semibold"
      >
        <span className="flex items-center gap-1.5">
          <Plane size={13} className="text-sky-400" />
          <span className="text-sky-400">Vols temps réel</span>
          <span className="ml-2 flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: getPeakColor(cdg.peak_level) }} />
              <span className="text-muted-foreground">CDG</span>
              <span className="font-bold" style={{ color: getPeakColor(cdg.peak_level) }}>{cdg.arrivals_next_hour} arr/h</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: getPeakColor(orly.peak_level) }} />
              <span className="text-muted-foreground">Orly</span>
              <span className="font-bold" style={{ color: getPeakColor(orly.peak_level) }}>{orly.arrivals_next_hour} arr/h</span>
            </span>
          </span>
        </span>
        <span className="text-muted-foreground flex items-center gap-1">
          <span className="text-[10px] opacity-60">{source === "opensky" ? "OpenSky" : "Heuristique"}</span>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {/* CDG */}
          <div className="rounded-lg p-2 border" style={{ borderColor: getPeakColor(cdg.peak_level) + "66" }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-sky-300">✈ CDG — Roissy</span>
              <Badge className="text-[9px] py-0 px-1" style={{ background: getPeakColor(cdg.peak_level) + "33", color: getPeakColor(cdg.peak_level), border: `1px solid ${getPeakColor(cdg.peak_level)}66` }}>
                {getPeakLabel(cdg.peak_level)}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-1 text-[10px]">
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Arrivées/h</p>
                <p className="font-bold text-sm" style={{ color: getPeakColor(cdg.peak_level) }}>{cdg.arrivals_next_hour}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Départs/h</p>
                <p className="font-bold text-sm">{cdg.departures_next_hour}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Pax VTC</p>
                <p className="font-bold text-green-400">{cdg.passenger_volume_estimate}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Boost ×</p>
                <p className="font-bold text-amber-400">{cdg.vtc_demand_boost.toFixed(2)}</p>
              </div>
            </div>
            {cdg.next_wave_eta && (
              <p className="text-[10px] text-amber-400 mt-1">
                ⏰ Prochaine vague : {fmtTime(cdg.next_wave_eta)}
              </p>
            )}
          </div>

          {/* Orly */}
          <div className="rounded-lg p-2 border" style={{ borderColor: getPeakColor(orly.peak_level) + "66" }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-sky-300">✈ Orly</span>
              <Badge className="text-[9px] py-0 px-1" style={{ background: getPeakColor(orly.peak_level) + "33", color: getPeakColor(orly.peak_level), border: `1px solid ${getPeakColor(orly.peak_level)}66` }}>
                {getPeakLabel(orly.peak_level)}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-1 text-[10px]">
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Arrivées/h</p>
                <p className="font-bold text-sm" style={{ color: getPeakColor(orly.peak_level) }}>{orly.arrivals_next_hour}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Départs/h</p>
                <p className="font-bold text-sm">{orly.departures_next_hour}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Pax VTC</p>
                <p className="font-bold text-green-400">{orly.passenger_volume_estimate}</p>
              </div>
              <div className="bg-muted/60 rounded p-1 text-center">
                <p className="text-muted-foreground">Boost ×</p>
                <p className="font-bold text-amber-400">{orly.vtc_demand_boost.toFixed(2)}</p>
              </div>
            </div>
            {orly.next_wave_eta && (
              <p className="text-[10px] text-amber-400 mt-1">
                ⏰ Prochaine vague : {fmtTime(orly.next_wave_eta)}
              </p>
            )}
          </div>

          {/* Liste des vols arrivants */}
          {flights && flights.length > 0 && (
            <div className="col-span-2 mt-1">
              <p className="text-[10px] font-semibold text-muted-foreground mb-1">Prochains atterrissages</p>
              <div className="space-y-0.5 max-h-24 overflow-y-auto">
                {flights.slice(0, 10).map((f: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-[10px] py-0.5 border-b border-border/40">
                    <span className="font-mono font-bold text-sky-300 w-16">{f.callsign}</span>
                    <span className="text-muted-foreground flex-1 px-1">{f.origin_airport || f.origin_country || "—"}</span>
                    <span className="text-green-400 mr-2">{f.airport}</span>
                    <span className="text-amber-400">{fmtTime(f.estimated_arrival)}</span>
                    <span className="text-muted-foreground ml-2 w-12 text-right">~{f.passengers_estimate} pax</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function MapPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const eventMarkersRef = useRef<any[]>([]);
  const flightMarkersRef = useRef<any[]>([]);
  const now = new Date();
  const [selectedHour, setSelectedHour] = useState(now.getHours());
  const [dayType, setDayType] = useState([0,6].includes(now.getDay()) ? "weekend" : "weekday");
  const [selectedZone, setSelectedZone] = useState<any>(null);

  const { data: zones = [] } = useQuery({ queryKey: ["/api/zones"], queryFn: () => apiRequest("GET", "/api/zones").then(r => r.json()) });
  const { data: profitability = [] } = useQuery({ queryKey: ["/api/profitability", selectedHour, dayType], queryFn: () => apiRequest("GET", `/api/profitability?hour=${selectedHour}&dayType=${dayType}`).then(r => r.json()) });
  const { data: topZones = [] } = useQuery({ queryKey: ["/api/top-zones", selectedHour, dayType], queryFn: () => apiRequest("GET", `/api/top-zones?hour=${selectedHour}&dayType=${dayType}&limit=5`).then(r => r.json()) });
  const { data: events = [] } = useQuery({ queryKey: ["/api/events"], queryFn: () => apiRequest("GET", "/api/events").then(r => r.json()), refetchInterval: 60000 });
  const { data: flightData } = useQuery({
    queryKey: ["/api/flights"],
    queryFn: () => apiRequest("GET", "/api/flights").then(r => r.json()),
    refetchInterval: 4 * 60 * 1000, // toutes les 4 min (aligne sur le cache backend)
  });

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    const tryInit = () => {
      const L = (window as any).L;
      if (!L) { setTimeout(tryInit, 300); return; }
      const map = L.map(mapRef.current, { center: [48.9180, 2.4350], zoom: 11, zoomControl: true });
      L.tileLayer("https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=fr", {
        attribution: "© Google Maps",
        subdomains: ["0","1","2","3"],
        maxZoom: 20,
        tileSize: 256,
      }).addTo(map);
      mapInstance.current = map;
    };
    setTimeout(tryInit, 500);
  }, []);

  // Markers zones profitabilité
  useEffect(() => {
    if (!zones.length || !profitability.length) return;
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }
      markersRef.current.forEach(m => m.remove());
      markersRef.current = [];
      const profMap: any = Object.fromEntries((profitability as any[]).map((p: any) => [p.zone_id, p]));
      (zones as any[]).forEach((zone: any) => {
        const prof = profMap[zone.id];
        if (!prof) return;
        const idx = prof.profitability_index ?? prof.profitabilityIndex ?? 0;
        const color = getProfitColor(idx);
        const radius = 20 + (idx / 100) * 30;
        const isAirport = zone.type === "airport";
        const flightBoost = prof.flight_boost ?? prof.flightBoost ?? 1.0;

        const circle = L.circleMarker([zone.lat, zone.lng], {
          radius: isAirport ? radius + 4 : radius,
          fillColor: color,
          fillOpacity: 0.65,
          color: isAirport ? "#38bdf8" : color,
          weight: isAirport ? 3 : 2,
          opacity: 0.9,
          dashArray: isAirport ? "6,3" : undefined,
        }).addTo(mapInstance.current);

        circle.on("click", () => setSelectedZone({ zone, prof }));

        // Étiquette — airports avec icône avion + boost vols
        const labelHtml = isAirport
          ? `<div style="background:rgba(0,0,0,0.85);color:white;padding:3px 7px;border-radius:6px;font-size:11px;font-weight:700;white-space:nowrap;border:2px solid #38bdf8;line-height:1.4;">
               ✈ ${zone.name.split("—")[0].trim()}<br>
               <span style="color:${color}">${Math.round(idx)}%</span>
               ${flightBoost > 1.0 ? `<span style="color:#fbbf24;font-size:10px;"> ×${flightBoost.toFixed(2)} ✈</span>` : ""}
             </div>`
          : `<div style="background:rgba(0,0,0,0.75);color:white;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid ${color};line-height:1.3;">${zone.name.split(" ").slice(0,2).join(" ")}<br><span style="color:${color}">${Math.round(idx)}%</span></div>`;

        const label = L.divIcon({ className: "", html: labelHtml, iconAnchor: [0, 0] });
        const lm = L.marker([zone.lat + (isAirport ? 0.004 : 0.002), zone.lng], { icon: label, interactive: false }).addTo(mapInstance.current);
        markersRef.current.push(circle, lm);
      });
    };
    render();
  }, [zones, profitability]);

  // Markers événements (incluant vols injectés)
  useEffect(() => {
    if (!(events as any[]).length) return;
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }
      eventMarkersRef.current.forEach(m => m.remove());
      eventMarkersRef.current = [];
      (events as any[]).forEach((event: any) => {
        if (!event.zone) return;
        const isFlightEvent = event.event_type === "flight_wave" || event.event_type === "flight_forecast";
        const isForecast = event.event_type === "flight_forecast";
        const bgColor = isFlightEvent ? (isForecast ? "#38bdf8" : "#0ea5e9") : "#f59e0b";
        const textColor = "#000";
        const prefix = isFlightEvent ? "✈" : "⚡";
        const label = event.name.substring(0, 26);
        const icon = L.divIcon({
          className: "",
          html: `<div style="background:${bgColor};color:${textColor};padding:3px 8px;border-radius:14px;font-size:10px;font-weight:800;white-space:nowrap;box-shadow:0 3px 12px ${bgColor}99;border:2px solid #fff;">${prefix} ${label}</div>`,
          iconAnchor: [0, 0],
        });
        const latOffset = isFlightEvent ? 0.010 : 0.006;
        const m = L.marker([event.zone.lat + latOffset, event.zone.lng + 0.005], { icon, zIndexOffset: 1000 }).addTo(mapInstance.current);
        m.bindPopup(`
          <div style="font-size:12px;min-width:220px;">
            <strong>${event.name}</strong><br>
            ${event.description || ""}<br>
            <span style="color:#f59e0b;">Boost ×${(event.demand_boost ?? 1).toFixed(2)}</span>
            ${event.expected_attendance ? `<br>~${event.expected_attendance} pass. VTC estim.` : ""}
          </div>
        `);
        eventMarkersRef.current.push(m);
      });
    };
    render();
  }, [events, profitability]);

  // Markers vols individuels (petits avions sur la carte pour les 8 prochains atterrissages)
  useEffect(() => {
    if (!flightData?.flights?.length) return;
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) { setTimeout(render, 400); return; }
      flightMarkersRef.current.forEach(m => m.remove());
      flightMarkersRef.current = [];

      // CDG et Orly coords
      const airportCoords: Record<string, [number, number]> = {
        CDG: [49.0097, 2.5479],
        ORLY: [48.7262, 2.3652],
      };

      (flightData.flights as any[]).slice(0, 12).forEach((f: any, i: number) => {
        const base = airportCoords[f.airport] || airportCoords.CDG;
        // Disposition en arc autour de l'aéroport
        const angle = (i / 12) * 2 * Math.PI;
        const r = 0.018 + (i % 3) * 0.006;
        const lat = base[0] + r * Math.cos(angle);
        const lng = base[1] + r * Math.sin(angle);

        const arrivalIn = f.estimated_arrival
          ? Math.max(0, Math.round((new Date(f.estimated_arrival).getTime() - Date.now()) / 60000))
          : "?";

        const icon = L.divIcon({
          className: "",
          html: `<div title="${f.callsign} — ${f.origin_airport || "?"} → ${f.airport} dans ${arrivalIn}min" style="font-size:14px;cursor:pointer;filter:drop-shadow(0 0 4px #38bdf8);">✈</div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        const m = L.marker([lat, lng], { icon, zIndexOffset: 500 }).addTo(mapInstance.current);
        m.bindPopup(`
          <div style="font-size:11px;">
            <strong>✈ ${f.callsign}</strong><br>
            ${f.origin_airport ? `Origine : ${f.origin_airport}` : ""}<br>
            Arrivée : <strong>${fmtTime(f.estimated_arrival)}</strong> (${arrivalIn} min)<br>
            ~${f.passengers_estimate || "?"} passagers<br>
            <span style="color:#fbbf24;">Aéroport : ${f.airport}</span>
          </div>
        `);
        flightMarkersRef.current.push(m);
      });
    };
    render();
  }, [flightData]);

  const fmtH = (h: number) => `${h.toString().padStart(2,"0")}:00`;

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8.5rem)" }}>
      <MapLoader />

      {/* Barre de contrôle heure/jour */}
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
        <div className="ml-auto">
          <UpdateWidget compact={true} />
        </div>
      </div>

      {/* Panel vols temps réel */}
      <FlightPanel flightData={flightData} />

      {/* Légende */}
      <div className="bg-card/80 px-3 py-1.5 flex items-center gap-3 text-xs border-b border-border flex-wrap">
        {Object.entries({ "Ultra rentable": COLORS.ultraHigh, "Rentable": COLORS.high, "Neutre": COLORS.medium, "Faible": COLORS.low, "Saturé": COLORS.veryLow }).map(([label, color]) => (
          <div key={label} className="flex items-center gap-1"><span className="w-3 h-3 rounded-full inline-block" style={{ background: color }} /><span className="text-muted-foreground">{label}</span></div>
        ))}
        <div className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-amber-400" /><span className="text-muted-foreground">Événement</span></div>
        <div className="flex items-center gap-1"><span className="text-sky-400">✈</span><span className="text-muted-foreground">Vols CDG/Orly</span></div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 relative">
          <div ref={mapRef} style={{ width: "100%", height: "100%" }} data-testid="map-container" />

          {/* Popup zone sélectionnée — enrichie avec données vols */}
          {selectedZone && (() => {
            const p = selectedZone.prof;
            const profIdx = p.profitability_index ?? p.profitabilityIndex ?? 0;
            const ratioDs = p.ratio_ds ?? p.ratioDs ?? 0;
            const avgDist = p.avg_distance_km ?? p.avgDistanceKm ?? 0;
            const longRide = p.long_ride_probability ?? p.longRideProbability ?? 0;
            const surge = p.surge_multiplier ?? p.surgeMultiplier ?? 1;
            const flightBoost = p.flight_boost ?? p.flightBoost ?? 1.0;
            const isAirport = selectedZone.zone.type === "airport";
            const airportKey = selectedZone.zone.id === "z_cdg" ? "cdg" : selectedZone.zone.id === "z_orly" ? "orly" : null;
            const airportStats = airportKey && flightData ? flightData[airportKey] : null;

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
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>Score: <strong className="text-foreground">{Math.round(profIdx)}/100</strong></span>
                      {surge > 1 && <span className="text-amber-500 font-medium">⚡ Surge ×{surge.toFixed(2)}</span>}
                    </div>

                    {/* Données vols si aéroport */}
                    {isAirport && airportStats && (
                      <div className="mt-2 rounded-lg p-2 border border-sky-500/30 bg-sky-950/30">
                        <p className="text-[10px] font-bold text-sky-400 mb-1 flex items-center gap-1">
                          <Plane size={10} /> Données vols en temps réel
                        </p>
                        <div className="grid grid-cols-2 gap-1 text-[10px]">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Arrivées/h :</span>
                            <span className="font-bold" style={{ color: getPeakColor(airportStats.peak_level) }}>{airportStats.arrivals_next_hour}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Départs/h :</span>
                            <span className="font-bold">{airportStats.departures_next_hour}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Pax VTC :</span>
                            <span className="font-bold text-green-400">~{airportStats.passenger_volume_estimate}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Boost vols :</span>
                            <span className="font-bold text-amber-400">×{flightBoost.toFixed(2)}</span>
                          </div>
                        </div>
                        <div className="mt-1 flex items-center justify-between">
                          <Badge className="text-[9px] py-0" style={{ background: getPeakColor(airportStats.peak_level) + "33", color: getPeakColor(airportStats.peak_level), border: `1px solid ${getPeakColor(airportStats.peak_level)}66` }}>
                            {getPeakLabel(airportStats.peak_level)}
                          </Badge>
                          {airportStats.next_wave_eta && (
                            <span className="text-[9px] text-amber-400">⏰ Prochaine vague {fmtTime(airportStats.next_wave_eta)}</span>
                          )}
                        </div>

                        {/* Liste vols arrivants pour cet aéroport */}
                        {flightData?.flights?.filter((f: any) => f.airport === (airportKey === "cdg" ? "CDG" : "ORLY")).slice(0, 4).map((f: any, i: number) => (
                          <div key={i} className="flex items-center justify-between text-[9px] border-t border-border/30 pt-0.5 mt-0.5">
                            <span className="font-mono font-bold text-sky-300">{f.callsign}</span>
                            <span className="text-muted-foreground">{f.origin_airport || "?"}</span>
                            <span className="text-amber-400">{fmtTime(f.estimated_arrival)}</span>
                            <span className="text-muted-foreground">{f.passengers_estimate} pax</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Boost vols pour zones proches (non-aéroport) */}
                    {!isAirport && flightBoost > 1.0 && (
                      <div className="mt-1.5 text-[10px] text-sky-400 bg-sky-950/30 rounded px-2 py-1 border border-sky-500/20">
                        ✈ Boost CDG/Orly actif sur cette zone : ×{flightBoost.toFixed(2)}
                      </div>
                    )}

                    <button className="text-xs text-muted-foreground mt-2 hover:text-foreground" onClick={() => setSelectedZone(null)}>Fermer</button>
                  </CardContent>
                </Card>
              </div>
            );
          })()}
        </div>

        {/* Sidebar droite */}
        <div className="w-56 border-l border-border bg-card overflow-y-auto hidden md:block">
          <div className="p-3 border-b border-border"><p className="text-xs font-semibold flex items-center gap-1.5"><TrendingUp size={13} className="text-primary" />Top zones — {fmtH(selectedHour)}</p></div>
          <div className="divide-y divide-border">
            {(topZones as any[]).map((item: any, i: number) => {
              const idx = item.profitability_index ?? item.profitabilityIndex ?? 0;
              const lrp = item.long_ride_probability ?? item.longRideProbability ?? 0;
              const flightBoost = item.flight_boost ?? item.flightBoost ?? 1.0;
              return (
                <button key={item.zone_id} className="w-full p-3 text-left hover:bg-muted/50 transition-colors" onClick={() => setSelectedZone({ zone: item.zone, prof: item })} data-testid={`button-zone-${item.zone_id}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-muted-foreground font-mono">#{i+1}</span>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: getProfitColor(idx) }} />
                    <span className="text-xs font-medium truncate">{item.zone?.name}</span>
                    {flightBoost > 1.05 && <Plane size={10} className="text-sky-400 shrink-0" />}
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>{Math.round(idx)}/100</span>
                    <span className="text-green-500">{Math.round(lrp * 100)}% longue</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-muted rounded-full overflow-hidden"><div className="h-full rounded-full transition-all" style={{ width: `${idx}%`, background: getProfitColor(idx) }} /></div>
                  {flightBoost > 1.05 && (
                    <p className="text-[9px] text-sky-400 mt-0.5">✈ ×{flightBoost.toFixed(2)} vols</p>
                  )}
                </button>
              );
            })}
          </div>

          {/* Événements sidebar — avec types vols */}
          {(events as any[]).length > 0 && (
            <>
              <div className="p-3 border-t border-b border-border mt-2">
                <p className="text-xs font-semibold flex items-center gap-1.5"><Zap size={13} className="text-amber-500" />Événements actifs</p>
              </div>
              <div className="divide-y divide-border">
                {(events as any[]).map((event: any) => {
                  const isFlightEvt = event.event_type === "flight_wave" || event.event_type === "flight_forecast";
                  return (
                    <div key={event.id} className="p-3">
                      <p className="text-xs font-medium flex items-center gap-1">
                        {isFlightEvt ? <Plane size={10} className="text-sky-400 shrink-0" /> : <Zap size={10} className="text-amber-400 shrink-0" />}
                        <span className="truncate">{event.name}</span>
                      </p>
                      <p className="text-[10px] text-muted-foreground">{event.zone?.name}</p>
                      <div className="flex items-center gap-1 mt-1">
                        <Badge className="text-[10px] mt-0 py-0" variant="secondary">
                          {isFlightEvt ? "✈" : "⚡"} Boost ×{(event.demand_boost ?? 1).toFixed(2)}
                        </Badge>
                        {event.expected_attendance && (
                          <span className="text-[9px] text-muted-foreground">~{event.expected_attendance} pax</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
