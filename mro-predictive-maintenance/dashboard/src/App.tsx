import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dashboardData from "./data/dashboard_data.json";
import { AppShell } from "./components/layout/AppShell";
import { useHashRoute } from "./hooks/useHashRoute";
import { fleetScan, getGlobalPending } from "./lib/api";
import { canWrite } from "./lib/identity";
import { useToast } from "./components/ui/feedback";
import type { PaletteAction } from "./components/layout/CommandPalette";
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
import { CopilotPage, type CopilotPrefill } from "./pages/CopilotPage";
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
  const [prefillPrompt, setPrefillPrompt] = useState<CopilotPrefill | null>(null);
  const toast = useToast();
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
    // Page title and document title agree; an open sheet names its item.
    const item = route.detail ? param : param ? (pageId === "ops/alerts" ? `Alert #${param}` : param) : null;
    document.title = `${item ? `${item} · ` : ""}${route.detail ? route.page.label : route.page.title} · MRO Predictive Maintenance`;
  }, [route, param, pageId]);

  // One scroll container: a new page starts at its top. Opening or closing a
  // detail sheet on the same list keeps the list's scroll position.
  const sheetPages = pageId === "ops/alerts" || pageId === "ops/work-orders" || pageId === "ops/knowledge-base";
  const scrollKey = sheetPages ? null : param;
  useEffect(() => {
    document.getElementById("app-main")?.scrollTo({ top: 0 });
  }, [pageId, scrollKey]);

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
    (prompt: string, alertId?: number, context?: string) => {
      setPrefillPrompt({ prompt, alertId, context });
      navigate("ops/copilot");
    },
    [navigate],
  );

  const runScan = useCallback(() => {
    if (!canWrite()) {
      toast.show({ tone: "info", message: "Viewer is read-only.", detail: "Switch to lead.engineer or planner to scan the fleet." });
      return;
    }
    const id = toast.show({ tone: "info", message: "Scanning the fleet…", detail: "Scoring every component against its threshold.", durationMs: 60_000 });
    fleetScan(30)
      .then((r) => {
        toast.dismiss(id);
        toast.show({
          tone: r.new_alerts.length > 0 ? "warn" : "good",
          message: r.new_alerts.length > 0 ? `${r.new_alerts.length} new alert${r.new_alerts.length === 1 ? "" : "s"} raised` : "Scan complete: no new alerts",
          detail: `${r.scored} components scored · ${r.existing} already open`,
          link: { label: "View alerts", href: "#/ops/alerts?stage=open" },
        });
      })
      .catch((err: unknown) => {
        toast.dismiss(id);
        toast.show({ tone: "error", message: "Fleet scan failed.", detail: err instanceof Error ? err.message : String(err) });
      });
  }, [toast]);

  const onPaletteAction = useCallback(
    (action: PaletteAction, query: string) => {
      if (action === "new-run") askCopilot("");
      else if (action === "ask") askCopilot(query);
      else if (action === "scan") runScan();
    },
    [askCopilot, runScan],
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
      onPaletteAction={onPaletteAction}
    >
      {pageId === "overview" && <OverviewPage data={data} pendingCount={pendingCount} />}

      {pageId === "ops/fleet" && <FleetPage view={param === "aircraft" ? "aircraft" : "components"} onAskCopilot={askCopilot} />}
      {pageId === "ops/component" && <ComponentDetailPage componentId={param} onAskCopilot={askCopilot} />}
      {pageId === "ops/aircraft" && <AircraftPage aircraftId={param} onAskCopilot={askCopilot} />}
      {pageId === "ops/alerts" && <AlertsPage alertId={param} onAskCopilot={askCopilot} />}
      {pageId === "ops/work-orders" && <WorkOrdersPage data={data} woId={param} />}
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
