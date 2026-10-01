import { CheckCircle, ThumbsDown, ThumbsUp, WarningCircle, XCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { api, errorText } from '../../lib/api'
import type { FeedbackRating, RunFeedback } from '../../lib/api-types'
import { NOTE_MAX, formatJudgeScore, judgeAgreement, nextVote } from '../../lib/feedback'
import { Button, Chip, Input, Skeleton, useToast } from '../ui'

interface RunFeedbackControlProps {
  runId: string
  /** Tighter spacing for table rows / chat turns. */
  compact?: boolean
}

/** Judge verdict next to the caller's own thumbs-up/down (with an optional
 * note) and everyone else's votes. Self-contained: it loads and saves via the
 * run feedback API and assumes nothing about the page it sits in. Every save
 * toasts with Undo: a vote restores the previous rating (or clears it through
 * `deleteRunFeedback` when there was none), a note restores the previous note. */
export function RunFeedbackControl({ runId, compact = false }: RunFeedbackControlProps) {
  const toast = useToast()
  const [state, setState] = useState<{ runId: string; data: RunFeedback } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState<'up' | 'down' | 'note' | null>(null)
  const [note, setNote] = useState('')
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

  /** Put the caller's feedback back to `rating` + `previousNote` (null rating clears it). */
  const restore = async (rating: FeedbackRating | null, previousNote: string) => {
    const data = rating === null ? await api.deleteRunFeedback(runId) : await api.putRunFeedback(runId, rating, previousNote)
    setFeedback(data)
    setNote(data.mine?.note ?? '')
  }

  const vote = (clicked: FeedbackRating) => {
    if (!feedback || saving) return
    const previous = feedback.mine?.rating ?? null
    const previousNote = feedback.mine?.note ?? ''
    const next = nextVote(previous, clicked)
    setSaving(clicked)
    const request = next === null ? api.deleteRunFeedback(runId) : api.putRunFeedback(runId, next, note.trim())
    request
      .then((data) => {
        setFeedback(data)
        setNote(data.mine?.note ?? '')
        toast({
          title: next === null ? 'Rating cleared' : next === 'up' ? 'Marked good' : 'Marked bad',
          action: { label: 'Undo', run: () => restore(previous, previousNote) },
        })
      })
      .catch((err: unknown) => toast({ tone: 'error', title: "Couldn't save your vote", description: errorText(err, 'Check your connection and click the thumb again.') }))
      .finally(() => setSaving(null))
  }

  const saveNote = () => {
    if (!feedback?.mine || saving) return
    const rating = feedback.mine.rating
    const previousNote = feedback.mine.note
    setSaving('note')
    api
      .putRunFeedback(runId, rating, note.trim())
      .then((data) => {
        setFeedback(data)
        toast({ title: 'Note saved', action: { label: 'Undo', run: () => restore(rating, previousNote) } })
      })
      .catch((err: unknown) => toast({ tone: 'error', title: "Couldn't save your note", description: errorText(err, 'Try saving it again.') }))
      .finally(() => setSaving(null))
  }

  if (loadError) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-rose-700" role="alert">
        <WarningCircle size={14} weight="fill" aria-hidden="true" />
        {loadError}
        <Button
          variant="link"
          onClick={() => {
            setLoadError(null)
            load()
          }}
        >
          Try again
        </Button>
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
        <span className="inline-flex items-center gap-1.5" title={feedback.judge_rationale ?? 'The judge gave no rationale.'}>
          <span className="font-medium text-zinc-600">Judge</span>
          <span className="font-data font-semibold text-zinc-900 tabular-nums">{formatJudgeScore(feedback.judge_score)}</span>
          {feedback.judge_passed !== null && (
            <Chip tone={feedback.judge_passed ? 'ok' : 'danger'} icon={feedback.judge_passed ? <CheckCircle size={12} weight="bold" aria-hidden="true" /> : <XCircle size={12} weight="bold" aria-hidden="true" />}>
              {feedback.judge_passed ? 'Passed' : 'Failed'}
            </Chip>
          )}
        </span>
      ) : (
        <span className="text-zinc-600">Judge: not scored yet</span>
      )}

      <span className="inline-flex items-center gap-1" role="group" aria-label="Your rating of this run">
        <Button
          size="sm"
          iconOnly
          variant={mine === 'up' ? 'primary' : 'secondary'}
          onClick={() => vote('up')}
          loading={saving === 'up'}
          disabled={saving !== null}
          aria-pressed={mine === 'up'}
          aria-label="Mark this run good"
          title={mine === 'up' ? 'Remove your thumbs-up' : 'Mark this run good'}
          icon={<ThumbsUp size={14} weight={mine === 'up' ? 'fill' : 'bold'} />}
        />
        <Button
          size="sm"
          iconOnly
          variant={mine === 'down' ? 'danger-solid' : 'secondary'}
          onClick={() => vote('down')}
          loading={saving === 'down'}
          disabled={saving !== null}
          aria-pressed={mine === 'down'}
          aria-label="Mark this run bad"
          title={mine === 'down' ? 'Remove your thumbs-down' : 'Mark this run bad'}
          icon={<ThumbsDown size={14} weight={mine === 'down' ? 'fill' : 'bold'} />}
        />
      </span>

      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Input
          aria-label="Add a note"
          name="feedback-note"
          type="text"
          autoComplete="off"
          value={note}
          maxLength={NOTE_MAX}
          disabled={saving !== null}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && noteChanged) saveNote()
          }}
          placeholder="Add a note…"
          className={`${compact ? 'w-40' : 'w-56'} max-w-full`}
        />
        {noteChanged && (
          <Button size="sm" onClick={saveNote} loading={saving === 'note'}>
            Save note
          </Button>
        )}
      </span>
      {mine === null && note.trim() !== '' && <span className="text-zinc-600">The note is saved with your vote.</span>}

      {agreement !== 'unknown' && (
        <Chip tone={agreement === 'agree' ? 'ok' : 'warn'} icon={agreement === 'agree' ? <CheckCircle size={12} weight="bold" aria-hidden="true" /> : <WarningCircle size={12} weight="bold" aria-hidden="true" />}>
          {agreement === 'agree' ? 'Agrees with judge' : 'Disagrees with judge'}
        </Chip>
      )}

      {feedback.others.length > 0 && (
        <ul className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-zinc-600" aria-label="Other votes">
          {feedback.others.map((o) => (
            <li key={o.user_id} className="inline-flex min-w-0 items-center gap-1" title={o.note || undefined}>
              {o.rating === 'up' ? <ThumbsUp size={12} weight="fill" aria-label="Thumbs up" /> : <ThumbsDown size={12} weight="fill" aria-label="Thumbs down" />}
              <span className="truncate">{o.user_name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
