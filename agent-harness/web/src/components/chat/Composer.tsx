import { ArrowUp, Lightning, Robot, Stop, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import type { Agent, SkillCommand } from '../../lib/api-types'
import { filterSkillCommands, SlashCommandMenu } from './SlashCommandMenu'

let cachedCommands: SkillCommand[] | null = null
let cachedCommandsPromise: Promise<SkillCommand[]> | null = null

/** `GET /skills/commands` cached per page load (per user identity switch —
 * see api.ts's X-User-Id — the list is RBAC-filtered server-side, so a
 * stale cache across a user switch could leak visibility; cleared by
 * `invalidateSkillCommandsCache`, called from `UserSwitcher`). */
function loadSkillCommands(): Promise<SkillCommand[]> {
  if (cachedCommands) return Promise.resolve(cachedCommands)
  if (!cachedCommandsPromise) {
    cachedCommandsPromise = api
      .listSkillCommands()
      .then((list) => {
        cachedCommands = list
        return list
      })
      .catch(() => [])
  }
  return cachedCommandsPromise
}

export function invalidateSkillCommandsCache(): void {
  cachedCommands = null
  cachedCommandsPromise = null
}

interface ComposerProps {
  agents: Agent[] | null
  agentId: string
  onAgentChange: (agentId: string) => void
  onSubmit: (text: string) => void
  submitting: boolean
  placeholder?: string
  /** Optional controlled value (e.g. NewRunPage's "example objective" chips
   * prefill the textarea from outside). Uncontrolled (internal state only)
   * when omitted. */
  value?: string
  onValueChange?: (value: string) => void
  /** While a run is in flight the send button becomes Stop. */
  running?: boolean
  onStop?: () => void
  stopping?: boolean
}

/** Shared chat composer (New run + continuing a session): a `/`-triggered
 * skill autocomplete popover on top of a plain textarea, an agent picker
 * chip, Shift+Enter for a newline. The selected skill is rendered as a chip
 * for clarity but the raw `/slug rest` text is what's actually submitted —
 * the server is the sole authority on slash-command parsing (phase 04), so
 * this component never expands or rewrites the command client-side. */
export function Composer({
  agents,
  agentId,
  onAgentChange,
  onSubmit,
  submitting,
  placeholder,
  value,
  onValueChange,
  running = false,
  onStop,
  stopping = false,
}: ComposerProps) {
  const [internalText, setInternalText] = useState('')
  const text = value ?? internalText
  const setText = onValueChange ?? setInternalText
  const [commands, setCommands] = useState<SkillCommand[] | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void loadSkillCommands().then(setCommands)
  }, [])

  const slashQuery = /^\/(\S*)$/.exec(text.split(/\s/)[0] ?? '')
  const isSlashTrigger = text.startsWith('/') && !text.includes(' ') && commands !== null
  const filtered = isSlashTrigger && slashQuery ? filterSkillCommands(commands ?? [], slashQuery[1]) : []

  useEffect(() => {
    setMenuOpen(isSlashTrigger)
    setActiveIndex(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSlashTrigger, text])

  const selectCommand = (cmd: SkillCommand) => {
    setText(`/${cmd.slug} `)
    setMenuOpen(false)
    textareaRef.current?.focus()
  }

  const trimmed = text.trim()
  const canSubmit = trimmed.length > 0 && !submitting && !running

  const submit = () => {
    if (!canSubmit) return
    onSubmit(trimmed)
    setText('')
    setMenuOpen(false)
  }

  const activeSlug = /^\/(\S+)/.exec(trimmed)?.[1]

  return (
    <div className="shrink-0">
      <div className="relative rounded-[1.25rem] bg-white shadow-[var(--shadow-lift)] ring-1 ring-[var(--color-line-strong)] transition-[box-shadow] duration-200 focus-within:shadow-[0_0_0_4px_oklch(0.608_0.192_280/0.12),var(--shadow-lift)] focus-within:ring-sky-400/70">
        {menuOpen && (
          <SlashCommandMenu
            id="slash-command-menu"
            commands={filtered}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onSelect={selectCommand}
          />
        )}
        <textarea name="message" autoComplete="off"
          ref={textareaRef}
          aria-label="Message"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? 'slash-command-menu' : undefined}
          aria-activedescendant={menuOpen && filtered.length > 0 ? `slash-command-menu-option-${activeIndex}` : undefined}
          role="combobox"
          aria-autocomplete="list"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (menuOpen && filtered.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIndex((i) => (i + 1) % filtered.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                selectCommand(filtered[activeIndex])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMenuOpen(false)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={running ? 'The agent is working… press Stop to interrupt.' : (placeholder ?? 'Message the agent… (type / for skill commands)')}
          disabled={running}
          rows={2}
          className="block max-h-48 min-h-[3.25rem] w-full resize-none rounded-t-[1.25rem] bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:outline-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
          {agents && agents.length > 0 && (
            <label className="relative inline-flex h-8 items-center rounded-full bg-zinc-950/[0.04] pl-2.5 text-xs font-medium text-zinc-700 ring-1 ring-[var(--color-line)] transition-colors hover:bg-zinc-950/[0.07]">
              <Robot size={14} weight="bold" className="pointer-events-none mr-1 shrink-0 text-sky-600" aria-hidden="true" />
              <span className="sr-only">Agent</span>
              <select
                name="agent-picker"
                id="agent-picker"
                value={agentId}
                onChange={(e) => onAgentChange(e.target.value)}
                className="h-8 max-w-[11rem] truncate rounded-full bg-transparent bg-[length:0.9rem] bg-[position:right_0.45rem_center] pl-0.5 text-xs font-medium text-zinc-800 focus:outline-none sm:max-w-[14rem]"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.is_default ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {activeSlug ? (
            <span className="inline-flex h-8 animate-rise items-center gap-1 rounded-full bg-sky-50 pr-1 pl-2.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200 ring-inset">
              <Lightning size={12} weight="fill" aria-hidden="true" />
              /{activeSlug}
              <button
                type="button"
                aria-label="Clear skill command"
                onClick={() => setText('')}
                className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-sky-100"
              >
                <X size={10} weight="bold" />
              </button>
            </span>
          ) : (
            !running && (
              <button
                type="button"
                onClick={() => {
                  setText('/')
                  textareaRef.current?.focus()
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-900"
                aria-label="Insert a skill command"
                title="Skill commands (/)"
              >
                <span className="font-data text-sm font-semibold">/</span>
              </button>
            )
          )}
          <span className="hidden flex-1 truncate px-1 text-right text-[11px] text-zinc-400 md:block">
            {running ? 'Working… you can stop it at any time.' : submitting ? 'Sending…' : 'Enter to send · Shift+Enter for a new line'}
          </span>
          <span className="flex-1 md:hidden" />
          {running ? (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              aria-label="Stop"
              title="Stop the run"
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-zinc-950 px-3.5 text-xs font-semibold text-white shadow-[var(--shadow-sm)] transition-[background-color,transform] duration-150 hover:bg-zinc-800 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Stop size={13} weight="fill" />
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              aria-label="Send"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_2px_oklch(0.35_0.15_279/0.35)] transition-[background-color,transform,opacity] duration-150 hover:bg-sky-700 active:scale-90 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 disabled:shadow-none disabled:ring-1 disabled:ring-[var(--color-line)]"
            >
              <ArrowUp size={16} weight="bold" />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-zinc-400 md:hidden">
        {running ? 'Working… you can stop it at any time.' : submitting ? 'Sending…' : 'Enter to send · / for skill commands'}
      </p>
    </div>
  )
}
