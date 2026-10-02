import { ArrowClockwise, ArrowSquareOut, ChartBar, Copy, Lock, Plus, Robot, ShareNetwork, Sparkle, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DiscardBar } from '../components/widgets/DiscardBar'
import {
  Button,
  Card,
  CardGridSkeleton,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  FilteredEmpty,
  Input,
  LinkButton,
  PageHeader,
  RelativeTime,
  RowActions,
  SearchInput,
  Segmented,
  Sheet,
  SheetSection,
  Skeleton,
  useToast,
  type RowAction,
} from '../components/ui'
import { canWriteResource, disabledReason, useMe } from '../hooks/useMe'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { Dashboard, DashboardTemplate, DashboardWidget } from '../lib/api-types'
import { autoRefreshLabel } from '../lib/dashboard-refresh'
import { DASHBOARD_SCOPES, filterDashboards, validateDashboardName, type DashboardScope } from '../lib/dashboards-model'
import { getCurrentUserId } from '../lib/identity'

const SEARCH_DEBOUNCE_MS = 250
const FILTER_KEYS = ['q', 'scope']

/** A miniature of the dashboard's real layout: one block per widget, sized by
 * its column span. */
function LayoutPreview({ widgets }: { widgets: DashboardWidget[] }) {
  const SPAN: Record<number, string> = { 3: 'col-span-3', 4: 'col-span-4', 6: 'col-span-6', 12: 'col-span-12' }
  const shown = widgets.slice(0, 6)
  return (
    <div aria-hidden="true" className="grid h-[4.5rem] grid-cols-12 content-start gap-1 overflow-hidden rounded-[10px] bg-zinc-950/[0.035] p-1.5">
      {shown.length === 0 ? (
        <span className="col-span-12 self-center text-center text-[11px] text-zinc-500">No widgets yet</span>
      ) : (
        shown.map((w) => <span key={w.id} className={`h-4 rounded-[6px] bg-white shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-line)] ${SPAN[w.col_span] ?? 'col-span-6'}`} />)
      )}
    </div>
  )
}

/** Dashboards: a searchable grid of the caller's readable dashboards. Search
 * and the scope tab live in the URL. `?create=1` (the command palette's
 * "Create dashboard") opens the create sheet with the template picker.
 * Delete is soft (Undo restores it); duplicate offers an "Open" shortcut. */
