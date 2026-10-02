import type { Guardrail, GuardrailKind, GuardrailRuleCheck, GuardrailTestResult, GuardrailTrigger } from './api-types'

export interface HighlightParts {
  before: string
  match: string
  after: string
  found: boolean
}

/** Split `text` around the first case-insensitive occurrence of `pattern`.
 * Uses `indexOf` on lowercased copies (never a RegExp), so patterns
 * containing regex metacharacters are matched literally. When the pattern is
 * missing/empty/absent, `found` is false and the whole text is `before`. */
export function splitHighlight(text: string, pattern: string | null | undefined): HighlightParts {
  if (!pattern) return { before: text, match: '', after: '', found: false }
  const index = text.toLowerCase().indexOf(pattern.toLowerCase())
  if (index < 0) return { before: text, match: '', after: '', found: false }
  const end = index + pattern.length
  return { before: text.slice(0, index), match: text.slice(index, end), after: text.slice(end), found: true }
}

export type VerdictTone = 'blocked' | 'downgraded' | 'clear'

export interface Verdict {
  tone: VerdictTone
  headline: string
}

export function summarizeVerdict(result: GuardrailTestResult): Verdict {
  if (result.blocked) return { tone: 'blocked', headline: 'Blocked before the run starts' }
  if (result.severity_downgraded_to) {
    return {
      tone: 'downgraded',
      headline: `Not blocked. Severity would be downgraded to ${result.severity_downgraded_to}`,
    }
  }
  return { tone: 'clear', headline: 'Not blocked' }
}

const KIND_LABELS: Record<GuardrailKind, string> = {
  objective_pattern_block: 'Objective pattern block (input)',
  severity_upgrade_block: 'Severity evidence cap (output)',
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as GuardrailKind] ?? kind
}

export type CheckStatus = 'fired' | 'clear' | 'disabled'

/** A disabled rule never fires, so `disabled` wins over `fired`. */
export function checkStatus(check: GuardrailRuleCheck): CheckStatus {
  if (!check.enabled) return 'disabled'
  return check.fired ? 'fired' : 'clear'
}

/** One-line plain-words summary of what a recorded trigger did. */
export function describeTrigger(trigger: GuardrailTrigger): string {
  if (trigger.event_type === 'guardrail_blocked') {
    return `Blocked objective matching "${String(trigger.data.matched_pattern ?? '?')}"`
  }
  return `Downgraded severity ${String(trigger.data.proposed_severity ?? '?')} to ${String(
    trigger.data.downgraded_to ?? '?',
  )}`
}

export interface SandboxExample {
  key: string
  label: string
  text?: string
  severity?: string
  status?: string
}

/** Example chips come only from the rules actually configured. */
export function buildExamples(guardrails: Guardrail[]): SandboxExample[] {
  const examples: SandboxExample[] = []
  const seen = new Set<string>()
  for (const g of guardrails) {
    if (!g.enabled || g.kind !== 'objective_pattern_block') continue
    const patterns = Array.isArray(g.config.patterns) ? (g.config.patterns as unknown[]) : []
    const first = patterns.find((p): p is string => typeof p === 'string' && p.trim() !== '')
    if (first && !seen.has(first.toLowerCase()) && examples.length < 2) {
      seen.add(first.toLowerCase())
      examples.push({ key: `p-${g.id}`, label: first, text: first })
    }
  }
  if (guardrails.some((g) => g.enabled && g.kind === 'severity_upgrade_block')) {
    examples.push({
      key: 'sev',
      label: 'critical severity, service not down',
      // An objective too, so one click makes the sandbox runnable (Test needs text).
      text: 'auth-service looks slow, open a critical incident for it',
      severity: 'critical',
      status: 'operational',
    })
  }
  return examples
}
