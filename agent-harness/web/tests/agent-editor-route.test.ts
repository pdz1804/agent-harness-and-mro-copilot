import { describe, expect, it } from 'vitest'
import { agentEditorPath, legacyAgentEditTarget } from '../src/lib/agents-form'

describe('agent editor route', () => {
  it('builds the canonical editor path, encoding the id and keeping the tab', () => {
    expect(agentEditorPath('ag_1')).toBe('/agents/ag_1')
    expect(agentEditorPath('new')).toBe('/agents/new')
    expect(agentEditorPath('a b', 'test')).toBe('/agents/a%20b?tab=test')
  })

  it('maps old ?edit= links onto the route and ignores list-only params', () => {
    expect(legacyAgentEditTarget('?edit=ag_1')).toBe('/agents/ag_1')
    expect(legacyAgentEditTarget('?edit=ag_1&tab=usage&q=x')).toBe('/agents/ag_1?tab=usage')
    expect(legacyAgentEditTarget('?edit=new')).toBe('/agents/new')
  })

  it('returns null when there is no edit parameter', () => {
    expect(legacyAgentEditTarget('')).toBeNull()
    expect(legacyAgentEditTarget('?open=ag_1')).toBeNull()
    expect(legacyAgentEditTarget('?edit=')).toBeNull()
  })
})
