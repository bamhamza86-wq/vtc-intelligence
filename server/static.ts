import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import fs from "node:fs";
import path from "node:path";
import { requireAuth } from "./auth";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Assets statiques (JS, CSS, images) : accessibles sans auth
  app.use(express.static(distPath));

  // Toutes les pages HTML nécessitent une session valide
  app.use("/{*path}", (req: Request, res: Response, next: NextFunction) => {
    const sess = req.session as any;
    // requireAuth gère la redirection vers /login si non authentifié
    requireAuth(req, res, () => {
      res.sendFile(path.resolve(distPath, "index.html"));
    });
  });
}
