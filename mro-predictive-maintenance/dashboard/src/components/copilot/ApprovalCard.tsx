import { useEffect, useState } from "react";
import type { CopilotPendingItem } from "../../types";
import type { CopilotResolution } from "../../lib/api";
import { IDENTITY_CHANGE_EVENT, canApprove, getCurrentUser } from "../../lib/identity";
import { Button, Chip } from "../ui/primitives";
import { Notice } from "../ui/states";
import { humanizeKey } from "../../lib/tool-view";

const RISKY_TOOLS = new Set(["recommend_aircraft_status"]);
export const TOOL_LABELS: Record<string, string> = {
  create_work_order: "Raise work order",
  recommend_aircraft_status: "Change aircraft status",
  acknowledge_alert: "Acknowledge alert",
};

/** Per-tool editable field map -- the ONLY keys a human may ever override
 * for a given tool (must match `ALLOWED_OVERRIDE_KEYS` in
 * `src/copilot/hitl.py`; the server independently rejects anything else
 * with a 422, this is just so the UI never even offers it). Every other
 * key in `args` renders as a plain read-only value. */
type FieldSpec = { key: string; label: string } & (
  | { kind: "select"; options: string[] }
  | { kind: "text" }
);

const TOOL_FIELDS: Record<string, FieldSpec[]> = {
  create_work_order: [
    { key: "priority", label: "Priority", kind: "select", options: ["routine", "urgent", "aog"] },
    { key: "task_ref", label: "Task ref", kind: "text" },
  ],
  recommend_aircraft_status: [
    { key: "status", label: "Status", kind: "select", options: ["serviceable", "restricted", "aog"] },
    { key: "mel_item", label: "MEL item", kind: "text" },
  ],
  acknowledge_alert: [{ key: "note", label: "Note", kind: "text" }],
};

function asEditableString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

interface ApprovalCardProps {
  item: CopilotPendingItem;
  onDraftChange: (pendingId: string, resolution: CopilotResolution | null) => void;
  /** Live note text; the page reads it at Submit time so a note typed after Approve/Deny is kept. */
  onNoteChange?: (pendingId: string, note: string) => void;
}

/** Approval form, rendered inside the awaiting tool-call block (the block
 * header carries the tool name and the "needs approval" state): a typed
 * editable field per tool
 * (see `TOOL_FIELDS`) with every other arg shown read-only, justification
 * note, and Approve / Deny. Only fields the human actually changed from the
 * server-provided value are sent as `override_args` -- a plain Approve with
 * no edits sends `override_args: null`. Risky actions require typed
 * confirmation of the tail id before Approve is enabled. */
export function ApprovalCard({ item, onDraftChange, onNoteChange }: ApprovalCardProps) {
  const args = item.args ?? {};
  const fields = TOOL_FIELDS[item.tool_name ?? ""] ?? [];
  const editableKeys = new Set(fields.map((f) => f.key));
  const [edits, setEdits] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, asEditableString(args[f.key])])),
  );
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<"approve" | "deny" | null>(null);
  const [confirmText, setConfirmText] = useState("");
  // Re-render when the acting identity changes (e.g. switched to "Viewer")
  // so this card's disabled/tooltip state stays in sync without a remount.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const onIdentityChange = () => forceTick((t) => t + 1);
    window.addEventListener(IDENTITY_CHANGE_EVENT, onIdentityChange);
    return () => window.removeEventListener(IDENTITY_CHANGE_EVENT, onIdentityChange);
  }, []);

  const approvalAllowed = canApprove();
  const risky = item.tool_name != null && RISKY_TOOLS.has(item.tool_name);
  const tailId = (args.aircraft_id as string) ?? "";
  const confirmed = !risky || confirmText.trim() === tailId;

  const setField = (key: string, value: string) => setEdits((prev) => ({ ...prev, [key]: value }));

  const emit = (next: "approve" | "deny") => {
    setDecision(next);
    if (next === "deny") {
      onDraftChange(item.id, { pending_id: item.id, decision: "deny", answer_text: note || null });
      return;
    }
    if (!confirmed) {
      onDraftChange(item.id, null);
      return;
    }
    // Only fields the human actually changed from the server-provided
    // value go into override_args -- a plain Approve with no edits sends
    // no override_args at all (the fix for the bug where every field,
    // including ones that were never edited, used to be echoed back).
    const overrideArgs: Record<string, unknown> = {};
    for (const f of fields) {
      if (edits[f.key] !== asEditableString(args[f.key])) {
        overrideArgs[f.key] = edits[f.key];
      }
    }
    onDraftChange(item.id, {
      pending_id: item.id,
      decision: "approve",
      override_args: Object.keys(overrideArgs).length > 0 ? overrideArgs : null,
      answer_text: note || null,
    });
  };

  return (
    <div className="tcb-form">
      {item.is_stale && <Chip>stale (run has moved on)</Chip>}

      {!approvalAllowed && (
        <Notice tone="plain" role="note">
          Viewing as <strong>{getCurrentUser()}</strong> (read-only). Switch to an engineer identity in the top bar to approve or deny this.
        </Notice>
      )}

      <dl className="kv hitl-args">
        {fields.map((f) => (
          <div key={f.key} style={{ display: "contents" }}>
            <dt>
              <label htmlFor={`f-${item.id}-${f.key}`}>{f.label}</label>
            </dt>
            <dd>
              {f.kind === "select" ? (
                <select id={`f-${item.id}-${f.key}`} className="select select-sm" value={edits[f.key]} onChange={(e) => setField(f.key, e.target.value)}>
                  {f.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : (
                <input id={`f-${item.id}-${f.key}`} className="input input-sm" name={f.key} autoComplete="off" value={edits[f.key]} onChange={(e) => setField(f.key, e.target.value)} />
              )}
            </dd>
          </div>
        ))}
        {Object.entries(args)
          .filter(([k]) => !editableKeys.has(k))
          .map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{humanizeKey(k)}</dt>
              <dd className={k === "justification" || k === "reason" ? "tcb-prose" : "mono"}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
      </dl>

      {risky && (
        <label className="field">
          <span className="field-label">
            Type the tail id (<span className="mono">{tailId}</span>) to confirm this risky action
          </span>
          <input id={`confirm-${item.id}`} className="input" autoComplete="off" spellCheck={false} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        </label>
      )}

      <label className="field">
        <span className="field-label">Note (optional)</span>
        <input id={`note-${item.id}`} className="input" name="note" autoComplete="off" value={note} onChange={(e) => {
            setNote(e.target.value);
            onNoteChange?.(item.id, e.target.value);
          }} />
      </label>

      <div className="form-actions" style={{ marginTop: 0 }}>
        <Button
          variant="primary"
          aria-pressed={decision === "approve"}
          disabled={!approvalAllowed || (risky && !confirmed)}
          title={!approvalAllowed ? "Read-only identity: switch to an engineer to approve" : undefined}
          onClick={() => emit("approve")}
        >
          {decision === "approve" ? "Approve (drafted)" : "Approve"}
        </Button>
        <Button
          variant="danger"
          aria-pressed={decision === "deny"}
          disabled={!approvalAllowed}
          title={!approvalAllowed ? "Read-only identity: switch to an engineer to deny" : undefined}
          onClick={() => emit("deny")}
        >
          {decision === "deny" ? "Deny (drafted)" : "Deny"}
        </Button>
      </div>
    </div>
  );
}
