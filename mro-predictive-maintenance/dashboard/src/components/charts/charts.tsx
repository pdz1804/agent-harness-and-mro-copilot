import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
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
  grid: "#eceef2",
  axis: "#5c6576",
  accent: "#3451d1",
  bad: "#dc4436",
  badBand: "rgba(220, 68, 54, 0.06)",
  badBorder: "rgba(220, 68, 54, 0.3)",
  warn: "#d48a06",
  warnBand: "rgba(212, 138, 6, 0.08)",
  warnBorder: "rgba(212, 138, 6, 0.35)",
  text: "#0b1220",
  baseline: "#98a1b3",
};

/** Vertical gradient for the soft fill under a line. */
function Fade({ id, color }: { id: string; color: string }) {
  return (
    <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={0.2} />
      <stop offset="100%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}
const AXIS_TICK = { fontSize: 11, fill: CHART.axis };

const fmtDay = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtSecs = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** Snapshots a few minutes apart need seconds or the axis repeats a label. */
const tickFormatterFor = (span: number) => (span < 3_600_000 ? fmtSecs : fmtDay);

/** Plain ring marker. The default recharts dot inherits the line's dash
 * pattern, which renders as stray glyphs on a dashed series. */
function plainDot(color: string, r = 3) {
  return (props: { cx?: number; cy?: number; index?: number }) =>
    typeof props.cx === "number" && typeof props.cy === "number" ? (
      <circle key={props.index} cx={props.cx} cy={props.cy} r={r} fill="#fff" stroke={color} strokeWidth={1.75} strokeDasharray="0" />
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
            <i className="swatch" style={{ background: CHART.badBand, boxShadow: `inset 0 0 0 1px ${CHART.badBorder}` }} />
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
            <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: y.zoomed ? 8 : 0 }}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 4" vertical={false} />
              <ReferenceArea y1={threshold} y2={1} fill={CHART.badBand} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={domain}
                tickFormatter={fmtDay}
                tick={AXIS_TICK}
                stroke="transparent"
                tickCount={single ? 3 : 5}
                minTickGap={40}
              />
              <YAxis
                domain={y.domain}
                ticks={y.ticks}
                allowDataOverflow
                tickFormatter={(v: number) => `${Math.round(v * 1000) / 10}%`}
                tick={AXIS_TICK}
                stroke="transparent"
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
              <defs>
                <Fade id="fade-risk" color={CHART.bad} />
              </defs>
              <Area dataKey="risk" type="monotone" stroke="none" fill="url(#fade-risk)" baseValue={y.domain[0]} isAnimationActive={false} activeDot={false} tooltipType="none" />
              <Line
                dataKey="risk"
                type="monotone"
                stroke={CHART.bad}
                strokeWidth={2}
                dot={{ r: 3, fill: "#fff", stroke: CHART.bad, strokeWidth: 1.75 }}
                activeDot={{ r: 4.5, strokeWidth: 2, stroke: "#fff" }}
                isAnimationActive={false}
                label={single ? { position: "top", fontSize: 11, fill: CHART.text, formatter: (v: number) => formatPct(v, 1) } : undefined}
              />
            </ComposedChart>
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
            <i className="swatch" style={{ background: CHART.warnBand, boxShadow: `inset 0 0 0 1px ${CHART.warnBorder}` }} />
            Watch from {warnAt}
          </span>
          <span>
            <i className="swatch" style={{ background: CHART.badBand, boxShadow: `inset 0 0 0 1px ${CHART.badBorder}` }} />
            Drift from {alertAt}
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
            <ComposedChart data={points} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 4" vertical={false} />
              <ReferenceArea y1={warnAt} y2={alertAt} fill={CHART.warnBand} />
              <ReferenceArea y1={alertAt} y2={top * 1.05} fill={CHART.badBand} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={domain}
                tickFormatter={tickFormatterFor(span)}
                tick={AXIS_TICK}
                stroke="transparent"
                tickCount={single ? 3 : 4}
                minTickGap={60}
              />
              <YAxis
                domain={[0, top * 1.05]}
                tickFormatter={(v: number) => v.toFixed(2)}
                tick={AXIS_TICK}
                stroke="transparent"
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
              <defs>
                <Fade id="fade-psi-score" color={CHART.accent} />
                <Fade id="fade-psi-feature" color={CHART.warn} />
              </defs>
              <Area dataKey="maxFeaturePsi" stroke="none" fill="url(#fade-psi-feature)" isAnimationActive={false} activeDot={false} tooltipType="none" connectNulls />
              <Area dataKey="scorePsi" stroke="none" fill="url(#fade-psi-score)" isAnimationActive={false} activeDot={false} tooltipType="none" connectNulls />
              <Line dataKey="scorePsi" stroke={CHART.accent} strokeWidth={2} dot={plainDot(CHART.accent)} activeDot={{ r: 4.5, strokeWidth: 2, stroke: "#fff" }} isAnimationActive={false} connectNulls />
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
                activeDot={{ r: 4.5, strokeWidth: 2, stroke: "#fff" }}
                isAnimationActive={false}
                connectNulls
              />
            </ComposedChart>
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
