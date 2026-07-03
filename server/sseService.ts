// ─── Service SSE (Server-Sent Events) — push temps réel serveur → clients ─────
// Levier 1 : diffusion des mises à jour de zones sans polling côté client.
// Maintient un registre des connexions Response ouvertes et broadcast à tous.
import { EventEmitter } from "events";
import type { Response } from "express";

class SSEService extends EventEmitter {
  private clients = new Set<Response>();

  addClient(res: Response) { this.clients.add(res); }
  removeClient(res: Response) { this.clients.delete(res); }

  broadcast(event: string, data: any) {
    const payload = `event: ${event}\ndata: ${JSON.stringify({ ...data, _ts: Date.now() })}\n\n`;
    // Array.from pour itérer sans dépendre du target d'itération TS (cf. tsconfig)
    for (const client of Array.from(this.clients)) {
      try { client.write(payload); } catch { this.removeClient(client); }
    }
  }

  getClientCount() { return this.clients.size; }
}

export const sseService = new SSEService();
