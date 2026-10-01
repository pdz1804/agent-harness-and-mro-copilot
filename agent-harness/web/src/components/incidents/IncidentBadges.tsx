import { Info, Warning, WarningDiamond, WarningOctagon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { statusLabel } from '../../lib/incident-lifecycle'
import { Chip, type ChipTone } from '../ui'

const SEVERITY_META: Record<string, { icon: ReactNode; tone: ChipTone }> = {
  low: { icon: <Info size={12} weight="bold" />, tone: 'neutral' },
  medium: { icon: <Warning size={12} weight="bold" />, tone: 'warn' },
  high: { icon: <WarningDiamond size={12} weight="bold" />, tone: 'orange' },
  critical: { icon: <WarningOctagon size={12} weight="bold" />, tone: 'danger' },
}

const STATUS_TONE: Record<string, ChipTone> = { open: 'danger', acknowledged: 'warn', resolved: 'ok' }

/** Severity keeps a soft pill with an icon, so it is never colour alone. */
export function SeverityBadge({ severity }: { severity: string }) {
  const meta = SEVERITY_META[severity] ?? SEVERITY_META.low
  return (
    <Chip tone={meta.tone} icon={meta.icon}>
      <span className="capitalize">{severity}</span>
    </Chip>
  )
}

/** Lifecycle status as dot + text. */
export function IncidentStatusBadge({ status }: { status: string }) {
  return (
    <Chip tone={STATUS_TONE[status] ?? 'neutral'} dot>
      {statusLabel(status)}
    </Chip>
  )
}
