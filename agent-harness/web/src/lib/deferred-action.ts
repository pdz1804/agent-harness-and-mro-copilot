/** Undo for mutations the API cannot reverse (e.g. acknowledging an incident:
 * there is no acknowledged -> open transition). The UI updates optimistically
 * and the request is held for the toast's Undo window; Undo cancels it before
 * it is ever sent. The queue is module-level, so a pending commit survives
 * in-app navigation, and `flushDeferred` (wired to `pagehide`) sends anything
 * still waiting when the tab closes or reloads, so nothing is silently lost. */

interface Pending {
  timer: ReturnType<typeof setTimeout>
  run: () => Promise<unknown>
  onError?: (err: unknown) => void
}

const pending = new Map<string, Pending>()

function fire(key: string): void {
  const entry = pending.get(key)
  if (!entry) return
  pending.delete(key)
  clearTimeout(entry.timer)
  entry.run().catch((err: unknown) => entry.onError?.(err))
}

/** Schedule `run` after `delayMs` under `key` (one pending action per key: a
 * newer one for the same key replaces the older, which is sent first).
 * Returns `cancel`, which reports whether it stopped the action in time. */
export function deferAction(key: string, run: () => Promise<unknown>, delayMs: number, onError?: (err: unknown) => void): () => boolean {
  if (pending.has(key)) fire(key)
  const timer = setTimeout(() => fire(key), delayMs)
  pending.set(key, { timer, run, onError })
  return () => {
    const entry = pending.get(key)
    if (!entry || entry.timer !== timer) return false
    clearTimeout(entry.timer)
    pending.delete(key)
    return true
  }
}

/** Send every held action now (tab closing, identity switch). */
export function flushDeferred(): void {
  // Deleting the entry being visited is safe during Map iteration.
  for (const key of pending.keys()) fire(key)
}

export function hasPendingAction(key: string): boolean {
  return pending.has(key)
}

/** The toast's Undo window; the deferred commit waits exactly this long. */
export const UNDO_WINDOW_MS = 6000
