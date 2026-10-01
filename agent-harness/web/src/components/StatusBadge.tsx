import type { RunStatus } from '../lib/api-types'
import { Chip, type ChipTone } from './ui/Chip'

const STATUS_META: Record<RunStatus, { label: string; tone: ChipTone; live?: boolean }> = {
  running: { label: 'Running', tone: 'iris', live: true },
  pending_approval: { label: 'Waiting for approval', tone: 'warn', live: true },
  completed: { label: 'Completed', tone: 'ok' },
  step_limit_exceeded: { label: 'Step limit exceeded', tone: 'orange' },
  time_limit_exceeded: { label: 'Time limit exceeded', tone: 'orange' },
  llm_error_exceeded: { label: 'LLM error limit', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  guardrail_blocked: { label: 'Blocked by guardrail', tone: 'violet' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
}

/** A run's status as a chip; live states carry the run pulse. */
export function StatusBadge({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status]
  return (
    <Chip tone={meta.tone} dot live={meta.live}>
      {meta.label}
    </Chip>
  )
}
