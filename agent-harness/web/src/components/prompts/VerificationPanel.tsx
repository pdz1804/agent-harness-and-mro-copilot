import { CheckCircle, Info, Robot, Warning, XCircle } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { LintSeverity, PromptVerification } from '../../lib/api-types'
import { sortIssues, summarizeVerification, type VerificationTone } from '../../lib/prompt-verification'
import { Chip, RelativeTime, type ChipTone } from '../ui'

const TONE: Record<VerificationTone, ChipTone> = {
  pass: 'ok',
  warn: 'warn',
  fail: 'danger',
  none: 'neutral',
}

const SEVERITY_ICON: Record<LintSeverity, ReactNode> = {
  error: <XCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-rose-600" />,
  warning: <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-amber-600" />,
  info: <Info size={14} weight="fill" className="mt-0.5 shrink-0 text-sky-600" />,
}

/** Compact status chip for a version's persisted verification. */
export function VerificationBadge({ verification }: { verification: PromptVerification | null | undefined }) {
  const summary = summarizeVerification(verification)
  return (
    <Chip
      tone={TONE[summary.tone]}
      icon={summary.tone === 'fail' ? <XCircle size={11} weight="fill" /> : summary.tone === 'none' ? <Info size={11} weight="fill" /> : <CheckCircle size={11} weight="fill" />}
      title={summary.activatable ? 'Can be activated' : 'Lint failed: this version cannot be activated until the errors are fixed in a new version'}
    >
      {summary.label}
      {summary.llmIssues > 0 && ` · ${summary.llmIssues} review note${summary.llmIssues === 1 ? '' : 's'}`}
    </Chip>
  )
}

/** Full verification result: every lint issue (rule, severity, message, line)
 * and, if it was run, the advisory LLM review. */
export function VerificationPanel({ verification }: { verification: PromptVerification }) {
  const issues = sortIssues(verification.lint.issues)
  const review = verification.llm_review
  return (
    <div className="space-y-3 text-sm" data-testid="verification-panel">
      <div className="flex flex-wrap items-center gap-2">
        <VerificationBadge verification={verification} />
        <span className="text-xs text-zinc-500">
          {verification.lint.char_count.toLocaleString()} characters · checked <RelativeTime value={verification.verified_at} />
        </span>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-zinc-500">Lint rules</p>
        {issues.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-emerald-700">
            <CheckCircle size={14} weight="fill" /> No issues: not empty, within length limits, placeholders valid, no contradictions.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {issues.map((issue, i) => (
              <li key={`${issue.rule}-${i}`} className="flex gap-2 text-xs text-zinc-700">
                {SEVERITY_ICON[issue.severity]}
                <span className="min-w-0">
                  <Chip mono tone="neutral" className="mr-1.5 align-middle">
                    {issue.rule}
                  </Chip>
                  {issue.message}
                  {issue.line ? <span className="text-zinc-500"> (line {issue.line})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {review && (
        <div>
          <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-zinc-500">
            <Robot size={12} weight="bold" /> LLM review (advisory){review.model ? ` · ${review.model}` : ''}
          </p>
          {review.status !== 'ok' ? (
            <p className="text-xs text-zinc-500">{review.error ?? 'Review unavailable.'}</p>
          ) : (
            <>
              {review.summary && <p className="mb-1 text-xs text-zinc-700">{review.summary}</p>}
              {review.issues.length === 0 ? (
                <p className="text-xs text-emerald-700">The reviewer found no issues.</p>
              ) : (
                <ul className="space-y-1.5">
                  {sortIssues(review.issues).map((issue, i) => (
                    <li key={i} className="flex gap-2 text-xs text-zinc-700">
                      {SEVERITY_ICON[issue.severity]}
                      <span>
                        {issue.message}
                        {issue.suggestion && <span className="block text-zinc-500">Suggestion: {issue.suggestion}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
