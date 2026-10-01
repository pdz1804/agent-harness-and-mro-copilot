import { HandPalm } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { usePendingApprovals } from '../hooks/usePendingApprovals'
import { badgeLabel, singleTarget, tabTitle, waitingFor } from '../lib/pending-approvals'

/** Live header badge: appears while one or more runs are paused on a human
 * approval the signed-in user can resolve. One waiting run: click goes straight
 * to it. Several: click opens a list linking to each. Also puts the count in the
 * browser tab title so a waiting approval is visible from another tab. */
export function PendingApprovalsBadge() {
  const items = usePendingApprovals()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const baseTitle = useRef(document.title)

  useEffect(() => {
    document.title = tabTitle(baseTitle.current, items.length)
    return () => {
      document.title = baseTitle.current
    }
  }, [items.length])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (items.length === 0) return null
  const target = singleTarget(items)
  const label = badgeLabel(items.length)

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="pending-approvals-badge"
        aria-label={label}
        aria-haspopup={target ? undefined : 'menu'}
        aria-expanded={target ? undefined : open}
        onClick={() => (target ? navigate(target) : setOpen((v) => !v))}
        className="inline-flex h-8 animate-rise items-center gap-2 rounded-full bg-amber-50 pr-3 pl-2 text-xs font-medium text-amber-900 ring-1 ring-amber-300/80 ring-inset transition-colors duration-150 hover:bg-amber-100"
      >
        <span className="relative flex h-2 w-2" aria-hidden="true"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" /></span>
        <HandPalm size={14} weight="bold" aria-hidden="true" />
        <span className="tabular-nums">{items.length}</span>
        <span className="hidden sm:inline">{items.length === 1 ? 'approval waiting' : 'approvals waiting'}</span>
      </button>
      {open && !target && (
        <div
          role="menu"
          aria-label="Runs waiting for approval"
          className="absolute top-full right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] animate-rise rounded-xl border border-[var(--color-line)] bg-white p-1 shadow-[var(--shadow-lg)]"
        >
          <p className="ui-section-label px-2.5 pt-2 pb-1">Waiting for your decision</p>
          <ul>
            {items.map((item) => (
              <li key={item.run_id}>
                <Link
                  to={`/runs/${item.run_id}`}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-2.5 py-2 transition-colors duration-150 hover:bg-zinc-100"
                >
                  <span className="block truncate text-sm font-medium text-zinc-900">{item.objective}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-xs text-zinc-600">
                    <span className="font-data">{item.tool_name}</span>
                    <span className="tabular-nums">waiting {waitingFor(item.started_at)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
