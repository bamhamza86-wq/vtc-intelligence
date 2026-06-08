import { useState } from "react";
import { setAuthToken } from "@/lib/queryClient";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (res.ok && data.success && data.token) {
        setAuthToken(data.token);
        onLogin();
      } else {
        setError(data.error || "Identifiant ou mot de passe incorrect.");
      }
    } catch {
      setError("Erreur de connexion au serveur. Réessayez.");
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0a0f",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      color: "#e2e8f0",
      position: "relative",
    }}>
      {/* Grille fond */}
      <div style={{
        position: "fixed", inset: 0, zIndex: 0,
        backgroundImage: "linear-gradient(rgba(99,179,237,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(99,179,237,0.04) 1px, transparent 1px)",
        backgroundSize: "40px 40px",
      }} />

      <div style={{
        position: "relative", zIndex: 1,
        background: "rgba(15,15,25,0.97)",
        border: "1px solid rgba(99,179,237,0.2)",
        borderRadius: "16px",
        padding: "40px 36px",
        width: "100%",
        maxWidth: "400px",
        boxShadow: "0 25px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(99,179,237,0.05)",
        margin: "16px",
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "28px" }}>
          <div style={{
            width: "40px", height: "40px",
            background: "linear-gradient(135deg, #3b82f6, #0ea5e9)",
            borderRadius: "10px",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "18px",
          }}>🚗</div>
          <div>
            <div style={{ fontSize: "18px", fontWeight: 700, letterSpacing: "-0.3px" }}>VTC Intelligence</div>
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "1px" }}>Seine-Saint-Denis • CDG • Orly</div>
          </div>
        </div>

        {/* Badge */}
        <div style={{
          display: "inline-flex", alignItems: "center", gap: "4px",
          background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.2)",
          borderRadius: "20px", padding: "3px 10px", fontSize: "11px", color: "#93c5fd",
          marginBottom: "20px",
        }}>🔒 Accès sécurisé</div>

        <h1 style={{ fontSize: "22px", fontWeight: 700, marginBottom: "6px" }}>Connexion</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginBottom: "28px" }}>
          Identifiez-vous pour accéder au tableau de bord
        </p>

        {error && (
          <div style={{
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: "8px",
            padding: "10px 14px",
            fontSize: "13px",
            color: "#fca5a5",
            marginBottom: "16px",
            display: "flex", alignItems: "center", gap: "8px",
          }}>
            ⚠ {error}
          </div>
        )}

        <form onSubmit={handleSubmit} autoComplete="on">
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#94a3b8", marginBottom: "6px", letterSpacing: "0.4px", textTransform: "uppercase" }}>
              Identifiant
            </label>
            <input
              type="text"
              name="username"
              autoComplete="username"
              placeholder="root"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              style={{
                width: "100%",
                background: "rgba(30,30,50,0.8)",
                border: "1px solid rgba(99,179,237,0.15)",
                borderRadius: "8px",
                padding: "11px 14px",
                fontSize: "14px",
                color: "#e2e8f0",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#94a3b8", marginBottom: "6px", letterSpacing: "0.4px", textTransform: "uppercase" }}>
              Mot de passe
            </label>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              style={{
                width: "100%",
                background: "rgba(30,30,50,0.8)",
                border: "1px solid rgba(99,179,237,0.15)",
                borderRadius: "8px",
                padding: "11px 14px",
                fontSize: "14px",
                color: "#e2e8f0",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              background: loading ? "#334155" : "linear-gradient(135deg, #3b82f6, #0ea5e9)",
              color: "white",
              border: "none",
              borderRadius: "8px",
              padding: "12px",
              fontSize: "15px",
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              marginTop: "6px",
              transition: "opacity 0.2s",
            }}
          >
            {loading ? "Connexion…" : "Connexion →"}
          </button>
        </form>

        <div style={{ textAlign: "center", marginTop: "20px", fontSize: "11px", color: "#334155" }}>
          VTC Intelligence v2 • Données Seine-Saint-Denis 93
        </div>
      </div>
    </div>
  );
}
