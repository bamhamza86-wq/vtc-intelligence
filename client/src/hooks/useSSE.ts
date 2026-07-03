// ─── Hook useSSE — connexion Server-Sent Events avec reconnexion auto ─────────
// Levier 1 : écoute le flux /api/stream, expose l'état de connexion et le dernier
// événement reçu, et émet un CustomEvent window "vtc:sse" pour resynchroniser
// les queries (React Query) sans polling.
import { useEffect, useRef, useState } from "react";

export function useSSE(url: string = "/api/stream") {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<{ type: string; data: any; at: Date } | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.onopen = () => { setConnected(true); retryRef.current = 0; };
      es.onerror = () => {
        setConnected(false);
        es.close();
        // ─── Reconnexion exponentielle max 30s ─────
        const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30000);
        retryRef.current++;
        setTimeout(connect, delay);
      };

      // Écoute événements typés
      ["zones:updated", "tick", "connected"].forEach(evt => {
        es.addEventListener(evt, (e: MessageEvent) => {
          try { setLastEvent({ type: evt, data: JSON.parse(e.data), at: new Date() }); } catch {}
          // Émettre un event window pour synchroniser les queries
          window.dispatchEvent(new CustomEvent("vtc:sse", { detail: { type: evt } }));
        });
      });
    }

    connect();
    return () => { cancelled = true; esRef.current?.close(); };
  }, [url]);

  return { connected, lastEvent };
}
