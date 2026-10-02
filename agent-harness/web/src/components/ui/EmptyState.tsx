import { FunnelSimpleX, WarningCircle } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Button } from './Button'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description: ReactNode
  /** The one primary action that fills this view. */
  action?: ReactNode
  /** A concrete example ("Try: 'Why is payments-api slow?'"). */
  example?: ReactNode
  /** `compact` for side panels and sheets (no dotted field, less padding). */
  size?: 'default' | 'compact'
}

/** Truly empty: explain what lives here, one primary action, an example. */
export function EmptyState({ icon, title, description, action, example, size = 'default' }: EmptyStateProps) {
  const compact = size === 'compact'
  return (
    <div
      className={`relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-[14px] border border-dashed border-[var(--color-line-strong)] text-center ${
        compact ? 'bg-transparent px-4 py-8' : 'bg-white px-6 py-14'
      }`}
    >
      {!compact && (
        <div
          className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(oklch(0.25_0.02_272/0.08)_1px,transparent_1px)] [background-size:16px_16px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]"
          aria-hidden="true"
        />
      )}
      <div className={`relative flex items-center justify-center rounded-[14px] bg-white text-zinc-500 shadow-[var(--shadow-sm)] ring-1 ring-[var(--color-line)] ${compact ? 'h-10 w-10' : 'h-12 w-12'}`}>
        {icon}
      </div>
      <p className="relative font-[family-name:var(--font-display)] text-base font-semibold tracking-[-0.01em] text-zinc-950">{title}</p>
      <div className="relative max-w-xl text-sm text-zinc-500">{description}</div>
      {action && <div className="relative mt-1">{action}</div>}
      {example && <div className="relative max-w-xl text-xs text-zinc-500">{example}</div>}
    </div>
  )
}

/** Filtered-empty is not truly-empty: name the filter and offer to clear it. */
export function FilteredEmpty({ query, what = 'results', onClear }: { query?: string; what?: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[14px] border border-dashed border-[var(--color-line-strong)] px-6 py-10 text-center">
      <FunnelSimpleX size={20} weight="duotone" className="text-zinc-400" />
      <p className="text-sm font-medium text-zinc-900">
        No {what}
        {query ? (
          <>
            {' '}
            for <span className="font-semibold">“{query}”</span>
          </>
        ) : (
          ' match these filters'
        )}
      </p>
      <Button variant="secondary" size="sm" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  )
}

/** A failed load in place of content: human message + Retry. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-[14px] bg-rose-50/70 px-6 py-10 text-center ring-1 ring-rose-200 ring-inset">
      <WarningCircle size={20} weight="fill" className="text-rose-600" />
      <p className="max-w-xl text-sm text-rose-900 [overflow-wrap:anywhere]">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}
