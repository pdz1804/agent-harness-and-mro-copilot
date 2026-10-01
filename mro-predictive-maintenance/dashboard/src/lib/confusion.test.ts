import { describe, expect, it } from "vitest";
import { confusionFrom, confusionTotals } from "./confusion";

describe("confusionFrom", () => {
  it("reads the stored test_at_threshold counts", () => {
    const c = confusionFrom({ threshold: 0.9405, tp: 23, fp: 0, fn: 5, tn: 2487, recall: 0.82 });
    expect(c).toEqual({ threshold: 0.9405, tp: 23, fp: 0, fn: 5, tn: 2487 });
    const t = confusionTotals(c!);
    expect(t.rows).toBe(2515);
    expect(t.positives).toBe(28);
    expect(t.recall).toBeCloseTo(23 / 28);
    expect(t.precision).toBe(1);
  });
  it("refuses incomplete or invalid records instead of guessing", () => {
    expect(confusionFrom(null)).toBeNull();
    expect(confusionFrom({ threshold: 0.5, tp: 1, fp: 2, fn: 3 })).toBeNull();
    expect(confusionFrom({ threshold: 0.5, tp: 1.5, fp: 2, fn: 3, tn: 4 })).toBeNull();
    expect(confusionFrom({ threshold: 0.5, tp: -1, fp: 2, fn: 3, tn: 4 })).toBeNull();
    expect(confusionFrom({ tp: 1, fp: 2, fn: 3, tn: 4 })).toBeNull();
  });
  it("leaves precision undefined when nothing was predicted", () => {
    const t = confusionTotals({ threshold: 0.99, tp: 0, fp: 0, fn: 4, tn: 10 });
    expect(t.precision).toBeNull();
    expect(t.recall).toBe(0);
  });
});
