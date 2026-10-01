import type { RunStatus } from '../lib/api-types'

const STATUS_META: Record<RunStatus, { label: string; className: string; pulse?: boolean }> = {
  running: {
    label: 'Running',
    className: 'text-sky-700',
    pulse: true,
  },
  pending_approval: {
    label: 'Pending approval',
    className: 'text-amber-700',
    pulse: true,
  },
  completed: {
    label: 'Completed',
    className: 'text-emerald-700',
  },
  step_limit_exceeded: {
    label: 'Step limit exceeded',
    className: 'text-orange-700',
  },
  time_limit_exceeded: {
    label: 'Time limit exceeded',
    className: 'text-orange-700',
  },
  llm_error_exceeded: {
    label: 'LLM error limit',
    className: 'text-rose-700',
  },
  failed: {
    label: 'Failed',
    className: 'text-rose-700',
  },
  guardrail_blocked: {
    label: 'Blocked by guardrail',
    className: 'text-fuchsia-700',
  },
  cancelled: {
    label: 'Stopped',
    className: 'text-zinc-600',
  },
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status]
  return (
    <span
      className={`inline-flex h-6 items-center gap-1.5 text-xs font-medium whitespace-nowrap ${meta.className}`}
    >
      <span
        className={`h-2 w-2 rounded-full bg-current ring-2 ring-current/15 ${meta.pulse ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {meta.label}
    </span>
  )
}
