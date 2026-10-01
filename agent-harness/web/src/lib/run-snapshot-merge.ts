import type { AgentEvent, RunSnapshot } from './api-types'

export function eventKey(event: AgentEvent): string {
  return `${event.step}:${event.event_type}:${event.timestamp}`
}

/** How often the run view re-reads `GET /runs/{id}` while a run is in flight.
 * A safety net under the live stream: status, `pending_approval` and the
 * final answer converge even if the EventSource is delayed, queued behind the
 * browser's per-host connection limit, or dropped by a proxy. */
export const SNAPSHOT_POLL_MS = 3_000

/** Apply a freshly fetched snapshot without losing live events that arrived
 * over SSE after the fetch was issued. The fetched snapshot is authoritative
 * for everything it covers; events newer than its last event that are only
 * known from the stream are kept on the end. */
export function mergeSnapshot(prev: RunSnapshot | null, next: RunSnapshot): RunSnapshot {
  if (!prev || prev.run_id !== next.run_id) return next
  const known = new Set(next.history.map(eventKey))
  const newest = next.history.reduce((max, e) => Math.max(max, e.timestamp), 0)
  const streamedLater = prev.history.filter((e) => !known.has(eventKey(e)) && e.timestamp > newest)
  if (streamedLater.length === 0) return next
  return { ...next, history: [...next.history, ...streamedLater] }
}
