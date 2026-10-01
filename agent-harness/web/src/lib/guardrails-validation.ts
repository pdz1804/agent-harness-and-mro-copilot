import type { Guardrail, GuardrailTrigger } from './api-types'

export function validateGuardrailName(name: string): string | null {
  return name.trim() === '' ? 'Give the rule a name.' : null
}

/** One banned pattern per line: trimmed, blanks dropped, case-insensitive
 * duplicates collapsed (the first spelling wins). */
export function parsePatterns(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split('\n')) {
    const pattern = line.trim()
    const key = pattern.toLowerCase()
    if (!pattern || seen.has(key)) continue
    seen.add(key)
    out.push(pattern)
  }
  return out
}

export function validatePatterns(text: string): string | null {
  return parsePatterns(text).length === 0 ? 'Add at least one banned pattern, one per line.' : null
}

export function guardrailPatterns(guardrail: Pick<Guardrail, 'config'>): string[] {
  const raw = guardrail.config.patterns
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
}

export type GuardrailStateFilter = 'all' | 'enabled' | 'disabled'
export const GUARDRAIL_STATE_FILTERS: readonly GuardrailStateFilter[] = ['all', 'enabled', 'disabled']

/** Search over name, kind and patterns, plus an enabled-state filter. */
export function filterGuardrails(items: readonly Guardrail[], q: string, state: GuardrailStateFilter): Guardrail[] {
  const needle = q.trim().toLowerCase()
  return items.filter((g) => {
    if (state === 'enabled' && !g.enabled) return false
    if (state === 'disabled' && g.enabled) return false
    if (!needle) return true
    return [g.name, g.kind, ...guardrailPatterns(g)].some((field) => field.toLowerCase().includes(needle))
  })
}

/** Triggers recorded for one rule (matched by the rule name stored on the event). */
export function triggersForRule(triggers: readonly GuardrailTrigger[], guardrail: Pick<Guardrail, 'name'>): GuardrailTrigger[] {
  return triggers.filter((t) => t.data.guardrail_name === guardrail.name)
}

/** Search over the rule name, what happened and the objective. */
export function filterTriggers(triggers: readonly GuardrailTrigger[], q: string): GuardrailTrigger[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return [...triggers]
  return triggers.filter((t) =>
    [typeof t.data.guardrail_name === 'string' ? t.data.guardrail_name : '', t.run_id, t.objective ?? '', String(t.data.matched_pattern ?? '')].some((field) => field.toLowerCase().includes(needle)),
  )
}
