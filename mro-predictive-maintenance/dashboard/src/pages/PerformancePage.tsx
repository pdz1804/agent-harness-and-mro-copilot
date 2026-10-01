import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ThresholdSweepChart } from "../components/ThresholdSweepChart";
import { CHART } from "../components/charts/charts";
import { Chip, PageHead, Panel } from "../components/ui/primitives";
import { Segmented } from "../components/ui/widgets";
import { EmptyState, LoadingRows, Notice, ServiceStatusBanner } from "../components/ui/states";
import { getModelMetrics, getRegistryStatus } from "../lib/api";
import { useAsync } from "../hooks/useAsync";
import { formatDecimal, formatPct } from "../lib/format";
import { championVersion, compareVersions, comparisonSummary, isFragileThreshold, pickChallenger, versionNumber, type ComparisonRow } from "../lib/models";
import { hrefFor } from "../lib/routes";
import type { DashboardData, ModelResult } from "../types";

type View = "head" | "registry" | "curves" | "stress";

const SERIES_COLOR: Record<string, string> = {
  logistic_regression: CHART.baseline,
  hist_gradient_boosting: CHART.accent,
};

function HeadToHead({ data }: { data: DashboardData }) {
  const { models, target } = data;
  const metrics: { label: string; get: (m: ModelResult) => number }[] = [
    { label: "Recall", get: (m) => m.test_recall },
    { label: "Precision", get: (m) => m.test_precision },
    { label: "PR-AUC", get: (m) => m.test_pr_auc },
    { label: "ROC-AUC", get: (m) => m.test_roc_auc },
  ];
  const chartData = metrics.map((metric) => ({
    metric: metric.label,
    ...Object.fromEntries(models.map((m) => [m.label, Number(metric.get(m).toFixed(4))])),
  }));
  const rows: [string, (m: ModelResult) => string][] = [
    ["Chosen threshold", (m) => formatDecimal(m.chosen_threshold, 4)],
    ["Validation recall", (m) => formatPct(m.val_at_chosen_threshold.recall)],
    ["Test recall", (m) => formatPct(m.test_recall)],
    ["Test precision", (m) => formatPct(m.test_precision)],
    ["Alerts raised", (m) => String(m.test_n_alerts)],
    ["Removals caught", (m) => `${Math.round(m.test_recall * m.test_n_positive)} / ${m.test_n_positive}`],
    ["Target met", (m) => (m.target_met ? "yes" : "no")],
  ];

  return (
    <>
      <Notice tone="plain">
        <strong>The bar:</strong> at least {formatPct(target.min_recall, 0)} recall at no more than {formatDecimal(target.max_alerts_per_100, 1)} alerts per 100 components. The threshold is chosen on validation only, then applied to the held-out test split with no re-tuning.
      </Notice>
      <div className="grid-2">
        <Panel title="Head to head on the test split" sub="Higher is better on every metric.">
          <div className="chart-box" role="img" aria-label="Grouped bar chart of recall, precision, PR-AUC and ROC-AUC per model">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={CHART.grid} strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="metric" stroke="transparent" tickLine={false} tick={{ fontSize: 12, fill: CHART.axis }} />
                <YAxis domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} stroke="transparent" tickLine={false} tick={{ fontSize: 11, fill: CHART.axis }} />
                <Tooltip
                  formatter={(v: number) => formatPct(v, 1)}
                  cursor={{ fill: "rgba(52, 81, 209, 0.05)", radius: 6 }}
                  contentStyle={{ border: 0, borderRadius: 10, boxShadow: "var(--shadow-float)", fontSize: 12, padding: "8px 12px" }}
                  labelStyle={{ fontWeight: 600, marginBottom: 4, color: CHART.text }}
                />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
                {models.map((m) => (
                  <Bar key={m.id} dataKey={m.label} fill={SERIES_COLOR[m.id] ?? CHART.accent} radius={[6, 6, 2, 2]} maxBarSize={28} isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Why this one is deployed" flush>
          <div className="table-scroll">
            <table className="dt" aria-label="Model measures">
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  {models.map((m) => (
                    <th key={m.id} scope="col" className="num">
                      {m.id === "logistic_regression" ? "Logistic" : "Boosting"}
                      {m.is_primary ? " (deployed)" : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, fn]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    {models.map((m) => (
                      <td key={m.id} className="num">
                        {fn(m)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}

function fmtMetric(v: number | null, kind: "pct" | "dec"): string {
  if (v === null) return "n/a";
  return kind === "pct" ? formatPct(v, 1) : formatDecimal(v, 3);
}

function fmtDelta(r: ComparisonRow): string {
  if (r.delta === null) return "n/a";
  const sign = r.delta > 0 ? "+" : r.delta < 0 ? "−" : "";
  return r.meta.kind === "pct" ? `${sign}${Math.abs(r.delta * 100).toFixed(1)} pp` : `${sign}${Math.abs(r.delta).toFixed(3)}`;
}

function VerdictChip({ v }: { v: ComparisonRow["verdict"] }) {
  if (v === "better") return <Chip tone="good">Better</Chip>;
  if (v === "worse") return <Chip tone="bad">Worse</Chip>;
  if (v === "same") return <Chip>Same</Chip>;
  return <Chip plain>n/a</Chip>;
}

/** Champion against a challenger from the MLflow registry, using
 * GET /models/{version}/metrics. The challenger defaults to the newest
 * non-champion version and can be changed. */
function Registry() {
  const reg = useAsync(() => getRegistryStatus(), []);
  const versions = reg.data?.versions ?? [];
  const champion = championVersion(versions);
  const defaultChallenger = pickChallenger(versions);
  const [challengerId, setChallengerId] = useState<string>("");

  useEffect(() => {
    if (!challengerId && defaultChallenger) setChallengerId(String(defaultChallenger.version));
  }, [challengerId, defaultChallenger]);

  const pair = useAsync(
    async () => {
      if (!champion || !challengerId) return null;
      const [a, b] = await Promise.all([getModelMetrics(champion.version), getModelMetrics(challengerId)]);
      return { a, b };
    },
    [champion?.version, challengerId],
  );

  const rows = useMemo(() => (pair.data ? compareVersions(pair.data.a, pair.data.b) : []), [pair.data]);
  const others = [...versions].filter((v) => !v.aliases.includes("champion")).sort((x, y) => versionNumber(y.version) - versionNumber(x.version));

  if (reg.loading && !reg.data) return <LoadingRows rows={4} height={32} label="Loading registry…" />;
  if (reg.error) return <ServiceStatusBanner message={reg.error} onRetry={reg.reload} />;
  if (reg.data && !reg.data.tracking_enabled) {
    return (
      <Panel>
        <EmptyState title="MLflow tracking is disabled">Enable tracking to compare registered versions.</EmptyState>
      </Panel>
    );
  }
  if (!champion || others.length === 0) {
    return (
      <Panel>
        <EmptyState title="Nothing to compare yet">The registry needs a champion and at least one other version. Run the retrain gate on Monitoring to create a challenger.</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title="Champion vs challenger"
      sub="Held-out test metrics recorded in MLflow for each version."
      actions={
        <label className="row" style={{ flexWrap: "nowrap" }}>
          <span className="field-label">Challenger</span>
          <select className="select select-sm" value={challengerId} onChange={(e) => setChallengerId(e.target.value)}>
            {others.map((v) => (
              <option key={String(v.version)} value={String(v.version)}>
                v{v.version}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {pair.loading && !pair.data && <LoadingRows rows={4} height={28} label="Loading version metrics…" />}
      {pair.error && <ServiceStatusBanner message={pair.error} onRetry={pair.reload} />}
      {pair.data && (
        <div className="stack">
          <div className="table-scroll">
            <table className="dt" aria-label="Champion against challenger">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col" className="num">Champion v{pair.data.a.version}</th>
                  <th scope="col" className="num">Challenger v{pair.data.b.version}</th>
                  <th scope="col" className="num">Change</th>
                  <th scope="col">Verdict</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Served threshold</td>
                  <td className="num">{pair.data.a.threshold ?? "n/a"}</td>
                  <td className="num">
                    <span className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      {isFragileThreshold(pair.data.b.threshold) && <Chip tone="warn">fragile</Chip>}
                      {pair.data.b.threshold ?? "n/a"}
                    </span>
                  </td>
                  <td className="num muted">n/a</td>
                  <td />
                </tr>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.meta.label}</td>
                    <td className="num">{fmtMetric(r.champion, r.meta.kind)}</td>
                    <td className="num">{fmtMetric(r.challenger, r.meta.kind)}</td>
                    <td className="num">{fmtDelta(r)}</td>
                    <td>
                      <VerdictChip v={r.verdict} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>{comparisonSummary(rows)}</p>
          {isFragileThreshold(pair.data.b.threshold) && (
            <Notice tone="warn">
              The challenger is served at a threshold of {pair.data.b.threshold}, very close to 0. A small shift in the score distribution can swing which components alert, so treat its recall as fragile, not a stable tuned result. Its alert volume ({fmtMetric(pair.data.b.test_metrics.test_alerts_per_100 ?? null, "dec")} per 100) is the cost.
            </Notice>
          )}
          <p className="muted">
            Versions record different metric sets; a metric only one side has shows n/a rather than zero. <a href={hrefFor("model/monitoring")}>Run the retrain gate on Monitoring.</a>
          </p>
        </div>
      )}
    </Panel>
  );
}

function CurveCard({ model, data }: { model: ModelResult; data: DashboardData }) {
  const color = SERIES_COLOR[model.id] ?? CHART.accent;
  const valGap = model.val_at_chosen_threshold.recall - model.test_recall;
  return (
    <Panel
      title={
        <span className="row" style={{ flexWrap: "nowrap" }}>
          <i className="swatch" style={{ background: color }} />
          {model.label}
        </span>
      }
      actions={model.is_primary ? <Chip tone="info">deployed</Chip> : undefined}
    >
      <dl className="kv" style={{ marginBottom: 12 }}>
        <dt>Test recall / precision</dt>
        <dd>{formatPct(model.test_recall)} / {formatPct(model.test_precision)}</dd>
        <dt>Alerts per 100</dt>
        <dd>{formatDecimal(model.test_alerts_per_100)}</dd>
        <dt>Test PR-AUC</dt>
        <dd>{formatDecimal(model.test_pr_auc, 3)}</dd>
      </dl>
      <ThresholdSweepChart
        sweep={data.threshold_sweeps[model.id]}
        color={color}
        target={data.target}
        valPoint={{ threshold: model.chosen_threshold, recall: model.val_at_chosen_threshold.recall, alerts_per_100: model.val_at_chosen_threshold.alerts_per_100 }}
        testPoint={{ recall: model.test_recall, alerts_per_100: model.test_alerts_per_100 }}
      />
      {valGap > 0.05 && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="warn">
            Validation-to-test recall gap: {formatPct(model.val_at_chosen_threshold.recall)} on validation against {formatPct(model.test_recall)} on test at the same threshold, applied without re-tuning.
          </Notice>
        </div>
      )}
    </Panel>
  );
}

function StressTest({ data }: { data: DashboardData }) {
  const report = data.realistic;
  if (!report) {
    return (
      <Panel>
        <EmptyState title="No stress-test report">
          Run the pipeline with <code>--profile realistic</code> to generate one.
        </EmptyState>
      </Panel>
    );
  }
  const card = report.model_card;
  const at = card.test_at_threshold;
  const fragile = isFragileThreshold(card.threshold);
  return (
    <Panel
      title={card.model_id}
      sub="Same architecture, re-fit on a deliberately harder synthetic profile (more overlap between failing and healthy components)."
      actions={<Chip tone="warn">stress test, not the reported result</Chip>}
    >
      <div className="stack">
        <dl className="kv">
          <dt>Test recall</dt>
          <dd>{formatPct(at.recall)}</dd>
          <dt>Test precision</dt>
          <dd>{formatPct(at.precision)}</dd>
          <dt>Alerts per 100</dt>
          <dd>{formatDecimal(at.alerts_per_100)}</dd>
          <dt>False positives</dt>
          <dd>{formatDecimal(at.fp, 0)}</dd>
          <dt>Served threshold</dt>
          <dd>
            <span className="row" style={{ flexWrap: "nowrap" }}>
              <span className="mono">{formatDecimal(card.threshold, 4)}</span>
              {fragile && <Chip tone="warn">fragile</Chip>}
            </span>
          </dd>
        </dl>
        {fragile && (
          <Notice tone="warn">
            A threshold this close to 0 means a small shift in the score distribution (drift, a new batch, a different seed) can swing which components alert. Treat it as fragile, not a stable tuned choice. The headline numbers elsewhere are the reported result.
          </Notice>
        )}
      </div>
    </Panel>
  );
}

/** Performance: one view at a time so the page stays short. */
export function PerformancePage({ data }: { data: DashboardData }) {
  const [view, setView] = useState<View>("head");
  return (
    <div className="page">
      <PageHead
        title="Performance"
        description="Did it hit the target on held-out data? Head to head, registry versions, threshold curves, stress test."
        actions={
          <Segmented<View>
            label="Performance view"
            value={view}
            onChange={setView}
            options={[
              { id: "head", label: "Head to head" },
              { id: "registry", label: "Champion vs challenger" },
              { id: "curves", label: "Threshold curves" },
              { id: "stress", label: "Stress test" },
            ]}
          />
        }
      />
      {view === "head" && <HeadToHead data={data} />}
      {view === "registry" && <Registry />}
      {view === "curves" && (
        <>
          <Notice tone="plain">Each curve sweeps the alert threshold on validation. The filled dot is the chosen operating point; the outlined dot is the same threshold applied to test without re-tuning.</Notice>
          <div className="grid-2">
            {data.models.map((m) => (
              <CurveCard key={m.id} model={m} data={data} />
            ))}
          </div>
        </>
      )}
      {view === "stress" && <StressTest data={data} />}
    </div>
  );
}
