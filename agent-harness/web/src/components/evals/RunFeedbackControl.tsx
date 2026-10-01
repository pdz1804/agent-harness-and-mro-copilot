import { CheckCircle, ThumbsDown, ThumbsUp, WarningCircle, XCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useId, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import type { FeedbackRating, RunFeedback } from '../../lib/api-types'
import { NOTE_MAX, formatJudgeScore, judgeAgreement, nextVote } from '../../lib/feedback'
import { Skeleton } from '../Skeleton'

interface RunFeedbackControlProps {
  runId: string
  /** Tighter spacing for table rows / chat turns. */
  compact?: boolean
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

/** Judge verdict next to the caller's own thumbs-up/down (with an optional
 * note) and everyone else's votes. Self-contained: it loads and saves via the
 * run feedback API and assumes nothing about the page it sits in. */
export function RunFeedbackControl({ runId, compact = false }: RunFeedbackControlProps) {
  const [state, setState] = useState<{ runId: string; data: RunFeedback } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const noteId = useId()
  // Ignore data that belongs to a previous runId while the new one loads.
  const feedback = state?.runId === runId ? state.data : null
  const setFeedback = (data: RunFeedback) => setState({ runId, data })

  const load = useCallback(() => {
    let cancelled = false
    api
      .getRunFeedback(runId)
      .then((data) => {
        if (cancelled) return
        setLoadError(null)
        setState({ runId, data })
        setNote(data.mine?.note ?? '')
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorText(err, 'Could not load feedback for this run.'))
      })
    return () => {
      cancelled = true
    }
  }, [runId])

  useEffect(() => load(), [load])

  const vote = (clicked: FeedbackRating) => {
    if (!feedback || saving) return
    const next = nextVote(feedback.mine?.rating ?? null, clicked)
    setSaving(true)
    setActionError(null)
    const request = next === null ? api.deleteRunFeedback(runId) : api.putRunFeedback(runId, next, note.trim())
    request
      .then((data) => {
        setFeedback(data)
        setNote(data.mine?.note ?? '')
      })
      .catch((err: unknown) =>
        setActionError(errorText(err, 'Could not save your vote. Check your connection and click the thumb again.')),
      )
      .finally(() => setSaving(false))
  }

  const saveNote = () => {
    if (!feedback?.mine || saving) return
    setSaving(true)
    setActionError(null)
    api
      .putRunFeedback(runId, feedback.mine.rating, note.trim())
      .then((data) => setFeedback(data))
      .catch((err: unknown) => setActionError(errorText(err, 'Could not save your note. Try saving it again.')))
      .finally(() => setSaving(false))
  }

  if (loadError) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-rose-700" role="alert">
        <WarningCircle size={14} weight="fill" aria-hidden="true" />
        {loadError}
        <button
          type="button"
          onClick={() => {
            setLoadError(null)
            load()
          }}
          className="ui-btn-link"
        >
          Try again
        </button>
      </p>
    )
  }
  if (feedback === null) {
    return <Skeleton className={compact ? 'h-7 w-64 max-w-full' : 'h-12 w-full'} />
  }

  const mine = feedback.mine?.rating ?? null
  const agreement = judgeAgreement(feedback.judge_passed, mine)
  const scored = feedback.judge_score !== null || feedback.judge_passed !== null
  const noteChanged = feedback.mine !== null && note.trim() !== feedback.mine.note
  const gap = compact ? 'gap-x-3 gap-y-1.5' : 'gap-x-4 gap-y-2'

  return (
    <div className={`flex min-w-0 flex-wrap items-center ${gap} text-xs text-zinc-700`}>
      {scored ? (
        <span
          className="inline-flex items-center gap-1.5"
          title={feedback.judge_rationale ?? 'The judge gave no rationale.'}
        >
          <span className="font-medium text-zinc-600">Judge</span>
          <span className="font-data tabular-nums font-semibold text-zinc-900">
            {formatJudgeScore(feedback.judge_score)}
          </span>
          {feedback.judge_passed !== null && (
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium ring-1 ring-inset ${
                feedback.judge_passed
                  ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                  : 'bg-rose-50 text-rose-800 ring-rose-200'
              }`}
            >
              {feedback.judge_passed ? (
                <CheckCircle size={12} weight="bold" aria-hidden="true" />
              ) : (
                <XCircle size={12} weight="bold" aria-hidden="true" />
              )}
              {feedback.judge_passed ? 'Passed' : 'Failed'}
            </span>
          )}
        </span>
      ) : (
        <span className="text-zinc-600">Judge: not scored yet</span>
      )}

      <span className="inline-flex items-center gap-1" role="group" aria-label="Your rating of this run">
        <button
          type="button"
          onClick={() => vote('up')}
          disabled={saving}
          aria-pressed={mine === 'up'}
          aria-label="Mark this run good"
          title={mine === 'up' ? 'Remove your thumbs-up' : 'Mark this run good'}
          className={`ui-btn ui-btn-sm ui-btn-icon ${mine === 'up' ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
        >
          <ThumbsUp size={14} weight={mine === 'up' ? 'fill' : 'bold'} />
        </button>
        <button
          type="button"
          onClick={() => vote('down')}
          disabled={saving}
          aria-pressed={mine === 'down'}
          aria-label="Mark this run bad"
          title={mine === 'down' ? 'Remove your thumbs-down' : 'Mark this run bad'}
          className={`ui-btn ui-btn-sm ui-btn-icon ${mine === 'down' ? 'ui-btn-danger-solid' : 'ui-btn-secondary'}`}
        >
          <ThumbsDown size={14} weight={mine === 'down' ? 'fill' : 'bold'} />
        </button>
      </span>

      <span className="inline-flex min-w-0 items-center gap-1.5">
        <label htmlFor={noteId} className="sr-only">
          Add a note
        </label>
        <input
          id={noteId}
          name="feedback-note"
          type="text"
          autoComplete="off"
          value={note}
          maxLength={NOTE_MAX}
          disabled={saving}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && noteChanged) saveNote()
          }}
          placeholder="Add a note…"
          className={`ui-input ${compact ? 'w-40' : 'w-56'} max-w-full`}
        />
        {noteChanged && (
          <button type="button" onClick={saveNote} disabled={saving} className="ui-btn ui-btn-sm ui-btn-secondary">
            Save note
          </button>
        )}
      </span>
      {mine === null && note.trim() !== '' && (
        <span className="text-zinc-600">The note is saved with your vote.</span>
      )}

      {agreement !== 'unknown' && (
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium ring-1 ring-inset ${
            agreement === 'agree'
              ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
              : 'bg-amber-50 text-amber-800 ring-amber-200'
          }`}
        >
          {agreement === 'agree' ? (
            <CheckCircle size={12} weight="bold" aria-hidden="true" />
          ) : (
            <WarningCircle size={12} weight="bold" aria-hidden="true" />
          )}
          {agreement === 'agree' ? 'Agrees with judge' : 'Disagrees with judge'}
        </span>
      )}

      {feedback.others.length > 0 && (
        <ul className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-zinc-600" aria-label="Other votes">
          {feedback.others.map((o) => (
            <li
              key={o.user_id}
              className="inline-flex min-w-0 items-center gap-1"
              title={o.note || undefined}
            >
              {o.rating === 'up' ? (
                <ThumbsUp size={12} weight="fill" aria-label="Thumbs up" />
              ) : (
                <ThumbsDown size={12} weight="fill" aria-label="Thumbs down" />
              )}
              <span className="truncate">{o.user_name}</span>
            </li>
          ))}
        </ul>
      )}

      {actionError && (
        <p className="flex basis-full items-center gap-1.5 text-rose-700" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden="true" />
          {actionError}
        </p>
      )}
    </div>
  )
}
