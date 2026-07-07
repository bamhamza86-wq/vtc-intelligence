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
import MLInsightsPage from "./pages/MLInsightsPage";
import BestRoutePage from "./pages/BestRoutePage";
import ReturnJourneyPage from "./pages/ReturnJourneyPage";
import SmartPlanPage from "./pages/SmartPlanPage";
import DrivePage from "./pages/DrivePage";
import EconomicsDashboard from "./pages/EconomicsDashboard";
import FocusPage from "./pages/FocusPage";
import TaxJournalPage from "./pages/TaxJournalPage";
import PlatformsPage from "./pages/PlatformsPage";
import RadarPage from "./pages/RadarPage";
import AirportPage from "./pages/AirportPage";
import MLInsightsPage from "./pages/MLInsightsPage";
import FatiguePage from "./pages/FatiguePage";
import DecisionPage from "./pages/DecisionPage";
import CrmPage from "./pages/CrmPage";
import YieldPage from "./pages/YieldPage";
// ─── Couche DIVERSIFICATION DE REVENUS (colis, B2B, devis/contrats, marketplace, aéroport, événements, cashback) ───
import DiversificationPage from "./pages/DiversificationPage";
// ─── Couche Coach IA Économique + Gamification (rapport.md §10, §13, §15, §20, §21) ───
import CoachPage from "./pages/CoachPage";
// ─── Couche SANTÉ & FINANCE PERSO (rapport.md §6, §11, §19 + gaps benchmark) ───
import SantePage from "./pages/SantePage";
import FinancePage from "./pages/FinancePage";
// ─── Couche ARBITRAGE MULTI-PLATEFORME AUTOMATIQUE ───
import ArbitragePage from "./pages/ArbitragePage";
// ─── Couche FISCAL PROACTIF (rapport.md §5, §6, §18) ───
import FiscalProactifPage from "./pages/FiscalProactifPage";
// ─── Couche Prédictive Signaux (rapport.md §3, §8, §9, §22) ───
import SignalsPage from "./pages/SignalsPage";
// ─── Couche Véhicule (entretien, EV, carburant, éco-conduite) (rapport.md §4, §6) ───
import VehiculePage from "./pages/VehiculePage";
// ─── Couche TRUST & TRANSPARENCE (pourboire, flags client/lieu, historique offres, bouclier fiscal, incidents) ───
import TrustPage from "./pages/TrustPage";
// ─── Couche ANALYTICS BI AVANCÉE (rapport.md §10, §20 + gaps benchmark) ───
import AnalyticsPage from "./pages/AnalyticsPage";
// ─── Couche ONBOARDING NOUVEAU CHAUFFEUR + JURIDIQUE ───
import OnboardingPage from "./pages/OnboardingPage";
import LegalPage from "./pages/LegalPage";
import LoginPage from "./pages/LoginPage";
import NotFound from "./pages/not-found";
import { registerServiceWorker } from "./lib/pwa";
import { ToastProvider } from "./lib/toast";
import FocusBubble from "./components/FocusBubble";
import QuickActionBar from "./components/QuickActionBar";
import AutoDriveToast from "./components/AutoDriveToast";
import { useBatteryStatus } from "./hooks/useBatteryStatus";
import { useAutoSunsetTheme } from "./hooks/useAutoSunsetTheme";
import OfflineBanner from "./components/OfflineBanner";
import EcoScoreTracker from "./components/EcoScoreTracker";
import DeadZoneAlert from "./components/DeadZoneAlert";
import EndOfShiftModal from "./components/EndOfShiftModal";
import AchievementsPage from "./pages/AchievementsPage";
import RecordAlertToast from "./components/RecordAlertToast";
import FatiguePage from "./pages/FatiguePage";
import FatigueCoach from "./components/FatigueCoach";
import { useTelemetry } from "./hooks/useTelemetry";
// ─── Couche UX Avancée (Itération 3) : onboarding progressif au premier login (§11.3) ───
import OnboardingCoach from "./components/OnboardingCoach";

