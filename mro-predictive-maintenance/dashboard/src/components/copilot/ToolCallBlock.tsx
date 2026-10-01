import { useEffect, useId, useState } from "react";
import { listWorkOrders, type CopilotResolution } from "../../lib/api";
import { workOrderIdFromResult } from "../../lib/run-status";
import type { TranscriptItem } from "../../lib/transcript";
import { describeFields, describeResult, type FieldRow } from "../../lib/tool-view";
import { hrefFor } from "../../lib/routes";
import { humanizeFeatureName } from "../../lib/format";
import type { CopilotResolvedItem } from "../../types";
import { Chip } from "../ui/primitives";
import { CheckIcon, ChevronRightIcon, CloseIcon, LockIcon, OctagonIcon, RingIcon, WrenchIcon } from "../ui/icons";
import { ApprovalCard, TOOL_LABELS } from "./ApprovalCard";
import { OptionCard } from "./OptionCard";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

interface ToolCallBlockProps {
  item: ToolItem;
  /** Drafts only exist for actionable (awaiting) items. */
  onDraftChange: (pendingId: string, resolution: CopilotResolution | null) => void;
  drafted: boolean;
  /** Decision this session just submitted for this call (before the server's record is readable). */
  localDecision?: { action: "approve" | "deny" | "answer"; actor: string; at: string } | null;
  onNoteChange?: (pendingId: string, note: string) => void;
  /** Server's durable record of the human decision for this call (survives reload). */
  resolution?: CopilotResolvedItem | null;
}

export interface ApprovalRecord {
  by: string;
  at: string;
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const v = JSON.parse(args);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return (args as Record<string, unknown>) ?? {};
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Who approved a create_work_order call: the work order row is the server's
 * durable record (`approved_by`, `created_at` = when the approved call ran). */
function useWorkOrderApproval(woId: string | null, aircraftId: unknown): { approval: ApprovalRecord | null; status: string | null } {
  const [rec, setRec] = useState<{ approval: ApprovalRecord | null; status: string | null }>({ approval: null, status: null });
  useEffect(() => {
    if (!woId) return;
    let alive = true;
    listWorkOrders(undefined, typeof aircraftId === "string" ? aircraftId : undefined)
      .then((rows) => {
        const wo = rows.find((r) => r.id === woId);
        if (alive && wo) setRec({ approval: wo.approved_by ? { by: wo.approved_by, at: wo.created_at } : null, status: wo.status });
      })
      .catch(() => {
        /* attribution is a nicety; the block still shows the result */
      });
    return () => {
      alive = false;
    };
  }, [woId, aircraftId]);
  return rec;
}

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value ?? null, null, 2);
}

/** One inline block per tool call. Approval is a state of the block, not a
 * separate card: running -> needs approval / needs answer (amber, expanded
 * in place with the typed fields and Approve/Deny) -> approved / denied ->
 * succeeded / failed. */
