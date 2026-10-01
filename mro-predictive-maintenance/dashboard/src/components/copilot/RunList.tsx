import type { CopilotRunSummary } from "../../types";
import { Chip } from "../ui/primitives";
import { runStatusLabel } from "../../lib/run-status";
import { matchesQuery } from "../../lib/row-diff";

interface RunListProps {
  runs: CopilotRunSummary[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
  /** Runs the SERVER marked stale: an "awaiting_input" run whose only pending
   * rows are legacy-cancelled (`GET /copilot/runs/{id}` legacy view). Never
   * inferred from a missing pending item -- a run mid-resume has none either. */
  staleRunIds: Set<string>;
  /** A search is active (changes the empty message). */
  filtered?: boolean;
}

function statusTone(status: string, isStaleRun: boolean): string {
  if (isStaleRun) return "neutral";
  if (status === "awaiting_input") return "bad";
  if (status === "completed") return "good";
  if (status === "running") return "info";
  if (status === "failed") return "bad";
  return "neutral";
}

function statusLabel(status: string, isStaleRun: boolean): string {
  if (isStaleRun) return "Stale, cancelled";
  return runStatusLabel(status);
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

/** Run search: every word must appear in the prompt, id, status or trigger. */
export function filterRuns<T extends Pick<CopilotRunSummary, "id" | "status" | "trigger" | "user_prompt">>(runs: T[], q: string): T[] {
  return runs.filter((r) => matchesQuery([r.user_prompt, r.id, r.status, runStatusLabel(r.status), r.trigger], q));
}

/** Left column of the Copilot page: the run list. */
export function RunList({ runs, activeRunId, onSelect, staleRunIds, filtered }: RunListProps) {
  return (
    <div className="runs" role="list" aria-label="Copilot runs">
      {runs.length === 0 && (
        <p className="muted" style={{ padding: 16 }}>
          {filtered ? "No run matches the search." : "No runs yet. Ask something in the composer to start one."}
        </p>
      )}
      {runs.map((r) => {
        const isStaleRun = staleRunIds.has(r.id);
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
              <Chip tone={tone as "good" | "bad" | "neutral" | "info"}>{statusLabel(r.status, isStaleRun)}</Chip>
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
