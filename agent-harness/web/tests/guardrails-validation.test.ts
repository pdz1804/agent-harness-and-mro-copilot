import { describe, expect, it } from 'vitest'
import type { Guardrail, GuardrailTrigger } from '../src/lib/api-types'
import { filterGuardrails, filterTriggers, guardrailPatterns, parsePatterns, triggersForRule, validateGuardrailName, validatePatterns } from '../src/lib/guardrails-validation'

const rule = (over: Partial<Guardrail>): Guardrail => ({
  id: 'g1',
  name: 'No wipes',
  kind: 'objective_pattern_block',
  config: { patterns: ['wipe the database', 'drop table'] },
  enabled: true,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
})

describe('pattern parsing', () => {
  it('trims, drops blanks and collapses case-insensitive duplicates', () => {
    expect(parsePatterns('  Drop table \n\ndrop TABLE\nwipe it')).toEqual(['Drop table', 'wipe it'])
  })
  it('validates required fields', () => {
    expect(validateGuardrailName('  ')).not.toBeNull()
    expect(validateGuardrailName('x')).toBeNull()
    expect(validatePatterns('\n  \n')).not.toBeNull()
    expect(validatePatterns('a')).toBeNull()
  })
})

describe('guardrail lists', () => {
  const items = [rule({}), rule({ id: 'g2', name: 'Severity cap', kind: 'severity_upgrade_block', config: {}, enabled: false })]
  it('reads patterns defensively', () => {
    expect(guardrailPatterns(items[0])).toHaveLength(2)
    expect(guardrailPatterns(items[1])).toEqual([])
    expect(guardrailPatterns({ config: { patterns: [1, 'ok'] } })).toEqual(['ok'])
  })
  it('filters by search and state', () => {
    expect(filterGuardrails(items, 'DROP', 'all').map((g) => g.id)).toEqual(['g1'])
    expect(filterGuardrails(items, '', 'disabled').map((g) => g.id)).toEqual(['g2'])
    expect(filterGuardrails(items, 'severity_upgrade', 'enabled')).toHaveLength(0)
  })
})

describe('triggers', () => {
  const trig = (over: Partial<GuardrailTrigger>): GuardrailTrigger => ({
    run_id: 'run-1',
    step: 1,
    event_type: 'guardrail_blocked',
    timestamp: 1,
    data: { guardrail_name: 'No wipes', matched_pattern: 'drop table' },
    objective: 'please DROP TABLE users',
    ...over,
  })
  it('matches by rule name and search', () => {
    const list = [trig({}), trig({ run_id: 'run-2', data: { guardrail_name: 'Other' }, objective: null })]
    expect(triggersForRule(list, { name: 'No wipes' })).toHaveLength(1)
    expect(filterTriggers(list, 'users').map((t) => t.run_id)).toEqual(['run-1'])
    expect(filterTriggers(list, '')).toHaveLength(2)
  })
})
