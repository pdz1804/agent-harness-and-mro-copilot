import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}

/** Designed empty state: a soft icon tile on a faint dotted field, a clear
 * title, one teaching sentence and (optionally) the action that fills it. */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-dashed border-[var(--color-line-strong)] bg-white px-6 py-14 text-center">
      <div
        className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(oklch(0.25_0.02_272/0.08)_1px,transparent_1px)] [background-size:16px_16px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]"
        aria-hidden="true"
      />
      <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-white text-zinc-500 shadow-[var(--shadow-sm)] ring-1 ring-[var(--color-line)]">
        {icon}
      </div>
      <p className="relative font-[family-name:var(--font-display)] text-base font-semibold tracking-[-0.01em] text-zinc-950">{title}</p>
      <p className="relative max-w-sm text-sm text-zinc-500">{description}</p>
      {action && <div className="relative mt-1">{action}</div>}
    </div>
  )
}
