/**
 * ChargingStationsMap — Calque Leaflet "Bornes ⚡" (rapport.md §6.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer optionnel activable via toggle dans MapPage. Affiche des pins électriques
 * cliquables (puissance, disponibilité, prix estimé) à partir de
 * GET /api/ux/charging-stations?lat=&lng=&radius_km=.
 *
 * Utilise `window.L` (Leaflet déjà chargé en CDN par MapPage — zéro nouvelle
 * dépendance npm), suit le même pattern que les autres calques de MapPage.tsx
 * (community heatmap, markers PredictHQ...).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface ChargingStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  network: string;
  powerKw: number;
  connectorType: string;
  available: boolean;
  estimatedPriceEurPerKwh: number;
  address: string;
  distanceKm?: number;
}

interface ChargingStationsResponse {
  source: string;
  stations: ChargingStation[];
}

interface Props {
  mapInstance: React.MutableRefObject<any>;
  enabled: boolean;
  lat: number;
  lng: number;
}

export function ChargingStationsMap({ mapInstance, enabled, lat, lng }: Props) {
  const markersRef = useRef<any[]>([]);

  const { data } = useQuery<ChargingStationsResponse>({
    queryKey: ["/api/ux/charging-stations", lat, lng],
    queryFn: () =>
      apiRequest("GET", `/api/ux/charging-stations?lat=${lat}&lng=${lng}&radius_km=8`).then((r) => r.json()),
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: enabled ? 5 * 60_000 : false,
  });

  useEffect(() => {
    const render = () => {
      const L = (window as any).L;
      if (!L || !mapInstance.current) {
        setTimeout(render, 400);
        return;
      }

      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      if (!enabled || !data?.stations) return;

      data.stations.forEach((station) => {
        const color = station.available ? "#22c55e" : "#71717a";
        const icon = L.divIcon({
          className: "",
          html: `<div style="position:relative;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:${color}dd;border:2px solid #fff;box-shadow:0 0 6px ${color};font-size:14px;">⚡</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });

        const marker = L.marker([station.lat, station.lng], { icon, zIndexOffset: 800 }).addTo(mapInstance.current);
        marker.bindPopup(
          `<div style="font-family:sans-serif;font-size:12px;min-width:180px;">
            <strong>${station.name}</strong><br/>
            <span style="color:#666;">${station.network} · ${station.connectorType}</span><br/>
            <span>Puissance : <strong>${station.powerKw} kW</strong></span><br/>
            <span>Statut : <strong style="color:${station.available ? "#16a34a" : "#71717a"};">${station.available ? "Disponible" : "Occupée/inconnue"}</strong></span><br/>
            <span>Prix estimé : <strong>~${station.estimatedPriceEurPerKwh.toFixed(2)}€/kWh</strong></span>
            ${station.distanceKm != null ? `<br/><span style="color:#666;">${station.distanceKm} km</span>` : ""}
          </div>`
        );
        markersRef.current.push(marker);
      });
    };
    render();

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, data]);

  return null;
}

export default ChargingStationsMap;
