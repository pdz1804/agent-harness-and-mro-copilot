import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { humanizeFeatureName } from "../lib/format";
import { Notice } from "./ui/states";
import { Panel } from "./ui/primitives";
import type { DashboardData, FeatureImportanceRow } from "../types";

interface FeatureImportanceSectionProps {
  data: DashboardData;
}

const TOP_N = 10;

const SERIES_COLOR: Record<string, string> = {
  logistic_regression: "#98a1b3",
  hist_gradient_boosting: "#3451d1",
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
      <div className="rc-tooltip-row">
        <span>importance</span>
        <span>{row.importance_mean.toFixed(4)}</span>
      </div>
      <div className="rc-tooltip-row">
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
        <CartesianGrid stroke="#eceef2" strokeDasharray="3 4" horizontal={false} />
        <XAxis type="number" tickFormatter={(v: number) => v.toFixed(2)} stroke="transparent" tick={{ fontSize: 11, fill: "#5c6576" }} />
        <YAxis
          dataKey="display"
          type="category"
          width={168}
          tick={{ fontSize: 11, fill: "#384152" }}
          stroke="transparent"
        />
        <Tooltip content={<ImportanceTooltip />} cursor={{ fill: "rgba(52, 81, 209, 0.06)" }} />
        <Bar dataKey="importance_mean" radius={[0, 6, 6, 0]} barSize={14} isAnimationActive={false}>
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
    <>
      <Notice tone="plain">
        Permutation importance, average-precision scoring, validation split, 10 repeats. A longer bar means the model leans on that feature more.
      </Notice>
      <div className="grid-2">
        {data.models.map((model) => {
          const color = SERIES_COLOR[model.id] ?? "#3451d1";
          return (
            <Panel
              key={model.id}
              title={
                <span className="row" style={{ flexWrap: "nowrap" }}>
                  <i className="swatch" style={{ background: color }} />
                  {model.label}
                </span>
              }
            >
              <div className="chart-box" role="img" aria-label={`Top ${TOP_N} features by permutation importance for ${model.label}`}>
                <ImportanceChart rows={data.feature_importance[model.id]} color={color} />
              </div>
            </Panel>
          );
        })}
      </div>
    </>
  );
}
