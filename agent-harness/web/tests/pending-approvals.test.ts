import { describe, expect, it } from 'vitest'
import type { PendingApprovalItem } from '../src/lib/api-types'
import { badgeLabel, sameItems, singleTarget, tabTitle, waitingFor } from '../src/lib/pending-approvals'

const item = (run_id: string, tool_name = 'create_incident'): PendingApprovalItem => ({
  run_id,
  objective: 'open an incident',
  session_id: 's1',
  owner_id: 'u_editor',
  tool_name,
  started_at: 1000,
})

describe('singleTarget', () => {
  it('links straight to the run only when exactly one is waiting', () => {
    expect(singleTarget([])).toBeNull()
    expect(singleTarget([item('r1')])).toBe('/runs/r1')
    expect(singleTarget([item('r1'), item('r2')])).toBeNull()
  })
})

describe('badgeLabel', () => {
  it('pluralises', () => {
    expect(badgeLabel(0)).toBe('No approvals waiting')
    expect(badgeLabel(1)).toBe('1 approval waiting')
    expect(badgeLabel(3)).toBe('3 approvals waiting')
  })
})

describe('waitingFor', () => {
  const now = 10_000_000
  it('formats seconds, minutes and hours', () => {
    expect(waitingFor(now / 1000 - 5, now)).toBe('5s')
    expect(waitingFor(now / 1000 - 125, now)).toBe('2m')
    expect(waitingFor(now / 1000 - 3900, now)).toBe('1h 5m')
  })
  it('never goes negative (clock skew)', () => {
    expect(waitingFor(now / 1000 + 50, now)).toBe('0s')
  })
})

describe('tabTitle', () => {
  it('puts the count in front only when something waits', () => {
    expect(tabTitle('Agent Harness', 0)).toBe('Agent Harness')
    expect(tabTitle('Agent Harness', 2)).toBe('(2) Agent Harness')
  })
})

describe('sameItems', () => {
  it('detects an unchanged waiting set', () => {
    expect(sameItems([item('a'), item('b')], [item('a'), item('b')])).toBe(true)
    expect(sameItems([item('a')], [item('b')])).toBe(false)
    expect(sameItems([item('a')], [item('a'), item('b')])).toBe(false)
    expect(sameItems([item('a', 'create_incident')], [item('a', 'create_dashboard')])).toBe(false)
  })
})
