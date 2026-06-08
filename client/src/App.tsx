import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryClient, getAuthToken, setAuthToken } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "./components/ThemeProvider";
import Layout from "./components/Layout";
import MapPage from "./pages/MapPage";
import SimulatorPage from "./pages/SimulatorPage";
import AlertsPage from "./pages/AlertsPage";
import DataSourcesPage from "./pages/DataSourcesPage";
import ProfilePage from "./pages/ProfilePage";
import LoginPage from "./pages/LoginPage";
import NotFound from "./pages/not-found";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// ─── Garde d'authentification ─────────────────────────────────────────────────

function AuthGuard({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();

  const { data: auth, isLoading } = useQuery({
    queryKey: ["auth-me"],
    queryFn: async () => {
      const token = getAuthToken();
      if (!token) return { authenticated: false };
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { "Authorization": `Bearer ${token}`, "X-Auth-Token": token },
      });
      if (!res.ok) return { authenticated: false };
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
    retry: false,
    staleTime: 60 * 1000,
  });

  if (isLoading) {
    return (
      <div style={{
        minHeight: "100vh", background: "#0a0a0f",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "#64748b", fontSize: "14px", gap: "10px",
      }}>
        <div style={{ width: "18px", height: "18px", border: "2px solid #3b82f6", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
        Chargement…
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!auth?.authenticated) {
    return (
      <LoginPage
        onLogin={() => {
          qc.invalidateQueries({ queryKey: ["auth-me"] });
        }}
      />
    );
  }

  return <>{children}</>;
}

// ─── App principale ───────────────────────────────────────────────────────────

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthGuard>
          <Router hook={useHashLocation}>
            <Layout>
              <Switch>
                <Route path="/" component={MapPage} />
                <Route path="/simulator" component={SimulatorPage} />
                <Route path="/alerts" component={AlertsPage} />
                <Route path="/sources" component={DataSourcesPage} />
                <Route path="/profile" component={ProfilePage} />
                <Route component={NotFound} />
              </Switch>
            </Layout>
          </Router>
        </AuthGuard>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
