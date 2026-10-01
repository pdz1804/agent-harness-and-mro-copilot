import type { Automation, AutomationTriggeredRun } from './api-types'

export function validateAutomationName(name: string): string | null {
  return name.trim() === '' ? 'Give the automation a name.' : null
}

export function validateObjective(objective: string): string | null {
  return objective.trim() === '' ? 'Say what the run should investigate.' : null
}

export type AutomationStateFilter = 'all' | 'enabled' | 'disabled'
export const AUTOMATION_STATE_FILTERS: readonly AutomationStateFilter[] = ['all', 'enabled', 'disabled']

/** Search over name, service, status and objective, plus an enabled-state filter. */
export function filterAutomations(items: readonly Automation[], q: string, state: AutomationStateFilter): Automation[] {
  const needle = q.trim().toLowerCase()
  return items.filter((a) => {
    if (state === 'enabled' && !a.enabled) return false
    if (state === 'disabled' && a.enabled) return false
    if (!needle) return true
    return [a.name, a.trigger_service_name, a.trigger_status, a.objective_template].some((field) => field.toLowerCase().includes(needle))
  })
}

/** Runs one automation started (`triggered_by_automation_id`). */
export function runsForAutomation(runs: readonly AutomationTriggeredRun[], automationId: string): AutomationTriggeredRun[] {
  return runs.filter((r) => r.triggered_by_automation_id === automationId)
}

/** "When payments-api flips to down" / "When any service flips to degraded". */
export function describeTrigger(automation: Pick<Automation, 'trigger_service_name' | 'trigger_status'>): string {
  const service = automation.trigger_service_name === 'any' ? 'any service' : automation.trigger_service_name
  return `When ${service} flips to ${automation.trigger_status}`
}
