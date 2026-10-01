import { describe, expect, it } from "vitest";
import { describeFields, describeResult, finalizeResolutions, humanizeKey, resolutionFor } from "./tool-view";
import type { CopilotResolvedItem } from "../types";

describe("humanizeKey", () => {
  it("maps known and generic keys", () => {
    expect(humanizeKey("task_ref")).toBe("Task ref");
    expect(humanizeKey("aircraft_id")).toBe("Aircraft");
    expect(humanizeKey("some_new_key")).toBe("Some new key");
  });
});

describe("describeFields", () => {
  it("renders create_work_order args (a JSON string) as chip / prose / mono rows", () => {
    const rows = describeFields(
      JSON.stringify({ aircraft_id: "AC-003", task_ref: "AMM-21-10", priority: "urgent", justification: "Risk above threshold for 3 cycles." }),
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.priority).toMatchObject({ label: "Priority", kind: "chip", value: "urgent" });
    expect(by.justification.kind).toBe("prose");
    expect(by.task_ref).toMatchObject({ label: "Task ref", kind: "mono" });
  });
});

describe("describeResult", () => {
  it("score result -> risk vs threshold", () => {
    const v = describeResult("score_component", { found: true, component_id: "C1", risk_score: 0.81, threshold: 0.4, alert: true, top_factors: [{ feature: "hours", shap_value: 0.2 }] });
    expect(v).toMatchObject({ kind: "score", risk: 0.81, threshold: 0.4, alert: true });
  });
  it("manuals result -> doc hits", () => {
    const v = describeResult("search_manuals", JSON.stringify({ hits: [{ doc_id: "AMM-21", title: "Fan", doc_type: "amm", snippet: "x" }] }));
    expect(v.kind).toBe("manuals");
    if (v.kind === "manuals") expect(v.hits[0].docId).toBe("AMM-21");
  });
  it("work order result", () => {
    const v = describeResult("create_work_order", { id: "WO-2026-0008", status: "open" });
    expect(v).toMatchObject({ kind: "work_order", id: "WO-2026-0008" });
  });
  it("plain string stays text", () => {
    expect(describeResult("create_work_order", "User denied: Not now")).toEqual({ kind: "text", text: "User denied: Not now" });
  });
});

describe("finalizeResolutions (note read at submit time)", () => {
  it("includes a note typed AFTER the Deny click", () => {
    // Draft captured when Deny was clicked: no note yet.
    const drafts = { p1: { pending_id: "p1", decision: "deny" as const, answer_text: null } };
    // Note typed afterwards.
    const out = finalizeResolutions(["p1"], drafts, { p1: "defer to next A-check" });
    expect(out[0]).toMatchObject({ decision: "deny", answer_text: "defer to next A-check" });
  });
  it("keeps the draft when no note", () => {
    const drafts = { p1: { pending_id: "p1", decision: "approve" as const, override_args: { priority: "aog" }, answer_text: null } };
    expect(finalizeResolutions(["p1"], drafts, { p1: "  " })[0]).toEqual(drafts.p1);
  });
});

describe("resolutionFor", () => {
  const resolved: CopilotResolvedItem[] = [
    { id: "a", tool_call_id: "call_1", kind: "approval", tool_name: "acknowledge_alert", decision: "approve", note: null, option_id: null, resolved_by: "lead.engineer", resolved_at: "2026-10-01T10:00:00Z" },
    { id: "b", tool_call_id: "call_2", kind: "approval", tool_name: "acknowledge_alert", decision: "deny", note: "no", option_id: null, resolved_by: "x", resolved_at: "2026-10-01T10:05:00Z" },
  ];
  it("matches exactly by tool_call_id", () => {
    expect(resolutionFor({ role: "tool_call", tool_name: "acknowledge_alert", tool_call_id: "call_1" }, "acknowledge_alert", resolved)?.id).toBe("a");
  });
  it("an id with no match is not attributed (it was never gated)", () => {
    expect(resolutionFor({ role: "tool_call", tool_name: "acknowledge_alert", tool_call_id: "call_9" }, "acknowledge_alert", resolved)).toBeNull();
  });
  it("falls back to latest-by-tool when ids are absent", () => {
    expect(resolutionFor({ role: "tool_call", tool_name: "acknowledge_alert" }, "acknowledge_alert", resolved)?.id).toBe("b");
  });
});
