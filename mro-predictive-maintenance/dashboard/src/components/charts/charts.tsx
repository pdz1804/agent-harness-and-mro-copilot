import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatPct } from "../../lib/format";
import { lifeMax, lifePosition, riskYDomain, type LifeEvent, type RiskPoint } from "../../lib/history";
import type { DriftTimelinePoint } from "../../lib/drift";
import { triggerLabel } from "../../lib/drift";
import { Button } from "../ui/primitives";

/** Recharts takes literal colours; keep them in step with tokens.css. */
export const CHART = {
  grid: "#dde2e8",
  axis: "#5a6772",
  accent: "#0b6b8a",
  bad: "#b42318",
  badBand: "rgba(180, 35, 24, 0.07)",
  warn: "#b8770a",
  warnBand: "rgba(184, 119, 10, 0.1)",
  text: "#101820",
  baseline: "#7d8b98",
};

const fmtDay = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtSecs = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** Snapshots a few minutes apart need seconds or the axis repeats a label. */
const tickFormatterFor = (span: number) => (span < 3_600_000 ? fmtSecs : fmtDay);

/** Plain ring marker. The default recharts dot inherits the line's dash
 * pattern, which renders as stray glyphs on a dashed series. */
function plainDot(color: string, r = 3.5) {
  return (props: { cx?: number; cy?: number; index?: number }) =>
    typeof props.cx === "number" && typeof props.cy === "number" ? (
      <circle key={props.index} cx={props.cx} cy={props.cy} r={r} fill="#fff" stroke={color} strokeWidth={2} strokeDasharray="0" />
    ) : (
      <g key={props.index} />
    );
}

