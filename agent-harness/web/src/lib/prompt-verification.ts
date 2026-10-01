import type { LintIssue, PromptVerification } from './api-types'

export type VerificationTone = 'pass' | 'warn' | 'fail' | 'none'

export interface VerificationSummary {
  tone: VerificationTone
  label: string
  errors: number
  warnings: number
  llmIssues: number
  activatable: boolean
}

/** One-line summary of a version's persisted verification for badges.
 * Mirrors the server gate: a version is activatable only when lint did not
 * fail. A version with no verification yet is activatable on the server (it
 * is linted at activation), so `activatable` is true but the tone is `none`. */
export function summarizeVerification(v: PromptVerification | null | undefined): VerificationSummary {
  if (!v) return { tone: 'none', label: 'Not verified', errors: 0, warnings: 0, llmIssues: 0, activatable: true }
  const errors = v.lint.issues.filter((i) => i.severity === 'error').length
  const warnings = v.lint.issues.filter((i) => i.severity === 'warning').length
  const llmIssues = v.llm_review?.status === 'ok' ? v.llm_review.issues.length : 0
  const tone: VerificationTone = v.lint.status
  const label =
    tone === 'fail'
      ? `Lint failed (${errors} error${errors === 1 ? '' : 's'})`
      : tone === 'warn'
        ? `Passed with ${warnings} warning${warnings === 1 ? '' : 's'}`
        : 'Lint passed'
  return { tone, label, errors, warnings, llmIssues, activatable: v.lint.status !== 'fail' }
}

const SEVERITY_ORDER: Record<LintIssue['severity'], number> = { error: 0, warning: 1, info: 2 }

export function sortIssues<T extends { severity: LintIssue['severity'] }>(issues: T[]): T[] {
  return [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

/** "Roll back" is just activating an older version; label it as such. */
export function activationLabel(version: number, activeVersion: number | null): string {
  if (activeVersion === null) return 'Activate'
  return version < activeVersion ? `Roll back to v${version}` : 'Activate'
}
