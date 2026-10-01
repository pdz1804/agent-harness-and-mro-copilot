import { X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { isTypingTarget } from '../../lib/keyboard'
import { Button } from './Button'

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Anywhere',
    items: [
      [`${MOD} K`, 'Search pages, sessions and actions'],
      ['?', 'Show this list'],
      ['Esc', 'Close the sheet, popover or dialog on top'],
    ],
  },
  {
    title: 'Lists and detail sheets',
    items: [
      ['Enter', 'Open the focused row'],
      ['← / →', 'Previous / next item in an open sheet'],
      ['Esc', 'Clear the selection (bulk bar)'],
    ],
  },
  {
    title: 'Chat',
    items: [
      ['Enter', 'Send'],
      ['Shift Enter', 'New line'],
      ['/', 'Skill commands'],
      ['A / D', 'Approve / deny a paused tool call'],
      [`${MOD} .`, 'Toggle the inspector'],
    ],
  },
]

/** The `?` keyboard shortcut sheet. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" data-command-palette="">
      <button type="button" aria-label="Close shortcuts" tabIndex={-1} className="absolute inset-0 animate-fade bg-zinc-950/20" onClick={() => setOpen(false)} />
      <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="ui-glass-solid relative w-full max-w-lg animate-pop rounded-[20px] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-950">Keyboard shortcuts</h2>
          <Button variant="ghost" size="sm" iconOnly icon={<X size={14} weight="bold" />} aria-label="Close" autoFocus onClick={() => setOpen(false)} />
        </div>
        <div className="space-y-4">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-1.5 font-[family-name:var(--font-sans)] text-xs font-medium tracking-normal text-zinc-500">{g.title}</h3>
              <dl className="space-y-1">
                {g.items.map(([keys, what]) => (
                  <div key={`${g.title}-${keys}-${what}`} className="flex items-center justify-between gap-4 text-[13px]">
                    <dt className="text-zinc-700">{what}</dt>
                    <dd>
                      <kbd className="ui-kbd">{keys}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
