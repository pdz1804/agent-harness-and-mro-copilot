import { ThresholdSweepChart } from "./ThresholdSweepChart";
import { StatusBadge } from "./StatusBadge";
import { formatDecimal, formatPct } from "../lib/format";
import type { DashboardData, ModelResult } from "../types";

interface ModelComparisonSectionProps {
  data: DashboardData;
}

const SERIES_COLOR: Record<string, string> = {
  logistic_regression: "var(--series-lr)",
  hist_gradient_boosting: "var(--series-hgb)",
};

function ModelCard({ model, data }: { model: ModelResult; data: DashboardData }) {
  const sweep = data.threshold_sweeps[model.id];
  const color = SERIES_COLOR[model.id] ?? "var(--accent)";
  const valGap = model.val_at_chosen_threshold.recall - model.test_recall;
  const showGapCallout = valGap > 0.05;

  return (
    <div className="panel">
      <div className="model-card__header">
        <div className="model-card__title">
          <span className="model-card__dot" style={{ background: color }} />
          {model.label}
          {model.is_primary ? <StatusBadge tone="neutral">deployed</StatusBadge> : null}
        </div>
        <StatusBadge tone={model.target_met ? "good" : "bad"}>
          {model.target_met ? "target met" : "target not met"}
        </StatusBadge>
      </div>

      <div className="model-card__metrics">
        <div className="metric-tile">
          <div className="metric-tile__label">Test recall</div>
          <div className="metric-tile__value mono">{formatPct(model.test_recall)}</div>
        </div>
        <div className="metric-tile">
          <div className="metric-tile__label">Test precision</div>
          <div className="metric-tile__value mono">{formatPct(model.test_precision)}</div>
        </div>
        <div className="metric-tile">
          <div className="metric-tile__label">Alerts / 100</div>
          <div className="metric-tile__value mono">
            {formatDecimal(model.test_alerts_per_100)}
          </div>
        </div>
        <div className="metric-tile">
          <div className="metric-tile__label">Test PR-AUC</div>
          <div className="metric-tile__value mono">{formatDecimal(model.test_pr_auc, 3)}</div>
        </div>
      </div>

      <ThresholdSweepChart
        sweep={sweep}
        color={color}
        target={data.target}
        valPoint={{
          threshold: model.chosen_threshold,
          recall: model.val_at_chosen_threshold.recall,
          alerts_per_100: model.val_at_chosen_threshold.alerts_per_100,
        }}
        testPoint={{ recall: model.test_recall, alerts_per_100: model.test_alerts_per_100 }}
      />

      {showGapCallout ? (
        <div className="gap-callout">
          Validation-to-test recall gap: {formatPct(model.val_at_chosen_threshold.recall)} (val)
          vs. {formatPct(model.test_recall)} (test) at the same threshold, applied without
          re-tuning on test.
        </div>
      ) : null}
    </div>
  );
}

export function ModelComparisonSection({ data }: ModelComparisonSectionProps) {
  return (
    <section className="section">
      <div className="section__heading">
        <h2 className="section__title">Model comparison</h2>
        <span className="section__note">
          threshold swept on validation, applied to test without re-tuning
        </span>
      </div>
      <div className="model-grid">
        {data.models.map((model) => (
          <ModelCard key={model.id} model={model} data={data} />
        ))}
      </div>
    </section>
  );
}
