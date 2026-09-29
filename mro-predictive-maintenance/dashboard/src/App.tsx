import { useState } from "react";
import dashboardData from "./data/dashboard_data.json";
import { OverviewSection } from "./components/OverviewSection";
import { ModelComparisonSection } from "./components/ModelComparisonSection";
import { FeatureImportanceSection } from "./components/FeatureImportanceSection";
import { HighRiskLeaderboard } from "./components/HighRiskLeaderboard";
import { LiveScoringPage } from "./components/LiveScoringPage";
import { FleetRiskPage } from "./components/FleetRiskPage";
import { AppFooter } from "./components/AppFooter";
import type { DashboardData } from "./types";

const data = dashboardData as unknown as DashboardData;

type Tab = "offline" | "live-scoring" | "fleet-risk";

const TABS: { id: Tab; label: string }[] = [
  { id: "offline", label: "Offline results" },
  { id: "live-scoring", label: "Live scoring" },
  { id: "fleet-risk", label: "Fleet risk" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("offline");

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-header__eyebrow">MRO Predictive Maintenance</span>
        <h1 className="app-header__title">Unscheduled Removal Risk &mdash; Results Dashboard</h1>
        <p className="app-header__subtitle">
          Predicts whether an aircraft component needs an unscheduled removal within the next
          30 flight cycles. "Offline results" is generated from <code>reports/*.csv</code>,{" "}
          <code>reports/*.md</code>, and <code>docs/*.md</code> by{" "}
          <code>dashboard/scripts/build_dashboard_data.py</code>. "Live scoring" and "Fleet risk"
          call the real inference service (<code>src/service/app.py</code>) live &mdash; nothing
          on this page is hand-typed.
        </p>
        <nav style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                border: `1px solid ${tab === t.id ? "var(--accent)" : "var(--panel-border-strong)"}`,
                background: tab === t.id ? "var(--accent-dim)" : "transparent",
                color: tab === t.id ? "var(--accent-strong)" : "var(--text-secondary)",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {tab === "offline" && (
        <>
          <OverviewSection data={data} />
          <ModelComparisonSection data={data} />
          <FeatureImportanceSection data={data} />
          <HighRiskLeaderboard data={data} />
        </>
      )}
      {tab === "live-scoring" && <LiveScoringPage />}
      {tab === "fleet-risk" && <FleetRiskPage />}

      <AppFooter />
    </div>
  );
}
