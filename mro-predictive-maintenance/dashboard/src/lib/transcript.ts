import type { CopilotMessage, CopilotPendingItem } from "../types";

/** Lifecycle of one tool call, rendered as a single inline block:
 * running -> awaiting (approval or answer) -> approved/denied -> succeeded/failed. */
export type ToolState = "running" | "awaiting" | "succeeded" | "failed" | "denied" | "incomplete";

export type TranscriptItem =
  | { kind: "message"; index: number; message: CopilotMessage }
  | {
      kind: "tool";
      key: string;
      toolName: string;
      call: CopilotMessage | null;
      result: CopilotMessage | null;
      pending: CopilotPendingItem | null;
      /** True when the tool is approval-gated and a human let it run. */
      approved: boolean;
      state: ToolState;
    };

function resultText(result: CopilotMessage): string {
  const c = result.content as unknown;
  if (typeof c === "string") return c;
  try {
    return JSON.stringify(c ?? "");
  } catch {
    return "";
  }
}

/** Classify a finished tool call from its result content. "User denied: ..."
 * is the server's denial marker (see src/copilot/hitl.py). */
export function classifyResult(result: CopilotMessage): "succeeded" | "failed" | "denied" {
  const text = resultText(result).trim();
  const lower = text.toLowerCase();
  if (lower.startsWith("user denied")) return "denied";
  if (lower.startsWith("error") || /"error"\s*:/.test(text)) return "failed";
  return "succeeded";
}

/**
 * Fold a run's flat message list into user/assistant messages and one block
 * per tool call. Each tool_call is paired with the next unconsumed
 * tool_result of the same tool; an unresolved call is matched to the
 * actionable pending item for that tool, so the approval lives inside the
 * call's own block. Pending items with no matching call (should not happen,
 * but never hide a decision) are appended as their own blocks.
 */
export function buildTranscript(
  messages: CopilotMessage[],
  pending: CopilotPendingItem[],
  opts: { running: boolean; gatedTools?: readonly string[] } = { running: false },
): TranscriptItem[] {
  const gated = new Set(opts.gatedTools ?? []);
  const usedResults = new Set<number>();
  const usedPending = new Set<string>();
  const out: TranscriptItem[] = [];

  messages.forEach((m, i) => {
    if (m.role === "tool_result") return; // folded into its call below (or orphaned at the end)
    if (m.role !== "tool_call") {
      out.push({ kind: "message", index: i, message: m });
      return;
    }
    const name = m.tool_name ?? "";
    let resultIdx = -1;
    for (let j = i + 1; j < messages.length; j++) {
      const r = messages[j];
      if (usedResults.has(j) || r.role !== "tool_result") continue;
      // Pair by tool_call_id when the server sends it (a call the model retried has no result
      // of its own); fall back to "next result of the same tool" for older snapshots.
      const sameCall = m.tool_call_id && r.tool_call_id ? r.tool_call_id === m.tool_call_id : (r.tool_name ?? "") === name;
      if (sameCall) {
        resultIdx = j;
        break;
      }
    }
    if (resultIdx >= 0) {
      usedResults.add(resultIdx);
      const result = messages[resultIdx];
      const verdict = classifyResult(result);
      out.push({
        kind: "tool",
        key: `call-${i}`,
        toolName: name,
        call: m,
        result,
        pending: null,
        approved: gated.has(name) && verdict !== "denied",
        state: verdict,
      });
      return;
    }
    const match =
      pending.find((p) => !usedPending.has(p.id) && !!m.tool_call_id && p.tool_call_id === m.tool_call_id) ??
      pending.find((p) => !usedPending.has(p.id) && (p.tool_name ?? "") === name && !(m.tool_call_id && p.tool_call_id));
    if (match) usedPending.add(match.id);
    out.push({
      kind: "tool",
      key: `call-${i}`,
      toolName: name,
      call: m,
      result: null,
      pending: match ?? null,
      approved: false,
      state: match ? "awaiting" : opts.running ? "running" : "incomplete",
    });
  });

  // A result whose call was never recorded still deserves a row.
  messages.forEach((m, i) => {
    if (m.role === "tool_result" && !usedResults.has(i)) {
      out.push({
        kind: "tool",
        key: `result-${i}`,
        toolName: m.tool_name ?? "",
        call: null,
        result: m,
        pending: null,
        approved: false,
        state: classifyResult(m),
      });
    }
  });

  for (const p of pending) {
    if (usedPending.has(p.id)) continue;
    out.push({
      kind: "tool",
      key: `pending-${p.id}`,
      toolName: p.tool_name ?? (p.kind === "ask_user" ? "ask_user" : "pending action"),
      call: null,
      result: null,
      pending: p,
      approved: false,
      state: "awaiting",
    });
  }
  return out;
}
