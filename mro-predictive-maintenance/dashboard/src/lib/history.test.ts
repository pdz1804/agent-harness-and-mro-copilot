import { describe, expect, it } from "vitest";
import { classifyEvent, historySummary, lifeMax, lifePosition, riskTrend, riskYDomain, toLifeEvents, toRiskPoints } from "./history";
import type { PredictionPoint } from "../types";

const pred = (scored_at: string, risk: number): PredictionPoint => ({
  scored_at,
  snapshot_date: "2026-08-31",
  cycle: 1537.5,
  risk_score: risk,
  threshold: 0.9405,
  alert: risk >= 0.9405,
  model_version: "13",
});

describe("toRiskPoints", () => {
  it("sorts oldest first and drops invalid rows", () => {
    const pts = toRiskPoints([
      pred("2026-10-01T03:33:16Z", 0.9),
      pred("2026-09-30T16:04:34Z", 0.8),
      pred("not-a-date", 0.5),
      { ...pred("2026-10-02T00:00:00Z", 0.7), risk_score: Number.NaN },
    ]);
    expect(pts.map((p) => p.risk)).toEqual([0.8, 0.9]);
  });
  it("labels a missing model version", () => {
    expect(toRiskPoints([{ ...pred("2026-10-01T00:00:00Z", 0.1), model_version: null }])[0].version).toBe("?");
  });
});

describe("riskTrend / historySummary", () => {
  it("handles empty, single, flat, rising, falling", () => {
    expect(riskTrend([])).toBe("none");
    const one = toRiskPoints([pred("2026-10-01T00:00:00Z", 0.5)]);
    expect(riskTrend(one)).toBe("single");
    const flat = toRiskPoints([pred("2026-10-01T00:00:00Z", 0.995), pred("2026-10-02T00:00:00Z", 0.995)]);
    expect(riskTrend(flat)).toBe("flat");
    const up = toRiskPoints([pred("2026-10-01T00:00:00Z", 0.2), pred("2026-10-02T00:00:00Z", 0.6)]);
    expect(riskTrend(up)).toBe("rising");
    const down = toRiskPoints([pred("2026-10-01T00:00:00Z", 0.6), pred("2026-10-02T00:00:00Z", 0.2)]);
    expect(riskTrend(down)).toBe("falling");
  });
  it("never claims a trend from one scan", () => {
    const one = toRiskPoints([pred("2026-10-01T00:00:00Z", 0.5)]);
    expect(historySummary(one)).toMatch(/One scan/);
    expect(historySummary([])).toMatch(/No fleet scan/);
  });
});

describe("life timeline", () => {
  it("classifies event types", () => {
    expect(classifyEvent("scheduled_check")).toBe("scheduled");
    expect(classifyEvent("unscheduled_check")).toBe("unscheduled");
    expect(classifyEvent("unscheduled_removal")).toBe("removal");
    expect(classifyEvent("install")).toBe("other");
  });
  it("sorts by cycle and scales positions", () => {
    const events = toLifeEvents([
      { date: "2026-02-22", cycle: 900, event_type: "scheduled_check", note: null },
      { date: "2025-08-27", cycle: 300, event_type: "scheduled_check", note: null },
    ]);
    expect(events.map((e) => e.cycle)).toEqual([300, 900]);
    const max = lifeMax(events, 1537.5);
    expect(max).toBe(1537.5);
    expect(lifePosition(300, max)).toBeCloseTo(19.5, 1);
    expect(lifePosition(5000, max)).toBe(100);
    expect(lifePosition(-5, max)).toBe(0);
    expect(lifeMax([], null)).toBe(1);
  });
});

describe("riskYDomain", () => {
  it("zooms to data near 99% and the 94.05% threshold", () => {
    const d = riskYDomain([0.9953, 0.9921, 0.99], 0.9405);
    expect(d.zoomed).toBe(true);
    expect(d.domain[1]).toBe(1);
    expect(d.domain[0]).toBeLessThan(0.9405);
    expect(d.domain[0]).toBeGreaterThan(0.8);
    expect(d.ticks[d.ticks.length - 1]).toBe(1);
    expect(d.ticks.length).toBeLessThanOrEqual(6);
    expect(d.ticks[0]).toBe(d.domain[0]);
    // Round whole-percent ticks, not 97.8%.
    expect(d.ticks.every((t) => Math.abs(t * 100 - Math.round(t * 100)) < 1e-6)).toBe(true);
  });
  it("includes a point below the threshold", () => {
    expect(riskYDomain([0.7, 0.99], 0.9405).domain[0]).toBeLessThan(0.7);
  });
  it("falls back to 0-100% for a wide spread", () => {
    const d = riskYDomain([0.05, 0.95], 0.9405);
    expect(d.domain).toEqual([0, 1]);
    expect(d.zoomed).toBe(false);
  });
  it("puts the threshold label on the side with fewer points", () => {
    expect(riskYDomain([0.99, 0.995], 0.9405).labelSide).toBe("below");
    expect(riskYDomain([0.5, 0.6], 0.9405).labelSide).toBe("above");
  });
});
