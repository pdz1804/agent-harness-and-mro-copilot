import { describe, expect, it } from "vitest";
import { WO_OUTCOMES, ageLabel, asLiveOutcomes, componentTypeFromId, parseTopFactors, riskBand, riskTone } from "./risk";

describe("risk helpers", () => {
  it("parses persisted SHAP factors and survives garbage", () => {
    expect(parseTopFactors('[{"feature":"a","shap_value":1.5}]')).toEqual([{ feature: "a", shap_value: 1.5 }]);
    expect(parseTopFactors("not json")).toEqual([]);
    expect(parseTopFactors(null)).toEqual([]);
    expect(parseTopFactors('[{"feature":1}]')).toEqual([]);
  });

  it("derives the component type from the id", () => {
    expect(componentTypeFromId("AC-113-HYD_PUMP")).toBe("HYD_PUMP");
  });

  it("buckets risk relative to the threshold", () => {
    expect(riskTone(0.95, 0.94)).toBe("bad");
    expect(riskTone(0.6, 0.94)).toBe("warn");
    expect(riskTone(0.01, 0.94)).toBe("good");
  });

  it("formats coarse ages", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(ageLabel("2026-10-01T11:59:40Z", now)).toBe("just now");
    expect(ageLabel("2026-10-01T11:30:00Z", now)).toBe("30m");
    expect(ageLabel("2026-10-01T07:00:00Z", now)).toBe("5h");
    expect(ageLabel("2026-09-28T12:00:00Z", now)).toBe("3d");
    expect(ageLabel(null, now)).toBe("-");
  });

  it("only offers the close outcomes the API accepts", () => {
    expect(WO_OUTCOMES.map((o) => o.id)).toEqual(["confirmed_failure", "nff", "not_inspected"]);
  });

  it("normalizes live outcomes", () => {
    expect(asLiveOutcomes(null)).toBeNull();
    const o = asLiveOutcomes({ closed_with_outcome: 3, confirmed_failure: 2, nff: 1, live_precision: 0.66 });
    expect(o?.confirmed_failure).toBe(2);
    expect(o?.not_inspected).toBe(0);
    expect(o?.nff_rate).toBeNull();
  });
});

describe("riskBand", () => {
  it("bands by threshold first, then the 50% watch floor", () => {
    expect(riskBand(0.97, true).label).toBe("Alert");
    expect(riskBand(0.5, false)).toEqual({ label: "Watch", tone: "warn" });
    expect(riskBand(0.49, false)).toEqual({ label: "Normal", tone: "good" });
  });
});