export function DashboardsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { me } = useMe()
  const [q, setQ] = useUrlState('q')
  const [scope, setScope] = useUrlEnum<DashboardScope>('scope', DASHBOARD_SCOPES, 'all')
  const [create, setCreate] = useUrlState('create')
  const clearParams = useClearUrlParams()
  const [searchInput, setSearchInput] = useState(q)
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== q) setQ(searchInput)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, q, setQ])

  useEffect(() => {
    let cancelled = false
    api.listDashboards().then(
      (d) => {
        if (cancelled) return
        setDashboards(d)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Could not load dashboards.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const reload = useCallback(() => setRefreshToken((n) => n + 1), [])
  const currentUserId = me?.id ?? getCurrentUserId()
  const canCreate = me ? me.permissions.includes('mutate_artifacts') : true
  const createReason = canCreate ? undefined : disabledReason(me, 'mutate_artifacts')

  const rows = useMemo(() => filterDashboards(dashboards ?? [], q, scope, currentUserId), [dashboards, q, scope, currentUserId])
  const counts = useMemo(
    () => ({
      all: dashboards?.length ?? 0,
      mine: (dashboards ?? []).filter((d) => d.owner_id === currentUserId).length,
      shared: (dashboards ?? []).filter((d) => d.visibility === 'shared').length,
    }),
    [dashboards, currentUserId],
  )
  const filtered = !!q || scope !== 'all'
  const clearFilters = () => {
    setSearchInput('')
    clearParams(FILTER_KEYS)
  }

  const duplicate = async (d: Dashboard) => {
    try {
      const copy = await api.duplicateDashboard(d.id)
      reload()
      toast({
        title: `Duplicated as “${copy.name}”`,
        action: { label: 'Open', run: () => navigate(`/dashboards/${copy.id}`) },
      })
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't duplicate “${d.name}”`, description: errorText(err, 'Try again.') })
    }
  }

  const remove = async (d: Dashboard) => {
    try {
      await api.deleteDashboard(d.id)
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't delete “${d.name}”`, description: errorText(err, 'Try again.') })
      return
    }
    reload()
    toast({
      title: `Deleted “${d.name}”`,
      description: 'Kept in the trash for 7 days.',
      action: {
        label: 'Undo',
        run: async () => {
          await api.restoreDashboard(d.id)
          reload()
          toast({ title: `Restored “${d.name}”` })
        },
      },
    })
  }

  const actionsFor = (d: Dashboard): RowAction[] => {
    const canWrite = canCreate && canWriteResource(me, d)
    const reason = canCreate ? 'Only the owner or an admin can delete this dashboard.' : disabledReason(me, 'mutate_artifacts')
    return [
      { label: 'Open', icon: <ArrowSquareOut size={14} />, onSelect: () => navigate(`/dashboards/${d.id}`) },
      { label: 'Duplicate', icon: <Copy size={14} />, disabled: !canCreate, disabledReason: createReason, onSelect: () => duplicate(d) },
      {
        label: 'Delete',
        icon: <Trash size={14} />,
        destructive: true,
        disabled: !canWrite,
        disabledReason: reason,
        confirm: { title: `Delete “${d.name}”?`, description: 'Its widgets go with it. You can undo for a few seconds; it stays in the trash for 7 days.' },
        onSelect: () => remove(d),
      },
    ]
  }

  const newDashboard = (
    <Button variant="primary" icon={<Plus size={14} weight="bold" />} disabled={!canCreate} title={createReason} onClick={() => setCreate('1')}>
      New dashboard
    </Button>
  )

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Dashboards"
        description="Live, read-only SQL over incidents, services, runs and events. Build one from a template, or ask the agent in chat and approve what it proposes."
        actions={
          <>
            <LinkButton to="/chat" icon={<Sparkle size={14} />}>
              Ask the agent
            </LinkButton>
            {newDashboard}
          </>
        }
        toolbar={
          <>
            <Segmented
              label="Dashboard scope"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: 'All', count: dashboards ? counts.all : undefined },
                { value: 'mine', label: 'Mine', count: dashboards ? counts.mine : undefined },
                { value: 'shared', label: 'Shared', count: dashboards ? counts.shared : undefined },
              ]}
            />
            <SearchInput label="Search dashboards" placeholder="Search name or template" value={searchInput} onValueChange={setSearchInput} className="w-full sm:w-64" />
            {filtered && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </>
        }
      />

      {error && dashboards === null ? (
        <ErrorState message={`${error} Check that the backend is running.`} onRetry={reload} />
      ) : dashboards === null ? (
        <CardGridSkeleton count={6} />
      ) : dashboards.length === 0 ? (
        <EmptyState
          icon={<ChartBar size={22} weight="duotone" />}
          title="No dashboards yet"
          description="A dashboard is a set of widgets, each backed by a stored read-only SQL query. Start from a template and edit the widgets afterwards."
          action={newDashboard}
          example="Try: “Build me a dashboard of incidents by severity over time” in chat."
        />
      ) : rows.length === 0 ? (
        <FilteredEmpty query={q || undefined} what="dashboards" onClear={clearFilters} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((d) => (
            <Card key={d.id} as="article" interactive className="relative flex flex-col gap-3">
              <LayoutPreview widgets={d.widgets} />
              <div className="min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 truncate font-[family-name:var(--font-sans)] text-sm font-semibold tracking-normal text-zinc-950">
                    <Link to={`/dashboards/${d.id}`} className="rounded after:absolute after:inset-0 after:rounded-[14px] after:content-['']">
                      {d.name}
                    </Link>
                  </h2>
                  <span className="relative z-10 -mt-1 -mr-1.5">
                    <RowActions visibility="always" label={`Actions for “${d.name}”`} items={actionsFor(d)} />
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-zinc-500 tabular-nums">
                  {d.widgets.length} widget{d.widgets.length === 1 ? '' : 's'} · {d.template_key}
                  {d.auto_refresh_seconds ? ` · ${autoRefreshLabel(d.auto_refresh_seconds).toLowerCase()}` : ''}
                </p>
              </div>
              <div className="mt-auto flex items-center gap-1.5 text-xs text-zinc-500">
                <Chip icon={d.visibility === 'private' ? <Lock size={11} /> : <ShareNetwork size={11} />}>{d.visibility === 'private' ? 'Private' : 'Shared'}</Chip>
                {d.created_by_run_id && (
                  <Chip tone="iris" icon={<Robot size={11} weight="bold" />} title="Created by the agent in a chat run">
                    Built by agent
                  </Chip>
                )}
                <span className="min-w-0 truncate">{d.owner_id === currentUserId ? 'You' : d.owner_id}</span>
                {/* Icon plus relative time keeps the footer on one line at the 3-column card width. */}
                <span className="ml-auto inline-flex shrink-0 items-center gap-1" title={d.last_refreshed_at ? 'Last refreshed' : 'Never refreshed'}>
                  <ArrowClockwise size={11} aria-hidden="true" />
                  {d.last_refreshed_at ? (
                    <>
                      <span className="sr-only">Refreshed </span>
                      <RelativeTime value={d.last_refreshed_at} />
                    </>
                  ) : (
                    'Never'
                  )}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}

      {create && (
        <CreateDashboardSheet
          canCreate={canCreate}
          reason={createReason}
          onClose={() => setCreate('')}
          onCreated={(d) => {
            setCreate('')
            reload()
            navigate(`/dashboards/${d.id}`)
            toast({
              title: `Created “${d.name}”`,
              action: {
                label: 'Undo',
                run: async () => {
                  await api.deleteDashboard(d.id)
                  navigate('/dashboards')
                },
              },
            })
          }}
        />
      )}
    </div>
  )
}

/** Create flow: pick a template, name it, choose who can see it. Every
 * template instantiation copies real widget rows the user can then edit,
 * delete or add to (the template itself is never referenced again). */
function CreateDashboardSheet({ canCreate, reason, onClose, onCreated }: { canCreate: boolean; reason?: string; onClose: () => void; onCreated: (d: Dashboard) => void }) {
  const [templates, setTemplates] = useState<DashboardTemplate[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [templateKey, setTemplateKey] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private')
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    api.listDashboardTemplates().then(
      (list) => {
        if (cancelled) return
        setTemplates(list)
        if (list.length > 0) {
          setTemplateKey((current) => current || list[0].key)
          setName((current) => current || list[0].name)
        }
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(errorText(err, 'Could not load templates.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const template = templates?.find((t) => t.key === templateKey) ?? null
  const dirty = nameEdited || visibility !== 'private' || (!!templates && templates.length > 0 && templateKey !== templates[0].key)
  const nameError = validateDashboardName(name)

  const pick = (t: DashboardTemplate) => {
    // The suggested name follows the template until the user types their own.
    if (!nameEdited) setName(t.name)
    setTemplateKey(t.key)
  }

  const requestClose = () => {
    if (dirty && !saving) setConfirmingDiscard(true)
    else onClose()
  }

  const submit = async () => {
    setNameTouched(true)
    if (nameError || !template) return
    setSaving(true)
    setSubmitError(null)
    try {
      onCreated(await api.createDashboard({ name: name.trim(), template_key: template.key, visibility }))
    } catch (err) {
      setSubmitError(errorText(err, 'Could not create the dashboard.'))
      setSaving(false)
    }
  }

  return (
    <Sheet
      open
      onClose={requestClose}
      width="lg"
      eyebrow="Dashboards"
      title="New dashboard"
      meta={<span>Starts from a template; every widget stays editable.</span>}
      footer={
        <>
          <Button variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!canCreate || !template} title={reason} onClick={() => void submit()}>
            Create dashboard
          </Button>
        </>
      }
    >
      {confirmingDiscard && <DiscardBar onKeep={() => setConfirmingDiscard(false)} onDiscard={onClose} />}
      {!canCreate && <p className="mb-4 rounded-[10px] bg-amber-50 px-3 py-2 text-xs text-amber-800">{reason}</p>}
      {submitError && (
        <p role="alert" className="mb-4 rounded-[10px] bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800">
          {submitError}
        </p>
      )}

      <SheetSection title="Template">
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
        ) : templates === null ? (
          <div className="space-y-2" role="status" aria-label="Loading templates">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : (
          <div role="radiogroup" aria-label="Template" className="space-y-2">
            {templates.map((t) => {
              const selected = t.key === templateKey
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => pick(t)}
                  className={`flex w-full items-start gap-3 rounded-[14px] border bg-white p-3 text-left transition-colors ${
                    selected ? 'border-sky-300 shadow-[0_0_0_3px_oklch(0.608_0.192_280/0.14)]' : 'border-[var(--color-line)] hover:border-[var(--color-line-strong)]'
                  }`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-sky-50 text-sky-700">
                    <ChartBar size={15} weight="bold" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-zinc-950">{t.name}</span>
                    <span className="mt-0.5 block text-xs text-zinc-600">{t.description}</span>
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      {t.widget_kinds.map((k, i) => (
                        <Chip key={`${k}-${i}`}>{k}</Chip>
                      ))}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </SheetSection>

      <SheetSection title="Details">
        <div className="space-y-3">
          <Field label="Name" error={nameTouched ? nameError : null}>
            {(p) => (
              <Input
                {...p}
                name="dashboard-name"
                autoComplete="off"
                value={name}
                maxLength={140}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameEdited(true)
                }}
                onBlur={() => setNameTouched(true)}
                className="w-full"
              />
            )}
          </Field>
          <Field label="Visibility" hint={visibility === 'private' ? 'Only you and admins can see it.' : 'Everyone can see it; only you and admins can edit it.'}>
            {() => (
              <Segmented
                label="Visibility"
                value={visibility}
                onChange={setVisibility}
                options={[
                  { value: 'private', label: 'Private', icon: <Lock size={12} /> },
                  { value: 'shared', label: 'Shared', icon: <ShareNetwork size={12} /> },
                ]}
              />
            )}
          </Field>
        </div>
      </SheetSection>
    </Sheet>
  )
}
