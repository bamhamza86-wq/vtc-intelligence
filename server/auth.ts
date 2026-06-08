/**
 * auth.ts — Authentification VTC Intelligence
 * Token opaque en mémoire, transmis via Authorization: Bearer <token>
 * Compatible avec le proxy pplx.app (pas de cookies de session)
 * Credentials par défaut : root / 12345678
 */

import type { Express, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";

// ─── Utilisateurs ─────────────────────────────────────────────────────────────

interface User {
  id: number;
  username: string;
  passwordHash: string;
  role: "admin" | "driver";
}

const DEFAULT_HASH = bcrypt.hashSync("12345678", 10);

const users: User[] = [
  { id: 1, username: "root", passwordHash: DEFAULT_HASH, role: "admin" },
];

// ─── Store de tokens en mémoire ───────────────────────────────────────────────

interface TokenEntry {
  userId: number;
  username: string;
  role: string;
  generation: number;
  createdAt: number;
  expiresAt: number; // 8h
}

const tokenStore = new Map<string, TokenEntry>();
let sessionGeneration = 1;

export function revokeAllSessions() {
  sessionGeneration++;
  tokenStore.clear();
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function cleanExpiredTokens() {
  const now = Date.now();
  for (const [tok, entry] of tokenStore.entries()) {
    if (entry.expiresAt < now || entry.generation < sessionGeneration) {
      tokenStore.delete(tok);
    }
  }
}

// ─── Extraction du token depuis la requête ────────────────────────────────────
// Priorité : Authorization: Bearer <token>  puis  X-Auth-Token: <token>

function extractToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  const xauth = req.headers["x-auth-token"] as string | undefined;
  if (xauth) return xauth.trim();
  return null;
}

// ─── Middleware requireAuth ───────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  cleanExpiredTokens();
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "Non authentifié", code: "UNAUTHORIZED" });
  }
  const entry = tokenStore.get(token);
  if (!entry || entry.generation < sessionGeneration || entry.expiresAt < Date.now()) {
    tokenStore.delete(token ?? "");
    return res.status(401).json({ error: "Session expirée", code: "SESSION_EXPIRED" });
  }
  (req as any).authUser = { userId: entry.userId, username: entry.username, role: entry.role };
  next();
}

// ─── Enregistrement des routes auth ───────────────────────────────────────────

export function registerAuth(app: Express) {
  // POST /api/auth/login — retourne un token Bearer
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { username, password } = req.body as { username: string; password: string };
    if (!username || !password) {
      return res.status(400).json({ error: "Identifiant et mot de passe requis." });
    }
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
    }
    const token = generateToken();
    const now = Date.now();
    tokenStore.set(token, {
      userId: user.id,
      username: user.username,
      role: user.role,
      generation: sessionGeneration,
      createdAt: now,
      expiresAt: now + 8 * 60 * 60 * 1000, // 8h
    });
    return res.json({ success: true, token, username: user.username, role: user.role });
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", (req: Request, res: Response) => {
    const token = extractToken(req);
    if (token) tokenStore.delete(token);
    res.json({ success: true });
  });

  // GET /api/auth/me
  app.get("/api/auth/me", (req: Request, res: Response) => {
    const token = extractToken(req);
    if (!token) return res.json({ authenticated: false });
    const entry = tokenStore.get(token);
    if (!entry || entry.generation < sessionGeneration || entry.expiresAt < Date.now()) {
      return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, username: entry.username, role: entry.role });
  });

  // POST /api/auth/revoke-all — déconnecte tout le monde
  app.post("/api/auth/revoke-all", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).authUser;
    if (user?.role !== "admin") {
      return res.status(403).json({ error: "Accès refusé" });
    }
    revokeAllSessions();
    res.json({ success: true, message: "Toutes les sessions révoquées." });
  });
}
