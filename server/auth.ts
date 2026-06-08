/**
 * auth.ts — Authentification VTC Intelligence
 * Login/password protégé, sessions Express
 * Credentials par défaut : root / 12345678
 */

import type { Express, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import session from "express-session";

// ─── Stockage en mémoire des utilisateurs ─────────────────────────────────────
// (table légère — pas besoin de SQLite pour un usage VTC mono-user)

interface User {
  id: number;
  username: string;
  passwordHash: string;
  role: "admin" | "driver";
  createdAt: string;
}

// Hash de "12345678" pré-calculé (bcrypt, cost 10)
const DEFAULT_HASH = bcrypt.hashSync("12345678", 10);

const users: User[] = [
  {
    id: 1,
    username: "root",
    passwordHash: DEFAULT_HASH,
    role: "admin",
    createdAt: new Date().toISOString(),
  },
];

// ─── Révocation de toutes les sessions actives ────────────────────────────────
// On conserve un compteur de génération ; toute session avec une génération
// inférieure à la génération courante est considérée comme révoquée.

let sessionGeneration = 1;

export function revokeAllSessions() {
  sessionGeneration++;
}

// ─── Middleware de vérification session ───────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sess = req.session as any;
  if (
    sess?.userId &&
    sess?.generation === sessionGeneration
  ) {
    return next();
  }
  // Pour les requêtes API → 401 JSON
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Non authentifié", code: "UNAUTHORIZED" });
  }
  // Pour les pages → redirect login
  return res.redirect("/login");
}

// ─── Page de login HTML ───────────────────────────────────────────────────────

function loginPage(error?: string) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VTC Intelligence — Connexion</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background: #0a0a0f;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #e2e8f0;
    }
    .bg-grid {
      position: fixed; inset: 0; z-index: 0;
      background-image:
        linear-gradient(rgba(99,179,237,0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(99,179,237,0.04) 1px, transparent 1px);
      background-size: 40px 40px;
    }
    .card {
      position: relative; z-index: 1;
      background: rgba(15,15,25,0.95);
      border: 1px solid rgba(99,179,237,0.2);
      border-radius: 16px;
      padding: 40px 36px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 25px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(99,179,237,0.05);
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
    }
    .logo-icon {
      width: 40px; height: 40px;
      background: linear-gradient(135deg, #3b82f6, #0ea5e9);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }
    .logo-text {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }
    .logo-sub {
      font-size: 11px;
      color: #64748b;
      margin-top: 1px;
    }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
    .subtitle { font-size: 13px; color: #64748b; margin-bottom: 28px; }
    .field { margin-bottom: 16px; }
    label { display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; letter-spacing: 0.4px; text-transform: uppercase; }
    input {
      width: 100%;
      background: rgba(30,30,50,0.8);
      border: 1px solid rgba(99,179,237,0.15);
      border-radius: 8px;
      padding: 11px 14px;
      font-size: 14px;
      color: #e2e8f0;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: rgba(59,130,246,0.6); box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
    .error {
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      color: #fca5a5;
      margin-bottom: 16px;
      display: flex; align-items: center; gap: 8px;
    }
    button[type=submit] {
      width: 100%;
      background: linear-gradient(135deg, #3b82f6, #0ea5e9);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 6px;
      transition: opacity 0.2s, transform 0.1s;
    }
    button[type=submit]:hover { opacity: 0.9; transform: translateY(-1px); }
    button[type=submit]:active { transform: translateY(0); }
    .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #334155; }
    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.2);
      border-radius: 20px; padding: 3px 10px; font-size: 11px; color: #93c5fd;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">🚗</div>
      <div>
        <div class="logo-text">VTC Intelligence</div>
        <div class="logo-sub">Seine-Saint-Denis • CDG • Orly</div>
      </div>
    </div>
    <div class="badge">🔒 Accès sécurisé</div>
    <h1>Connexion</h1>
    <p class="subtitle">Identifiez-vous pour accéder au tableau de bord</p>
    ${error ? `<div class="error">⚠ ${error}</div>` : ""}
    <form method="POST" action="/login" autocomplete="on">
      <div class="field">
        <label for="username">Identifiant</label>
        <input type="text" id="username" name="username" placeholder="root" autocomplete="username" required />
      </div>
      <div class="field">
        <label for="password">Mot de passe</label>
        <input type="password" id="password" name="password" placeholder="••••••••" autocomplete="current-password" required />
      </div>
      <button type="submit">Connexion →</button>
    </form>
    <div class="footer">VTC Intelligence v2 • Données Seine-Saint-Denis 93</div>
  </div>
</body>
</html>`;
}

// ─── Enregistrement des routes auth ───────────────────────────────────────────

export function registerAuth(app: Express) {
  // Configuration session — cookie __Host- requis pour pplx.app
  app.use(
    session({
      name: "__Host-vtc-sid",
      secret: process.env.SESSION_SECRET || "vtc-intelligence-secret-2026-93",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000, // 8h
        path: "/",
      },
    })
  );

  // GET /login
  app.get("/login", (req: Request, res: Response) => {
    const sess = req.session as any;
    if (sess?.userId && sess?.generation === sessionGeneration) {
      return res.redirect("/");
    }
    res.send(loginPage());
  });

  // POST /login
  app.post("/login", async (req: Request, res: Response) => {
    const { username, password } = req.body as { username: string; password: string };

    if (!username || !password) {
      return res.send(loginPage("Identifiant et mot de passe requis."));
    }

    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) {
      return res.send(loginPage("Identifiant ou mot de passe incorrect."));
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.send(loginPage("Identifiant ou mot de passe incorrect."));
    }

    const sess = req.session as any;
    sess.userId = user.id;
    sess.username = user.username;
    sess.role = user.role;
    sess.generation = sessionGeneration;

    return res.redirect("/");
  });

  // POST /logout
  app.post("/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.redirect("/login");
    });
  });

  // GET /api/auth/me — état de la session courante
  app.get("/api/auth/me", (req: Request, res: Response) => {
    const sess = req.session as any;
    if (sess?.userId && sess?.generation === sessionGeneration) {
      return res.json({ authenticated: true, username: sess.username, role: sess.role });
    }
    res.json({ authenticated: false });
  });

  // POST /api/auth/revoke-all — révoque toutes les sessions (admin)
  app.post("/api/auth/revoke-all", requireAuth, (req: Request, res: Response) => {
    const sess = req.session as any;
    if (sess?.role !== "admin") {
      return res.status(403).json({ error: "Accès refusé" });
    }
    revokeAllSessions();
    // Détruit la session courante aussi → force re-login
    req.session.destroy(() => {
      res.json({ success: true, message: "Toutes les sessions révoquées. Re-connexion requise." });
    });
  });
}
