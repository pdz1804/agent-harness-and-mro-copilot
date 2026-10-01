import {
  ArrowClockwise,
  ArrowSquareOut,
  Brain,
  CaretRight,
  ChartBar,
  CheckCircle,
  CircleNotch,
  Clock,
  HandPalm,
  Prohibit,
  Siren,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import type { PendingApproval } from '../../lib/api-types'
import { formatDuration } from '../../lib/chat-metrics'
import { LIFECYCLE, artifactOf, summarizeArgs, type ArtifactRef, type LifecycleTone } from '../../lib/tool-call-view'
import type { ToolCallStatus, ToolCallSummary } from '../../lib/trace-model'
import { JsonTree } from '../ui/JsonTree'
import { ApprovalDetails } from './ApprovalDetails'

const STATUS_ICON: Record<ToolCallStatus, ReactNode> = {
  awaiting_approval: <HandPalm size={14} weight="fill" />,
  started: <CircleNotch size={14} weight="bold" className="animate-spin" />,
  retry: <ArrowClockwise size={14} weight="bold" className="animate-spin [animation-duration:1.6s]" />,
  ok: <CheckCircle size={14} weight="fill" />,
  timeout: <Clock size={14} weight="fill" />,
  error: <XCircle size={14} weight="fill" />,
  denied: <Prohibit size={14} weight="bold" />,
  invalid: <WarningCircle size={14} weight="fill" />,
}

const TONE: Record<LifecycleTone, { tile: string; dot: string; text: string }> = {
  running: { tile: 'bg-sky-50 text-sky-600 ring-sky-200', dot: 'bg-sky-500', text: 'text-sky-700' },
  attention: { tile: 'bg-amber-50 text-amber-600 ring-amber-200', dot: 'bg-amber-500', text: 'text-amber-700' },
  success: { tile: 'bg-emerald-50 text-emerald-600 ring-emerald-200', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  danger: { tile: 'bg-rose-50 text-rose-600 ring-rose-200', dot: 'bg-rose-500', text: 'text-rose-700' },
  muted: { tile: 'bg-zinc-100 text-zinc-500 ring-zinc-200', dot: 'bg-zinc-400', text: 'text-zinc-600' },
}

const ARTIFACT_ICON: Record<ArtifactRef['kind'], ReactNode> = {
  dashboard: <ChartBar size={12} weight="bold" />,
  incident: <Siren size={12} weight="bold" />,
  memory: <Brain size={12} weight="bold" />,
}
const ARTIFACT_NOUN: Record<ArtifactRef['kind'], string> = { dashboard: 'Dashboard', incident: 'Incident', memory: 'Memory' }

function clock(unixSeconds: number | null): string {
  return unixSeconds ? new Date(unixSeconds * 1000).toLocaleTimeString() : ''
}

/** Ticks once a second while `active` (live timer for a running call). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export interface ToolCallApproval {
  pending: PendingApproval
  onDecide: (approved: boolean) => Promise<void>
}

interface ToolCallCardProps {
  call: ToolCallSummary
  /** Present only on the call the run is paused on: the card shows its
   * "needs approval" state with the full preview. The decision itself lives in
   * the ApprovalBar docked above the composer, so it never scrolls away. */
  approval?: ToolCallApproval
  /** Scroll anchor for the "needs your approval" chip. */
  anchorRef?: Ref<HTMLDivElement>
  onOpenArtifact?: (artifact: ArtifactRef) => void
  /** Thread rows offer "Open in inspector". */
  onInspect?: () => void
  defaultOpen?: boolean
  highlighted?: boolean
  /** Rendered as one row of a grouped list (no own border) vs a standalone card. */
  grouped?: boolean
}

/** THE tool-call card: the same one in the thread, the inspector's Tools tab
 * and run history. A call moves through one lifecycle and the card reflects it
 * in place:
 *
 *   running -> needs approval (amber ring, expanded preview)
 *           -> approved / denied (when) -> succeeded / failed (result, latency)
 *
 * Approval is a STATE of this card, not a separate widget; Approve / Deny are
 * on the docked ApprovalBar. Collapsed it is one row: status glyph, tool,
 * argument summary, artifact chip, status, duration. Once decided it folds
 * back into a normal row that records the decision, so the thread reads as a
 * log. The card is solid content, never glass. */
export function ToolCallCard({
  call,
  approval,
  anchorRef,
  onOpenArtifact,
  onInspect,
  defaultOpen = false,
  highlighted = false,
  grouped = false,
}: ToolCallCardProps) {
  const needsDecision = call.status === 'awaiting_approval' && !!approval
  const [open, setOpen] = useState(defaultOpen || needsDecision)
  const previous = useRef(call.status)

  // Expand when the call starts waiting on a human; fold back once decided.
  useEffect(() => {
    if (call.status === 'awaiting_approval' && approval) setOpen(true)
    else if (previous.current === 'awaiting_approval') setOpen(defaultOpen)
    previous.current = call.status
  }, [call.status, approval, defaultOpen])

  const life = LIFECYCLE[call.status]
  const tone = TONE[life.tone]
  const running = call.status === 'started' || call.status === 'retry'
  const now = useNow(running)
  const durationMs =
    call.latencyMs ??
    (call.startedAt && call.finishedAt ? (call.finishedAt - call.startedAt) * 1000 : running && call.startedAt ? now - call.startedAt * 1000 : null)
  const summary = summarizeArgs(call.args)
  const artifact = artifactOf(call)

  const container = needsDecision
    ? 'rounded-[14px] bg-white ring-1 ring-amber-300 shadow-[0_0_0_4px_oklch(0.83_0.12_80/0.16),var(--shadow-sm)]'
    : grouped
      ? ''
      : `rounded-[14px] bg-white ring-1 shadow-[var(--shadow-xs)] ${highlighted ? 'ring-2 ring-sky-400 shadow-[0_0_0_4px_oklch(0.608_0.192_280/0.12)]' : 'ring-[var(--color-line)]'}`

  return (
    <div
      ref={anchorRef}
      id={`tool-call-${call.key}`}
      data-testid={needsDecision ? 'approval-card' : undefined}
      role={needsDecision ? 'alert' : undefined}
      aria-live={needsDecision ? 'assertive' : undefined}
      className={`min-w-0 scroll-mt-4 transition-shadow duration-200 ${container}`}
    >
      <div className="flex min-h-10 items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`group flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors duration-150 ${
            needsDecision ? 'rounded-t-[14px] bg-gradient-to-b from-amber-50 to-transparent' : 'hover:bg-zinc-950/[0.025]'
          } ${grouped || needsDecision ? '' : 'rounded-[14px]'}`}
        >
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ${tone.tile}`} aria-hidden="true">
            {STATUS_ICON[call.status]}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-data font-medium text-zinc-900">{call.toolName}</span>
            {summary && <span className="text-zinc-500"> · {summary}</span>}
          </span>
          <span className={`hidden shrink-0 items-center gap-1.5 text-[11.5px] font-medium sm:inline-flex ${tone.text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${running || needsDecision ? 'animate-pulse' : ''}`} aria-hidden="true" />
            {life.label}
            {call.approvalOutcome === 'granted' && call.status !== 'awaiting_approval' && <span className="text-zinc-400">· approved</span>}
          </span>
          <span className="sr-only sm:hidden">{life.label}</span>
          {durationMs !== null && (
            <span className="font-data w-12 shrink-0 text-right text-[11.5px] text-zinc-500 tabular-nums">{formatDuration(Math.max(0, Math.round(durationMs)))}</span>
          )}
          <CaretRight
            size={12}
            weight="bold"
            className={`shrink-0 text-zinc-300 transition-transform duration-200 group-hover:text-zinc-500 ${open ? 'rotate-90' : ''}`}
          />
        </button>
      </div>

      {artifact && (
        <div className="-mt-1 flex px-3 pb-2 pl-[2.875rem]">
          <button
            type="button"
            onClick={() => onOpenArtifact?.(artifact)}
            disabled={!onOpenArtifact}
            className="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-zinc-950/[0.04] px-2 text-[11.5px] font-medium text-zinc-700 ring-1 ring-[var(--color-line)] transition-colors hover:bg-sky-50 hover:text-sky-800 hover:ring-sky-200 disabled:pointer-events-none"
            title={onOpenArtifact ? 'Open in Workspace' : undefined}
          >
            <span className="shrink-0 text-zinc-500">{ARTIFACT_ICON[artifact.kind]}</span>
            <span className="shrink-0 text-zinc-500">{ARTIFACT_NOUN[artifact.kind]} ·</span>
            <span className="truncate">{artifact.label}</span>
          </button>
        </div>
      )}

      {open && (
        <div className={`animate-fade ${needsDecision ? '' : 'border-t border-[var(--color-line)]'}`}>
          {needsDecision && approval ? (
            <div className="px-4 pt-1 pb-4">
              <p className="mb-3 text-[13px] text-zinc-600">
                <span className="font-semibold text-zinc-950">Needs your approval.</span> The run is paused here. Review what this call will
                do, then approve or deny it in the bar above the message box.
              </p>
              <ApprovalDetails args={approval.pending.tool_args} preview={approval.pending.preview ?? call.approvalPreview} />
            </div>
          ) : (
            <div className="space-y-3 px-3 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                <span>step {call.step}</span>
                {call.attempts > 1 && <span>{call.attempts} attempts</span>}
                {call.approvalOutcome && (
                  <span className={call.approvalOutcome === 'granted' ? 'text-emerald-700' : 'text-rose-700'}>
                    {call.approvalOutcome === 'granted' ? 'Approved' : 'Denied'}
                    {call.decidedAt ? ` at ${clock(call.decidedAt)}` : ''}
                  </span>
                )}
                {call.status === 'awaiting_approval' && <span className="text-amber-700">Waiting for a decision</span>}
                {onInspect && (
                  <button
                    type="button"
                    onClick={onInspect}
                    className="ml-auto inline-flex items-center gap-1 rounded font-medium text-zinc-500 hover:text-zinc-900"
                  >
                    <ArrowSquareOut size={12} weight="bold" />
                    Open in inspector
                  </button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {call.args && <JsonTree value={call.args} label="Arguments" />}
                {call.result != null && <JsonTree value={call.result} label="Result" />}
              </div>
              {call.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-200 ring-inset">{call.error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
