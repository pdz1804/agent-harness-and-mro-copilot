import { ShieldWarning } from '@phosphor-icons/react'
import { useState } from 'react'
import type { PendingApproval } from '../lib/api-types'

const SEVERITY_STYLES: Record<string, string> = {
  low: 'bg-zinc-700/50 text-zinc-300 ring-zinc-600/50',
  medium: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  critical: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
}

interface ApprovalPanelProps {
  pending: PendingApproval
  onDecide: (approved: boolean) => Promise<void>
}

export function ApprovalPanel({ pending, onDecide }: ApprovalPanelProps) {
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const args = pending.tool_args
  const title = typeof args.title === 'string' ? args.title : undefined
  const description = typeof args.description === 'string' ? args.description : undefined
  const severity = typeof args.severity === 'string' ? args.severity : undefined
  const severityClass = severity ? (SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.medium) : SEVERITY_STYLES.medium

  const decide = async (approved: boolean) => {
    setSubmitting(approved ? 'approve' : 'deny')
    setError(null)
    try {
      await onDecide(approved)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit decision.')
      setSubmitting(null)
    }
  }

  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/[0.04] p-4">
      <div className="flex items-center gap-2 text-amber-300">
        <ShieldWarning size={20} weight="fill" />
        <h2 className="text-sm font-semibold tracking-wide uppercase">Approval required</h2>
      </div>
      <p className="mt-1 text-sm text-zinc-400">
        The agent wants to call <code className="font-data text-zinc-200">{pending.tool_name}</code>. Review
        before it runs.
      </p>

      <dl className="mt-3 space-y-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-3">
        {title && (
          <div>
            <dt className="text-xs font-medium text-zinc-500">Title</dt>
            <dd className="text-sm text-zinc-100">{title}</dd>
          </div>
        )}
        {description && (
          <div>
            <dt className="text-xs font-medium text-zinc-500">Description</dt>
            <dd className="text-sm text-zinc-300">{description}</dd>
          </div>
        )}
        {severity && (
          <div>
            <dt className="text-xs font-medium text-zinc-500">Severity</dt>
            <dd className="mt-0.5">
              <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${severityClass}`}>
                {severity}
              </span>
            </dd>
          </div>
        )}
        {!title && !description && !severity && (
          <pre className="font-data text-xs text-zinc-400">{JSON.stringify(args, null, 2)}</pre>
        )}
      </dl>

      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => void decide(true)}
          disabled={submitting !== null}
          className="flex-1 rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => void decide(false)}
          disabled={submitting !== null}
          className="flex-1 rounded-md border border-rose-500/40 bg-transparent px-3 py-2 text-sm font-semibold text-rose-300 transition hover:bg-rose-500/10 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting === 'deny' ? 'Denying…' : 'Deny'}
        </button>
      </div>
    </section>
  )
}
