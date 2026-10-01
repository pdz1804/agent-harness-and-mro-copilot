/** Pure decision logic for "stick to the bottom while streaming" (no DOM,
 * no React) so it can be unit-tested; `hooks/useStickToBottom.ts` wires it
 * to a real scroll container.
 *
 * Rules:
 *  - Following is ON only while the user is at (or within a small threshold
 *    of) the bottom.
 *  - Any scroll that moves UP and leaves the bottom turns it OFF — the user
 *    is reading history, so new tokens must not yank them back down.
 *  - Reaching the bottom again (scrolling down, dragging the scrollbar, or
 *    "Jump to latest") turns it back ON.
 *  - Content growing under a user who is following never changes the
 *    decision by itself (growth does not emit a scroll event); the hook just
 *    re-pins to the bottom. Growth under a user who scrolled up is ignored. */

export const BOTTOM_THRESHOLD_PX = 72

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop)
}

export function isNearBottom(m: ScrollMetrics, threshold: number = BOTTOM_THRESHOLD_PX): boolean {
  return distanceFromBottom(m) <= threshold
}

/** Next "following" flag after a scroll event. `previousTop` is the
 * container's scrollTop at the previous scroll event. */
export function nextFollowing(
  following: boolean,
  metrics: ScrollMetrics,
  previousTop: number,
  threshold: number = BOTTOM_THRESHOLD_PX,
): boolean {
  if (isNearBottom(metrics, threshold)) return true
  // Moving up (by more than sub-pixel jitter) away from the bottom = the
  // user is reading history. Moving down while still far from the bottom
  // (e.g. a smooth "jump to latest" in flight) must not flip anything.
  if (metrics.scrollTop < previousTop - 2) return false
  return following
}

/** The "Jump to latest" pill shows only when there is something live to
 * catch up with and the user is not following. */
export function shouldShowJumpPill(following: boolean, active: boolean): boolean {
  return active && !following
}
