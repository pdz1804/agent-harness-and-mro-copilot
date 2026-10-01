import { Check, Copy } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'

export type ChipTone = 'neutral' | 'iris' | 'ok' | 'warn' | 'danger' | 'orange' | 'violet' | 'muted'

const TONE: Record<ChipTone, string> = {
  neutral: 'bg-zinc-950/[0.05] text-zinc-700 ring-zinc-950/[0.06]',
  iris: 'bg-sky-50 text-sky-700 ring-sky-200/80',
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200/80',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200/80',
  danger: 'bg-rose-50 text-rose-700 ring-rose-200/80',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200/80',
  violet: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200/80',
  muted: 'bg-transparent text-zinc-500 ring-zinc-950/10',
}

const DOT: Record<ChipTone, string> = {
  neutral: 'bg-zinc-400',
  iris: 'bg-sky-500',
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  danger: 'bg-rose-500',
  orange: 'bg-orange-500',
  violet: 'bg-fuchsia-500',
  muted: 'bg-zinc-300',
}

interface ChipProps {
  tone?: ChipTone
  /** Leading status dot. `live` adds the run pulse (only while streaming). */
  dot?: boolean
  live?: boolean
  icon?: ReactNode
  mono?: boolean
  title?: string
  className?: string
  children: ReactNode
}

/** The one chip: compact metadata tokens (status, tags, versions, counts).
 * Pill radius, 22px tall, tone from a fixed palette. */
export function Chip({ tone = 'neutral', dot, live, icon, mono, title, className = '', children }: ChipProps) {
  return (
    <span
      title={title}
      className={`inline-flex h-[1.375rem] max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap ring-1 ring-inset ${TONE[tone]} ${mono ? 'font-data' : ''} ${className}`}
    >
      {dot && <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]} ${live ? 'ui-live-dot text-current' : ''}`} />}
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

/** An ID in monospace that copies itself on click ("Copied" for 1.2 s). */
export function CopyId({ value, className = '', label }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          },
          () => {
            /* clipboard denied (insecure context): the id is still selectable */
          },
        )
      }}
      title={copied ? 'Copied' : `Copy ${label ?? 'ID'}`}
      aria-label={copied ? 'Copied' : `Copy ${label ?? 'ID'} ${value}`}
      className={`group/copy font-data inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-1 text-[12px] text-zinc-600 transition-colors hover:bg-zinc-950/[0.05] hover:text-zinc-900 ${className}`}
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check size={11} weight="bold" className="shrink-0 text-emerald-600" />
      ) : (
        <Copy size={11} className="shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-70 group-focus-visible/copy:opacity-70" />
      )}
    </button>
  )
}
