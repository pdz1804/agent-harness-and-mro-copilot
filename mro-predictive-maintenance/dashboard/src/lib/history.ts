import type { MaintenanceEvent, PredictionPoint } from "../types";

/** Pure helpers behind the component risk-history chart and the life timeline. */

export interface RiskPoint {
  ts: number;
  risk: number;
  threshold: number;
  alert: boolean;
  version: string;
}

/** One point per logged fleet scan, oldest first. Invalid rows are dropped. */
export function toRiskPoints(predictions: readonly PredictionPoint[]): RiskPoint[] {
  const out: RiskPoint[] = [];
  for (const p of predictions) {
    const ts = Date.parse(p.scored_at);
    if (Number.isNaN(ts) || typeof p.risk_score !== "number" || Number.isNaN(p.risk_score)) continue;
    out.push({
      ts,
      risk: p.risk_score,
      threshold: p.threshold,
      alert: p.alert,
      version: p.model_version === null || p.model_version === undefined ? "?" : String(p.model_version),
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export type TrendKind = "none" | "single" | "rising" | "falling" | "flat";

export function riskTrend(points: readonly RiskPoint[]): TrendKind {
  if (points.length === 0) return "none";
  if (points.length === 1) return "single";
  const delta = points[points.length - 1].risk - points[0].risk;
  if (Math.abs(delta) < 0.005) return "flat";
  return delta > 0 ? "rising" : "falling";
}

export function historySummary(points: readonly RiskPoint[]): string {
  const trend = riskTrend(points);
  if (trend === "none") {
    return "No fleet scan has logged a score for this component yet. Run a fleet scan to start its history.";
  }
  if (trend === "single") {
    return "One scan logged so far. Each fleet scan adds a point, so a trend appears after the next one.";
  }
  const n = points.length;
  if (trend === "flat") return `${n} scans logged. Risk has not moved between the first and the latest.`;
  return `${n} scans logged. Risk is ${trend}, from ${(points[0].risk * 100).toFixed(1)}% to ${(points[n - 1].risk * 100).toFixed(1)}%.`;
}

export type LifeEventKind = "scheduled" | "unscheduled" | "removal" | "other";

export interface LifeEvent {
  cycle: number;
  kind: LifeEventKind;
  label: string;
  date: string;
}

export function classifyEvent(eventType: string): LifeEventKind {
  const t = eventType.toLowerCase();
  if (t.includes("removal") || t.includes("removed")) return "removal";
  if (t.includes("unscheduled")) return "unscheduled";
  if (t.includes("scheduled")) return "scheduled";
  return "other";
}

const EVENT_LABEL: Record<LifeEventKind, string> = {
  scheduled: "Scheduled check",
  unscheduled: "Unscheduled check",
  removal: "Removal",
  other: "Event",
};

export function toLifeEvents(events: readonly MaintenanceEvent[]): LifeEvent[] {
  return events
    .filter((e) => typeof e.cycle === "number" && !Number.isNaN(e.cycle))
    .map((e) => {
      const kind = classifyEvent(e.event_type);
      return { cycle: e.cycle, kind, label: EVENT_LABEL[kind], date: e.date };
    })
    .sort((a, b) => a.cycle - b.cycle);
}

/** Position (0..100) of a cycle on the life timeline. */
export function lifePosition(cycle: number, maxCycle: number): number {
  if (maxCycle <= 0) return 0;
  return Math.min(100, Math.max(0, (cycle / maxCycle) * 100));
}

export function lifeMax(events: readonly LifeEvent[], currentCycle: number | null): number {
  const last = events.length > 0 ? events[events.length - 1].cycle : 0;
  return Math.max(last, currentCycle ?? 0, 1);
}

export interface RiskYDomain {
  domain: [number, number];
  ticks: number[];
  /** True when the floor is above 0, so the axis label must say so. */
  zoomed: boolean;
  /** Side of the threshold line with fewer points: where its label can sit without touching data. */
  labelSide: "above" | "below";
}

/** Y-axis for the risk chart. Zooms to the data and the threshold with a margin
 * (half the visible span, at least 3 points of probability), snapped down to a
 * whole percent; the ceiling stays 100%. A wide spread falls back to 0-100%. */
export function riskYDomain(risks: readonly number[], threshold: number): RiskYDomain {
  const vals = risks.filter((r) => Number.isFinite(r));
  const lo = Math.min(threshold, ...vals);
  const margin = Math.max(0.03, (1 - lo) * 0.5);
  const rawFloor = Math.max(0, lo - margin);
  if (rawFloor < 0.3) {
    return { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1], zoomed: false, labelSide: labelSide(vals, threshold) };
  }
  // Smallest round step that keeps the axis to five intervals or fewer.
  const step = [0.01, 0.02, 0.05, 0.1].find((s) => (1 - rawFloor) / s <= 5) ?? 0.1;
  const floor = Math.round(Math.floor(rawFloor / step + 1e-9) * step * 1000) / 1000;
  const ticks: number[] = [];
  for (let t = floor; t < 1 - 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000);
  ticks.push(1);
  return { domain: [floor, 1], ticks, zoomed: true, labelSide: labelSide(vals, threshold) };
}

function labelSide(vals: readonly number[], threshold: number): "above" | "below" {
  const above = vals.filter((r) => r >= threshold).length;
  return above > vals.length - above ? "below" : "above";
}
