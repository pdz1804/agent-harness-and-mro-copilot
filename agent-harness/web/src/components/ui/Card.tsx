import type { HTMLAttributes, ReactNode } from 'react'

interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'li'
  /** `none` for cards that host their own rows/table; `md` (16px) default. */
  padding?: 'none' | 'sm' | 'md' | 'lg'
  /** Lifts on hover (clickable cards). */
  interactive?: boolean
  /** Paints the focus / selected ring (deep-linked or highlighted card). */
  selected?: boolean
}

const PAD = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-5' } as const

/** The one solid content surface: 14px radius, hairline, soft shadow. Never
 * glass (glass is for floating chrome) and never nested (a card inside a card
 * loses its chrome via the .ui-card .ui-card rule). */
export function Card({ as: Tag = 'div', padding = 'md', interactive, selected, className = '', children, ...rest }: CardProps) {
  return (
    <Tag
      className={`ui-card min-w-0 ${PAD[padding]} ${interactive ? 'ui-card-hover cursor-pointer' : ''} ${
        selected ? '!border-sky-300 shadow-[0_0_0_3px_oklch(0.608_0.192_280/0.14)]' : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  )
}

/** Card section header: title (+ optional meta) left, actions right. */
export function CardHeader({ title, meta, actions, className = '' }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 ${className}`}>
      <div className="min-w-0">
        <h2 className="font-[family-name:var(--font-sans)] text-[13px] font-semibold tracking-normal text-zinc-950">{title}</h2>
        {meta && <p className="mt-0.5 text-xs text-zinc-500">{meta}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  )
}
