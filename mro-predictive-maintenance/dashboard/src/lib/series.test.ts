import { describe, expect, it } from "vitest";
import { countSince, dailyCounts } from "./series";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("dailyCounts", () => {
  it("buckets events oldest first and ignores older or invalid ones", () => {
    const out = dailyCounts([iso(1000), iso(1000), iso(DAY + 1000), iso(20 * DAY), "nope"], 3, NOW);
    expect(out).toEqual([0, 1, 2]);
  });
  it("puts future timestamps in the last bucket", () => {
    expect(dailyCounts([iso(-5 * DAY)], 2, NOW)).toEqual([0, 1]);
  });
});

describe("countSince", () => {
  it("counts only events inside the window", () => {
    expect(countSince([iso(1000), iso(2 * DAY), "bad"], DAY, NOW)).toBe(1);
  });
});
