import { describe, expect, it } from "vitest";
import { filterAircraft, statusSeverity, summarizeAircraft } from "./aircraft-index";
import type { AircraftIndexRow } from "../types";

const rows: AircraftIndexRow[] = [
  { aircraft_id: "AC-005", status: "serviceable", n_open_alerts: 1, n_open_wos: 1, max_risk: 0.995 },
  { aircraft_id: "AC-019", status: "restricted", n_open_alerts: 1, n_open_wos: 0, max_risk: 0.97 },
  { aircraft_id: "AC-003", status: "serviceable", n_open_alerts: 0, n_open_wos: 0, max_risk: null },
  { aircraft_id: "AC-120", status: "aog", n_open_alerts: 2, n_open_wos: 3, max_risk: 0.5 },
];

describe("summarizeAircraft", () => {
  it("counts statuses, open items and scanned aircraft", () => {
    expect(summarizeAircraft(rows)).toEqual({
      total: 4,
      serviceable: 2,
      restricted: 1,
      aog: 1,
      openAlerts: 4,
      openWorkOrders: 4,
      scanned: 3,
    });
  });
  it("handles an empty fleet", () => {
    expect(summarizeAircraft([]).total).toBe(0);
  });
});

describe("filterAircraft", () => {
  it("filters by id and status", () => {
    expect(filterAircraft(rows, "ac-0", "all").map((r) => r.aircraft_id)).toEqual(["AC-005", "AC-019", "AC-003"]);
    expect(filterAircraft(rows, "", "aog").map((r) => r.aircraft_id)).toEqual(["AC-120"]);
    expect(filterAircraft(rows, "zzz", "all")).toEqual([]);
  });
});

describe("statusSeverity", () => {
  it("ranks aog above restricted above serviceable", () => {
    expect(statusSeverity("aog")).toBeGreaterThan(statusSeverity("restricted"));
    expect(statusSeverity("restricted")).toBeGreaterThan(statusSeverity("serviceable"));
    expect(statusSeverity("mystery")).toBe(0);
  });
});
