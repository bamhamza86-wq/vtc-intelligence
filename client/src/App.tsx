import { useState, useEffect } from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, API_BASE, getAuthToken, setAuthToken } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "./components/ThemeProvider";
import Layout from "./components/Layout";
import { useRoutingOriginSync } from "./hooks/useRoutingOriginSync";
import MapPage from "./pages/MapPage";
import SimulatorPage from "./pages/SimulatorPage";
import AlertsPage from "./pages/AlertsPage";
import DataSourcesPage from "./pages/DataSourcesPage";
import ProfilePage from "./pages/ProfilePage";
import BestRoutePage from "./pages/BestRoutePage";
import ReturnJourneyPage from "./pages/ReturnJourneyPage";
import SmartPlanPage from "./pages/SmartPlanPage";
import EconomicsDashboard from "./pages/EconomicsDashboard";
import LoginPage from "./pages/LoginPage";
import NotFound from "./pages/not-found";

// ──────────────────────────────────────────────────────────────────────────────
// AuthGuard — checks /api/auth/me on mount, shows LoginPage if not authenticated
// ──────────────────────────────────────────────────────────────────────────────
function AuthGuard({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");

  const checkAuth = async () => {
    const token = getAuthToken();
    if (!token) {
      setStatus("unauthenticated");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Auth-Token": token,
        },
      });
      const data = await res.json();
      setStatus(data.authenticated ? "authenticated" : "unauthenticated");
      if (!data.authenticated) setAuthToken(null);
    } catch {
      setStatus("unauthenticated");
    }
  };

  useEffect(() => {
    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "checking") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f172a",
          color: "#94a3b8",
          fontFamily: "Inter, sans-serif",
          fontSize: "14px",
        }}
      >
        Vérification de la session…
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <LoginPage
        onLogin={() => {
          queryClient.clear();
          setStatus("authenticated");
        }}
      />
    );
  }

  return <>{children}</>;
}

// ──────────────────────────────────────────────────────────────────────────────
// RoutingOriginSync — synchronise l'origine du cache routing backend avec le GPS
// (monté une seule fois pour toute l'app, ne rend rien)
// ──────────────────────────────────────────────────────────────────────────────
function RoutingOriginSync() {
  useRoutingOriginSync();
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthGuard>
          <RoutingOriginSync />
          <Router hook={useHashLocation}>
            <Layout>
              <Switch>
                <Route path="/" component={MapPage} />
                <Route path="/best-route" component={BestRoutePage} />
                <Route path="/return-journey" component={ReturnJourneyPage} />
                <Route path="/smart-plan" component={SmartPlanPage} />
                <Route path="/simulator" component={SimulatorPage} />
                <Route path="/alerts" component={AlertsPage} />
                <Route path="/economics" component={EconomicsDashboard} />
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
