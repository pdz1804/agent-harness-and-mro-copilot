import { ArrowClockwise, ArrowSquareOut, Brain, ChartBar, FileText, Package, Siren, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SessionArtifacts } from '../../hooks/useSessionArtifacts'
import { api, ApiError } from '../../lib/api'
import type { Dashboard } from '../../lib/api-types'
import type { ArtifactRef } from '../../lib/tool-call-view'
import { Skeleton } from '../Skeleton'
import { WidgetBody } from '../widgets/WidgetBody'

const SEVERITY_DOT: Record<string, string> = {
  low: 'bg-zinc-400',
  medium: 'bg-amber-500',
  high: 'bg-orange-500',
  critical: 'bg-rose-600',
}

function Section({ title, icon, count, children }: { title: string; icon: React.ReactNode; count: number; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 px-0.5 font-[family-name:var(--font-sans)] text-xs font-medium tracking-normal text-zinc-500">
        <span className="text-zinc-400">{icon}</span>
        {title}
        <span className="text-zinc-400 tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  )
}

function focusRing(active: boolean): string {
  return active ? 'ring-2 ring-sky-400 shadow-[0_0_0_4px_oklch(0.608_0.192_280/0.12)]' : 'ring-1 ring-[var(--color-line)]'
}

/** A dashboard the session created, rendered LIVE (its widgets' stored
 * results), with Refresh (re-runs every widget query) and a link out. */
function DashboardArtifact({ dashboard, focused, onUpdated }: { dashboard: Dashboard; focused: boolean; onUpdated: (d: Dashboard) => void }) {
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      onUpdated(await api.refreshDashboard(dashboard.id))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <article id={`artifact-dashboard-${dashboard.id}`} className={`scroll-mt-4 overflow-hidden rounded-xl bg-white shadow-[var(--shadow-xs)] transition-shadow ${focusRing(focused)}`}>
      <header className="flex items-start gap-2.5 border-b border-[var(--color-line)] px-3 py-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700 ring-1 ring-sky-200 ring-inset">
          <ChartBar size={14} weight="bold" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-zinc-950">{dashboard.name}</p>
          <p className="text-[11px] text-zinc-500">
            {dashboard.widgets.length} widget{dashboard.widgets.length === 1 ? '' : 's'} · {dashboard.visibility}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon"
          aria-label={`Refresh ${dashboard.name}`}
          title="Re-run every widget query"
        >
          <ArrowClockwise size={14} weight="bold" className={refreshing ? 'animate-spin' : ''} />
        </button>
        <Link to={`/dashboards/${dashboard.id}`} className="ui-btn ui-btn-secondary ui-btn-sm" title="Open full dashboard">
          <ArrowSquareOut size={13} weight="bold" />
          Open
        </Link>
      </header>
      {error && <p className="bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      <div className="space-y-3 p-3">
        {dashboard.widgets.length === 0 && <p className="text-xs text-zinc-500">No widgets yet.</p>}
        {dashboard.widgets.map((w) => (
          <div key={w.id} className="min-w-0">
            <p className="mb-1.5 truncate text-xs font-medium text-zinc-700">{w.title}</p>
            {w.last_error ? (
              <p className="rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-700">{w.last_error}</p>
            ) : w.last_result ? (
              <WidgetBody widget={w} />
            ) : refreshing ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <p className="text-xs text-zinc-500">Not refreshed yet — use Refresh.</p>
            )}
          </div>
        ))}
      </div>
    </article>
  )
}

interface WorkspacePanelProps {
  artifacts: SessionArtifacts & { reloadDashboard: (d: Dashboard) => void }
  open: boolean
  onOpenChange: (open: boolean) => void
  focus: ArtifactRef | null
}

/** The session Workspace: the things this conversation produced, beside the
 * conversation (like an artifacts panel). Toggled from the run header. */
