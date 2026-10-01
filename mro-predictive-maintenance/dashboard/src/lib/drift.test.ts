import { describe, expect, it } from "vitest";
import { driftTimelineNote, monitoredLookup, normalizeDrift, normalizeDriftHistory, selectDriftSeries, triggerLabel } from "./drift";
import type { DriftHistory, DriftReport } from "../types";

describe("normalizeDrift", () => {
  it("reads the live service shape (features dict, status) without throwing", () => {
    const live = {
      status: "warn",
      n_reference: 312,
      n_current: 624,
      features: {
        vibration_mm_s: { psi: 0.05, status: "ok", type: "numeric", monitored: true },
        temperature_delta_c: { psi: 0.107, status: "warn", type: "numeric", monitored: true },
        component_age_cycles: {
          psi: 0.6,
          status: "alert",
          type: "numeric",
          monitored: false,
          unmonitored_reason: "calendar age",
        },
      },
      score_psi: 0.0015,
      score_status: "ok",
      thresholds: { warn: 0.1, alert: 0.25 },
      current_source: "predictions_log",
      simulated_shift_applied: false,
    } as unknown as DriftReport;
    const n = normalizeDrift(live);
    expect(n.overall).toBe("warn");
    expect(n.rows.map((r) => r.feature)).toEqual(["temperature_delta_c", "vibration_mm_s", "component_age_cycles"]);
    expect(n.rows[2].monitored).toBe(false);
    expect(n.scorePsi).toBeCloseTo(0.0015);
    expect(n.warnAt).toBe(0.1);
    expect(n.alertAt).toBe(0.25);
  });

  it("still accepts the older feature_drift array shape", () => {
    const old = {
      overall_status: "alert",
      feature_drift: [
        { feature: "a", psi: 0.3, status: "alert" },
        { feature: "b", psi: 0.01, status: "ok" },
      ],
      current_source: "x",
      simulated_shift_applied: true,
    } as DriftReport;
    const n = normalizeDrift(old);
    expect(n.overall).toBe("alert");
    expect(n.rows[0].feature).toBe("a");
    expect(n.simulated).toBe(true);
  });

  it("treats null/NaN PSI (insufficient data) as 0 instead of crashing", () => {
    const n = normalizeDrift({
      status: "insufficient_data",
      features: { x: { psi: null, status: "insufficient_data" } },
    } as unknown as DriftReport);
    expect(n.rows[0].psi).toBe(0);
  });
});

describe("normalizeDriftHistory", () => {
  const raw = {
    points: [
      {
        at: "2026-10-01T04:39:00+00:00",
        overall: "warn",
        score_psi: 0.0015,
        features: { airflow_cfm: 0.2247, vibration_mm_s: 0.0536, bad: null },
        trigger: "drift_call",
        n_current: 624,
      },
      { at: "2026-10-01T04:36:03+00:00", overall: "ok", score_psi: null, features: {}, trigger: "fleet_scan", n_current: 0 },
      { at: "garbage", overall: "ok", score_psi: 0, features: {}, trigger: "x", n_current: 0 },
    ],
  };
  const pts = normalizeDriftHistory(raw as unknown as DriftHistory);

  it("orders oldest first and drops unparseable timestamps", () => {
    expect(pts).toHaveLength(2);
    expect(pts[0].trigger).toBe("fleet_scan");
  });
  it("finds the worst feature and keeps a null score PSI null", () => {
    expect(pts[1].maxFeature).toBe("airflow_cfm");
    expect(pts[1].maxFeaturePsi).toBeCloseTo(0.2247, 4);
    expect(pts[0].scorePsi).toBeNull();
    expect(pts[0].maxFeature).toBeNull();
  });
  it("tolerates a missing payload", () => {
    expect(normalizeDriftHistory(null)).toEqual([]);
  });
  it("does not call two snapshots a trend", () => {
    expect(driftTimelineNote(pts)).toMatch(/too few to call a trend/);
    expect(driftTimelineNote([])).toMatch(/No snapshots/);
  });
  it("labels triggers", () => {
    expect(triggerLabel("fleet_scan")).toBe("Fleet scan");
    expect(triggerLabel("drift_call")).toBe("Monitoring view");
  });
});

describe("selectDriftSeries", () => {
  const features = { airflow_cfm: 0.2247, temperature_delta_c: 0.107, aircraft_age_years: 0.283, component_age_cycles: 0.145, broken: null };
  const monitored = { aircraft_age_years: false, component_age_cycles: false };
  it("keeps unmonitored features out of the worst-monitored series", () => {
    const s = selectDriftSeries(features, monitored);
    expect(s.maxFeature).toBe("airflow_cfm");
    expect(s.maxFeaturePsi).toBeCloseTo(0.2247, 4);
    expect(s.maxUnmonitoredFeature).toBe("aircraft_age_years");
    expect(s.maxUnmonitoredPsi).toBeCloseTo(0.283, 3);
  });
  it("treats unknown features as monitored and handles empty input", () => {
    expect(selectDriftSeries(features, {}).maxFeature).toBe("aircraft_age_years");
    expect(selectDriftSeries(undefined, monitored).maxFeaturePsi).toBeNull();
  });
  it("threads the live monitored flags through history", () => {
    const rows = normalizeDrift({
      status: "warn",
      features: { a: { psi: 0.3, status: "alert", monitored: false }, b: { psi: 0.2, status: "warn", monitored: true } },
    } as unknown as DriftReport).rows;
    const hist = { points: [{ at: "2026-10-01T04:00:00Z", overall: "warn", score_psi: 0.001, features: { a: 0.3, b: 0.2 }, trigger: "fleet_scan", n_current: 5 }] };
    const [p] = normalizeDriftHistory(hist as unknown as DriftHistory, monitoredLookup(rows));
    expect(p.maxFeature).toBe("b");
    expect(p.maxUnmonitoredFeature).toBe("a");
  });
});
