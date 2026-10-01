import { MagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import type { ChatSession } from '../lib/api-types'
import { isPaletteShortcut, moveIndex, rankItems, type PaletteItem } from '../lib/command-palette'
import { PALETTE_ACTIONS, PALETTE_PAGES } from './nav-config'

const GROUP_ORDER: PaletteItem['group'][] = ['Approvals', 'Actions', 'Pages', 'Sessions']

function sessionItems(sessions: ChatSession[]): PaletteItem[] {
  return sessions.map((s) => ({
    id: `session:${s.id}`,
    label: s.title,
    to: s.last_run_id ? `/runs/${s.last_run_id}` : '/sessions',
    group: 'Sessions',
    hint: s.status.replace(/_/g, ' '),
  }))
}

/** Ctrl+K (Cmd+K) command palette: jump to any page or session by typing. Pages
 * come from the navigation config; sessions are fetched each time it opens, so
 * they are always current. Arrow keys move, Enter opens, Escape closes. */
export function CommandPalette() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isPaletteShortcut(event)) {
        event.preventDefault()
        setOpen((wasOpen) => {
          if (!wasOpen) returnFocusRef.current = document.activeElement as HTMLElement | null
          return !wasOpen
        })
      }
    }
    const onOpenRequest = () => {
      returnFocusRef.current = document.activeElement as HTMLElement | null
      setOpen(true)
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('open-command-palette', onOpenRequest)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('open-command-palette', onOpenRequest)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .listSessions({ archived: 'include' })
      .then((list) => {
        if (!cancelled) setSessions(list)
      })
      .catch(() => {
        /* pages still work without the session list */
      })
    inputRef.current?.focus()
    return () => {
      cancelled = true
    }
  }, [open])

  const items = useMemo<PaletteItem[]>(
    () => [
      ...PALETTE_ACTIONS.map((a) => ({ id: `action:${a.to}`, label: a.label, to: a.to, group: 'Actions' as const, keywords: a.keywords })),
      ...PALETTE_PAGES.map((p) => ({ id: `page:${p.to}`, label: p.label, to: p.to, group: 'Pages' as const, keywords: p.keywords })),
      ...sessionItems(sessions),
    ],
    [sessions],
  )
  const results = useMemo(() => rankItems(items, query, 14), [items, query])
  const ordered = useMemo(
    () => GROUP_ORDER.flatMap((group) => results.filter((r) => r.group === group)),
    [results],
  )

  const close = () => {
    setOpen(false)
    setQuery('')
    setActive(0)
    returnFocusRef.current?.focus?.()
  }

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return
    navigate(item.to)
    close()
  }

  if (!open) return null

  const activeId = ordered[active] ? `palette-option-${ordered[active].id}` : undefined

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="presentation" data-command-palette="">
      <button type="button" aria-label="Close command palette" className="absolute inset-0 animate-fade bg-zinc-950/20" onClick={close} />
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="ui-glass relative w-full max-w-xl animate-pop overflow-hidden rounded-[20px]">
        <div className="flex items-center gap-2.5 border-b border-[var(--color-line)] px-4">
          <MagnifyingGlass size={16} weight="bold" className="shrink-0 text-zinc-500" aria-hidden="true" />
          <input
            ref={inputRef}
            name="command-palette-query"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-activedescendant={activeId}
            aria-label="Search pages, sessions and actions"
            placeholder="Search pages, sessions and actions…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => moveIndex(i, 1, ordered.length))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => moveIndex(i, -1, ordered.length))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(ordered[active])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
            className="h-13 min-w-0 flex-1 bg-transparent text-[15px] text-zinc-900 outline-none placeholder:text-zinc-500"
          />
          <kbd className="ui-kbd">Esc</kbd>
        </div>
        <ul id="palette-listbox" role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto overscroll-contain p-1.5">
          {ordered.length === 0 && <li className="px-3 py-6 text-center text-sm text-zinc-600">Nothing matches “{query}”.</li>}
          {ordered.map((item, index) => {
            const heading = item.group !== ordered[index - 1]?.group ? item.group : null
            return (
              <li key={item.id} role="presentation">
                {heading && <p className="ui-section-label px-2.5 pt-2 pb-1">{heading}</p>}
                <button
                  type="button"
                  id={`palette-option-${item.id}`}
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(item)}
                  className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left text-sm transition-colors duration-100 ${
                    index === active ? 'bg-white text-zinc-950 shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-line)]' : 'text-zinc-700'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-xs text-zinc-600">{item.hint}</span>}
                </button>
              </li>
            )
          })}
        </ul>
        <p className="flex items-center gap-1.5 border-t border-[var(--color-line)] px-4 py-2 text-xs text-zinc-500">
          <kbd className="ui-kbd">↑↓</kbd> move · <kbd className="ui-kbd">Enter</kbd> open · <kbd className="ui-kbd">Ctrl K</kbd> toggle · <kbd className="ui-kbd">?</kbd> shortcuts
        </p>
      </div>
    </div>
  )
}
