import { hrefFor } from "../lib/routes";
import { Chip, Panel } from "./ui/primitives";
import { FactorBars } from "./ui/widgets";
import { Notice } from "./ui/states";
import type { DashboardData, HighRiskExample } from "../types";

function RiskCard({ example }: { example: HighRiskExample }) {
  const maxAbs = Math.max(...example.top_features.map((f) => Math.abs(f.contribution)), 1e-9);
  return (
    <Panel
      title={
        <a className="id-link break" href={hrefFor(`ops/component/${example.component_id}`)} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)" }}>
          {example.component_id}
        </a>
      }
      sub={`cycle ${example.cycle.toLocaleString()} · ${example.date.split(" ")[0]} · ${example.explanation_method.toUpperCase()}`}
      actions={<span className="mono" style={{ fontWeight: 600 }}>{example.risk_score.toFixed(3)}</span>}
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <Chip plain icon={null}>{example.component_type}</Chip>
        {example.true_label === 1 ? <Chip tone="warn">removed within 30 cycles</Chip> : <Chip>no unscheduled removal</Chip>}
      </div>
      <FactorBars
        factors={example.top_features.map((f) => ({ feature: f.feature, value: f.contribution }))}
        maxAbs={maxAbs}
      />
    </Panel>
  );
}

export function HighRiskLeaderboard({ data }: { data: DashboardData }) {
  const primary = data.models.find((m) => m.is_primary) ?? data.models[0];
  return (
    <>
      <Notice tone="plain">
        Top test-split predictions from {primary.label}, each with its SHAP local explanation. Red bars push risk up, teal bars pull it down.
      </Notice>
      <div className="grid-2">
        {data.high_risk_examples.map((example, i) => (
          <RiskCard key={`${example.component_id}-${i}`} example={example} />
        ))}
      </div>
    </>
  );
}
