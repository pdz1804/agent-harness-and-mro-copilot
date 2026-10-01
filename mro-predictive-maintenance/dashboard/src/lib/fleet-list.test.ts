import { describe, expect, it } from "vitest";
import { clampPage, fleetCsv, pageCount, pageRangeLabel, toServerSort, triagePrompt } from "./fleet-list";
import type { FleetListItem } from "../types";

const item = (over: Partial<FleetListItem> = {}): FleetListItem => ({
  rank: 1,
  component_id: "AC-113-HYD_PUMP",
  aircraft_id: "AC-113",
  aircraft_type: "A321",
  component_type: "HYD_PUMP",
  cycle: 1537.5,
  snapshot_date: "2026-08-31 00:00:00",
  risk_score: 0.9953069,
  alert: true,
  band: "alert",
  true_label: 1,
  ...over,
});

describe("toServerSort", () => {
  it("maps rank ascending to risk descending (the default ranking)", () => {
    expect(toServerSort({ key: "rank", dir: "asc" })).toEqual({ sort: "risk", dir: "desc" });
    expect(toServerSort({ key: "rank", dir: "desc" })).toEqual({ sort: "risk", dir: "asc" });
  });
  it("maps table columns to server keys and falls back to risk", () => {
    expect(toServerSort({ key: "component", dir: "asc" })).toEqual({ sort: "component_id", dir: "asc" });
    expect(toServerSort({ key: "cycle", dir: "desc" })).toEqual({ sort: "cycle", dir: "desc" });
    expect(toServerSort({ key: "nope", dir: "asc" })).toEqual({ sort: "risk", dir: "desc" });
    expect(toServerSort(null)).toEqual({ sort: "risk", dir: "desc" });
  });
});

describe("paging", () => {
  it("counts pages and labels the range", () => {
    expect(pageCount(312)).toBe(16);
    expect(pageCount(0)).toBe(1);
    expect(pageRangeLabel(1, 312)).toBe("1–20 of 312");
    expect(pageRangeLabel(16, 312)).toBe("301–312 of 312");
    expect(pageRangeLabel(1, 0)).toBe("0 of 0");
  });
  it("clamps bad page params", () => {
    expect(clampPage(undefined, 16)).toBe(1);
    expect(clampPage("abc", 16)).toBe(1);
    expect(clampPage("-3", 16)).toBe(1);
    expect(clampPage("40", 16)).toBe(16);
    expect(clampPage("3", 16)).toBe(3);
  });
});

describe("fleetCsv and triagePrompt", () => {
  it("writes one header and one row per item", () => {
    const csv = fleetCsv([item(), item({ rank: 2, component_id: "AC-067-APU_STARTER", aircraft_type: null, band: "watch", alert: false })]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("rank,component_id,aircraft_id,aircraft_type,component_type,cycle,risk_score,band,alert");
    expect(lines[1]).toBe("1,AC-113-HYD_PUMP,AC-113,A321,HYD_PUMP,1537.5,0.995307,alert,true");
    expect(lines[2]).toContain("AC-067-APU_STARTER,AC-113,,HYD_PUMP");
  });
  it("puts every selected id into the copilot prompt", () => {
    const p = triagePrompt([item(), item({ component_id: "AC-005-BLEED_VALVE" })]);
    expect(p).toMatch(/^Triage these 2 components/);
    expect(p).toContain("AC-113-HYD_PUMP");
    expect(p).toContain("AC-005-BLEED_VALVE");
  });
});
