import { CaretDown, CaretRight, ChatsCircle, List, MagnifyingGlass, NotePencil, SidebarSimple, Warning, X } from '@phosphor-icons/react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { api } from '../lib/api'
import { CommandPalette } from './CommandPalette'
import { NAV_GROUPS, PALETTE_PAGES } from './nav-config'
import { PendingApprovalsBadge } from './PendingApprovalsBadge'
import { UserSwitcher } from './UserSwitcher'
import type { ChatSession, HealthResponse, UsageToday } from '../lib/api-types'

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

/** Sidebar's Sessions subtabs: the last handful of sessions, like a chat
 * product's conversation list — critically, each one's *live* status
 * (`GET /sessions` recomputes it server-side every call, merging the
 * in-memory RunRegistry with Postgres; see api.py::_session_live_status),
 * not a one-shot snapshot. Polling on a short interval (independent of
 * whichever page is open) is what makes a session correctly keep showing as
 * running/pending_approval after a reload or in a second tab, per PRD 4.4. */
function useRecentSessions(routeKey: string): ChatSession[] {
  const [sessions, setSessions] = useState<ChatSession[]>([])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      api
        .listSessions()
        .then((data) => {
          if (!cancelled) setSessions(data.slice(0, 5))
        })
        .catch(() => {
          /* sidebar sessions list is best-effort; a failed fetch just keeps the last list */
        })
    }
    load()
    const interval = setInterval(load, 4_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  return sessions
}

const SESSION_DOT_CLASS: Record<ChatSession['status'], string> = {
  idle: 'bg-zinc-300',
  running: 'bg-sky-500 animate-pulse',
  pending_approval: 'bg-amber-500 animate-pulse',
  completed: 'bg-emerald-500',
  step_limit_exceeded: 'bg-orange-500',
  time_limit_exceeded: 'bg-orange-500',
  llm_error_exceeded: 'bg-rose-500',
  failed: 'bg-rose-500',
  guardrail_blocked: 'bg-fuchsia-500',
  cancelled: 'bg-zinc-400',
}

/** Compact token-usage readout: today's running total across every session,
 * backed by the already-tested `GET /usage/today` (11d) — real Postgres
 * aggregation, not a client-side sum. Polls the same cadence as health. */
