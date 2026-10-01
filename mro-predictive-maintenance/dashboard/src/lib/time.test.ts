import { describe, expect, it } from "vitest";
import { absoluteTime, relativeTime } from "./time";

const now = Date.parse("2026-10-01T12:00:00Z");

describe("time", () => {
  it("formats relative times", () => {
    expect(relativeTime("2026-10-01T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-10-01T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-10-01T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-28T12:00:00Z", now)).toBe("3d ago");
    expect(relativeTime("2026-10-01T15:00:00Z", now)).toBe("in 3h");
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("garbage", now)).toBe("");
  });
  it("formats absolute times", () => {
    expect(absoluteTime("2026-10-01T12:00:00Z")).toMatch(/2026/);
    expect(absoluteTime(undefined)).toBe("");
  });
});
