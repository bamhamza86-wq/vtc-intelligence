import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "./components/ThemeProvider";
import Layout from "./components/Layout";
import MapPage from "./pages/MapPage";
import SimulatorPage from "./pages/SimulatorPage";
import AlertsPage from "./pages/AlertsPage";
import DataSourcesPage from "./pages/DataSourcesPage";
import ProfilePage from "./pages/ProfilePage";
import NotFound from "./pages/not-found";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
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
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