// ──────────────────────────────────────────────────────────────────────────────
// FatigueTelemetryCollector — wrapper invisible autour de useTelemetry()
// Capture passive des proxys comportementaux pour le Fatigue Coach (aucun rendu).
// ──────────────────────────────────────────────────────────────────────────────
function FatigueTelemetryCollector() {
  useTelemetry(true);
  return null;
}

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
// BatteryAwareMode — active le mode performance dégradé si batterie faible
// ou Data Saver actif (Vague 2 - Feature 4). Ne rend rien.
// ──────────────────────────────────────────────────────────────────────────────
function BatteryAwareMode() {
  useBatteryStatus();
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// AutoSunsetTheme — bascule le thème clair/sombre selon lever/coucher du
// soleil à Paris (Vague 2 - Feature 7). Ne rend rien.
// ──────────────────────────────────────────────────────────────────────────────
function AutoSunsetTheme() {
  useAutoSunsetTheme();
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────────────────────────
export default function App() {
  useEffect(() => {
    // Enregistrement du service worker PWA (Lot A)
    registerServiceWorker();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
        <AuthGuard>
          <OfflineBanner />
          <RoutingOriginSync />
          <Router hook={useHashLocation}>
            <Layout>
              <Switch>
                <Route path="/" component={MapPage} />
                <Route path="/best-route" component={BestRoutePage} />
                <Route path="/return-journey" component={ReturnJourneyPage} />
                <Route path="/smart-plan" component={SmartPlanPage} />
                <Route path="/drive" component={DrivePage} />
                <Route path="/focus" component={FocusPage} />
                <Route path="/tax" component={TaxJournalPage} />
                <Route path="/simulator" component={SimulatorPage} />
                <Route path="/alerts" component={AlertsPage} />
                <Route path="/economics" component={EconomicsDashboard} />
                <Route path="/sources" component={DataSourcesPage} />
                <Route path="/platforms" component={PlatformsPage} />
                <Route path="/profile" component={ProfilePage} />
                <Route path="/ml-insights" component={MLInsightsPage} />
                <Route path="/achievements" component={AchievementsPage} />
                <Route path="/radar" component={RadarPage} />
                <Route path="/airport" component={AirportPage} />
                <Route path="/aeroports" component={AirportPage} />
                <Route path="/fatigue" component={FatiguePage} />
                <Route path="/decision" component={DecisionPage} />
                <Route path="/yield" component={YieldPage} />
                {/* ─── Couche FISCAL PROACTIF (rapport.md §5, §6, §18) ─── */}
                <Route path="/fiscal" component={FiscalProactifPage} />
                {/* ─── Couche Prédictive Signaux (rapport.md §3, §8, §9, §22) ─── */}
                <Route path="/signals" component={SignalsPage} />
                {/* ─── Couche CRM Chauffeur (rapport.md §7, §14.1, §17.1/17.3/17.4) ─── */}
                <Route path="/crm" component={CrmPage} />
                {/* ─── Couche DIVERSIFICATION DE REVENUS (colis, B2B, devis/contrats, marketplace, aéroport, cashback) ─── */}
                <Route path="/diversification" component={DiversificationPage} />
                {/* ─── Couche Coach IA Économique + Gamification (rapport.md §10, §13, §15, §20, §21) ─── */}
                <Route path="/coach" component={CoachPage} />
                {/* ─── Couche ARBITRAGE MULTI-PLATEFORME AUTOMATIQUE ─── */}
                <Route path="/arbitrage" component={ArbitragePage} />
                {/* ─── Couche Véhicule (entretien, EV, carburant, éco-conduite) (rapport.md §4, §6) ─── */}
                <Route path="/vehicule" component={VehiculePage} />
                {/* ─── Couche SANTÉ & FINANCE PERSO (rapport.md §6, §11, §19 + gaps benchmark) ─── */}
                <Route path="/sante" component={SantePage} />
                <Route path="/finance" component={FinancePage} />
                {/* ─── Couche TRUST & TRANSPARENCE (pourboire, flags, historique offres, bouclier fiscal, incidents) ─── */}
                <Route path="/trust" component={TrustPage} />
                {/* ─── Couche ANALYTICS BI AVANCÉE (rapport.md §10, §20 + gaps benchmark) ─── */}
                <Route path="/analytics" component={AnalyticsPage} />
                {/* ─── Couche ONBOARDING NOUVEAU CHAUFFEUR + JURIDIQUE ─── */}
                <Route path="/onboarding" component={OnboardingPage} />
                <Route path="/legal" component={LegalPage} />
                <Route component={NotFound} />
              </Switch>
            </Layout>
          </Router>
          <FocusBubble />
          <QuickActionBar />
          <AutoDriveToast />
          <EcoScoreTracker />
          <DeadZoneAlert />
          <EndOfShiftModal />
          {/* ─── Couche Wow Factor : alerte "proche du record" (type=record_hunt) ─── */}
          <RecordAlertToast />
          <BatteryAwareMode />
          <AutoSunsetTheme />
          {/* ─── Couche Fatigue Coach avancé : bulle discrète + capture télémétrie (rapport.md §5, §2) ─── */}
          <FatigueTelemetryCollector />
          <FatigueCoach />
          {/* ─── Couche UX Avancée : coach d'onboarding progressif, affiché tant que les étapes ne sont pas terminées ─── */}
          <OnboardingCoach />
        </AuthGuard>
        <Toaster />
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
