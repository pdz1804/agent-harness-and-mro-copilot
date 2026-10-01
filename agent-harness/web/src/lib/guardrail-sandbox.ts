import type { GuardrailKind, GuardrailRuleCheck, GuardrailTestResult, GuardrailTrigger } from './api-types'

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
