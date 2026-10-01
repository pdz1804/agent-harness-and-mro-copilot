import { CaretRight, ChatsCircle, List, MagnifyingGlass, Plus, SidebarSimple, Warning, X } from '@phosphor-icons/react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { api } from '../lib/api'
import { getItemTitle, setSectionTitle, subscribeItemTitle } from '../lib/document-title'
import { groupContainsPath } from '../lib/nav-fold'
import { CommandPalette } from './CommandPalette'
import { NAV_GROUPS, PALETTE_PAGES } from './nav-config'
import { PendingApprovalsBadge } from './PendingApprovalsBadge'
import { NavGroup } from './ui/NavGroup'
import { ShortcutsDialog } from './ui/ShortcutsDialog'
import { ToastProvider } from './ui/Toast'
import { UserSwitcher } from './UserSwitcher'
import type { ChatSession, HealthResponse, UsageToday } from '../lib/api-types'

type HealthState = 'checking' | 'ok' | 'down'

/** Polls `fn` every `ms` (and once on mount); a failed poll keeps the last
 * value. Used for the shell's best-effort status readouts. */
function usePoll<T>(fn: () => Promise<T>, ms: number, key = ''): { value: T | null; failed: boolean } {
  const [value, setValue] = useState<T | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fn().then(
        (v) => {
          if (!cancelled) {
            setValue(v)
            setFailed(false)
          }
        },
        () => {
          if (!cancelled) setFailed(true)
        },
      )
    void load()
    const t = setInterval(load, ms)
    return () => {
      cancelled = true
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, key])
  return { value, failed }
}

