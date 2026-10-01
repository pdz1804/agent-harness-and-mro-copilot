import { describe, expect, it } from "vitest";
import { effectiveStatus, isSettledAfterResume, isStaleRun, workOrderIdFromResult } from "./run-status";
import type { CopilotPendingItem } from "../types";

const actionable: CopilotPendingItem = { id: "p1", kind: "approval", tool_name: "create_work_order", args: {}, question: null, is_stale: false };
const legacy: CopilotPendingItem = { ...actionable, id: "p0", status: "stale_legacy_cancelled", is_stale: true };

describe("isStaleRun: only the server's legacy marker makes a run stale", () => {
  it("a run mid-resume (awaiting_input in DB, pending already resolved) is NOT stale", () => {
    expect(isStaleRun({ status: "awaiting_input", pending: [] }, false)).toBe(false);
    expect(isStaleRun({ status: "awaiting_input", pending: [] }, true)).toBe(false);
  });
  it("a completed run is never stale", () => {
    expect(isStaleRun({ status: "completed", pending: [legacy] }, false)).toBe(false);
  });
  it("an awaiting run whose only pending rows are legacy-cancelled is stale", () => {
    expect(isStaleRun({ status: "awaiting_input", pending: [legacy] }, false)).toBe(true);
  });
  it("an awaiting run with an actionable item is not stale", () => {
    expect(isStaleRun({ status: "awaiting_input", pending: [legacy, actionable] }, false)).toBe(false);
  });
  it("never stale while this session is resuming it", () => {
    expect(isStaleRun({ status: "awaiting_input", pending: [legacy] }, true)).toBe(false);
  });
});

describe("isSettledAfterResume", () => {
  it("the immediate post-resolve snapshot (still awaiting_input, nothing pending) is in flight", () => {
    expect(isSettledAfterResume({ status: "awaiting_input", pending: [] })).toBe(false);
    expect(isSettledAfterResume({ status: "running", pending: [] })).toBe(false);
  });
  it("completed / failed settle", () => {
    expect(isSettledAfterResume({ status: "completed", pending: [] })).toBe(true);
    expect(isSettledAfterResume({ status: "failed", pending: [] })).toBe(true);
  });
  it("a NEW actionable pending item (follow-on approval/question) settles", () => {
    expect(isSettledAfterResume({ status: "awaiting_input", pending: [actionable] })).toBe(true);
  });
});

describe("effectiveStatus", () => {
  it("reads as running while resuming", () => {
    expect(effectiveStatus("awaiting_input", true)).toBe("running");
    expect(effectiveStatus("completed", false)).toBe("completed");
  });
});

describe("workOrderIdFromResult", () => {
  it("reads the real server shape (object content)", () => {
    expect(
      workOrderIdFromResult({
        role: "tool_result",
        tool_name: "create_work_order",
        content: { id: "WO-2026-0005", status: "open", alert_id: null } as unknown as string,
      }),
    ).toBe("WO-2026-0005");
  });
  it("reads JSON-string content and ignores non work-order ids", () => {
    expect(workOrderIdFromResult({ role: "tool_result", content: '{"id":"WO-2026-0012"}' })).toBe("WO-2026-0012");
    expect(workOrderIdFromResult({ role: "tool_result", content: '{"id":"ALERT-3"}' })).toBeNull();
    expect(workOrderIdFromResult(null)).toBeNull();
  });
});
