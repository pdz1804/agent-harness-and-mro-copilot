import { describe, expect, it } from "vitest";
import { canStartRetrain, extractRunId, gateVerdict, isTerminal, nextPollDelay, retrainMetricRows } from "./retrain";
import type { RetrainJob } from "../types";

// Shaped from the example in the backend endpoints report.
const finished: RetrainJob = {
  run_id: "3f9c1a7b2e44",
  status: "succeeded",
  requested_by: "lead.engineer",
  profile: "realistic",
  baseline_available: false,
  promote_allowed: false,
  result: {
    gate: { promote: true, reasons: ["no existing champion metrics found; promoting unconditionally"] },
    challenger_metrics: { recall_ci_low: 0.61, component_window_alerts_per_100: 3.73, brier: 0.0096 },
    champion_metrics: null,
    targets: { recall_ci_low_slack: 0.02, max_alerts_per_100: 5.0, brier_slack: 0.005 },
    promoted: false,
    model_version: null,
    served_model_changed: false,
    note: "no recorded champion baseline: the gate had nothing to compare against, so nothing was promoted",
    v1_model_card_unchanged: true,
  },
};

describe("access and polling", () => {
  it("only lead.engineer may start a retrain", () => {
    expect(canStartRetrain("lead.engineer")).toBe(true);
    for (const u of ["planner", "viewer", "engineer.demo", ""]) expect(canStartRetrain(u)).toBe(false);
  });
  it("knows terminal states", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });
  it("eases the poll delay up to a ceiling", () => {
    expect(nextPollDelay(0)).toBe(1500);
    expect(nextPollDelay(2)).toBe(2500);
    expect(nextPollDelay(100)).toBe(5000);
  });
});

describe("gateVerdict", () => {
  it("does not call a withheld promotion a success", () => {
    const v = gateVerdict(finished);
    expect(v.tone).toBe("warn");
    expect(v.label).toMatch(/nothing was promoted/);
    expect(v.detail).toMatch(/no recorded champion baseline/);
  });
  it("reports a failed gate with its reasons", () => {
    const v = gateVerdict({
      ...finished,
      result: { ...finished.result, gate: { promote: false, reasons: ["alerts per 100 above target"] }, promoted: false },
    });
    expect(v.tone).toBe("bad");
    expect(v.detail).toMatch(/above target/);
  });
  it("says a promotion still needs a restart to be served", () => {
    const v = gateVerdict({ ...finished, result: { ...finished.result, promoted: true, served_model_changed: false } });
    expect(v.tone).toBe("good");
    expect(v.detail).toMatch(/restarts/);
  });
  it("surfaces a job failure message", () => {
    expect(gateVerdict({ run_id: "x", status: "failed", error: "boom" })).toMatchObject({ tone: "bad", detail: "boom" });
  });
  it("shows in-flight jobs as neutral", () => {
    expect(gateVerdict({ run_id: "x", status: "running" }).tone).toBe("neutral");
    expect(gateVerdict({ run_id: "x", status: "queued" }).label).toBe("Queued");
  });
});

describe("retrainMetricRows", () => {
  it("keeps a missing champion as null, never zero, and attaches the alert target", () => {
    const rows = retrainMetricRows(finished);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.champion === null)).toBe(true);
    const alerts = rows.find((r) => r.key === "component_window_alerts_per_100");
    expect(alerts?.target).toBe(5);
    expect(alerts?.passes).toBe("lower");
  });
  it("returns nothing before a result exists", () => {
    expect(retrainMetricRows({ run_id: "x", status: "running" })).toEqual([]);
  });
});

describe("extractRunId", () => {
  it("reads a run_id from a JSON detail", () => {
    expect(extractRunId('409 Conflict: {"detail":{"run_id":"3f9c1a7b2e44","status":"running"}}')).toBe("3f9c1a7b2e44");
  });
  it("falls back to a 12-hex token in plain text", () => {
    expect(extractRunId("409 Conflict: retrain 3f9c1a7b2e44 is already running")).toBe("3f9c1a7b2e44");
  });
  it("returns null when there is no id", () => {
    expect(extractRunId("409 Conflict: busy")).toBeNull();
  });
});
