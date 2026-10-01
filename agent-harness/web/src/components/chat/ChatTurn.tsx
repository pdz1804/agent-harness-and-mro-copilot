import { ArrowRight, ArrowsClockwise, CaretDown, ChartBar, Check, Copy, Sparkle, StopCircle } from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type Ref } from 'react'
import { Link } from 'react-router-dom'
import { isActivityOpen } from '../../lib/activity-open'
import { buildTurnMetrics, formatDuration } from '../../lib/chat-metrics'
import type { RunSnapshot } from '../../lib/api-types'
import { buildToolCalls } from '../../lib/trace-model'
import { RunFeedbackControl } from '../evals/RunFeedbackControl'
import { MarkdownText } from '../MarkdownText'
import { StatusBadge } from '../StatusBadge'
import { stopReason } from '../../lib/run-outcome'
import { ActivityList } from './ActivityList'
import { MemoryStrip } from './MemoryStrip'
import type { ArtifactRef } from '../../lib/tool-call-view'
import type { ToolCallSummary } from '../../lib/trace-model'
import { ToolCallBlock, type ToolCallApproval } from './ToolCallBlock'

interface ChatTurnProps {
  snapshot: RunSnapshot
  /** True while this turn's run is streaming. */
  live: boolean
  streamingFinalAnswer?: string
  streamingToolArgs?: string
  /** The decision the run is paused on. It is rendered as a STATE of the
   * matching tool call (`ToolCallBlock`), in order with the other calls —
   * never as a separate card. */
  approval?: ToolCallApproval
  /** Scroll anchor for the awaiting-approval tool call. */
  approvalAnchorRef?: Ref<HTMLDivElement>
  onOpenArtifact?: (artifact: ArtifactRef) => void
  /** Only the newest turn offers regenerate. */
  onRegenerate?: () => void
  onFocusToolCall?: (key: string) => void
}

const ACTION_BUTTON =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-zinc-500 transition-colors duration-150 hover:bg-zinc-950/5 hover:text-zinc-900 active:scale-95'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => {
            /* clipboard unavailable (insecure context / denied) - nothing to do */
          })
      }}
      className={ACTION_BUTTON}
      aria-label="Copy answer"
    >
      {copied ? <Check size={13} weight="bold" className="text-emerald-600" /> : <Copy size={13} weight="bold" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** One conversation turn: the user's message (a quiet bubble), then the
 * agent's work as unboxed text - an activity log (open while the run is in
 * flight, collapsed once it has finished so the answer is prominent), tool-call
 * rows, the memories used, the approval card at the point of the pause, and the
 * final answer with copy/regenerate and per-message tokens + time. Used for
 * every run in a session, past or live. */
