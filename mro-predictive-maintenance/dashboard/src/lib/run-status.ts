import type { CopilotMessage, CopilotPendingItem, CopilotRunDetail } from "../types";

/** Pending rows a human can still act on (excludes legacy-cancelled / stale rows). */
export function actionablePending(pending: CopilotPendingItem[]): CopilotPendingItem[] {
  return pending.filter((p) => !p.is_stale && (!p.status || p.status === "pending"));
}

/**
 * Keep the drafted decisions whose pending row is still actionable. A run
 * snapshot refresh (stream end, its backstop re-fetch, polling) must not wipe
 * a decision the human already drafted on a row that is still waiting --
 * otherwise the card says "drafted" while the batch footer counts 0.
 */
export function keepLiveDrafts<T>(drafts: Record<string, T>, pending: CopilotPendingItem[]): Record<string, T> {
  const live = new Set(actionablePending(pending).map((p) => p.id));
  const kept: Record<string, T> = {};
  for (const [id, draft] of Object.entries(drafts)) if (live.has(id)) kept[id] = draft;
  return kept;
}

/** Legacy rows the server's startup cleanup cancelled: the server's explicit stale marker. */
export function legacyCancelledPending(pending: CopilotPendingItem[]): CopilotPendingItem[] {
  return pending.filter((p) => !!p.status && p.status !== "pending");
}

/**
 * Whether a snapshot fetched after a resolve/follow-up reflects the END of the
 * resumed turn. The server keeps `status = "awaiting_input"` in the DB for the
 * whole resumed turn (it only rewrites status when the turn persists), and the
 * resolved pending row is already gone -- so "awaiting_input with nothing
 * actionable" means "still running", never "done".
 */
export function isSettledAfterResume(detail: Pick<CopilotRunDetail, "status" | "pending">): boolean {
  if (detail.status === "completed" || detail.status === "failed" || detail.status === "cancelled") return true;
  if (detail.status === "awaiting_input") return actionablePending(detail.pending).length > 0;
  return false;
}

/**
 * A run is "stale, cancelled" ONLY when the server says so: it carries a
 * legacy-cancelled pending row and nothing actionable. Never inferred from a
 * missing pending item (that is exactly the state of a run mid-resume).
 */
export function isStaleRun(detail: Pick<CopilotRunDetail, "status" | "pending"> | null, resuming: boolean): boolean {
  if (!detail || resuming || detail.status !== "awaiting_input") return false;
  return actionablePending(detail.pending).length === 0 && legacyCancelledPending(detail.pending).length > 0;
}

/** Status to show for a run: a turn in flight after a resolve reads as running. */
export function effectiveStatus(status: string, resuming: boolean): string {
  return resuming ? "running" : status;
}

/** Work order id from a create_work_order result (object or JSON-string content). */
export function workOrderIdFromResult(result: CopilotMessage | null): string | null {
  if (!result) return null;
  let c: unknown = result.content;
  if (typeof c === "string") {
    try {
      c = JSON.parse(c);
    } catch {
      const m = /\bWO-\d{4}-\d+\b/.exec(c as string);
      return m ? m[0] : null;
    }
  }
  if (c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string") {
    const id = (c as { id: string }).id;
    return /^WO-/.test(id) ? id : null;
  }
  return null;
}

/** "awaiting_input" -> "Awaiting input", "completed" -> "Completed". */
export function runStatusLabel(status: string): string {
  const words = status.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : status;
}
