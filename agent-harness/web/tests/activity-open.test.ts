import { describe, expect, it } from 'vitest'
import { TERMINAL_STATUSES, type RunStatus } from '../src/lib/api-types'
import { isActivityOpen } from '../src/lib/activity-open'

describe('isActivityOpen', () => {
  it('is open while the run is in flight', () => {
    expect(isActivityOpen(null, 'running')).toBe(true)
    expect(isActivityOpen(null, 'pending_approval')).toBe(true)
  })

  it('collapses every finished run by default so the answer is prominent', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isActivityOpen(null, status), status).toBe(false)
    }
  })

  it('collapses automatically when a running turn completes', () => {
    const states: RunStatus[] = ['running', 'pending_approval', 'running', 'completed']
    expect(states.map((s) => isActivityOpen(null, s))).toEqual([true, true, true, false])
  })

  it("never overrides the reader's own choice", () => {
    expect(isActivityOpen(false, 'running')).toBe(false)
    expect(isActivityOpen(true, 'completed')).toBe(true)
    expect(isActivityOpen(true, 'failed')).toBe(true)
  })
})
