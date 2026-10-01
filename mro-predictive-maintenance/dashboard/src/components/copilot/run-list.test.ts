import { describe, expect, it } from "vitest";
import { runTime, runTitle } from "./RunList";

describe("runTitle", () => {
  it("uses the first non-empty prompt line", () => {
    expect(runTitle({ user_prompt: "\n  Tell me about AC-113\nsecond", trigger: "user" })).toBe("Tell me about AC-113");
  });
  it("falls back to the trigger", () => {
    expect(runTitle({ user_prompt: null, trigger: "automation:1" })).toBe("(automation:1 run)");
    expect(runTitle({ trigger: "user" })).toBe("(user run)");
  });
});

describe("runTime", () => {
  const now = new Date("2026-10-01T12:00:00");
  it("is clock-only today and carries the date otherwise, never a newline", () => {
    expect(runTime("2026-10-01T03:33:45", now)).not.toMatch(/Oct/);
    expect(runTime("2026-09-30T16:04:00", now)).toMatch(/Sep/);
    expect(runTime("nope", now)).toBe("");
  });
});
