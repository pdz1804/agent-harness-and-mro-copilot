import { ArrowDown, ArrowUp, ArrowsDownUp } from '@phosphor-icons/react'
import type { HTMLAttributes, KeyboardEvent, MouseEvent, ReactNode, ThHTMLAttributes } from 'react'
import type { SortState } from '../../lib/table-sort'

/** Table in its rounded (14px) container. The container owns horizontal
 * overflow; the page owns vertical scroll, and the header is sticky. */
export function Table({ children, className = '', label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div className={`ui-table-wrap ${className}`}>
      <table className="ui-table w-full" aria-label={label}>
        {children}
      </table>
    </div>
  )
}

interface SortHeaderProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** The column key this header sorts by. */
  column: string
  sort: SortState | null
  onSort: (column: string) => void
  children: ReactNode
  align?: 'left' | 'right'
}

/** A sortable column header with a direction indicator and `aria-sort`. */
export function SortHeader({ column, sort, onSort, children, align = 'left', className = '', ...rest }: SortHeaderProps) {
  const active = sort?.column === column
  const Icon = !active ? ArrowsDownUp : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={className} {...rest}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 rounded transition-colors hover:text-zinc-900 ${align === 'right' ? 'flex-row-reverse' : ''} ${active ? 'text-zinc-900' : ''}`}
      >
        {children}
        <Icon size={11} weight="bold" className={active ? 'text-sky-600' : 'opacity-40'} />
      </button>
    </th>
  )
}

interface RowProps extends Omit<HTMLAttributes<HTMLTableRowElement>, 'onClick'> {
  /** Whole-row click opens the detail sheet. Clicks on inner buttons, links,
   * inputs and the row-actions menu don't count. Enter does the same. */
  onOpen?: () => void
  selected?: boolean
  /** Briefly highlight a row whose data just changed. */
  flash?: boolean
  children: ReactNode
}

function fromInteractive(target: EventTarget | null, row: HTMLElement): boolean {
  let el = target as HTMLElement | null
  while (el && el !== row) {
    if (el.matches('a, button, input, select, textarea, label, [role="menuitem"], [data-no-row-open]')) return true
    el = el.parentElement
  }
  return false
}

export function Row({ onOpen, selected, flash, children, className = '', ...rest }: RowProps) {
  const onClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if (!onOpen || fromInteractive(e.target, e.currentTarget)) return
    if (window.getSelection()?.toString()) return // the user is selecting text
    onOpen()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (onOpen && e.key === 'Enter' && e.target === e.currentTarget) onOpen()
  }
  return (
    <tr
      data-clickable={onOpen ? '' : undefined}
      data-flash={flash ? '' : undefined}
      aria-selected={selected || undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`group ${className}`}
      {...rest}
    >
      {children}
    </tr>
  )
}

/** A row-selection checkbox (bulk actions). */
export function SelectBox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked
      }}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 cursor-pointer rounded-[4px] align-middle"
    />
  )
}
