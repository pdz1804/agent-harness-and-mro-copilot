import { useEffect, useRef } from 'react'
import type { SkillCommand } from '../../lib/api-types'

/** Fuzzy-ish filter: every character of `query` must appear in order inside
 * the target string (case-insensitive) — cheap, dependency-free, good
 * enough for a handful of skill slugs. */
function fuzzyMatch(target: string, query: string): boolean {
  if (!query) return true
  const c = target.toLowerCase()
  let i = 0
  for (const ch of query.toLowerCase()) {
    i = c.indexOf(ch, i)
    if (i === -1) return false
    i += 1
  }
  return true
}

export function filterSkillCommands(commands: SkillCommand[], query: string): SkillCommand[] {
  return commands.filter((cmd) => fuzzyMatch(cmd.slug, query) || fuzzyMatch(cmd.name, query))
}

interface SlashCommandMenuProps {
  commands: SkillCommand[]
  activeIndex: number
  onSelect: (command: SkillCommand) => void
  onHover: (index: number) => void
  id: string
}

/** ARIA listbox popover for the composer's `/` autocomplete. Selection is
 * driven entirely by the parent (Composer) via keyboard; this component
 * only renders the list and reports hover/click. */
export function SlashCommandMenu({ commands, activeIndex, onSelect, onHover, id }: SlashCommandMenuProps) {
  const activeRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (commands.length === 0) {
    return (
      <div
        id={id}
        role="listbox"
        className="absolute bottom-full left-0 z-20 mb-2 w-72 animate-rise rounded-xl border border-[var(--color-line)] bg-white p-3 text-xs text-zinc-500 shadow-[var(--shadow-lg)]"
      >
        No matching skills.
      </div>
    )
  }

  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Skill commands"
      className="absolute bottom-full left-0 z-20 mb-2 max-h-72 w-[22rem] max-w-[calc(100vw-2rem)] animate-rise overflow-y-auto rounded-xl border border-[var(--color-line)] bg-white p-1 shadow-[var(--shadow-lg)]"
    >
      {commands.map((cmd, index) => (
        <li
          key={cmd.slug}
          ref={index === activeIndex ? activeRef : undefined}
          id={`${id}-option-${index}`}
          role="option"
          aria-selected={index === activeIndex}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(e) => {
            // mousedown (not click) so the composer textarea doesn't blur
            // and lose the slash-trigger state before onSelect runs.
            e.preventDefault()
            onSelect(cmd)
          }}
          className={`flex cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2 ${
            index === activeIndex ? 'bg-zinc-100' : ''
          }`}
        >
          <span className="flex items-center gap-1.5">
            <span className="font-data text-xs font-semibold text-sky-700">/{cmd.slug}</span>
            <span className="text-xs text-zinc-500">{cmd.name}</span>
          </span>
          <span className="truncate text-xs text-zinc-500">{cmd.description}</span>
        </li>
      ))}
    </ul>
  )
}
