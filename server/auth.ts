import { Express, Request, Response, NextFunction, RequestHandler } from "express";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────
const USERS: Record<string, string> = {
  // username → bcrypt hash of password
  root: bcrypt.hashSync("12345678", 10),
};

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// ──────────────────────────────────────────────────────────────────────────────
// Token store (in-memory — survives only while the process is running)
// ──────────────────────────────────────────────────────────────────────────────
interface TokenEntry {
  username: string;
  expiresAt: number;
}

const tokenStore = new Map<string, TokenEntry>();

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function isValidToken(token: string): TokenEntry | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenStore.delete(token);
    return null;
  }
  return entry;
}

// ──────────────────────────────────────────────────────────────────────────────
// Revoke all sessions (called at startup → forces re-login after every deploy)
// ──────────────────────────────────────────────────────────────────────────────
export function revokeAllSessions(): void {
  tokenStore.clear();
  console.log("[auth] All sessions revoked — re-login required");
}

// ──────────────────────────────────────────────────────────────────────────────
// Middleware — protect API routes
// ──────────────────────────────────────────────────────────────────────────────
export const requireAuth: RequestHandler = (req, res, next) => {
  // Extract token from Authorization: Bearer <token>  or  X-Auth-Token: <token>
  const authHeader = req.headers["authorization"] || "";
  const headerToken = req.headers["x-auth-token"] as string | undefined;
  let token: string | null = null;

  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (headerToken) {
    token = headerToken.trim();
  }

  if (!token || !isValidToken(token)) {
    res.status(401).json({ error: "Non authentifié", authenticated: false });
    return;
  }

  next();
};

// ──────────────────────────────────────────────────────────────────────────────
// Auth route handlers
// ──────────────────────────────────────────────────────────────────────────────

/** POST /api/auth/login — { username, password } → { success, token } */
export function handleLogin(req: Request, res: Response): void {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ success: false, error: "Identifiants manquants" });
    return;
  }

  const hash = USERS[username];
  if (!hash || !bcrypt.compareSync(password, hash)) {
    res.status(401).json({ success: false, error: "Identifiants incorrects" });
    return;
  }

  // Revoke old tokens for this user
  for (const [t, entry] of tokenStore.entries()) {
    if (entry.username === username) tokenStore.delete(t);
  }

  const token = generateToken();
  tokenStore.set(token, { username, expiresAt: Date.now() + TOKEN_TTL_MS });
  console.log(`[auth] Login: ${username}`);

  res.json({ success: true, token, username });
}

/** GET /api/auth/me — check current session */
export function handleMe(req: Request, res: Response): void {
  const authHeader = req.headers["authorization"] || "";
  const headerToken = req.headers["x-auth-token"] as string | undefined;
  let token: string | null = null;

  if (authHeader.startsWith("Bearer ")) token = authHeader.slice(7).trim();
  else if (headerToken) token = headerToken.trim();

  const entry = token ? isValidToken(token) : null;
  if (!entry) {
    res.json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, username: entry.username });
}

/** POST /api/auth/logout — invalidate current token */
export function handleLogout(req: Request, res: Response): void {
  const authHeader = req.headers["authorization"] || "";
  const headerToken = req.headers["x-auth-token"] as string | undefined;
  let token: string | null = null;

  if (authHeader.startsWith("Bearer ")) token = authHeader.slice(7).trim();
  else if (headerToken) token = headerToken.trim();

  if (token) tokenStore.delete(token);
  res.json({ success: true });
}

/** POST /api/auth/revoke-all — revoke all sessions */
export function handleRevokeAll(_req: Request, res: Response): void {
  revokeAllSessions();
  res.json({ success: true, message: "Toutes les sessions révoquées" });
}

// ──────────────────────────────────────────────────────────────────────────────
// registerAuth — mount public auth routes on the Express app
// Call this BEFORE any requireAuth middleware.
// ──────────────────────────────────────────────────────────────────────────────
export function registerAuth(app: Express): void {
  app.post("/api/auth/login", handleLogin);
  app.get("/api/auth/me", handleMe);
  app.post("/api/auth/logout", handleLogout);
  app.post("/api/auth/revoke-all", handleRevokeAll);
}
