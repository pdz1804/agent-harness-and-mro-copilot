/** Undo queue for mutations. Two honest strategies:
 *  - "deferred": the request is NOT sent until the undo window ends; Undo
 *    cancels it. Used where the API has no reverse transition
 *    (acknowledge, close work order).
 *  - "compensate": the request is sent now; Undo sends the real reverse
 *    call (dismiss -> reopen).
 * The UI shows the optimistic state immediately in both cases. */

export type UndoStrategy = "deferred" | "compensate";

export interface UndoJob {
  id: string;
  strategy: UndoStrategy;
  /** Sends the mutation. */
  commit: () => Promise<unknown>;
  /** Reverse call; required for "compensate". */
  revert?: () => Promise<unknown>;
  /** The mutation is final (window passed and committed). */
  onSettled?: () => void;
  /** The mutation or its revert failed: roll the UI back. */
  onError?: (err: unknown) => void;
  /** A successful undo. */
  onUndone?: () => void;
}

interface Entry {
  job: UndoJob;
  timer: ReturnType<typeof setTimeout> | null;
  committed: Promise<unknown> | null;
}

export interface UndoQueue {
  push: (job: UndoJob) => void;
  undo: (id: string) => Promise<boolean>;
  /** Commit every deferred job now (e.g. on page hide). */
  flush: () => void;
  pending: () => string[];
}

type Timers = { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void };

export function createUndoQueue(windowMs = 5000, timers?: Timers): UndoQueue {
  const t: Timers = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (x) => clearTimeout(x) };
  const entries = new Map<string, Entry>();

  const finish = (id: string) => {
    const e = entries.get(id);
    if (!e) return;
    entries.delete(id);
    e.job.onSettled?.();
  };

  const runCommit = (e: Entry): Promise<unknown> => {
    e.committed = e.job.commit().catch((err) => {
      entries.delete(e.job.id);
      e.job.onError?.(err);
      throw err;
    });
    return e.committed;
  };

  return {
    push(job) {
      if (entries.has(job.id)) return;
      if (job.strategy === "compensate" && !job.revert) throw new Error("compensate jobs need a revert");
      const e: Entry = { job, timer: null, committed: null };
      entries.set(job.id, e);
      if (job.strategy === "compensate") {
        runCommit(e).catch(() => undefined);
        e.timer = t.set(() => finish(job.id), windowMs);
      } else {
        e.timer = t.set(() => {
          e.timer = null;
          runCommit(e)
            .then(() => finish(job.id))
            .catch(() => undefined);
        }, windowMs);
      }
    },
    async undo(id) {
      const e = entries.get(id);
      if (!e) return false;
      if (e.timer) t.clear(e.timer);
      entries.delete(id);
      if (e.job.strategy === "deferred" && !e.committed) {
        e.job.onUndone?.();
        return true;
      }
      try {
        await e.committed;
        await e.job.revert?.();
        e.job.onUndone?.();
        return true;
      } catch (err) {
        e.job.onError?.(err);
        return false;
      }
    },
    flush() {
      for (const e of [...entries.values()]) {
        if (e.job.strategy === "deferred" && !e.committed) {
          if (e.timer) t.clear(e.timer);
          runCommit(e)
            .then(() => finish(e.job.id))
            .catch(() => undefined);
        }
      }
    },
    pending: () => [...entries.keys()],
  };
}
