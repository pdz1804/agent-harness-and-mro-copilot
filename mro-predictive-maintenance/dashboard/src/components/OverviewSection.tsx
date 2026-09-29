import { StatCard } from "./StatCard";
import { StatusBadge } from "./StatusBadge";
import { formatDecimal, formatNumber, formatPct } from "../lib/format";
import type { DashboardData } from "../types";

interface OverviewSectionProps {
  data: DashboardData;
}

export function OverviewSection({ data }: OverviewSectionProps) {
  const { dataset, target, models } = data;
  const primaryModel = models.find((m) => m.is_primary) ?? models[0];
  const { splits } = dataset;

  return (
    <section className="section">
      <div className="section__heading">
        <h2 className="section__title">Overview</h2>
        <span className="section__note">
          seed {dataset.seed} &middot; run {dataset.run_date}
        </span>
      </div>

      <div className="panel headline-card" style={{ marginBottom: 16 }}>
        <div className="headline-card__main">
          <div className="stat-card__label" style={{ marginBottom: 8 }}>
            Headline result
          </div>
          <div style={{ fontSize: 16, fontWeight: 650, marginBottom: 6 }}>
            {primaryModel.label}
            <span style={{ color: "var(--text-tertiary)", fontWeight: 500 }}>
              {" "}
              &mdash; selected as the deployed model
            </span>
          </div>
          <div style={{ marginBottom: 10 }}>
            <StatusBadge tone={primaryModel.target_met ? "good" : "bad"}>
              {primaryModel.target_met ? "target met" : "target not met"}
            </StatusBadge>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--text-secondary)", maxWidth: "48ch", margin: 0 }}>
            Applied to the held-out test split ({formatNumber(splits.test.rows)} rows,{" "}
            {splits.test.positives} real unscheduled removals), evaluated at the operating
            threshold chosen on validation only.
          </p>
        </div>
        <div className="headline-card__metrics">
          <div className="metric-tile">
            <div className="metric-tile__label">Test recall</div>
            <div className="metric-tile__value mono">{formatPct(primaryModel.test_recall)}</div>
            <div style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 3 }}>
              target &ge; {formatPct(target.min_recall, 0)}
            </div>
          </div>
          <div className="metric-tile">
            <div className="metric-tile__label">Alerts / 100</div>
            <div className="metric-tile__value mono">
              {formatDecimal(primaryModel.test_alerts_per_100)}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 3 }}>
              target &le; {formatDecimal(target.max_alerts_per_100, 1)}
            </div>
          </div>
          <div className="metric-tile">
            <div className="metric-tile__label">Precision</div>
            <div className="metric-tile__value mono">
              {formatPct(primaryModel.test_precision)}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 3 }}>
              {primaryModel.test_n_alerts} alerts raised
            </div>
          </div>
          <div className="metric-tile">
            <div className="metric-tile__label">Caught / missed</div>
            <div className="metric-tile__value mono">
              {Math.round(primaryModel.test_recall * primaryModel.test_n_positive)}/
              {primaryModel.test_n_positive}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 3 }}>
              real removals caught
            </div>
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="Aircraft" value={formatNumber(dataset.aircraft)} />
        <StatCard
          label="Components"
          value={formatNumber(dataset.components_total)}
          sub={`${dataset.components_unscheduled} unsched. / ${dataset.components_scheduled} sched. / ${dataset.components_survived} survived`}
        />
        <StatCard label="Cycle snapshots" value={formatNumber(dataset.cycle_snapshots)} />
        <StatCard
          label="Positive rate"
          value={`${formatDecimal(dataset.positive_rate_pct, 3)}%`}
          sub={`${formatNumber(dataset.positive_count)} / ${formatNumber(
            dataset.positive_rate_denominator,
          )} rows`}
        />
        <StatCard
          label="Train split"
          value={formatNumber(splits.train.rows)}
          sub={`${splits.train.aircraft} aircraft, ${splits.train.positives} positive`}
        />
        <StatCard
          label="Val split"
          value={formatNumber(splits.val.rows)}
          sub={`${splits.val.aircraft} aircraft, ${splits.val.positives} positive`}
        />
        <StatCard
          label="Test split"
          value={formatNumber(splits.test.rows)}
          sub={`${splits.test.aircraft} aircraft, ${splits.test.positives} positive`}
        />
      </div>
    </section>
  );
}
