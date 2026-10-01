import { describe, expect, it } from "vitest";
import { buildTranscript, classifyResult } from "./transcript";
import type { CopilotMessage, CopilotPendingItem } from "../types";

const call = (tool_name: string, args: Record<string, unknown> = {}): CopilotMessage => ({ role: "tool_call", tool_name, args });
const result = (tool_name: string, content: string): CopilotMessage => ({ role: "tool_result", tool_name, content });
const pend = (id: string, tool_name: string, kind = "approval"): CopilotPendingItem => ({
  id,
  kind,
  tool_name,
  args: {},
  question: null,
  is_stale: false,
});

describe("classifyResult", () => {
  it("reads the server denial marker", () => {
    expect(classifyResult(result("create_work_order", "User denied: not now"))).toBe("denied");
  });
  it("flags error payloads as failed", () => {
    expect(classifyResult(result("fleet_risk", '{"error": "boom"}'))).toBe("failed");
    expect(classifyResult(result("fleet_risk", "Error: unreachable"))).toBe("failed");
  });
  it("treats anything else as success", () => {
    expect(classifyResult(result("fleet_risk", '{"items": []}'))).toBe("succeeded");
  });
});

describe("buildTranscript", () => {
  it("folds a call and its result into one block", () => {
    const items = buildTranscript([{ role: "user", content: "hi" }, call("fleet_risk"), result("fleet_risk", "{}")], [], { running: false });
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "tool", toolName: "fleet_risk", state: "succeeded", approved: false });
  });

  it("puts the pending approval inside the unresolved call's block", () => {
    const items = buildTranscript([call("create_work_order")], [pend("p1", "create_work_order")], { running: false });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", state: "awaiting" });
    expect(items[0].kind === "tool" && items[0].pending?.id).toBe("p1");
  });

  it("marks a gated call that ran as approved, and a denied one as denied", () => {
    const gatedTools = ["create_work_order"];
    const ok = buildTranscript([call("create_work_order"), result("create_work_order", '{"id": 9}')], [], { running: false, gatedTools });
    expect(ok[0]).toMatchObject({ state: "succeeded", approved: true });
    const no = buildTranscript([call("create_work_order"), result("create_work_order", "User denied: x")], [], { running: false, gatedTools });
    expect(no[0]).toMatchObject({ state: "denied", approved: false });
  });

  it("shows an unresolved call as running while the run is live, incomplete otherwise", () => {
    expect(buildTranscript([call("fleet_risk")], [], { running: true })[0]).toMatchObject({ state: "running" });
    expect(buildTranscript([call("fleet_risk")], [], { running: false })[0]).toMatchObject({ state: "incomplete" });
  });

  it("pairs repeated calls of the same tool in order", () => {
    const items = buildTranscript(
      [call("score_component", { id: "a" }), call("score_component", { id: "b" }), result("score_component", "1"), result("score_component", "2")],
      [],
      { running: false },
    );
    expect(items.map((t) => (t.kind === "tool" ? t.result?.content : null))).toEqual(["1", "2"]);
  });

  it("never drops a pending item that has no matching call", () => {
    const items = buildTranscript([], [pend("q1", "ask_user", "ask_user")], { running: false });
    expect(items).toEqual([expect.objectContaining({ kind: "tool", state: "awaiting", key: "pending-q1" })]);
  });
});

// Real `GET /copilot/runs/{id}` shapes (run-1ea6c600, 2026-10-01): parallel
// calls are recorded before their results, `args` is a JSON *string*, and a
// tool_result's `content` is an *object*, not a string.
describe("buildTranscript on real server message shapes", () => {
  const real = (o: Record<string, unknown>) => o as unknown as CopilotMessage;
  const before = [
    real({ role: "user", content: "AC-249-AVIONICS_FAN looks high risk. Check the manuals and raise a work order." }),
    real({ role: "tool_call", tool_name: "score_component", args: '{"component_id": "AC-249-AVIONICS_FAN"}' }),
    real({ role: "tool_call", tool_name: "search_manuals", args: '{"query": "AVIONICS_FAN"}' }),
    real({ role: "tool_result", tool_name: "score_component", content: { found: true, risk_score: 0.9953, alert: true } }),
    real({ role: "tool_result", tool_name: "search_manuals", content: { hits: [{ doc_id: "AMM-21-26-00-AVIONICS-FAN" }] } }),
    real({ role: "tool_call", tool_name: "create_work_order", args: '{"aircraft_id":"AC-249","component_id":"AC-249-AVIONICS_FAN","priority":"urgent"}' }),
  ];
  const gatedTools = ["create_work_order", "recommend_aircraft_status", "acknowledge_alert"];

  it("awaiting approval: the deferred call carries its pending item", () => {
    const items = buildTranscript(before, [pend("p1", "create_work_order")], { running: false, gatedTools });
    const wo = items.find((t) => t.kind === "tool" && t.toolName === "create_work_order");
    expect(wo).toMatchObject({ state: "awaiting", pending: { id: "p1" } });
  });

  it("mid-resume (pending resolved, no result yet, run shown as running): running, never 'No result'", () => {
    const items = buildTranscript(before, [], { running: true, gatedTools });
    const wo = items.find((t) => t.kind === "tool" && t.toolName === "create_work_order");
    expect(wo).toMatchObject({ state: "running", result: null });
  });

  it("after the resumed turn persists: paired with its post-approval result as approved + succeeded", () => {
    const after = [
      ...before,
      real({ role: "tool_result", tool_name: "create_work_order", content: { id: "WO-2026-0005", status: "open", alert_id: null } }),
      real({ role: "assistant", content: "I have confirmed that the AVIONICS_FAN on AC-249 ..." }),
    ];
    const items = buildTranscript(after, [], { running: false, gatedTools });
    const tools = items.filter((t) => t.kind === "tool");
    expect(tools.map((t) => (t.kind === "tool" ? [t.toolName, t.state] : null))).toEqual([
      ["score_component", "succeeded"],
      ["search_manuals", "succeeded"],
      ["create_work_order", "succeeded"],
    ]);
    const wo = tools[2];
    expect(wo).toMatchObject({ approved: true, result: { content: { id: "WO-2026-0005" } } });
    expect(items[items.length - 1]).toMatchObject({ kind: "message", message: { role: "assistant" } });
  });

  it("a denied deferred call reads as denied, not approved", () => {
    const after = [...before, real({ role: "tool_result", tool_name: "create_work_order", content: "User denied: not now" })];
    const wo = buildTranscript(after, [], { running: false, gatedTools }).find((t) => t.kind === "tool" && t.toolName === "create_work_order");
    expect(wo).toMatchObject({ state: "denied", approved: false });
  });
});

describe("buildTranscript pairs by tool_call_id (real run-8ecb7041 shape)", () => {
  it("a call the model retried gets no result; the denial lands on the call that was actually gated", () => {
    const items = buildTranscript(
      [
        { role: "tool_call", tool_name: "recommend_aircraft_status", args: { status: "grounded" }, tool_call_id: "call_a" },
        { role: "tool_call", tool_name: "recommend_aircraft_status", args: { status: "restricted" }, tool_call_id: "call_b" },
        { role: "tool_result", tool_name: "recommend_aircraft_status", content: "User denied: not needed", tool_call_id: "call_b" },
      ],
      [],
      { running: false, gatedTools: ["recommend_aircraft_status"] },
    ).filter((t) => t.kind === "tool");
    expect(items.map((t) => (t.kind === "tool" ? t.state : ""))).toEqual(["incomplete", "denied"]);
  });
});