export function WorkspacePanel({ artifacts, open, onOpenChange, focus }: WorkspacePanelProps) {
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024)
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 1024)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!open || !focus) return
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`artifact-${focus.kind}-${focus.id}`)
        ?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, focus])

  if (!open) return null
  const { dashboards, incidents, memories, promptVersions, loading, error } = artifacts
  const total = dashboards.length + incidents.length + memories.length
  const isFocused = (kind: ArtifactRef['kind'], id: string) => focus?.kind === kind && focus.id === id

  const body = (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-4">
        <Package size={16} weight="bold" className="text-zinc-500" />
        <h2 className="flex-1 text-[13px] font-semibold text-zinc-950">Workspace</h2>
        <span className="text-xs text-zinc-500 tabular-nums">{total} artifact{total === 1 ? '' : 's'}</span>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close workspace"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-900"
        >
          <X size={14} weight="bold" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : (
          <>
            {total === 0 && (
              <div className="rounded-xl border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center">
                <Package size={22} weight="duotone" className="mx-auto text-zinc-400" />
                <p className="mt-2 text-[13px] font-medium text-zinc-900">Nothing produced yet</p>
                <p className="mx-auto mt-1 max-w-xs text-xs text-zinc-500">
                  Dashboards, incidents and memories the agent creates in this session appear here, live.
                </p>
              </div>
            )}
            {dashboards.length > 0 && (
              <Section title="Dashboards" icon={<ChartBar size={13} weight="bold" />} count={dashboards.length}>
                {dashboards.map((d) => (
                  <DashboardArtifact key={d.id} dashboard={d} focused={isFocused('dashboard', d.id)} onUpdated={artifacts.reloadDashboard} />
                ))}
              </Section>
            )}
            {incidents.length > 0 && (
              <Section title="Incidents" icon={<Siren size={13} weight="bold" />} count={incidents.length}>
                {incidents.map((i) => (
                  <Link
                    key={i.id}
                    id={`artifact-incident-${i.id}`}
                    to={`/incidents/${i.id}`}
                    className={`flex scroll-mt-4 items-center gap-3 rounded-xl bg-white px-3 py-2.5 shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-lift)] ${focusRing(isFocused('incident', i.id))}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[i.severity] ?? 'bg-zinc-400'}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-zinc-900">{i.title}</span>
                      <span className="block text-[11px] text-zinc-500">
                        <span className="font-data">{i.id}</span> · {i.severity} · {i.status}
                        {i.service_name ? ` · ${i.service_name}` : ''}
                      </span>
                    </span>
                    <ArrowSquareOut size={13} weight="bold" className="shrink-0 text-zinc-400" />
                  </Link>
                ))}
              </Section>
            )}
            {memories.length > 0 && (
              <Section title="Memories saved" icon={<Brain size={13} weight="bold" />} count={memories.length}>
                {memories.map((m) => (
                  <Link
                    key={m.id}
                    id={`artifact-memory-${m.id}`}
                    to="/memory"
                    className={`block scroll-mt-4 rounded-xl bg-white px-3 py-2.5 text-[13px] text-zinc-800 shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-lift)] ${focusRing(isFocused('memory', m.id))} ${m.exists ? '' : 'line-through opacity-60'}`}
                  >
                    {m.fact}
                    {m.tags.length > 0 && <span className="mt-1 block text-[11px] text-zinc-500">{m.tags.join(' · ')}</span>}
                  </Link>
                ))}
              </Section>
            )}
            {promptVersions.length > 0 && (
              <Section title="Prompt versions used" icon={<FileText size={13} weight="bold" />} count={promptVersions.length}>
                <div className="flex flex-wrap gap-1.5">
                  {promptVersions.map((v) => (
                    <Link key={v} to="/prompts" className="ui-chip font-data hover:bg-zinc-950/10">
                      {v}
                    </Link>
                  ))}
                </div>
              </Section>
            )}
            <p className="text-[11px] leading-relaxed text-zinc-400">
              Knowledge-base documents are not linked to sessions by the API yet, so they are not listed here.
            </p>
          </>
        )}
      </div>
    </div>
  )

  if (isNarrow) {
    return (
      <div className="fixed inset-0 z-30 flex animate-fade justify-end bg-zinc-950/25 backdrop-blur-[2px]" onClick={() => onOpenChange(false)}>
        <div
          className="h-full w-full max-w-[440px] animate-drawer bg-[var(--color-sheet)] shadow-[var(--shadow-xl)]"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Session workspace"
        >
          {body}
        </div>
      </div>
    )
  }

  return (
    <aside
      aria-label="Session workspace"
      className="relative hidden h-full w-[26rem] shrink-0 animate-drawer border-l border-[var(--color-line)] bg-[var(--color-sheet)] shadow-[-12px_0_32px_-24px_oklch(0.2_0.03_272/0.25)] lg:flex xl:w-[28rem]"
    >
      {body}
    </aside>
  )
}
