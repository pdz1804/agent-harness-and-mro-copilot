import { describe, expect, it } from "vitest";
import { filterRuns, runTime, runTitle } from "./RunList";

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

describe("filterRuns", () => {
  const runs = [
    { id: "8ecb7041-aaaa", status: "awaiting_input", trigger: "user", user_prompt: "Raise a work order for alert #8" },
    { id: "1234abcd-bbbb", status: "completed", trigger: "automation:1", user_prompt: "Triage AC-019 cabin pressure" },
  ];
  it("matches every word against prompt, id, status and trigger", () => {
    expect(filterRuns(runs, "").map((r) => r.id)).toEqual(["8ecb7041-aaaa", "1234abcd-bbbb"]);
    expect(filterRuns(runs, "work order").map((r) => r.id)).toEqual(["8ecb7041-aaaa"]);
    expect(filterRuns(runs, "8ecb").map((r) => r.id)).toEqual(["8ecb7041-aaaa"]);
    expect(filterRuns(runs, "automation completed").map((r) => r.id)).toEqual(["1234abcd-bbbb"]);
    expect(filterRuns(runs, "AC-019 work")).toEqual([]);
  });
});
