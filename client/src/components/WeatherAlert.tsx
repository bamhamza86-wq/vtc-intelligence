/**
 * WeatherAlert — Ping météo & corrélation surge (Vague 1 - Levier 8)
 * ─────────────────────────────────────────────────────────────────────────────
 * Consomme /api/weather/current et affiche un bandeau si :
 *   - Pluie ou orage détecté ou prévu dans la prochaine heure
 * La corrélation "pluie → demande" est un signal empirique fort côté VTC :
 * on incite le chauffeur à se repositionner avant le pic.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { CloudRain, X } from "lucide-react";
import { useState } from "react";
import { API_BASE, getAuthToken } from "@/lib/queryClient";
import { speak } from "@/lib/voice";
import { opportunity } from "@/lib/haptics";

interface WeatherCondition {
  condition?: string;
  precipitation_mm?: number;
  will_rain_next_hour?: boolean;
  description?: string;
}

interface WeatherPayload {
  condition?: WeatherCondition | string;
  precipitation_mm?: number;
  will_rain_next_hour?: boolean;
  description?: string;
  zones_impacted?: string[];
}

const LS_LAST_ALERT = "vtc.weather.lastAlert";

export default function WeatherAlert() {
  const [dismissed, setDismissed] = useState(false);
  const announcedRef = useRef(false);

  const { data } = useQuery<WeatherPayload | null>({
    queryKey: ["weatherCurrent"],
    refetchInterval: 15 * 60 * 1000, // 15 min
    queryFn: async () => {
      const token = getAuthToken();
      const res = await fetch(`${API_BASE}/api/weather/current`, {
        headers: token ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token } : {},
      });
      if (!res.ok) return null;
      return res.json();
    },
  });

  // API can return either flat payload or nested { condition: {...}, zones_impacted }
  const cond =
    data && typeof data.condition === "object" && data.condition !== null
      ? (data.condition as WeatherCondition)
      : (data as WeatherCondition | undefined);
  const conditionStr = typeof data?.condition === "string" ? data.condition : cond?.condition ?? "";
  const willRain =
    cond?.will_rain_next_hour === true ||
    (cond?.precipitation_mm != null && cond.precipitation_mm > 0.5) ||
    (typeof conditionStr === "string" && conditionStr.toLowerCase().match(/rain|storm|shower|drizzle|pluie|orage/));

  useEffect(() => {
    if (!willRain || announcedRef.current || dismissed) return;
    const last = Number(localStorage.getItem(LS_LAST_ALERT) || 0);
    if (Date.now() - last < 30 * 60 * 1000) return; // Debounce 30 min
    announcedRef.current = true;
    localStorage.setItem(LS_LAST_ALERT, String(Date.now()));
    opportunity();
    speak(
      "Pluie détectée. La demande VTC va augmenter — repositionnez-vous vers les zones actives.",
      { priority: "high" },
    );
  }, [willRain, dismissed]);

  if (!willRain || dismissed) return null;

  return (
    <div
      className="rounded-xl border shadow-lg"
      style={{
        background: "linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(14,165,233,0.15) 100%)",
        borderColor: "rgba(56,189,248,0.5)",
      }}
      role="alert"
      data-testid="weather-alert"
    >
      <div className="flex items-start gap-3 p-3">
        <div className="p-2 rounded-lg bg-sky-500/20 text-sky-100 flex-shrink-0">
          <CloudRain size={22} />
        </div>
        <div className="flex-1 min-w-0 text-sky-100">
          <div className="font-semibold text-sm">Pluie imminente</div>
          <div className="text-xs opacity-90 mt-0.5">
            {data?.description || "Précipitations attendues dans l'heure"} — la demande VTC va
            augmenter. Repositionnez-vous.
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="p-2 rounded-lg hover:bg-white/10 text-sky-100 flex-shrink-0"
          style={{ minHeight: 40, minWidth: 40 }}
          aria-label="Ignorer l'alerte météo"
          data-testid="button-dismiss-weather"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
