import { CheckCircle, CircleDashed, Eye, Info, Warning, WarningDiamond, WarningOctagon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { statusLabel } from '../../lib/incident-lifecycle'

const SEVERITY_META: Record<string, { icon: ReactNode; className: string }> = {
  low: { icon: <Info size={12} weight="bold" />, className: 'bg-zinc-100 text-zinc-700' },
  medium: { icon: <Warning size={12} weight="bold" />, className: 'bg-amber-100/70 text-amber-800' },
  high: { icon: <WarningDiamond size={12} weight="bold" />, className: 'bg-orange-100/70 text-orange-800' },
  critical: { icon: <WarningOctagon size={12} weight="bold" />, className: 'bg-rose-100/70 text-rose-800' },
}

const STATUS_META: Record<string, { icon: ReactNode; className: string }> = {
  open: { icon: <CircleDashed size={13} weight="bold" className="text-rose-600" />, className: 'text-zinc-800' },
  acknowledged: { icon: <Eye size={13} weight="bold" className="text-amber-600" />, className: 'text-zinc-800' },
  resolved: { icon: <CheckCircle size={13} weight="fill" className="text-emerald-600" />, className: 'text-zinc-800' },
}

const FALLBACK = { icon: <Info size={12} weight="bold" />, className: 'bg-zinc-100 text-zinc-700' }
const BASE = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap'

/** Icon + label so severity is never conveyed by colour alone. */
export function SeverityBadge({ severity }: { severity: string }) {
  const meta = SEVERITY_META[severity] ?? FALLBACK
  return (
    <span className={`${BASE} ${meta.className}`}>
      {meta.icon}
      <span className="capitalize">{severity}</span>
    </span>
  )
}

export function IncidentStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? FALLBACK
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${meta.className}`}>
      {meta.icon}
      {statusLabel(status)}
    </span>
  )
}
