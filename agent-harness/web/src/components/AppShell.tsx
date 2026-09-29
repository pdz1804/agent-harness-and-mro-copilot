import {
  BookOpen,
  ClockCounterClockwise,
  ListMagnifyingGlass,
  PlusCircle,
  Pulse,
  Terminal,
  Warning,
} from '@phosphor-icons/react'
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { api } from '../lib/api'
import type { HealthResponse } from '../lib/api-types'

type HealthState = 'checking' | 'ok' | 'down'

function useBackendHealth(): { state: HealthState; health: HealthResponse | null } {
  const [state, setState] = useState<HealthState>('checking')
  const [health, setHealth] = useState<HealthResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const result = await api.health()
        if (!cancelled) {
          setHealth(result)
          setState('ok')
        }
      } catch {
        if (!cancelled) setState('down')
      }
    }
    void check()
    const interval = setInterval(check, 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return { state, health }
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
    isActive ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
  }`

export function AppShell({ children }: { children: ReactNode }) {
  const { state, health } = useBackendHealth()

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 sm:px-6">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30">
            <Terminal size={18} weight="bold" />
          </span>
          <span className="text-sm font-semibold tracking-wide text-zinc-100">Agent Harness Console</span>
        </div>
        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={navLinkClass}>
            <PlusCircle size={16} weight="bold" />
            New run
          </NavLink>
          <NavLink to="/history" className={navLinkClass}>
            <ClockCounterClockwise size={16} weight="bold" />
            History
          </NavLink>
          <NavLink to="/services" className={navLinkClass}>
            <Pulse size={16} weight="bold" />
            Services
          </NavLink>
          <NavLink to="/incidents" className={navLinkClass}>
            <Warning size={16} weight="bold" />
            Incidents
          </NavLink>
          <NavLink to="/kb" className={navLinkClass}>
            <BookOpen size={16} weight="bold" />
            Knowledge base
          </NavLink>
          <NavLink to="/logs" className={navLinkClass}>
            <ListMagnifyingGlass size={16} weight="bold" />
            Logs
          </NavLink>
          <span
            className="ml-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-500"
            title={state === 'ok' ? 'Backend reachable' : state === 'down' ? 'Backend unreachable' : 'Checking backend…'}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                state === 'ok' ? 'bg-emerald-400' : state === 'down' ? 'bg-rose-500' : 'bg-zinc-600'
              }`}
              aria-hidden="true"
            />
            API
          </span>
        </nav>
      </header>

      {state === 'ok' && health && !health.llm_configured && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-4 py-2.5 text-sm text-amber-200">
          <Warning size={16} weight="fill" className="shrink-0 text-amber-400" />
          <span>
            LLM not configured — set <code className="font-data">OPENAI_API_KEY</code> in
            <code className="font-data"> agent-harness/.env</code> (copy from{' '}
            <code className="font-data">.env.example</code>) and restart the server to run real
            objectives.
          </span>
        </div>
      )}

      {state === 'ok' && health?.llm_configured && health.llm_last_error && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/[0.06] px-4 py-2.5 text-sm text-rose-200">
          <Warning size={16} weight="fill" className="shrink-0 text-rose-400" />
          <span>
            LLM configured but the last provider call failed:{' '}
            <code className="font-data">{health.llm_last_error}</code>
          </span>
        </div>
      )}

      <main className="flex-1 py-6">{children}</main>
      <footer className="border-t border-zinc-900 py-4 text-center text-xs text-zinc-700">
        Services, incidents, and the knowledge base above are seeded with mock data — the agent, its
        retrieval, and its persistence are all real.
      </footer>
    </div>
  )
}