function useUsageToday(): UsageToday | null {
  const [usage, setUsage] = useState<UsageToday | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      api
        .getUsageToday()
        .then((data) => {
          if (!cancelled) setUsage(data)
        })
        .catch(() => {
          /* usage widget is best-effort; keep the last known value on a failed poll */
        })
    }
    load()
    const interval = setInterval(load, 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return usage
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'

/** Active state is a raised white pill with a hairline; inactive rows are
 * quiet text that tint on hover. Collapsed: icon-only, label in the tooltip. */
const navItemClass =
  (collapsed: boolean) =>
  ({ isActive }: { isActive: boolean }) =>
    `flex h-[30px] items-center gap-2.5 rounded-lg text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 ${
      collapsed ? 'w-9 justify-center' : 'px-2.5'
    } ${
      isActive
        ? 'bg-zinc-950/[0.065] text-zinc-950 [&>svg]:text-sky-600'
        : 'text-zinc-600 hover:bg-zinc-950/[0.04] hover:text-zinc-950 [&>svg]:text-zinc-500 hover:[&>svg]:text-zinc-700'
    }`

function BrandMark() {
  return (
    <svg viewBox="0 0 28 28" className="h-7 w-7 shrink-0" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="oklch(0.148 0.011 272)" />
      <path d="M8 19 14 8l6 11" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.8 14.4h6.4" stroke="oklch(0.74 0.14 280)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

function SidebarContent({
  collapsed = false,
  onNavigate,
  onToggleCollapsed,
  usage,
  health,
}: {
  collapsed?: boolean
  onNavigate?: () => void
  onToggleCollapsed?: () => void
  usage: UsageToday | null
  health: HealthState
}) {
  const location = useLocation()
  const [sessionsOpen, setSessionsOpen] = useState(true)
  const sessions = useRecentSessions(location.pathname)
  const itemClass = navItemClass(collapsed)
  const newRun = NAV_GROUPS[0].items[0]

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className={`flex h-14 shrink-0 items-center gap-2.5 ${collapsed ? 'justify-center px-2' : 'pr-2 pl-4'}`}>
        <Link to="/chat" onClick={onNavigate} className="flex min-w-0 items-center gap-2.5 rounded-lg" aria-label="Agent Harness — new run">
          <BrandMark />
          {!collapsed && (
            <span className="min-w-0 leading-tight">
              <span className="block truncate font-[family-name:var(--font-display)] text-[14px] font-semibold tracking-[-0.01em] text-zinc-950">
                Agent Harness
              </span>
              <span className="block truncate text-[11px] text-zinc-500">Ops console</span>
            </span>
          )}
        </Link>
        {!collapsed && onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-900"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <SidebarSimple size={16} />
          </button>
        )}
      </div>

      <div className={`shrink-0 pb-1 ${collapsed ? 'px-2' : 'px-3'}`}>
        <NavLink
          to={newRun.to}
          end
          onClick={onNavigate}
          title={collapsed ? newRun.label : undefined}
          aria-label={collapsed ? newRun.label : undefined}
          className={`flex h-9 items-center gap-2 rounded-lg bg-zinc-950 text-[13px] font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12),var(--shadow-sm)] transition-[background-color,transform] duration-150 hover:bg-zinc-800 active:scale-[0.98] ${
            collapsed ? 'w-9 justify-center' : 'px-3'
          }`}
        >
          <NotePencil size={16} weight="bold" className="text-sky-300" />
          {!collapsed && <span className="flex-1">{newRun.label}</span>}
        </NavLink>
      </div>

      <nav className={`flex-1 overflow-x-hidden overflow-y-auto pb-4 ${collapsed ? 'px-2' : 'px-3'}`} aria-label="Workspace">
        {!collapsed && (
          <div className="pt-3">
            <button
              type="button"
              onClick={() => setSessionsOpen((v) => !v)}
              aria-expanded={sessionsOpen}
              className="flex h-7 w-full items-center gap-1 rounded-md px-2.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900"
            >
              <span className="flex-1 text-left">Recent sessions</span>
              <CaretDown size={11} weight="bold" className={`transition-transform duration-200 ${sessionsOpen ? '' : '-rotate-90'}`} />
            </button>
            {sessionsOpen && (
              <div className="mt-0.5 space-y-px">
                {sessions.length === 0 && <p className="px-2.5 py-1.5 text-xs text-zinc-500">No sessions yet</p>}
                {sessions.map((session) => (
                  <NavLink
                    key={session.id}
                    to={`/sessions/${session.id}`}
                    onClick={onNavigate}
                    title={session.title}
                    // `min-w-0` on the flex row *and* the truncate span: without
                    // it a long title overflows the fixed-width sidebar and its
                    // link swallows clicks meant for the main column.
                    className={({ isActive }) =>
                      `flex h-7 min-w-0 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors duration-150 ${
                        isActive
                          ? 'bg-zinc-950/[0.065] font-medium text-zinc-950'
                          : 'text-zinc-600 hover:bg-zinc-950/[0.04] hover:text-zinc-950'
                      }`
                    }
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SESSION_DOT_CLASS[session.status]}`} aria-hidden="true" />
                    <span className="min-w-0 truncate">{session.title}</span>
                  </NavLink>
                ))}
                <NavLink
                  to="/sessions"
                  end
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors ${
                      isActive ? 'text-sky-700' : 'text-zinc-500 hover:text-zinc-900'
                    }`
                  }
                >
                  All sessions
                  <CaretRight size={10} weight="bold" />
                </NavLink>
              </div>
            )}
          </div>
        )}
        {collapsed && (
          <div className="mt-2">
            <NavLink to="/sessions" onClick={onNavigate} title="Sessions" aria-label="Sessions" className={itemClass}>
              <ChatsCircle size={17} />
            </NavLink>
          </div>
        )}

        {NAV_GROUPS.slice(1).map((group) => (
          <div key={group.label} className={`space-y-px ${collapsed ? 'mt-2 border-t border-[var(--color-line)] pt-2' : 'mt-3'}`}>
            {!collapsed && <p className="flex h-6 items-center px-2.5 text-xs font-medium text-zinc-500">{group.label}</p>}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={itemClass}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                aria-label={collapsed ? item.label : undefined}
              >
                <item.icon size={17} className="shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className={`shrink-0 border-t border-[var(--color-line)] ${collapsed ? 'flex flex-col items-center gap-2 px-2 py-3' : 'space-y-1.5 px-3 py-3'}`}>
        {!collapsed && (
          <div className="flex items-center justify-between gap-2 px-2.5 text-[11px] text-zinc-500">
            <span
              className="flex items-center gap-1.5"
              title={health === 'ok' ? 'Backend reachable' : health === 'down' ? 'Backend unreachable' : 'Checking backend…'}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  health === 'ok' ? 'bg-emerald-500' : health === 'down' ? 'bg-rose-500' : 'bg-zinc-300'
                }`}
                aria-hidden="true"
              />
              {health === 'ok' ? 'API online' : health === 'down' ? 'API offline' : 'Checking…'}
            </span>
            {usage && (
              <span
                className="font-data tabular-nums"
                title={`Today: ${usage.llm_calls} LLM call${usage.llm_calls === 1 ? '' : 's'} across ${usage.run_count} run${usage.run_count === 1 ? '' : 's'} (prompt ${usage.prompt_tokens} + completion ${usage.completion_tokens})`}
              >
                {usage.total_tokens.toLocaleString()} tokens today
              </span>
            )}
          </div>
        )}
        <UserSwitcher compact={collapsed} />
        {collapsed && onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex h-8 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-900"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <SidebarSimple size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

/** Breadcrumb trail derived from the route: section → page (→ detail). */
const DETAIL_LABEL: Record<string, string> = {
  '/evals': 'Eval run',
  '/dashboards': 'Dashboard',
  '/incidents': 'Incident',
  '/knowledge': 'Document',
  '/prompts': 'Prompt',
  '/sessions': 'Conversation',
}

function useBreadcrumbs(): { label: string; to?: string }[] {
  const { pathname } = useLocation()
  if (pathname === '/' || pathname === '/chat') return [{ label: 'New run' }]
  if (pathname.startsWith('/runs/')) return [{ label: 'Sessions', to: '/sessions' }, { label: 'Conversation' }]
  // Longest matching page prefix (so /settings/integrations and /evals/runs/x both resolve).
  const page = [...PALETTE_PAGES]
    .sort((a, b) => b.to.length - a.to.length)
    .find((p) => pathname === p.to || pathname.startsWith(`${p.to}/`))
  if (!page) return [{ label: 'Agent Harness' }]
  const group = NAV_GROUPS.find((g) => g.items.some((i) => i.to === page.to))?.label
  const trail: { label: string; to?: string }[] = []
  if (group) trail.push({ label: group })
  const isDetail = pathname !== page.to
  trail.push({ label: page.label, to: isDetail ? page.to : undefined })
  if (isDetail) trail.push({ label: DETAIL_LABEL[page.to] ?? 'Detail' })
  return trail
}

export function AppShell({ children }: { children: ReactNode }) {
  const { state, health } = useBackendHealth()
  const usage = useUsageToday()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useLocalStorageState('sidebar.collapsed', false)
  const crumbs = useBreadcrumbs()

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-canvas)]">
      <CommandPalette />
      {/* Desktop sidebar: persistent and collapsible; an overlay below md. */}
      <aside
        className={`hidden shrink-0 overflow-hidden transition-[width] duration-200 md:flex ${collapsed ? 'w-[3.25rem]' : 'w-60 lg:w-64'}`}
        aria-label="Primary"
      >
        <SidebarContent collapsed={collapsed} onToggleCollapsed={() => setCollapsed(!collapsed)} usage={usage} health={state} />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 animate-fade bg-zinc-950/30 backdrop-blur-[2px]"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] animate-rise flex-col bg-[var(--color-canvas)] shadow-[var(--shadow-xl)]">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute top-3 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-950/5"
              aria-label="Close navigation"
            >
              <X size={16} weight="bold" />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} usage={usage} health={state} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-sheet)] md:my-2 md:mr-2 md:rounded-xl md:shadow-[var(--shadow-card)] md:ring-1 md:ring-[var(--color-line)]">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-2 md:px-5">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-950/5 md:hidden"
            aria-label="Open navigation"
          >
            <List size={20} weight="bold" />
          </button>
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
              {crumbs.map((c, i) => (
                <li key={`${c.label}-${i}`} className={`flex min-w-0 items-center gap-1.5 ${i < crumbs.length - 1 ? 'hidden sm:flex' : ''}`}>
                  {i > 0 && (
                    <span className="hidden text-zinc-300 sm:inline" aria-hidden="true">
                      /
                    </span>
                  )}
                  {c.to ? (
                    <Link to={c.to} className="truncate text-zinc-500 transition-colors hover:text-zinc-900">
                      {c.label}
                    </Link>
                  ) : (
                    <span
                      className={`truncate ${i === crumbs.length - 1 ? 'font-medium text-zinc-900' : 'text-zinc-500'}`}
                      aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                    >
                      {c.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <PendingApprovalsBadge />
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('open-command-palette'))}
            aria-label="Open command palette (Ctrl+K)"
            className="flex h-8 min-w-8 items-center justify-center gap-2 rounded-lg bg-zinc-950/[0.035] px-2 text-[13px] text-zinc-500 ring-1 ring-[var(--color-line)] transition-colors hover:bg-zinc-950/[0.06] hover:text-zinc-800 sm:w-60 sm:justify-start sm:pr-1.5 sm:pl-2.5"
          >
            <MagnifyingGlass size={14} weight="bold" />
            <span className="hidden flex-1 text-left sm:inline">Search or jump to…</span>
            <kbd className="ui-kbd hidden sm:inline-flex">{MOD_KEY} K</kbd>
          </button>
        </header>

        {state === 'ok' && health && !health.llm_configured && (
          <div className="mx-4 mt-4 flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200 md:mx-8">
            <Warning size={16} weight="fill" className="shrink-0 text-amber-600" />
            <span>
              LLM not configured — set <code className="font-data">OPENAI_API_KEY</code> in
              <code className="font-data"> agent-harness/.env</code> (copy from <code className="font-data">.env.example</code>) and
              restart the server to run real objectives.
            </span>
          </div>
        )}

        {state === 'ok' && health?.llm_configured && health.llm_last_error && (
          <div className="mx-4 mt-4 flex items-center gap-2 rounded-lg bg-rose-50 px-4 py-2.5 text-sm text-rose-900 ring-1 ring-rose-200 md:mx-8">
            <Warning size={16} weight="fill" className="shrink-0 text-rose-600" />
            <span>
              LLM configured but the last provider call failed: <code className="font-data">{health.llm_last_error}</code>
            </span>
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">{children}</main>

        <footer className="flex shrink-0 items-center justify-between gap-x-4 border-t border-[var(--color-line)] px-4 py-1.5 text-[11px] text-zinc-500 md:px-5">
          <span className="min-w-0 flex-1 truncate" title="Services, incidents, and the knowledge base are seeded with mock data — the agent, its retrieval, and its persistence are all real.">
            Services, incidents, and the knowledge base are seeded with mock data — the agent, its retrieval, and its persistence are
            all real.
          </span>
          <span className="shrink-0 font-medium text-zinc-600">Phu Nguyen — HCMC, VN</span>
        </footer>
      </div>
    </div>
  )
}
