import { flushDeferred } from '../lib/deferred-action'
import { Chip, type ChipTone } from './ui/Chip'
import { CaretUpDown, Check } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { invalidateSkillCommandsCache } from './chat/Composer'
import { api, ApiError } from '../lib/api'
import { getCurrentUserId, setCurrentUserId } from '../lib/identity'
import type { Me, Role, User } from '../lib/api-types'

const ROLE_TONE: Record<Role, ChipTone> = { admin: 'violet', editor: 'iris', viewer: 'neutral' }

const AVATAR_CLASS: Record<Role, string> = {
  admin: 'from-violet-500 to-sky-600',
  editor: 'from-sky-400 to-sky-600',
  viewer: 'from-zinc-400 to-zinc-500',
}

function initials(name: string | undefined): string {
  if (!name) return '·'
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function Avatar({ name, role }: { name?: string; role?: Role }) {
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-semibold text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)] ${
        role ? AVATAR_CLASS[role] : 'from-zinc-300 to-zinc-400'
      }`}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

/** Identity switcher (phase 01 RBAC), docked at the bottom of the sidebar:
 * pick which seeded user you are for this browser. Explicitly labeled
 * "identity switcher, not authentication" — the header value is trivially
 * changeable by anyone with devtools, and server-side enforcement
 * (`agent_harness.rbac`) is what actually gates every mutating route; this
 * control exists so a reviewer can demonstrate that enforcement without four
 * separate browser profiles. */
export function UserSwitcher({ compact = false }: { compact?: boolean }) {
  const [me, setMe] = useState<Me | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const reload = () => {
    Promise.all([api.me(), api.listUsers()])
      .then(([meResult, usersResult]) => {
        setMe(meResult)
        setUsers(usersResult)
        setError(false)
      })
      .catch((err) => {
        setError(true)
        if (err instanceof ApiError && err.status === 401) {
          // Whatever id was stored is unknown to the backend (e.g. a stale
          // localStorage value from a reset database) — fall back so the
          // app is usable again instead of every call 401ing forever.
          setCurrentUserId('u_admin')
        }
      })
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const switchTo = (userId: string) => {
    // Send any held Undo-able change as the current user before switching.
    flushDeferred()
    setCurrentUserId(userId)
    invalidateSkillCommandsCache()
    setOpen(false)
    reload()
  }

  if (error && !me) {
    return (
      <span className="block px-2.5 text-xs text-rose-600" title="Could not resolve identity — is the backend running?">
        {compact ? '!' : 'identity unavailable'}
      </span>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? `Signed in as ${me?.display_name ?? '…'} — switch identity` : undefined}
        className={`flex w-full items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-zinc-950/[0.045] ${
          compact ? 'h-9 w-9 justify-center' : 'h-11 px-2'
        } ${open ? 'bg-zinc-950/[0.045]' : ''}`}
        title="Local identity switcher — not authentication. Server-side RBAC enforces every mutating route regardless of which user you pick here."
      >
        <Avatar name={me?.display_name} role={me?.role} />
        {!compact && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[13px] font-medium text-zinc-900">{me?.display_name ?? '…'}</span>
              <span className="block truncate text-[11px] text-zinc-500">{me ? `${me.role} · identity switcher` : 'loading'}</span>
            </span>
            <CaretUpDown size={14} weight="bold" className="shrink-0 text-zinc-400" />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`ui-glass absolute bottom-full z-50 mb-2 w-64 animate-pop overflow-hidden rounded-[20px] p-1 ${
            compact ? 'left-0' : 'inset-x-0 w-auto'
          }`}
        >
          <p className="px-2.5 pt-1.5 pb-1 text-xs text-zinc-500">Switch identity (not a login)</p>
          {users.map((user) => {
            const current = user.id === getCurrentUserId()
            return (
              <button
                key={user.id}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                onClick={() => switchTo(user.id)}
                className={`flex w-full items-center gap-2.5 rounded-[14px] px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-zinc-950/[0.05] ${
                  current ? 'font-medium text-zinc-950' : 'text-zinc-700'
                }`}
              >
                <Avatar name={user.display_name} role={user.role} />
                <span className="min-w-0 flex-1 truncate">{user.display_name}</span>
                <Chip tone={ROLE_TONE[user.role]}>{user.role}</Chip>
                <Check size={13} weight="bold" className={current ? 'text-sky-600' : 'invisible'} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
