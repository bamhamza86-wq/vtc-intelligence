import { useState } from "react";
import { setAuthToken, API_BASE } from "@/lib/queryClient";

interface LoginPageProps {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
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
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (res.ok && data.success && data.token) {
        setAuthToken(data.token);
        onLogin();
      } else {
        setError(data.error || "Identifiants incorrects");
      }
    } catch {
      setError("Impossible de joindre le serveur. Veuillez réessayer.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div
        style={{
          background: "rgba(30, 41, 59, 0.9)",
          border: "1px solid rgba(148, 163, 184, 0.15)",
          borderRadius: "16px",
          padding: "40px 48px",
          width: "100%",
          maxWidth: "400px",
          boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
        }}
      >
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            fill="none"
            aria-label="VTC Intelligence"
            style={{ margin: "0 auto 12px", display: "block" }}
          >
            <rect width="48" height="48" rx="12" fill="#3b82f6" />
            <path d="M10 32 L18 16 L24 26 L30 20 L38 32Z" stroke="white" strokeWidth="2.5" fill="none" strokeLinejoin="round" />
            <circle cx="36" cy="14" r="4" fill="#60a5fa" />
          </svg>
          <h1 style={{ color: "#f1f5f9", fontSize: "22px", fontWeight: 700, margin: 0 }}>
            VTC Intelligence
          </h1>
          <p style={{ color: "#94a3b8", fontSize: "13px", marginTop: "6px" }}>
            Zones rentables — 93 · CDG · Orly
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", color: "#94a3b8", fontSize: "12px", fontWeight: 600, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Identifiant
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              style={{
                width: "100%",
                padding: "10px 14px",
                background: "rgba(15, 23, 42, 0.8)",
                border: "1px solid rgba(148, 163, 184, 0.2)",
                borderRadius: "8px",
                color: "#f1f5f9",
                fontSize: "15px",
                outline: "none",
                boxSizing: "border-box",
              }}
              placeholder="root"
            />
          </div>

          <div style={{ marginBottom: "24px" }}>
            <label style={{ display: "block", color: "#94a3b8", fontSize: "12px", fontWeight: 600, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Mot de passe
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              style={{
                width: "100%",
                padding: "10px 14px",
                background: "rgba(15, 23, 42, 0.8)",
                border: "1px solid rgba(148, 163, 184, 0.2)",
                borderRadius: "8px",
                color: "#f1f5f9",
                fontSize: "15px",
                outline: "none",
                boxSizing: "border-box",
              }}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div
              style={{
                background: "rgba(239, 68, 68, 0.15)",
                border: "1px solid rgba(239, 68, 68, 0.4)",
                borderRadius: "8px",
                padding: "10px 14px",
                color: "#fca5a5",
                fontSize: "13px",
                marginBottom: "16px",
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: "12px",
              background: loading ? "#1d4ed8" : "#3b82f6",
              border: "none",
              borderRadius: "8px",
              color: "white",
              fontSize: "15px",
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              transition: "background 0.2s",
            }}
          >
            {loading ? "Connexion…" : "Se connecter"}
          </button>
        </form>
      </div>
    </div>
  );
}
