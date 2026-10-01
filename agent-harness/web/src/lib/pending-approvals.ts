import type { PendingApprovalItem } from './api-types'

/** Where the header badge should send the reader: straight to the run when
 * exactly one is waiting, otherwise nowhere (the badge opens a list). */
export function singleTarget(items: PendingApprovalItem[]): string | null {
  return items.length === 1 ? `/runs/${items[0].run_id}` : null
}

export function badgeLabel(count: number): string {
  if (count === 0) return 'No approvals waiting'
  return count === 1 ? '1 approval waiting' : `${count} approvals waiting`
}

/** "2m", "1h 5m" style wait time for an item that has been paused since `startedAt`. */
export function waitingFor(startedAtSeconds: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - startedAtSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** Browser tab title with the pending count in front, so a waiting approval is
 * visible from another tab. */
export function tabTitle(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base
}

/** Stable comparison so the poller only re-renders when the waiting set changes. */
export function sameItems(a: PendingApprovalItem[], b: PendingApprovalItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item.run_id === b[i].run_id && item.tool_name === b[i].tool_name)
}
