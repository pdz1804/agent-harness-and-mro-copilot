import type { RunStatus } from '../lib/api-types'

const STATUS_META: Record<RunStatus, { label: string; className: string; pulse?: boolean }> = {
  running: {
    label: 'Running',
    className: 'bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-500/30',
    pulse: true,
  },
  pending_approval: {
    label: 'Pending approval',
    className: 'bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/30',
    pulse: true,
  },
  completed: {
    label: 'Completed',
    className: 'bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/30',
  },
  step_limit_exceeded: {
    label: 'Step limit exceeded',
    className: 'bg-orange-500/10 text-orange-300 ring-1 ring-inset ring-orange-500/30',
  },
  time_limit_exceeded: {
    label: 'Time limit exceeded',
    className: 'bg-orange-500/10 text-orange-300 ring-1 ring-inset ring-orange-500/30',
  },
  llm_error_exceeded: {
    label: 'LLM error limit',
    className: 'bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-500/30',
  },
  failed: {
    label: 'Failed',
    className: 'bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-500/30',
  },
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap ${meta.className}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${meta.pulse ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {meta.label}
    </span>
  )
}
