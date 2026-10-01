import { describe, expect, it } from 'vitest'
import type { Me } from '../src/lib/api-types'
import { memoryBlockedReason, memorySortKey, memoryUsage } from '../src/lib/memory-list'

const memory = {
  id: 'm1',
  owner_id: 'u-1',
  owner_name: 'Dana',
  fact: 'On-call rotates Monday',
  tags: [],
  source_run_id: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  last_used_at: null,
  use_count: 2,
}

const me = (role: string, id: string) => ({ id, role, permissions: [] }) as unknown as Me

describe('memory-list', () => {
  it('lets the owner and admins manage a memory, nobody else', () => {
    expect(memoryBlockedReason(me('viewer', 'u-1'), memory)).toBeNull()
    expect(memoryBlockedReason(me('admin', 'u-9'), memory)).toBeNull()
    expect(memoryBlockedReason(null, memory)).toBeNull()
    expect(memoryBlockedReason(me('editor', 'u-9'), memory)).toMatch(/belongs to Dana/)
  })

  it('exposes sort keys and usage copy', () => {
    expect(memorySortKey(memory, 'used')).toBe(2)
    expect(memorySortKey(memory, 'fact')).toBe('On-call rotates Monday')
    expect(memorySortKey(memory, 'nope')).toBeNull()
    expect(memoryUsage({ use_count: 0 })).toBe('Not recalled yet')
    expect(memoryUsage({ use_count: 1 })).toBe('Used 1 time')
    expect(memoryUsage({ use_count: 5 })).toBe('Used 5 times')
  })
})
