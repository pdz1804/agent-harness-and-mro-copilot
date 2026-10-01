import { describe, expect, it } from "vitest";
import { decodeScenario, displayNumber, encodeScenario, featureRange } from "./whatif";

describe("featureRange", () => {
  it("covers observed values with padding", () => {
    const r = featureRange([2, 4, 6, 8, 10])!;
    expect(r.min).toBeLessThanOrEqual(2);
    expect(r.max).toBeGreaterThanOrEqual(10);
    expect(r.step).toBe(1);
  });
  it("uses decimal steps for real-valued features", () => {
    const r = featureRange([0.12, 0.9, 1.7])!;
    expect(r.step).toBeLessThan(0.1);
    expect(r.min).toBe(0);
  });
  it("includes the current value and ignores missing", () => {
    const r = featureRange([1, null, undefined, 2], 50)!;
    expect(r.max).toBeGreaterThanOrEqual(50);
  });
  it("handles a constant feature and no data", () => {
    const r = featureRange([5, 5])!;
    expect(r.min).toBeLessThan(5);
    expect(r.max).toBeGreaterThan(5);
    expect(featureRange([null])).toBeNull();
  });
});

describe("displayNumber", () => {
  it("trims long snapshot floats to 4 decimals", () => {
    expect(displayNumber(4.1203663902815375)).toBe(4.1204);
    expect(displayNumber(-16.74553626157683)).toBe(-16.7455);
  });
  it("passes integers and missing values through", () => {
    expect(displayNumber(4)).toBe(4);
    expect(displayNumber(null)).toBe("");
    expect(displayNumber(undefined)).toBe("");
  });
});

describe("scenario links", () => {
  const numeric = ["vibration_mm_s", "fault_count_last_500cyc"];
  const categorical = ["region"];
  it("round-trips changed fields, including missing values and odd characters", () => {
    const enc = encodeScenario({ vibration_mm_s: 6.5, region: "EU, north", fault_count_last_500cyc: null });
    expect(enc).toBe("fault_count_last_500cyc:null,region:EU%2C%20north,vibration_mm_s:6.5");
    expect(decodeScenario(enc, numeric, categorical)).toEqual({ vibration_mm_s: 6.5, region: "EU, north", fault_count_last_500cyc: null });
  });
  it("drops unknown fields and unparseable numbers", () => {
    expect(decodeScenario("evil:1,vibration_mm_s:abc,fault_count_last_500cyc:4,:x,bad", numeric, categorical)).toEqual({ fault_count_last_500cyc: 4 });
    expect(decodeScenario(undefined, numeric, categorical)).toEqual({});
    expect(decodeScenario("vibration_mm_s:%E0%A4%A", numeric, categorical)).toEqual({});
  });
});
