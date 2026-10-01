import { describe, expect, it } from 'vitest'
import { canWriteResource, disabledReason } from '../src/hooks/useMe'
import type { Me } from '../src/lib/api-types'

function me(overrides: Partial<Me>): Me {
  return { id: 'u_1', display_name: 'Test', role: 'editor', permissions: [], ...overrides }
}

describe('canWriteResource', () => {
  it('defaults to writable while /me has not resolved yet (no false-disabled flash)', () => {
    expect(canWriteResource(null, { owner_id: 'u_2' })).toBe(true)
  })

  it('admin can write any resource', () => {
    expect(canWriteResource(me({ role: 'admin', id: 'u_1' }), { owner_id: 'u_2' })).toBe(true)
  })

  it('viewer can never write, even their own resource', () => {
    expect(canWriteResource(me({ role: 'viewer', id: 'u_1' }), { owner_id: 'u_1' })).toBe(false)
  })

  it('editor can write only their own resource', () => {
    const editor = me({ role: 'editor', id: 'u_1' })
    expect(canWriteResource(editor, { owner_id: 'u_1' })).toBe(true)
    expect(canWriteResource(editor, { owner_id: 'u_2' })).toBe(false)
  })

  it('defaults to writable when the resource itself is not yet loaded', () => {
    expect(canWriteResource(me({ role: 'editor' }), null)).toBe(true)
  })
})

describe('disabledReason', () => {
  it('names the role and the blocked action', () => {
    expect(disabledReason(me({ role: 'viewer' }), 'mutate_guardrails')).toBe(
      "Your role (viewer) can't edit guardrails.",
    )
  })

  it('falls back to "viewer" when /me has not resolved yet', () => {
    expect(disabledReason(null, 'run_evals')).toBe("Your role (viewer) can't start a scoring run.")
  })
})
