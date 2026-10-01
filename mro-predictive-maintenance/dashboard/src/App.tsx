import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dashboardData from "./data/dashboard_data.json";
import { AppShell } from "./components/layout/AppShell";
import { useHashRoute } from "./hooks/useHashRoute";
import { getGlobalPending } from "./lib/api";
import { resolveRoute, type AreaId } from "./lib/routes";
import { OverviewPage } from "./pages/OverviewPage";
import { ArchitectureSection } from "./components/ArchitectureSection";
import { HowItWorksSection } from "./components/HowItWorksSection";
import { ProductionDesignSection } from "./components/ProductionDesignSection";
import { FleetPage } from "./pages/FleetPage";
import { ComponentDetailPage } from "./pages/detail/ComponentDetailPage";
import { AircraftPage } from "./pages/detail/AircraftPage";
import { AlertsPage } from "./pages/AlertsPage";
import { WorkOrdersPage } from "./pages/WorkOrdersPage";
import { CopilotPage } from "./pages/CopilotPage";
import { KnowledgeBasePage } from "./pages/KnowledgeBasePage";
import { PerformancePage } from "./pages/PerformancePage";
import { ExplainabilityPage } from "./pages/ExplainabilityPage";
import { WhatIfPage } from "./pages/WhatIfPage";
import { MonitoringPage } from "./pages/MonitoringPage";
import { AppFooter } from "./components/layout/AppFooter";
import type { DashboardData } from "./types";

const data = dashboardData as unknown as DashboardData;

export default function App() {
  const [segments, navigate] = useHashRoute();
  const route = useMemo(() => resolveRoute(segments), [segments]);
  const [pendingCount, setPendingCount] = useState(0);
  const [prefillPrompt, setPrefillPrompt] = useState<string | null>(null);
  const lastPageByArea = useRef<Partial<Record<AreaId, string>>>({});

  const pageId = route.page.id;
  const param = route.params[0];
  // Detail pages highlight their parent in the sub-nav.
  const activePageId = route.detail ? "ops/fleet" : pageId;
  if (!route.detail) lastPageByArea.current[route.area.id] = pageId;

  useEffect(() => {
    if (window.location.hash === "") {
      window.location.replace("#/overview");
    }
  }, []);

  useEffect(() => {
    document.title = `${route.detail ? param ?? route.page.label : route.page.title} · MRO Predictive Maintenance`;
  }, [route, param]);

  // One scroll container: a new page always starts at its top.
  useEffect(() => {
    document.getElementById("app-main")?.scrollTo({ top: 0 });
  }, [pageId, param]);

  useEffect(() => {
    const poll = () => {
      getGlobalPending()
        .then((items) => setPendingCount(items.filter((p) => !p.is_stale).length))
        .catch(() => {
          /* service unreachable -- pages surface this themselves */
        });
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, []);

  const askCopilot = useCallback(
    (prompt: string) => {
      setPrefillPrompt(prompt);
      navigate("ops/copilot");
    },
    [navigate],
  );
  const consumePrefill = useCallback(() => setPrefillPrompt(null), []);

  const fill = !!route.page.fill;

  return (
    <AppShell
      area={route.area}
      activePageId={activePageId}
      lastPageByArea={lastPageByArea.current}
      pendingCount={pendingCount}
      fill={fill}
    >
      {pageId === "overview" && <OverviewPage data={data} pendingCount={pendingCount} />}

      {pageId === "ops/fleet" && <FleetPage view={param === "aircraft" ? "aircraft" : "components"} onAskCopilot={askCopilot} />}
      {pageId === "ops/component" && <ComponentDetailPage componentId={param} onAskCopilot={askCopilot} />}
      {pageId === "ops/aircraft" && <AircraftPage aircraftId={param} onAskCopilot={askCopilot} />}
      {pageId === "ops/alerts" && <AlertsPage alertId={param} onAskCopilot={askCopilot} />}
      {pageId === "ops/work-orders" && <WorkOrdersPage data={data} />}
      {pageId === "ops/copilot" && (
        <CopilotPage
          prefillPrompt={prefillPrompt}
          onPrefillConsumed={consumePrefill}
          onPendingCountChange={setPendingCount}
        />
      )}
      {pageId === "ops/knowledge-base" && <KnowledgeBasePage docId={param} />}

      {pageId === "model/performance" && <PerformancePage data={data} />}
      {pageId === "model/explainability" && <ExplainabilityPage data={data} />}
      {pageId === "model/what-if" && <WhatIfPage componentId={param} />}
      {pageId === "model/monitoring" && <MonitoringPage data={data} />}

      {pageId === "about/architecture" && <ArchitectureSection />}
      {pageId === "about/how-it-works" && <HowItWorksSection data={data} />}
      {pageId === "about/production-design" && <ProductionDesignSection />}

      <AppFooter />
    </AppShell>
  );
}