function TooltipBox({ rows, title }: { rows: [string, string][]; title: string }) {
  return (
    <div className="rc-tooltip">
      <div className="rc-tooltip-title">{title}</div>
      {rows.map(([k, v]) => (
        <div className="rc-tooltip-row" key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

/* ---- Component risk history: one point per fleet scan ---------------------------- */
export function RiskHistoryChart({ points, threshold }: { points: RiskPoint[]; threshold: number }) {
  const [asTable, setAsTable] = useState(false);
  const data = points.map((p) => ({ ...p }));
  const single = data.length === 1;
  // A single timestamp has no width, so give the axis room either side.
  const y = riskYDomain(data.map((p) => p.risk), threshold);
  const domain: [number, number] = single
    ? [data[0].ts - 3_600_000, data[0].ts + 3_600_000]
    : [data[0].ts - (data[data.length - 1].ts - data[0].ts) * 0.04, data[data.length - 1].ts + (data[data.length - 1].ts - data[0].ts) * 0.04];

  return (
    <div>
      <div className="row row-between" style={{ marginBottom: 8 }}>
        <div className="legend">
          <span style={{ color: CHART.bad }}>
            <i className="swatch is-line" /> <span style={{ color: "var(--text-2)" }}>Risk score</span>
          </span>
          <span style={{ color: CHART.text }}>
            <i className="swatch is-dash" /> <span style={{ color: "var(--text-2)" }}>Alert threshold {formatPct(threshold, 2)}</span>
          </span>
          <span>
            <i className="swatch" style={{ background: CHART.badBand, border: "1px solid #f1b4ad" }} />
            Alert zone
          </span>
        </div>
        <Button size="sm" variant="ghost" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show chart" : "Show table"}
        </Button>
      </div>

      {asTable ? (
        <div className="table-scroll">
          <table className="dt" aria-label="Risk per fleet scan">
            <thead>
              <tr>
                <th scope="col">Scored at</th>
                <th scope="col" className="num">
                  Risk
                </th>
                <th scope="col">Result</th>
                <th scope="col">Model</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.ts}>
                  <td className="mono">{fmtDay(p.ts)}</td>
                  <td className="num">{formatPct(p.risk, 2)}</td>
                  <td>{p.alert ? "alert" : "below threshold"}</td>
                  <td className="mono">v{p.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-box" role="img" aria-label={`Risk per fleet scan, ${data.length} point${data.length === 1 ? "" : "s"}, against a threshold of ${formatPct(threshold, 2)}`}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: y.zoomed ? 8 : 0 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <ReferenceArea y1={threshold} y2={1} fill={CHART.badBand} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={domain}
                tickFormatter={fmtDay}
                tick={{ fontSize: 11, fill: CHART.axis }}
                stroke={CHART.grid}
                tickCount={single ? 3 : 5}
                minTickGap={40}
              />
              <YAxis
                domain={y.domain}
                ticks={y.ticks}
                allowDataOverflow
                tickFormatter={(v: number) => `${Math.round(v * 1000) / 10}%`}
                tick={{ fontSize: 11, fill: CHART.axis }}
                stroke={CHART.grid}
                width={y.zoomed ? 80 : 46}
                label={{
                  value: y.zoomed ? `zoomed axis, from ${formatPct(y.domain[0], 0)}` : "risk",
                  angle: -90,
                  position: "insideLeft",
                  offset: 8,
                  style: { textAnchor: "middle", fontSize: 10, fill: CHART.axis },
                }}
              />
              <ReferenceLine
                y={threshold}
                stroke={CHART.text}
                strokeDasharray="5 4"
                label={{ value: `threshold ${formatPct(threshold, 2)}`, position: y.labelSide === "below" ? "insideTopRight" : "insideBottomRight", fontSize: 11, fill: CHART.text }}
              />
              <Tooltip
                content={({ active, payload }) => {
                  const p = active && payload && payload[0] ? (payload[0].payload as RiskPoint) : null;
                  if (!p) return null;
                  return (
                    <TooltipBox
                      title={fmtDay(p.ts)}
                      rows={[
                        ["Risk", formatPct(p.risk, 2)],
                        ["Result", p.alert ? "alert" : "below threshold"],
                        ["Model", `v${p.version}`],
                      ]}
                    />
                  );
                }}
              />
              <Line
                dataKey="risk"
                type="monotone"
                stroke={CHART.bad}
                strokeWidth={2}
                dot={{ r: 4, fill: "#fff", stroke: CHART.bad, strokeWidth: 2 }}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
                label={single ? { position: "top", fontSize: 11, fill: CHART.text, formatter: (v: number) => formatPct(v, 1) } : undefined}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/* ---- Drift timeline: score PSI and the worst feature, with warn/alert bands ----- */
export function DriftTimelineChart({
  points,
  warnAt,
  alertAt,
}: {
  points: DriftTimelinePoint[];
  warnAt: number;
  alertAt: number;
}) {
  const [asTable, setAsTable] = useState(false);
  const hasUnmonitored = points.some((p) => p.maxUnmonitoredPsi !== null);
  const top = Math.max(alertAt * 1.5, ...points.map((p) => Math.max(p.maxFeaturePsi ?? 0, p.maxUnmonitoredPsi ?? 0, p.scorePsi ?? 0)));
  const single = points.length === 1;
  const span = points.length > 1 ? points[points.length - 1].ts - points[0].ts : 0;
  const domain: [number, number] = single
    ? [points[0].ts - 3_600_000, points[0].ts + 3_600_000]
    : [points[0].ts - span * 0.04, points[points.length - 1].ts + span * 0.04];

  return (
    <div>
      <div className="row row-between" style={{ marginBottom: 8 }}>
        <div className="legend">
          <span style={{ color: CHART.accent }}>
            <i className="swatch is-line" /> <span style={{ color: "var(--text-2)" }}>Score PSI</span>
          </span>
          <span style={{ color: CHART.warn }}>
            <i className="swatch is-line" /> <span style={{ color: "var(--text-2)" }}>Worst monitored feature PSI</span>
          </span>
          {hasUnmonitored && (
            <span style={{ color: CHART.baseline }}>
              <i className="swatch is-dash" /> <span style={{ color: "var(--text-2)" }}>unmonitored (excluded from status)</span>
            </span>
          )}
          <span>
            <i className="swatch" style={{ background: CHART.warnBand, border: "1px solid #e9cf94" }} />
            Warn above {warnAt}
          </span>
          <span>
            <i className="swatch" style={{ background: CHART.badBand, border: "1px solid #f1b4ad" }} />
            Alert above {alertAt}
          </span>
        </div>
        <Button size="sm" variant="ghost" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show chart" : "Show table"}
        </Button>
      </div>
      {asTable ? (
        <div className="table-scroll">
          <table className="dt" aria-label="Drift snapshots">
            <thead>
              <tr>
                <th scope="col">Recorded</th>
                <th scope="col">Source</th>
                <th scope="col">Overall</th>
                <th scope="col" className="num">
                  Score PSI
                </th>
                <th scope="col">Worst monitored feature</th>
                <th scope="col" className="num">
                  PSI
                </th>
                <th scope="col">Unmonitored (excluded)</th>
                <th scope="col" className="num">
                  PSI
                </th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.ts}>
                  <td className="mono">{fmtDay(p.ts)}</td>
                  <td>{triggerLabel(p.trigger)}</td>
                  <td>{p.overall === "ok" ? "no alert" : p.overall}</td>
                  <td className="num">{p.scorePsi === null ? "n/a" : p.scorePsi.toFixed(4)}</td>
                  <td className="mono">{p.maxFeature ?? "n/a"}</td>
                  <td className="num">{p.maxFeaturePsi === null ? "n/a" : p.maxFeaturePsi.toFixed(3)}</td>
                  <td className="mono">{p.maxUnmonitoredFeature ?? "n/a"}</td>
                  <td className="num">{p.maxUnmonitoredPsi === null ? "n/a" : p.maxUnmonitoredPsi.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-box" role="img" aria-label={`PSI drift timeline, ${points.length} snapshot${points.length === 1 ? "" : "s"}`}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <ReferenceArea y1={warnAt} y2={alertAt} fill={CHART.warnBand} />
              <ReferenceArea y1={alertAt} y2={top * 1.05} fill={CHART.badBand} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={domain}
                tickFormatter={tickFormatterFor(span)}
                tick={{ fontSize: 11, fill: CHART.axis }}
                stroke={CHART.grid}
                tickCount={single ? 3 : 4}
                minTickGap={60}
              />
              <YAxis
                domain={[0, top * 1.05]}
                tickFormatter={(v: number) => v.toFixed(2)}
                tick={{ fontSize: 11, fill: CHART.axis }}
                stroke={CHART.grid}
                width={42}
              />
              <ReferenceLine y={warnAt} stroke={CHART.warn} strokeDasharray="4 4" />
              <ReferenceLine y={alertAt} stroke={CHART.bad} strokeDasharray="4 4" />
              <Tooltip
                content={({ active, payload }) => {
                  const p = active && payload && payload[0] ? (payload[0].payload as DriftTimelinePoint) : null;
                  if (!p) return null;
                  return (
                    <TooltipBox
                      title={fmtDay(p.ts)}
                      rows={[
                        ["Source", triggerLabel(p.trigger)],
                        ["Overall", p.overall === "ok" ? "no alert" : p.overall],
                        ["Score PSI", p.scorePsi === null ? "n/a" : p.scorePsi.toFixed(4)],
                        [p.maxFeature ?? "Worst monitored", p.maxFeaturePsi === null ? "n/a" : p.maxFeaturePsi.toFixed(3)],
                        ...(p.maxUnmonitoredPsi === null
                          ? []
                          : [[`${p.maxUnmonitoredFeature} (unmonitored)`, p.maxUnmonitoredPsi.toFixed(3)] as [string, string]]),
                      ]}
                    />
                  );
                }}
              />
              <Line dataKey="scorePsi" stroke={CHART.accent} strokeWidth={2} dot={plainDot(CHART.accent)} activeDot={{ r: 5 }} isAnimationActive={false} connectNulls />
              {hasUnmonitored && (
                <Line
                  dataKey="maxUnmonitoredPsi"
                  stroke={CHART.baseline}
                  strokeOpacity={0.55}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={plainDot(CHART.baseline, 2.5)}
                  activeDot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              )}
              <Line
                dataKey="maxFeaturePsi"
                stroke={CHART.warn}
                strokeWidth={2}
                dot={plainDot(CHART.warn)}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/* ---- Component life: checks and removals along its cycle count ------------------ */
export function LifeTimeline({ events, currentCycle }: { events: LifeEvent[]; currentCycle: number | null }) {
  const max = lifeMax(events, currentCycle);
  return (
    <div>
      <div className="life" role="img" aria-label={`Component life to cycle ${Math.round(max)}: ${events.length} maintenance events`}>
        <div className="life-line" />
        {events.map((e, i) => (
          <span
            key={`${e.cycle}-${i}`}
            className={`life-mark is-${e.kind}`}
            style={{ left: `${lifePosition(e.cycle, max)}%` }}
            title={`${e.label}, cycle ${Math.round(e.cycle)}, ${e.date}`}
          />
        ))}
        {currentCycle !== null && <span className="life-now" style={{ left: `${lifePosition(currentCycle, max)}%` }} title={`Now, cycle ${Math.round(currentCycle)}`} />}
      </div>
      <div className="life-axis" aria-hidden="true">
        <span>cycle 0</span>
        <span>{Math.round(max / 2)}</span>
        <span>{Math.round(max)}</span>
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        <span>
          <i className="life-key is-scheduled" />
          Scheduled check
        </span>
        <span>
          <i className="life-key is-unscheduled" />
          Unscheduled check
        </span>
        <span>
          <i className="life-key is-removal" />
          Removal
        </span>
        <span>
          <i className="life-key is-now" />
          Latest snapshot
        </span>
      </div>
    </div>
  );
}
