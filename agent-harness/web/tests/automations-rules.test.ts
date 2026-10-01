import { describe, expect, it } from 'vitest'
import type { Automation, AutomationTriggeredRun } from '../src/lib/api-types'
import { describeTrigger, filterAutomations, runsForAutomation, validateAutomationName, validateObjective } from '../src/lib/automations-rules'

const auto = (over: Partial<Automation>): Automation => ({
  id: 'a1',
  name: 'Investigate outages',
  trigger_service_name: 'payments-api',
  trigger_status: 'down',
  objective_template: 'investigate payments-api',
  enabled: true,
  created_at: '2026-10-01T00:00:00Z',
  owner_id: 'u1',
  ...over,
})

describe('automation rules', () => {
  it('validates required text', () => {
    expect(validateAutomationName(' ')).not.toBeNull()
    expect(validateAutomationName('ok')).toBeNull()
    expect(validateObjective('')).not.toBeNull()
    expect(validateObjective('go')).toBeNull()
  })
  it('filters by search and state', () => {
    const items = [auto({}), auto({ id: 'a2', name: 'Degraded watch', trigger_service_name: 'any', trigger_status: 'degraded', enabled: false })]
    expect(filterAutomations(items, 'OUTAGES', 'all').map((a) => a.id)).toEqual(['a1'])
    expect(filterAutomations(items, '', 'disabled').map((a) => a.id)).toEqual(['a2'])
    expect(filterAutomations(items, 'degraded', 'enabled')).toHaveLength(0)
  })
  it('describes triggers and links runs', () => {
    expect(describeTrigger(auto({}))).toBe('When payments-api flips to down')
    expect(describeTrigger(auto({ trigger_service_name: 'any', trigger_status: 'degraded' }))).toBe('When any service flips to degraded')
    const runs = [
      { run_id: 'r1', triggered_by_automation_id: 'a1' },
      { run_id: 'r2', triggered_by_automation_id: 'a2' },
    ] as AutomationTriggeredRun[]
    expect(runsForAutomation(runs, 'a1').map((r) => r.run_id)).toEqual(['r1'])
  })
})
