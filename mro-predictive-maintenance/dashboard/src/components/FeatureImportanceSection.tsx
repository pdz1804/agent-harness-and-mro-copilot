import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { humanizeFeatureName } from "../lib/format";
import type { DashboardData, FeatureImportanceRow } from "../types";

interface FeatureImportanceSectionProps {
  data: DashboardData;
}

const TOP_N = 10;

const SERIES_COLOR: Record<string, string> = {
  logistic_regression: "var(--series-lr)",
  hist_gradient_boosting: "var(--series-hgb)",
};

interface TooltipPayloadItem {
  payload: FeatureImportanceRow;
}

function ImportanceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  return (
    <div className="rc-tooltip">
      <div style={{ marginBottom: 4, fontFamily: "var(--font-mono)" }}>{row.feature}</div>
      <div className="rc-tooltip__row">
        <span>importance</span>
        <span>{row.importance_mean.toFixed(4)}</span>
      </div>
      <div className="rc-tooltip__row">
        <span>std (10 repeats)</span>
        <span>&plusmn;{row.importance_std.toFixed(4)}</span>
      </div>
    </div>
  );
}

function ImportanceChart({ rows, color }: { rows: FeatureImportanceRow[]; color: string }) {
  const top = rows.slice(0, TOP_N).map((r) => ({ ...r, display: humanizeFeatureName(r.feature) }));
  const height = 34 * top.length + 20;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={top} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
        <CartesianGrid stroke="var(--panel-border)" horizontal={false} />
        <XAxis type="number" tickFormatter={(v: number) => v.toFixed(2)} stroke="var(--panel-border-strong)" />
        <YAxis
          dataKey="display"
          type="category"
          width={168}
          tick={{ fontSize: 11 }}
          stroke="var(--panel-border-strong)"
        />
        <Tooltip content={<ImportanceTooltip />} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
        <Bar dataKey="importance_mean" radius={[0, 3, 3, 0]} isAnimationActive={false}>
          {top.map((row) => (
            <Cell key={row.feature} fill={color} fillOpacity={row.importance_mean < 0 ? 0.35 : 1} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function FeatureImportanceSection({ data }: FeatureImportanceSectionProps) {
  return (
    <section className="section">
      <div className="section__heading">
        <h2 className="section__title">Feature importance</h2>
        <span className="section__note">
          permutation importance, avg. precision scoring, validation split, 10 repeats
        </span>
      </div>
      <div className="model-grid">
        {data.models.map((model) => (
          <div className="panel" key={model.id}>
            <div className="model-card__title" style={{ marginBottom: 10 }}>
              <span
                className="model-card__dot"
                style={{ background: SERIES_COLOR[model.id] ?? "var(--accent)" }}
              />
              {model.label}
            </div>
            <ImportanceChart
              rows={data.feature_importance[model.id]}
              color={SERIES_COLOR[model.id] ?? "var(--accent)"}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