const SESSION_DOT_CLASS: Record<ChatSession['status'], string> = {
  idle: 'bg-zinc-300',
  running: 'bg-sky-500 ui-live-dot text-sky-500',
  pending_approval: 'bg-amber-500 ui-live-dot text-amber-500',
  completed: 'bg-emerald-500',
  step_limit_exceeded: 'bg-orange-500',
  time_limit_exceeded: 'bg-orange-500',
  llm_error_exceeded: 'bg-rose-500',
  failed: 'bg-rose-500',
  guardrail_blocked: 'bg-fuchsia-500',
  cancelled: 'bg-zinc-400',
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'

/** Active = a solid white pill with an iris icon at weight 600 (reads by
 * lightness on the glass); inactive rows tint on hover. Rail: icon-only. */
const navItemClass =
  (collapsed: boolean) =>
  ({ isActive }: { isActive: boolean }) =>
    `flex h-8 min-w-0 items-center gap-2.5 rounded-[10px] text-[13px] transition-[background-color,color,box-shadow] duration-150 ${
      collapsed ? 'w-9 justify-center' : 'px-2.5'
    } ${
      isActive
        ? 'bg-white font-semibold text-zinc-950 shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-line)] [&>svg]:text-sky-600'
        : 'font-medium text-zinc-600 hover:bg-white/60 hover:text-zinc-950 [&>svg]:text-zinc-500'
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

const openPalette = () => window.dispatchEvent(new Event('open-command-palette'))

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
  const { pathname } = useLocation()
  // The sidebar's recent sessions show each one's LIVE status (the server
  // recomputes it per call), so poll on a short interval independent of the
  // open page; a failed poll just keeps the last list.
  const { value: sessionList } = usePoll(() => api.listSessions(), 4_000, pathname)
  const sessions = (sessionList ?? []).slice(0, 5)
  // Open incidents need someone: the count rides on the Incidents nav item.
  const { value: openIncidents } = usePoll(() => api.listIncidents({ status: 'open' }), 15_000, pathname)
  const badges: Record<string, number> = { '/incidents': openIncidents?.length ?? 0 }
  const itemClass = navItemClass(collapsed)
  const sessionsActive = pathname.startsWith('/sessions') || pathname.startsWith('/runs/')

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className={`flex h-14 shrink-0 items-center gap-2.5 ${collapsed ? 'justify-center px-2' : 'pr-2 pl-4'}`}>
        <Link to="/chat" onClick={onNavigate} className="flex min-w-0 items-center gap-2.5 rounded-lg" aria-label="Agent Harness, new run">
          <BrandMark />
          {!collapsed && (
            <span className="block truncate font-[family-name:var(--font-display)] text-[14px] font-semibold tracking-[-0.01em] text-zinc-950">
              Agent Harness
            </span>
          )}
        </Link>
        {!collapsed && onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-[10px] text-zinc-500 transition-colors hover:bg-white/70 hover:text-zinc-900"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <SidebarSimple size={16} />
          </button>
        )}
      </div>

      <div className={`shrink-0 space-y-1.5 pb-1 ${collapsed ? 'px-2' : 'px-3'}`}>
        <NavLink
          to="/chat"
          end
          onClick={onNavigate}
          title={collapsed ? 'New run' : undefined}
          aria-label={collapsed ? 'New run' : undefined}
          className={`ui-btn ui-btn-primary !h-9 w-full ${collapsed ? '!w-9 !px-0' : '!justify-start'}`}
        >
          <Plus size={15} weight="bold" />
          {!collapsed && <span className="flex-1 text-left">New run</span>}
        </NavLink>
        <button
          type="button"
          onClick={openPalette}
          aria-label={`Search or jump (${MOD_KEY}+K)`}
          title={collapsed ? `Search (${MOD_KEY}+K)` : undefined}
          className={`flex h-8 items-center gap-2 rounded-[10px] bg-white/55 text-[13px] text-zinc-500 ring-1 ring-[var(--color-line)] transition-colors hover:bg-white hover:text-zinc-800 ${
            collapsed ? 'w-9 justify-center' : 'w-full pr-1.5 pl-2.5'
          }`}
        >
          <MagnifyingGlass size={14} weight="bold" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Search</span>
              <kbd className="ui-kbd">{MOD_KEY} K</kbd>
            </>
          )}
        </button>
      </div>

      <nav className={`ui-fade-edges flex-1 overflow-x-hidden overflow-y-auto pt-1 pb-4 ${collapsed ? 'px-2' : 'px-3'}`} aria-label="Primary">
        {collapsed ? (
          <div className="mt-2 space-y-px">
            <NavLink to="/sessions" onClick={onNavigate} title="Sessions" aria-label="Sessions" className={itemClass}>
              <ChatsCircle size={17} />
            </NavLink>
            {NAV_GROUPS.slice(1).map((group) => (
              <div key={group.label} className="mt-2 space-y-px border-t border-[var(--color-line)] pt-2">
                {group.items.map((item) => (
                  <NavLink key={item.to} to={item.to} className={itemClass} onClick={onNavigate} title={item.label} aria-label={item.label}>
                    <item.icon size={17} className="shrink-0" />
                  </NavLink>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <>
            <NavGroup label="Sessions" count={sessions.length} active={sessionsActive}>
              {sessions.length === 0 && <p className="px-2.5 py-1.5 text-xs text-zinc-500">No sessions yet</p>}
              {sessions.map((session) => (
                <NavLink
                  key={session.id}
                  to={`/sessions/${session.id}`}
                  onClick={onNavigate}
                  title={session.title}
                  // `min-w-0` on the row and the label: a long title must
                  // truncate, not overflow into the main column.
                  className={({ isActive }) =>
                    `flex h-7 min-w-0 items-center gap-2 rounded-[10px] px-2.5 text-[13px] transition-colors duration-150 ${
                      isActive ? 'bg-white font-medium text-zinc-950 shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-line)]' : 'text-zinc-600 hover:bg-white/60 hover:text-zinc-950'
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
                  `flex h-7 items-center gap-1 rounded-[10px] px-2.5 text-xs font-medium transition-colors ${isActive ? 'text-sky-700' : 'text-zinc-500 hover:text-zinc-900'}`
                }
              >
                All sessions
                <CaretRight size={10} weight="bold" />
              </NavLink>
            </NavGroup>
            {NAV_GROUPS.slice(1).map((group) => (
              <NavGroup
                key={group.label}
                label={group.label ?? ''}
                count={group.items.length}
                active={groupContainsPath(
                  group.items.map((i) => i.to),
                  pathname,
                )}
              >
                {group.items.map((item) => (
                  <NavLink key={item.to} to={item.to} className={itemClass} onClick={onNavigate}>
                    <item.icon size={17} className="shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {(badges[item.to] ?? 0) > 0 && (
                      <span
                        className="ml-auto inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-rose-50 px-1 text-[10.5px] font-semibold text-rose-700 tabular-nums ring-1 ring-rose-200/80 ring-inset"
                        aria-label={`${badges[item.to]} open`}
                      >
                        {badges[item.to]}
                      </span>
                    )}
                  </NavLink>
                ))}
              </NavGroup>
            ))}
          </>
        )}
      </nav>

      <div className={`shrink-0 border-t border-[var(--color-line)] ${collapsed ? 'flex flex-col items-center gap-2 px-2 py-3' : 'space-y-1.5 px-3 py-3'}`}>
        {!collapsed && (
          <div className="flex items-center justify-between gap-2 px-2.5 text-[11px] text-zinc-500">
            <span className="flex items-center gap-1.5" title={health === 'ok' ? 'Backend reachable' : health === 'down' ? 'Backend unreachable' : 'Checking backend'}>
              <span className={`h-1.5 w-1.5 rounded-full ${health === 'ok' ? 'bg-emerald-500' : health === 'down' ? 'bg-rose-500' : 'bg-zinc-300'}`} aria-hidden="true" />
              {health === 'ok' ? 'API online' : health === 'down' ? 'API offline' : 'Checking…'}
            </span>
            {usage && (
              <span
                className="font-data tabular-nums"
                title={`Today: ${usage.llm_calls} LLM call${usage.llm_calls === 1 ? '' : 's'} across ${usage.run_count} run${usage.run_count === 1 ? '' : 's'} (prompt ${usage.prompt_tokens} + completion ${usage.completion_tokens})`}
              >
                {usage.total_tokens.toLocaleString()} tok today
              </span>
            )}
          </div>
        )}
        <UserSwitcher compact={collapsed} />
        {collapsed && onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex h-8 w-9 items-center justify-center rounded-[10px] text-zinc-500 transition-colors hover:bg-white/70 hover:text-zinc-900"
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

/** Breadcrumb trail derived from the route: section -> page (-> detail). */
const DETAIL_LABEL: Record<string, string> = {
  '/evals': 'Eval run',
  '/dashboards': 'Dashboard',
  '/incidents': 'Incident',
  '/knowledge': 'Document',
  '/prompts': 'Prompt',
  '/sessions': 'Conversation',
}

/** Shorten a detail title for the breadcrumb (objectives can be long). */
function crumbTitle(item: string, fallback: string): string {
  const t = item.trim()
  if (!t) return fallback
  return t.length > 48 ? `${t.slice(0, 47)}…` : t
}

function useBreadcrumbs(): { label: string; to?: string }[] {
  const { pathname } = useLocation()
  // Detail views name their item; the last crumb shows it once it has loaded.
  const item = useSyncExternalStore(subscribeItemTitle, getItemTitle)
  if (pathname === '/' || pathname === '/chat') return [{ label: 'New run' }]
  if (pathname.startsWith('/runs/')) return [{ label: 'Sessions', to: '/sessions' }, { label: crumbTitle(item, 'Conversation') }]
  // Longest matching page prefix (so /settings/integrations and /evals/runs/x both resolve).
  const page = [...PALETTE_PAGES].sort((a, b) => b.to.length - a.to.length).find((p) => pathname === p.to || pathname.startsWith(`${p.to}/`))
  if (!page) return [{ label: 'Agent Harness' }]
  const group = NAV_GROUPS.find((g) => g.items.some((i) => i.to === page.to))?.label
  const trail: { label: string; to?: string }[] = []
  if (group) trail.push({ label: group })
  const isDetail = pathname !== page.to
  trail.push({ label: page.label, to: isDetail ? page.to : undefined })
  if (isDetail) trail.push({ label: crumbTitle(item, DETAIL_LABEL[page.to] ?? 'Detail') })
  return trail
}

export function AppShell({ children }: { children: ReactNode }) {
  const health = usePoll(() => api.health(), 15_000)
  const healthState: HealthState = health.value ? (health.failed ? 'down' : 'ok') : health.failed ? 'down' : 'checking'
  const info: HealthResponse | null = health.value
  const { value: usage } = usePoll(() => api.getUsageToday(), 15_000)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useLocalStorageState('sidebar.collapsed', false)
  const crumbs = useBreadcrumbs()
  const { pathname } = useLocation()

  // Section part of the tab title; detail views add their item themselves.
  const section = crumbs.filter((c) => c.label !== 'Workspace' && c.label !== 'Build').find((c, i, list) => c.to || i === list.length - 1)?.label ?? ''
  useEffect(() => setSectionTitle(section), [section])
  // A route change closes the mobile nav drawer.
  useEffect(() => setMobileOpen(false), [pathname])

  return (
    <ToastProvider>
      <div className="flex h-dvh overflow-hidden md:gap-3 md:p-3">
        <CommandPalette />
        <ShortcutsDialog />
        <aside
          className={`ui-glass hidden shrink-0 overflow-hidden rounded-[20px] transition-[width] duration-200 ease-[var(--ease-spring-smooth)] md:flex ${collapsed ? 'w-[60px]' : 'w-[248px]'}`}
          aria-label="Sidebar"
        >
          <SidebarContent collapsed={collapsed} onToggleCollapsed={() => setCollapsed(!collapsed)} usage={usage} health={healthState} />
        </aside>

        {mobileOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <button type="button" aria-label="Close navigation" className="absolute inset-0 animate-fade bg-zinc-950/25" onClick={() => setMobileOpen(false)} />
            <aside className="ui-glass-solid absolute inset-y-2 left-2 flex w-72 max-w-[85vw] animate-sheet-in flex-col rounded-[20px]">
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="absolute top-3 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-[10px] text-zinc-500 hover:bg-zinc-950/5"
                aria-label="Close navigation"
              >
                <X size={16} weight="bold" />
              </button>
              <SidebarContent onNavigate={() => setMobileOpen(false)} usage={usage} health={healthState} />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-sheet)] md:rounded-[20px] md:shadow-[var(--shadow-card)] md:ring-1 md:ring-[var(--color-line)]">
          <header className="flex h-12 shrink-0 items-center gap-2 px-2 md:h-11 md:px-5">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-[10px] text-zinc-600 hover:bg-zinc-950/5 md:hidden"
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
                      <span className={`truncate ${i === crumbs.length - 1 ? 'font-medium text-zinc-900' : 'text-zinc-500'}`} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
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
              onClick={openPalette}
              aria-label={`Search (${MOD_KEY}+K)`}
              className="flex h-10 w-10 items-center justify-center rounded-[10px] text-zinc-600 hover:bg-zinc-950/5 md:hidden"
            >
              <MagnifyingGlass size={18} weight="bold" />
            </button>
          </header>

          {healthState === 'ok' && info && !info.llm_configured && (
            <div className="mx-4 mb-2 flex items-center gap-2 rounded-[14px] bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200 md:mx-8">
              <Warning size={16} weight="fill" className="shrink-0 text-amber-600" />
              <span>
                LLM not configured. Set <code className="font-data">OPENAI_API_KEY</code> in <code className="font-data">agent-harness/.env</code> (copy from{' '}
                <code className="font-data">.env.example</code>) and restart the server to run real objectives.
              </span>
            </div>
          )}
          {healthState === 'ok' && info?.llm_configured && info.llm_last_error && (
            <div className="mx-4 mb-2 flex items-center gap-2 rounded-[14px] bg-rose-50 px-4 py-2.5 text-sm text-rose-900 ring-1 ring-rose-200 md:mx-8">
              <Warning size={16} weight="fill" className="shrink-0 text-rose-600" />
              <span>
                LLM configured but the last provider call failed: <code className="font-data">{info.llm_last_error}</code>
              </span>
            </div>
          )}

          <main id="main" className="relative min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
            {children}
          </main>

          <footer className="flex shrink-0 items-center justify-between gap-x-4 border-t border-[var(--color-line)] px-4 py-1.5 text-[11px] text-zinc-500 md:px-5">
            <span className="min-w-0 flex-1 truncate" title="Services, incidents and the knowledge base are seeded with mock data. The agent, its retrieval and its persistence are all real.">
              Services, incidents and the knowledge base are seeded with mock data. The agent, its retrieval and its persistence are all real.
            </span>
            <span className="shrink-0 font-medium text-zinc-600">Phu Nguyen — HCMC, VN</span>
          </footer>
        </div>
      </div>
    </ToastProvider>
  )
}
