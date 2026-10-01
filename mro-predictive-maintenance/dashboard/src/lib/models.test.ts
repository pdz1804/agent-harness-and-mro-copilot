import { describe, expect, it } from "vitest";
import {
  championVersion,
  compareMetric,
  compareVersions,
  comparisonSummary,
  isFragileThreshold,
  pickChallenger,
  versionNumber,
} from "./models";
import type { ModelVersionMetrics, RegistryVersion } from "../types";

const v = (version: number | string, aliases: string[] = []): RegistryVersion => ({
  version,
  run_id: `run-${version}`,
  status: "READY",
  aliases,
});

// Real shapes from GET /models/{version}/metrics on the live service.
const champion: ModelVersionMetrics = {
  version: "13",
  aliases: ["champion"],
  test_metrics: { test_recall: 0.8214285714285714, test_precision: 1.0, test_alerts_per_100: 0.9145129224652088 },
  threshold: 0.9405,
  trained_at: "2026-09-30T09:03:37Z",
  run_id: "a",
};
const challenger: ModelVersionMetrics = {
  version: "14",
  aliases: [],
  test_metrics: {
    test_recall: 0.92,
    test_precision: 0.23711340206185566,
    test_alerts_per_100: 3.733641262509623,
    brier_post: 0.009642766906466376,
  },
  threshold: 0.01,
  trained_at: "2026-09-30T09:04:17Z",
  run_id: "b",
};

describe("registry picks", () => {
  const versions = [v(12), v(14), v(13, ["champion"]), v(1)];
  it("finds the champion and the newest other version", () => {
    expect(championVersion(versions)?.version).toBe(13);
    expect(pickChallenger(versions)?.version).toBe(14);
  });
  it("copes with numeric and string versions", () => {
    expect(versionNumber("13")).toBe(13);
    expect(versionNumber(13)).toBe(13);
    expect(versionNumber("x")).toBe(-1);
    expect(pickChallenger([v("2"), v(10)])?.version).toBe(10);
  });
  it("returns null when there is nothing to compare", () => {
    expect(pickChallenger([v(13, ["champion"])])).toBeNull();
    expect(championVersion([v(1)])).toBeNull();
  });
});

describe("compareMetric", () => {
  it("respects direction", () => {
    expect(compareMetric(0.8, 0.9, "higher").verdict).toBe("better");
    expect(compareMetric(0.8, 0.7, "higher").verdict).toBe("worse");
    expect(compareMetric(1, 3, "lower").verdict).toBe("worse");
    expect(compareMetric(3, 1, "lower").verdict).toBe("better");
    expect(compareMetric(1, 1, "lower").verdict).toBe("same");
  });
  it("is n/a when either side is missing", () => {
    expect(compareMetric(undefined, 1, "higher")).toEqual({ delta: null, verdict: "n/a" });
    expect(compareMetric(1, null, "higher")).toEqual({ delta: null, verdict: "n/a" });
  });
});

describe("compareVersions", () => {
  const rows = compareVersions(champion, challenger);
  it("covers the union of metric keys with known metrics first", () => {
    expect(rows.map((r) => r.key)).toEqual(["test_recall", "test_precision", "test_alerts_per_100", "brier_post"]);
  });
  it("marks a one-sided metric n/a instead of zero", () => {
    const brier = rows.find((r) => r.key === "brier_post")!;
    expect(brier.champion).toBeNull();
    expect(brier.verdict).toBe("n/a");
  });
  it("reads the real v13 vs v14 trade-off as mixed", () => {
    expect(rows.find((r) => r.key === "test_recall")?.verdict).toBe("better");
    expect(rows.find((r) => r.key === "test_precision")?.verdict).toBe("worse");
    expect(rows.find((r) => r.key === "test_alerts_per_100")?.verdict).toBe("worse");
    expect(comparisonSummary(rows)).toMatch(/^Mixed/);
  });
});

describe("fragile threshold", () => {
  it("flags the realistic profile threshold of 0.01 but not 0.9405", () => {
    expect(isFragileThreshold(0.01)).toBe(true);
    expect(isFragileThreshold(0.9405)).toBe(false);
    expect(isFragileThreshold(null)).toBe(false);
    expect(isFragileThreshold(undefined)).toBe(false);
  });
});
