import { TERMINAL_STATUSES, type RunStatus } from './api-types'

/** Whether a turn's "Agent activity" log is expanded.
 *
 * The answer is the product, the activity is the receipt: while a run is in
 * flight (running, or paused on an approval) the log is open so the reader can
 * follow along; once the run has finished it collapses so the answer stands
 * alone. A reader's own toggle always wins and is never overridden. */
export function isActivityOpen(userChoice: boolean | null, status: RunStatus): boolean {
  if (userChoice !== null) return userChoice
  return !TERMINAL_STATUSES.has(status)
}
