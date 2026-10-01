import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { OperatingTarget, ThresholdSweepRow } from "../types";
import { formatDecimal, formatPct } from "../lib/format";

interface ThresholdSweepChartProps {
  sweep: ThresholdSweepRow[];
  color: string;
  target: OperatingTarget;
  valPoint: { threshold: number; recall: number; alerts_per_100: number };
  testPoint: { recall: number; alerts_per_100: number };
}

interface TooltipPayloadItem {
  payload: ThresholdSweepRow;
}

function SweepTooltip({
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
      <div className="rc-tooltip-row">
        <span>threshold</span>
        <span>{row.threshold.toFixed(4)}</span>
      </div>
      <div className="rc-tooltip-row">
        <span>recall</span>
        <span>{formatPct(row.recall)}</span>
      </div>
      <div className="rc-tooltip-row">
        <span>alerts/100</span>
        <span>{formatDecimal(row.alerts_per_100)}</span>
      </div>
      <div className="rc-tooltip-row">
        <span>precision</span>
        <span>{formatPct(row.precision)}</span>
      </div>
    </div>
  );
}

/** Recall vs. alert-rate operating curve, swept on the VALIDATION split.
 * The chosen operating threshold (picked on val) and the actual TEST outcome
 * at that same threshold are both marked, so any val->test generalization
 * gap is visible rather than hidden. */
export function ThresholdSweepChart({
  sweep,
  color,
  target,
  valPoint,
  testPoint,
}: ThresholdSweepChartProps) {
  const maxAlerts = Math.max(
    target.max_alerts_per_100 * 1.4,
    ...sweep.filter((r) => r.recall >= 0.4).map((r) => r.alerts_per_100),
  );
  const chartData = sweep
    .filter((r) => r.alerts_per_100 <= maxAlerts)
    .sort((a, b) => a.alerts_per_100 - b.alerts_per_100);

  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="#eceef2" strokeDasharray="3 4" vertical={false} />
          <XAxis
            dataKey="alerts_per_100"
            type="number"
            domain={[0, maxAlerts]}
            tickFormatter={(v: number) => v.toFixed(1)}
            label={{
              value: "alerts / 100 components (validation sweep)",
              position: "insideBottom",
              offset: -4,
              fontSize: 11,
              fill: "#5c6576",
            }}
            stroke="transparent"
            tick={{ fontSize: 11, fill: "#5c6576" }}
          />
          <YAxis
            dataKey="recall"
            type="number"
            domain={[0, 1]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            width={44}
            stroke="transparent"
            tick={{ fontSize: 11, fill: "#5c6576" }}
          />
          <Tooltip content={<SweepTooltip />} cursor={{ stroke: "rgba(15, 23, 42, 0.16)" }} />
          <ReferenceLine
            y={target.min_recall}
            stroke="#0b1220"
            strokeDasharray="4 4"
            strokeOpacity={0.6}
          />
          <ReferenceLine
            x={target.max_alerts_per_100}
            stroke="#0b1220"
            strokeDasharray="4 4"
            strokeOpacity={0.6}
          />
          <Line
            type="monotone"
            dataKey="recall"
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <ReferenceDot
            x={valPoint.alerts_per_100}
            y={valPoint.recall}
            r={5}
            fill={color}
            stroke="#ffffff"
            strokeWidth={2}
          />
          <ReferenceDot
            x={testPoint.alerts_per_100}
            y={testPoint.recall}
            r={5}
            fill="#0b1220"
            stroke={color}
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="legend" style={{ marginTop: 8 }}>
        <i className="swatch is-dot" style={{ background: color }} /> validation operating point (threshold{" "}
        {valPoint.threshold.toFixed(4)}) &nbsp;&nbsp;
        <i className="swatch is-dot" style={{ background: "#0b1220" }} /> same threshold applied to
        held-out test &nbsp;&nbsp; dashed lines: target ({formatPct(target.min_recall, 0)} recall,{" "}
        {formatDecimal(target.max_alerts_per_100, 1)} alerts/100)
      </div>
    </div>
  );
}
