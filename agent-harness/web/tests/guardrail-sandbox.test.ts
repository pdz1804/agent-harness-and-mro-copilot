import { describe, expect, it } from 'vitest'
import type { Guardrail, GuardrailRuleCheck, GuardrailTrigger } from '../src/lib/api-types'
import { buildExamples, checkStatus, describeTrigger, kindLabel, splitHighlight, summarizeVerdict } from '../src/lib/guardrail-sandbox'

const check = (over: Partial<GuardrailRuleCheck>): GuardrailRuleCheck => ({
  guardrail_id: 'g1',
  name: 'r',
  kind: 'objective_pattern_block',
  enabled: true,
  fired: false,
  reason: '',
  matched_pattern: null,
  ...over,
})

describe('splitHighlight', () => {
  it('matches case-insensitively, keeping original casing', () => {
    expect(splitHighlight('Please DELETE all data now', 'delete all data')).toEqual({
      before: 'Please ',
      match: 'DELETE all data',
      after: ' now',
      found: true,
    })
  })
  it('uses the first occurrence only', () => {
    expect(splitHighlight('aXa x', 'x').before).toBe('a')
  })
  it('treats regex characters literally', () => {
    const parts = splitHighlight('run rm -rf (/*) please', '(/*)')
    expect(parts.found).toBe(true)
    expect(parts.match).toBe('(/*)')
  })
  it('reports not found for missing or empty patterns', () => {
    expect(splitHighlight('abc', 'zzz')).toEqual({ before: 'abc', match: '', after: '', found: false })
    expect(splitHighlight('abc', null).found).toBe(false)
    expect(splitHighlight('abc', '').found).toBe(false)
  })
})

describe('summarizeVerdict', () => {
  it('blocked wins', () => {
    expect(summarizeVerdict({ blocked: true, severity_downgraded_to: null, checks: [] })).toEqual({
      tone: 'blocked',
      headline: 'Blocked before the run starts',
    })
  })
  it('mentions the downgrade', () => {
    const v = summarizeVerdict({ blocked: false, severity_downgraded_to: 'high', checks: [] })
    expect(v.tone).toBe('downgraded')
    expect(v.headline).toContain('downgraded to high')
  })
  it('clear otherwise', () => {
    expect(summarizeVerdict({ blocked: false, severity_downgraded_to: null, checks: [] })).toEqual({
      tone: 'clear',
      headline: 'Not blocked',
    })
  })
})

describe('kindLabel / checkStatus', () => {
  it('labels known kinds and passes unknown through', () => {
    expect(kindLabel('severity_upgrade_block')).toContain('Severity')
    expect(kindLabel('mystery')).toBe('mystery')
  })
  it('disabled beats fired', () => {
    expect(checkStatus(check({ enabled: false, fired: true }))).toBe('disabled')
    expect(checkStatus(check({ fired: true }))).toBe('fired')
    expect(checkStatus(check({}))).toBe('clear')
  })
})

describe('describeTrigger', () => {
  const base: GuardrailTrigger = {
    run_id: 'r',
    step: 0,
    event_type: 'guardrail_blocked',
    timestamp: 1,
    data: {},
    objective: null,
  }
  it('describes a block', () => {
    expect(describeTrigger({ ...base, data: { matched_pattern: 'drop table' } })).toBe(
      'Blocked objective matching "drop table"',
    )
  })
  it('describes a downgrade and tolerates missing data', () => {
    const t = { ...base, event_type: 'guardrail_severity_downgraded' }
    expect(describeTrigger({ ...t, data: { proposed_severity: 'critical', downgraded_to: 'high' } })).toBe(
      'Downgraded severity critical to high',
    )
    expect(describeTrigger(t)).toBe('Downgraded severity ? to ?')
  })
})

describe('buildExamples', () => {
  const rule = (over: Partial<Guardrail>): Guardrail => ({
    id: 'g',
    name: 'r',
    kind: 'objective_pattern_block',
    config: {},
    enabled: true,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  })

  it('makes the severity preset runnable on its own: it fills an objective too', () => {
    const [ex] = buildExamples([rule({ kind: 'severity_upgrade_block' })])
    expect(ex.severity).toBe('critical')
    expect(ex.status).toBe('operational')
    expect(ex.text?.trim()).toBeTruthy()
  })

  it('offers banned patterns from enabled rules only, deduplicated', () => {
    const examples = buildExamples([
      rule({ id: 'a', config: { patterns: ['drop table'] } }),
      rule({ id: 'b', config: { patterns: ['DROP TABLE'] } }),
      rule({ id: 'c', enabled: false, config: { patterns: ['rm -rf'] } }),
    ])
    expect(examples.map((e) => e.text)).toEqual(['drop table'])
  })
})
