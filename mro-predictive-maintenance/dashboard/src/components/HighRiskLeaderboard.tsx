import { formatSignedDecimal, humanizeFeatureName } from "../lib/format";
import type { DashboardData, HighRiskExample } from "../types";

interface HighRiskLeaderboardProps {
  data: DashboardData;
}

function FactorRow({ feature, contribution, maxAbs }: { feature: string; contribution: number; maxAbs: number }) {
  const widthPct = maxAbs === 0 ? 0 : (Math.abs(contribution) / maxAbs) * 100;
  const positive = contribution >= 0;
  return (
    <div className="factor-row">
      <div>
        <div className="factor-row__name">{humanizeFeatureName(feature)}</div>
        <div className="factor-bar-track">
          <div
            className="factor-bar-fill"
            style={{
              width: `${widthPct}%`,
              left: positive ? "0" : undefined,
              right: positive ? undefined : "0",
              background: positive ? "var(--status-bad-fg)" : "var(--series-lr)",
            }}
          />
        </div>
      </div>
      <div className="factor-row__value">{formatSignedDecimal(contribution)}</div>
    </div>
  );
}

function RiskCard({ example }: { example: HighRiskExample }) {
  const maxAbs = Math.max(...example.top_features.map((f) => Math.abs(f.contribution)), 1e-9);
  return (
    <div className="risk-card">
      <div className="risk-card__top">
        <div>
          <div className="risk-card__id">{example.component_id}</div>
          <div className="risk-card__meta">
            cycle {example.cycle.toLocaleString()} &middot; {example.date.split(" ")[0]} &middot;{" "}
            {example.explanation_method.toUpperCase()}
          </div>
        </div>
        <span className="risk-score-pill">{example.risk_score.toFixed(3)}</span>
      </div>
      <div style={{ marginBottom: 8 }}>
        <span className="section__note" style={{ marginRight: 8 }}>
          {example.component_type}
        </span>
        {example.true_label === 1 ? (
          <span className="section__note" style={{ color: "var(--status-bad-fg)" }}>
            confirmed unscheduled removal within 30 cycles
          </span>
        ) : (
          <span className="section__note">did not require unscheduled removal</span>
        )}
      </div>
      <div>
        {example.top_features.map((f) => (
          <FactorRow key={f.feature} feature={f.feature} contribution={f.contribution} maxAbs={maxAbs} />
        ))}
      </div>
    </div>
  );
}

export function HighRiskLeaderboard({ data }: HighRiskLeaderboardProps) {
  const primary = data.models.find((m) => m.is_primary) ?? data.models[0];
  return (
    <section className="section">
      <div className="section__heading">
        <h2 className="section__title">High-risk leaderboard</h2>
        <span className="section__note">
          top test-split predictions, {primary.label}, SHAP local explanations
        </span>
      </div>
      <div className="leaderboard-grid">
        {data.high_risk_examples.map((example, i) => (
          <RiskCard key={`${example.component_id}-${i}`} example={example} />
        ))}
      </div>
    </section>
  );
}
