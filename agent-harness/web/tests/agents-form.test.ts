import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_FORM, filterAgents, isAgentFormDirty, slugify, validateAgentForm } from '../src/lib/agents-form'

describe('validateAgentForm', () => {
  const ok = { ...EMPTY_AGENT_FORM, slug: 'ops-bot', name: 'Ops bot', prompt_id: 'p1' }
  it('accepts a complete form', () => {
    expect(validateAgentForm(ok, true)).toEqual({})
  })
  it('flags bad slug only for new agents', () => {
    expect(validateAgentForm({ ...ok, slug: 'Ops Bot' }, true).slug).toBeTruthy()
    expect(validateAgentForm({ ...ok, slug: 'x' }, true).slug).toBeTruthy()
    expect(validateAgentForm({ ...ok, slug: '' }, false).slug).toBeUndefined()
  })
  it('requires name and prompt', () => {
    const errors = validateAgentForm({ ...ok, name: '  ', prompt_id: '' }, false)
    expect(errors.name).toBeTruthy()
    expect(errors.prompt_id).toBeTruthy()
  })
  it('validates max steps', () => {
    expect(validateAgentForm({ ...ok, max_steps: '8' }, true).max_steps).toBeUndefined()
    expect(validateAgentForm({ ...ok, max_steps: '0' }, true).max_steps).toBeTruthy()
    expect(validateAgentForm({ ...ok, max_steps: '2.5' }, true).max_steps).toBeTruthy()
  })
})

describe('isAgentFormDirty', () => {
  it('ignores tool order but sees membership changes', () => {
    const a = { ...EMPTY_AGENT_FORM, base_tools: ['a', 'b'] }
    expect(isAgentFormDirty({ ...a, base_tools: ['b', 'a'] }, a)).toBe(false)
    expect(isAgentFormDirty({ ...a, base_tools: ['a'] }, a)).toBe(true)
    expect(isAgentFormDirty({ ...a, name: 'x' }, a)).toBe(true)
  })
})

describe('filterAgents', () => {
  const agents = [
    { name: 'Ops Assistant', slug: 'ops-assistant', description: 'Default ops agent' },
    { name: 'KB Concierge', slug: 'kb-concierge', description: 'Answers from the knowledge base' },
  ]
  it('matches name, slug and description', () => {
    expect(filterAgents(agents, 'concierge')).toHaveLength(1)
    expect(filterAgents(agents, 'KNOWLEDGE')).toHaveLength(1)
    expect(filterAgents(agents, '')).toHaveLength(2)
    expect(filterAgents(agents, 'zzz')).toHaveLength(0)
  })
})

describe('slugify', () => {
  it('makes a valid kebab-case slug', () => {
    expect(slugify('Ops Assistant!')).toBe('ops-assistant')
    expect(slugify('  KB  Concierge v2 ')).toBe('kb-concierge-v2')
    expect(slugify('Trợ lý vận hành')).toBe('tro-ly-van-hanh')
    expect(slugify('x'.repeat(60)).length).toBe(41)
    expect(slugify('')).toBe('')
  })
})