export function ChatTurn({
  snapshot,
  live,
  streamingFinalAnswer = '',
  streamingToolArgs = '',
  approval,
  approvalAnchorRef,
  onOpenArtifact,
  onRegenerate,
  onFocusToolCall,
}: ChatTurnProps) {
  // null = the reader has not toggled it: open while running, collapsed when done.
  const [activityChoice, setActivityChoice] = useState<boolean | null>(null)
  const activityOpen = isActivityOpen(activityChoice, snapshot.status)
  const toolCalls = useMemo(() => buildToolCalls(snapshot.history), [snapshot.history])
  // The paused call, if any. Normally it is already in the trace (opened by
  // `approval_requested`); if the snapshot's pending approval arrives before
  // that event, show the same block from the pending payload.
  const awaitingKey = toolCalls.find((c) => c.status === 'awaiting_approval')?.key ?? null
  const fallbackApprovalCall: ToolCallSummary | null =
    approval && !awaitingKey
      ? {
          key: `pending:${approval.pending.tool_name}`,
          step: snapshot.steps_taken,
          toolName: approval.pending.tool_name,
          status: 'awaiting_approval',
          args: approval.pending.tool_args,
          result: null,
          error: null,
          latencyMs: null,
          attempts: 1,
          approvalOutcome: null,
          startedAt: null,
          finishedAt: null,
          decidedAt: null,
          approvalPreview: approval.pending.preview ?? null,
        }
      : null
  const visibleCalls = fallbackApprovalCall ? [...toolCalls, fallbackApprovalCall] : toolCalls
  const metrics = useMemo(
    () => buildTurnMetrics(snapshot.started_at, snapshot.history, live),
    [snapshot.started_at, snapshot.history, live],
  )
  // Dashboards the agent created in this turn (approved + executed): link straight to them.
  const createdDashboards = useMemo(
    () =>
      toolCalls.flatMap((call) => {
        const result = call.result as { dashboard_id?: unknown; name?: unknown } | null
        return call.toolName === 'create_dashboard' && call.status === 'ok' && result && typeof result.dashboard_id === 'string'
          ? [{ id: result.dashboard_id, name: typeof result.name === 'string' ? result.name : 'dashboard' }]
          : []
      }),
    [toolCalls],
  )
  const memoryCalls = useMemo(
    () => toolCalls.filter((c) => (c.toolName === 'recall' || c.toolName === 'remember') && c.status === 'ok').length,
    [toolCalls],
  )
  const isStreamingFinalAnswer = live && !snapshot.final_answer && streamingFinalAnswer.length > 0
  const isStreamingToolArgs = live && streamingToolArgs.length > 0 && !isStreamingFinalAnswer
  const answer = snapshot.final_answer || streamingFinalAnswer
  const stopped = live ? null : stopReason(snapshot)

  return (
    <article className="animate-rise space-y-5" data-run-id={snapshot.run_id} aria-label={`Turn ${snapshot.run_id}`}>
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-[1.25rem] rounded-br-md bg-zinc-950/[0.05] px-4 py-2.5 text-[15px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-zinc-900">
          {snapshot.objective}
        </p>
      </div>

      <div className="min-w-0 space-y-3">
        <div>
          <button
            type="button"
            onClick={() => setActivityChoice(!activityOpen)}
            aria-expanded={activityOpen}
            className="group -ml-1 flex min-h-8 items-center gap-2 rounded-lg py-1 pr-2 pl-1 text-left text-[13px] text-zinc-500 transition-colors duration-150 hover:bg-zinc-950/[0.035] hover:text-zinc-900"
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                live ? 'bg-sky-600 text-white shadow-[0_0_0_4px_oklch(0.608_0.192_280/0.15)]' : 'bg-zinc-950 text-white'
              }`}
              aria-hidden="true"
            >
              <Sparkle size={12} weight="fill" className={live ? 'animate-pulse' : ''} />
            </span>
            {live ? (
              <span className="font-medium text-sky-700">Working…</span>
            ) : (
              <span className="font-medium text-zinc-700">Worked for {formatDuration(metrics.durationMs)}</span>
            )}
            <span className="font-data text-xs text-zinc-400 tabular-nums">
              {snapshot.history.length} event{snapshot.history.length === 1 ? '' : 's'}
            </span>
            <CaretDown
              size={11}
              weight="bold"
              className={`shrink-0 text-zinc-400 transition-transform duration-200 group-hover:text-zinc-600 ${activityOpen ? '' : '-rotate-90'}`}
            />
            <span className="sr-only">Agent activity</span>
            {!live && snapshot.status !== 'completed' && <StatusBadge status={snapshot.status} />}
          </button>
          {activityOpen && (
            <div className="mt-2 animate-fade">
              <ActivityList events={snapshot.history} />
            </div>
          )}
        </div>

        {visibleCalls.length > 0 && (
          <div className="space-y-2">
            {visibleCalls.map((call) => {
              const isPaused = !!approval && (call.key === awaitingKey || call === fallbackApprovalCall)
              return (
                <ToolCallBlock
                  key={call.key}
                  call={call}
                  approval={isPaused ? approval : undefined}
                  anchorRef={isPaused ? approvalAnchorRef : undefined}
                  onOpenArtifact={onOpenArtifact}
                  onInspect={onFocusToolCall ? () => onFocusToolCall(call.key) : undefined}
                />
              )
            })}
          </div>
        )}

        <MemoryStrip runId={snapshot.run_id} memoryCalls={memoryCalls} />

        {createdDashboards.map((d) => (
          <Link
            key={d.id}
            to={`/dashboards/${d.id}`}
            className="group flex min-h-12 items-center gap-3 rounded-xl bg-white px-3 py-2.5 text-sm shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-line)] transition-[box-shadow] duration-200 hover:shadow-[var(--shadow-lift)]"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-700 ring-1 ring-sky-200 ring-inset">
              <ChartBar size={16} weight="bold" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-zinc-500">Dashboard created</span>
              <span className="block truncate font-medium text-zinc-900">{d.name}</span>
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-sky-700">
              Open
              <ArrowRight size={12} weight="bold" className="transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ))}

        {isStreamingToolArgs && (
          <div className="overflow-hidden rounded-xl bg-white ring-1 ring-[var(--color-line)]">
            <p className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2 text-xs font-medium text-zinc-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />
              Preparing a tool call…
            </p>
            <pre className="font-data max-h-40 overflow-auto px-3 py-2 text-xs text-zinc-700">{streamingToolArgs}</pre>
          </div>
        )}

        {stopped && (
          <p
            role="status"
            data-testid="run-stopped"
            className="flex items-start gap-2.5 rounded-xl bg-zinc-950/[0.035] px-3.5 py-2.5 text-[13px] text-zinc-700"
          >
            <StopCircle size={16} weight="fill" className="mt-px shrink-0 text-zinc-400" aria-hidden="true" />
            <span>
              <span className="font-semibold text-zinc-900">Run stopped:</span> {stopped}
            </span>
          </p>
        )}

        {(snapshot.final_answer || isStreamingFinalAnswer) && (
          <div className="min-w-0 pt-1">
            <div
              className="max-w-[70ch] [overflow-wrap:anywhere]"
              aria-live={isStreamingFinalAnswer ? 'off' : 'polite'}
              aria-busy={isStreamingFinalAnswer}
            >
              <MarkdownText text={answer} />
              {isStreamingFinalAnswer && (
                <span className="mt-1 ml-0.5 inline-block h-[1.1em] w-[2px] animate-caret rounded-full bg-sky-600 align-text-bottom" aria-hidden="true" />
              )}
            </div>
            {!isStreamingFinalAnswer && (
              <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-zinc-500">
                <span className="flex items-center gap-0.5">
                  <CopyButton text={answer} />
                  {onRegenerate && (
                    <button type="button" onClick={onRegenerate} className={ACTION_BUTTON}>
                      <ArrowsClockwise size={13} weight="bold" />
                      Regenerate
                    </button>
                  )}
                </span>
                {!live && snapshot.status === 'completed' && <RunFeedbackControl runId={snapshot.run_id} compact />}
                <span className="ml-auto flex items-center gap-2.5 text-zinc-400">
                  <span className="font-data tabular-nums" title={`prompt ${metrics.promptTokens} + completion ${metrics.completionTokens}`}>
                    {metrics.totalTokens.toLocaleString()} tokens
                  </span>
                  <span className="font-data tabular-nums">{formatDuration(metrics.durationMs)}</span>
                  <span className="tabular-nums">
                    {metrics.toolCalls} tool call{metrics.toolCalls === 1 ? '' : 's'}
                  </span>
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