export function ToolCallBlock({ item, onDraftChange, drafted, localDecision, onNoteChange, resolution }: ToolCallBlockProps) {
  const awaiting = item.state === "awaiting" && item.pending !== null;
  const isQuestion = awaiting && item.pending?.kind !== "approval";
  const [open, setOpen] = useState(awaiting);
  const bodyId = useId();

  // A block that becomes actionable opens itself; one that resolves stays as the user left it.
  useEffect(() => {
    if (awaiting) setOpen(true);
  }, [awaiting]);

  const args = parseArgs(item.call?.args);
  const woId = item.toolName === "create_work_order" && item.state === "succeeded" ? workOrderIdFromResult(item.result) : null;
  const wo = useWorkOrderApproval(woId, args.aircraft_id);
  const serverApproval: ApprovalRecord | null =
    resolution?.decision === "approve" && resolution.resolved_by ? { by: resolution.resolved_by, at: resolution.resolved_at ?? "" } : null;
  const approval: ApprovalRecord | null =
    serverApproval ?? wo.approval ?? (localDecision?.action === "approve" ? { by: localDecision.actor, at: localDecision.at } : null);
  const approvedPrefix = approval ? `Approved by ${approval.by} · ${clock(approval.at)} → ` : item.approved ? "Approved → " : "";

  const label = isQuestion ? "Copilot needs clarification" : TOOL_LABELS[item.toolName] ?? null;

  let tone: string;
  let icon;
  let status: string;
  // Attribution ("Approved by X · 14:29 → ") rendered as a separate span so it
  // can drop on narrow screens without squeezing out the tool name.
  let prefix = "";
  switch (item.state) {
    case "running":
      tone = "running";
      icon = <span className="tcb-spinner" />;
      prefix =
        localDecision?.action === "approve"
          ? `Approved by ${localDecision.actor} · ${clock(localDecision.at)} → `
          : localDecision?.action === "answer"
            ? "Answered → "
            : localDecision?.action === "deny"
              ? "Denied → "
              : "";
      status = "Running";
      break;
    case "awaiting":
      tone = "awaiting";
      icon = isQuestion ? <RingIcon /> : <LockIcon />;
      status = isQuestion ? (drafted ? "Answer drafted" : "Needs your answer") : drafted ? "Decision drafted" : "Needs approval";
      break;
    case "denied":
      tone = "denied";
      icon = <CloseIcon />;
      prefix = resolution?.resolved_by ? `by ${resolution.resolved_by} · ${clock(resolution.resolved_at ?? "")} → ` : "";
      status = "Denied";
      break;
    case "failed":
      tone = "failed";
      icon = <OctagonIcon />;
      prefix = approvedPrefix;
      status = "Failed";
      break;
    case "succeeded":
      tone = "succeeded";
      icon = <CheckIcon />;
      prefix = approvedPrefix;
      status = item.toolName === "ask_user" ? "Answered" : "Succeeded";
      break;
    default:
      tone = "incomplete";
      icon = <WrenchIcon />;
      status = "No result";
  }

  return (
    <div className={`tcb is-${tone}`}>
      <button type="button" className="tcb-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={bodyId}>
        <span className="tcb-ico" aria-hidden="true">
          {icon}
        </span>
        <span className="tcb-title">
          {label && <span className="tcb-label">{label}</span>}
          <span className="tcb-name" title={item.toolName}>{item.toolName}</span>
        </span>
        <span className="tcb-status">
          {prefix && <span className="tcb-status-prefix">{prefix}</span>}
          <span className="tcb-status-word">{status}</span>
        </span>
        <span className="tcb-chev" aria-hidden="true">
          <ChevronRightIcon />
        </span>
      </button>
      {/* The awaiting form stays mounted while collapsed so a drafted decision is never lost. */}
      <div id={bodyId} className="tcb-body" hidden={!open}>
        {awaiting && item.pending ? (
          item.pending.kind === "approval" ? (
            <ApprovalCard item={item.pending} onDraftChange={onDraftChange} onNoteChange={onNoteChange} />
          ) : (
            <OptionCard item={item.pending} onDraftChange={onDraftChange} />
          )
        ) : (
          <>
            {resolution && resolution.kind === "approval" && (
              <div className="tcb-section">
                <span className="tcb-section-label">Decision</span>
                <p className="tcb-decision">
                  <Chip tone={resolution.decision === "approve" ? "good" : "bad"} plain>
                    {resolution.decision === "approve" ? "Approved" : "Denied"}
                  </Chip>
                  <span className="muted">
                    {" "}
                    by {resolution.resolved_by ?? "unknown"}
                    {resolution.resolved_at ? ` at ${clock(resolution.resolved_at)}` : ""}
                  </span>
                </p>
                {resolution.note && <p className="tcb-prose">{resolution.note}</p>}
              </div>
            )}
            {item.call && (
              <div className="tcb-section">
                <span className="tcb-section-label">Arguments</span>
                <FieldList rows={describeFields(item.call.args ?? {})} empty="No arguments" />
                <RawJson value={item.call.args ?? {}} />
              </div>
            )}
            {woId && (
              <div className="tcb-section">
                <span className="tcb-section-label">Work order</span>
                <p className="tcb-wo">
                  <a href="#/ops/work-orders" className="tcb-wo-link">
                    {woId}
                  </a>
                  {wo.status && <span className="muted"> · {wo.status}</span>}
                  {approval && (
                    <span className="muted">
                      {" "}
                      · approved by {approval.by} at {clock(approval.at)}
                    </span>
                  )}
                </p>
              </div>
            )}
            {item.result && (
              <div className="tcb-section">
                <span className="tcb-section-label">Result</span>
                <ResultBody toolName={item.toolName} content={item.result.content} skipWorkOrder={!!woId} />
                <RawJson value={item.result.content} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FieldList({ rows, empty }: { rows: FieldRow[]; empty?: string }) {
  if (rows.length === 0) return empty ? <p className="muted tcb-empty">{empty}</p> : null;
  return (
    <dl className="kv is-compact tcb-fields">
      {rows.map((r) => (
        <div key={r.key} style={{ display: "contents" }}>
          <dt>{r.label}</dt>
          <dd className={r.kind === "mono" ? "mono" : r.kind === "prose" ? "tcb-prose" : undefined}>
            {r.kind === "chip" ? (
              <Chip tone={r.value === "aog" ? "bad" : r.value === "urgent" ? "warn" : "neutral"} plain icon={r.value === "aog" || r.value === "urgent" ? undefined : null}>
                {r.value}
              </Chip>
            ) : (
              r.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RawJson({ value }: { value: unknown }) {
  return (
    <details className="tcb-raw">
      <summary>View raw JSON</summary>
      <pre className="tool-body">{pretty(value)}</pre>
    </details>
  );
}

function ResultBody({ toolName, content, skipWorkOrder }: { toolName: string; content: unknown; skipWorkOrder: boolean }) {
  const view = describeResult(toolName, content);
  switch (view.kind) {
    case "score": {
      const pct = Math.round(view.risk * 1000) / 10;
      const thr = Math.round(view.threshold * 1000) / 10;
      return (
        <div className="tcb-score">
          <p className="tcb-score-line">
            <strong className="tcb-score-value">{pct}%</strong>
            <span className="muted"> risk vs {thr}% threshold</span>{" "}
            <Chip tone={view.alert ? "bad" : "good"} plain>
              {view.alert ? "above threshold" : "below threshold"}
            </Chip>
          </p>
          <div className="tcb-meter" role="img" aria-label={`Risk ${pct}% against threshold ${thr}%`}>
            <span className={`tcb-meter-fill${view.alert ? " is-alert" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} />
            <span className="tcb-meter-thr" style={{ left: `${Math.min(100, thr)}%` }} />
          </div>
          {view.factors.length > 0 && (
            <ul className="tcb-factors">
              {view.factors.map((f) => (
                <li key={f.feature}>
                  <span title={f.feature}>{humanizeFeatureName(f.feature)}</span>
                  <span className="mono muted">
                    {f.value >= 0 ? "+" : ""}
                    {f.value.toFixed(3)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case "manuals":
      return view.hits.length === 0 ? (
        <p className="muted tcb-empty">No matching documents.</p>
      ) : (
        <ul className="tcb-hits">
          {view.hits.map((h) => (
            <li key={h.docId}>
              <a href={hrefFor(`ops/knowledge-base/${h.docId}`)} className="tcb-doc-link">
                {h.title}
              </a>{" "}
              <span className="mono muted">{h.docId}</span>
              {h.docType && (
                <>
                  {" "}
                  <Chip plain icon={null}>
                    {h.docType}
                  </Chip>
                </>
              )}
              {h.snippet && <p className="tcb-prose tcb-snippet">{h.snippet}</p>}
            </li>
          ))}
        </ul>
      );
    case "work_order":
      return skipWorkOrder ? (
        <FieldList rows={view.rows} />
      ) : (
        <>
          <p className="tcb-wo">
            <a href="#/ops/work-orders" className="tcb-wo-link">
              {view.id}
            </a>
          </p>
          <FieldList rows={view.rows} />
        </>
      );
    case "fields":
      return <FieldList rows={view.rows} empty="Empty result" />;
    default:
      return <p className="tcb-prose">{view.text}</p>;
  }
}
