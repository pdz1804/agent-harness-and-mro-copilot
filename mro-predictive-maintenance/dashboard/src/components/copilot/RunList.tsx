import type { CopilotRunSummary } from "../../types";
import { Chip } from "../ui/primitives";

interface RunListProps {
  runs: CopilotRunSummary[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
  /** Run ids that have at least one genuinely actionable pending item
   * (`GET /copilot/pending`, which never includes legacy-cancelled rows).
   * A run whose DB status is still "awaiting_input" but isn't in this set
   * has nothing left to resolve -- its only pending row was auto-cancelled
   * by the startup cleanup migration -- and is shown as "stale -- cancelled"
   * instead of a misleading "awaiting_input". */
  actionableRunIds: Set<string>;
}

function statusTone(status: string, isStaleRun: boolean): string {
  if (isStaleRun) return "neutral";
  if (status === "awaiting_input") return "bad";
  if (status === "completed") return "good";
  if (status === "failed") return "bad";
  return "neutral";
}

function statusLabel(status: string, isStaleRun: boolean): string {
  if (isStaleRun) return "stale – cancelled";
  return status;
}

/** First non-empty line of the run's prompt; falls back to the trigger. */
export function runTitle(r: Pick<CopilotRunSummary, "user_prompt" | "trigger">): string {
  const line = (r.user_prompt ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  return line ?? `(${r.trigger} run)`;
}

/** Time on one line: clock today, "Sep 30, 16:04" otherwise. */
export function runTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const clock = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? clock : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock}`;
}

/** Left column of the Copilot page: the run list. */
export function RunList({ runs, activeRunId, onSelect, actionableRunIds }: RunListProps) {
  return (
    <div className="runs" role="list" aria-label="Copilot runs">
      {runs.length === 0 && <p className="muted" style={{ padding: 16 }}>No runs yet. Ask something in the composer to start one.</p>}
      {runs.map((r) => {
        const isStaleRun = r.status === "awaiting_input" && !actionableRunIds.has(r.id);
        const tone = statusTone(r.status, isStaleRun);
        return (
          <button
            key={r.id}
            type="button"
            role="listitem"
            className={`run${activeRunId === r.id ? " is-active" : ""}${isStaleRun ? " is-stale" : ""}`}
            aria-current={activeRunId === r.id ? "true" : undefined}
            title={r.user_prompt ?? undefined}
            onClick={() => onSelect(r.id)}
          >
            <span className="run-title">{runTitle(r)}</span>
            <span className="run-top">
              <Chip tone={tone as "good" | "bad" | "neutral"}>{statusLabel(r.status, isStaleRun)}</Chip>
              <span className="run-time">
                {r.trigger} · {runTime(r.created_at)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
