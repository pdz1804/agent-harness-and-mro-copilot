import { ArrowUp, Check, HandPalm, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { isBareKey } from '../../lib/keyboard'
import { waitingLabel } from '../../lib/run-progress'
import { Button } from '../ui/Button'

interface ApprovalBarProps {
  toolName: string
  /** Unix seconds the run paused (latest `approval_requested`), if known. */
  requestedAt: number | null
  onDecide: (approved: boolean) => Promise<void>
  /** Scrolls the thread to the paused tool-call card. */
  onReview: () => void
  /** Set when the caller may not decide (viewer role): buttons disable and
   * the reason is shown instead of a dead click. */
  disabledReason?: string | null
}

/** The decision for a paused tool call, docked in glass above the composer so
 * it never scrolls away however long the thread is. Shows how long the run has
 * been waiting (the API exposes no deadline, so there is no countdown).
 * A / D approve / deny from anywhere outside a text field. A failed decision
 * stays on the bar with the server's reason; nothing is recorded until the
 * server confirms. */
export function ApprovalBar({ toolName, requestedAt, onDecide, onReview, disabledReason }: ApprovalBarProps) {
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const busy = useRef(false)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const decide = async (approved: boolean) => {
    if (busy.current || disabledReason) return
    busy.current = true
    setSubmitting(approved ? 'approve' : 'deny')
    setError(null)
    try {
      await onDecide(approved)
    } catch (err) {
      setError(`${err instanceof Error && err.message ? err.message : 'The decision did not go through.'} Nothing was recorded; try again.`)
    } finally {
      busy.current = false
      setSubmitting(null)
    }
  }

  const decideRef = useRef(decide)
  decideRef.current = decide
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[data-anchored-layer], [data-sheet], [data-command-palette]')) return
      if (isBareKey(e, 'a')) {
        e.preventDefault()
        void decideRef.current(true)
      } else if (isBareKey(e, 'd')) {
        e.preventDefault()
        void decideRef.current(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      role="region"
      aria-label="Approval needed"
      data-testid="approval-bar"
      className="ui-glass mb-2 flex animate-toast-in flex-col gap-2.5 rounded-[20px] p-2.5 pl-3.5 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] bg-amber-50 text-amber-600 ring-1 ring-amber-200 ring-inset" aria-hidden="true">
          <HandPalm size={14} weight="fill" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-zinc-950">
            <span className="font-data">{toolName}</span> wants to act
          </p>
          <p className="flex items-center gap-1.5 text-xs text-zinc-600" aria-live="off">
            <span className="ui-live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 text-amber-500" aria-hidden="true" />
            <span className="tabular-nums">{waitingLabel(requestedAt, now)}</span>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={onReview} className="inline-flex items-center gap-0.5 font-medium text-sky-700 hover:text-sky-800">
              Review
              <ArrowUp size={11} weight="bold" />
            </button>
          </p>
          {disabledReason && <p className="mt-1 text-xs text-zinc-500">{disabledReason}</p>}
          {error && (
            <p role="alert" className="mt-1 text-xs text-rose-700">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
        <Button
          variant="secondary"
          className="max-sm:!h-11"
          icon={<X size={14} weight="bold" />}
          kbd="D"
          onClick={() => void decide(false)}
          loading={submitting === 'deny'}
          disabled={!!disabledReason || submitting === 'approve'}
          title={disabledReason ?? 'Deny (D)'}
        >
          Deny
        </Button>
        <Button
          variant="success"
          className="max-sm:!h-11"
          icon={<Check size={15} weight="bold" />}
          kbd="A"
          onClick={() => void decide(true)}
          loading={submitting === 'approve'}
          disabled={!!disabledReason || submitting === 'deny'}
          title={disabledReason ?? 'Approve (A)'}
          data-testid="approve-button"
        >
          Approve
        </Button>
      </div>
    </div>
  )
}
