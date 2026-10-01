import { ArrowSquareOut, Lightning, Plus } from '@phosphor-icons/react'
import { useEffect, useId, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DiscardFooter } from '../components/guardrails/DiscardFooter'
import {
  Button,
  Chip,
  CopyId,
  EmptyState,
  ErrorState,
  FactList,
  Field,
  FilteredEmpty,
  Input,
  PageHeader,
  RelativeTime,
  Row,
  SearchInput,
  Segmented,
  Select,
  Sheet,
  SheetSection,
  StatusBadge,
  Switch,
  Table,
  TableSkeleton,
  Textarea,
  useToast,
} from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { disabledReason, useMe } from '../hooks/useMe'
import { api, errorText } from '../lib/api'
import type { Automation, AutomationTriggeredRun, RunStatus, Service, ServiceStatus } from '../lib/api-types'
import {
  AUTOMATION_STATE_FILTERS,
  describeTrigger,
  filterAutomations,
  runsForAutomation,
  validateAutomationName,
  validateObjective,
  type AutomationStateFilter,
} from '../lib/automations-rules'

const STATUS_OPTIONS: ServiceStatus[] = ['operational', 'degraded', 'down']
const TABS = ['rules', 'runs'] as const
const FILTER_KEYS = ['q', 'state']

function ServiceStatusChip({ status }: { status: ServiceStatus }) {
  return (
    <Chip tone={status === 'operational' ? 'ok' : status === 'degraded' ? 'warn' : 'danger'} dot>
      {status}
    </Chip>
  )
}

/** Automations: a real, event-driven rule engine. When a service's status is
 * flipped via the Services page (`POST /services/{name}/status`), the backend
 * checks every enabled automation matching that exact service+status
 * transition and, for each match, starts a real new run with the automation's
 * objective, the same `RunRegistry.start_run` path a manual "New run" uses
 * (see `api.py::_trigger_automations`). Tab, filters, the open automation
 * (`?open=<id>`) and the create sheet (`?create=1`) live in the URL. */
export function AutomationsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [tab, setTab] = useUrlEnum('tab', TABS, 'rules')
  const [q, setQ] = useUrlState('q')
  const [state, setState] = useUrlEnum<AutomationStateFilter>('state', AUTOMATION_STATE_FILTERS, 'all')
  const [openId, setOpenId] = useUrlState('open')
  const [create, setCreate] = useUrlState('create')
  const clearParams = useClearUrlParams()
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [triggeredRuns, setTriggeredRuns] = useState<AutomationTriggeredRun[] | null>(null)
  const [services, setServices] = useState<Service[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<Set<string>>(() => new Set())
  const [refreshToken, setRefreshToken] = useState(0)

  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_automations') : true
  const mutateTitle = canMutate ? undefined : disabledReason(me, 'mutate_automations')

  useEffect(() => {
    let cancelled = false
    Promise.all([api.listAutomations(), api.listAutomationRuns(), api.listServices()]).then(
      ([a, r, s]) => {
        if (cancelled) return
        setAutomations(a)
        setTriggeredRuns(r)
        setServices(s)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Failed to load automations.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const replace = (updated: Automation) => setAutomations((prev) => (prev ? prev.map((a) => (a.id === updated.id ? updated : a)) : prev))
  const setPending = (id: string, on: boolean) =>
    setUpdating((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  /** Flip an automation; the toast's Undo flips it back. */
  const toggle = async (automation: Automation, enabled: boolean) => {
    setPending(automation.id, true)
    try {
      replace(await api.setAutomationEnabled(automation.id, enabled))
      toast({
        title: `${enabled ? 'Enabled' : 'Disabled'} “${automation.name}”`,
        action: {
          label: 'Undo',
          run: async () => {
            replace(await api.setAutomationEnabled(automation.id, !enabled))
          },
        },
      })
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't ${enabled ? 'enable' : 'disable'} “${automation.name}”`, description: errorText(err, 'Try again.') })
    } finally {
      setPending(automation.id, false)
    }
  }

  const nameOf = useMemo(() => new Map((automations ?? []).map((a) => [a.id, a.name])), [automations])
  const rules = useMemo(() => (automations ? filterAutomations(automations, q, state) : null), [automations, q, state])
  const runs = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!triggeredRuns) return null
    if (!needle) return triggeredRuns
    return triggeredRuns.filter((r) => [r.objective, r.run_id, nameOf.get(r.triggered_by_automation_id) ?? ''].some((f) => f.toLowerCase().includes(needle)))
  }, [triggeredRuns, q, nameOf])
  const filtersActive = q.trim() !== '' || (tab === 'rules' && state !== 'all')
  const clearFilters = () => clearParams(FILTER_KEYS)
  const retry = () => {
    setError(null)
    setRefreshToken((n) => n + 1)
  }

  const openIndex = rules ? rules.findIndex((a) => a.id === openId) : -1
  const step = (delta: 1 | -1) => {
    if (!rules?.length) return
    setOpenId(rules[(Math.max(0, openIndex) + delta + rules.length) % rules.length].id)
  }

  const newButton = (
    <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setCreate('1')} disabled={!canMutate} title={mutateTitle}>
      New automation
    </Button>
  )

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Automations"
        description={
          <>
            When a service flips to a matching status on the{' '}
            <Link to="/services" className="ui-btn-link">
              Services
            </Link>{' '}
            page, a real new run starts with the configured objective.
          </>
        }
        actions={newButton}
        toolbar={
          <>
            <Segmented
              label="Automation sections"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'rules', label: 'Automations', count: automations?.length },
                { value: 'runs', label: 'Triggered runs', count: triggeredRuns?.length },
              ]}
            />
            <SearchInput label="Search" placeholder={tab === 'rules' ? 'Search name, service or objective' : 'Search objective or run'} value={q} onValueChange={setQ} className="w-full sm:w-64" />
            {tab === 'rules' && (
              <Segmented
                label="Enabled state"
                value={state}
                onChange={setState}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'enabled', label: 'Enabled' },
                  { value: 'disabled', label: 'Disabled' },
                ]}
              />
            )}
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </>
        }
      />

      {error && automations === null ? (
        <ErrorState message={error} onRetry={retry} />
      ) : tab === 'rules' ? (
        rules === null ? (
          <TableSkeleton rows={4} columns={4} />
        ) : automations?.length === 0 ? (
          <EmptyState
            icon={<Lightning size={22} weight="duotone" />}
            title="No automations yet"
            description="An automation starts a real run when a service changes status, so the first investigation is already under way when you look."
            action={newButton}
            example="Try: when any service flips to down, run “investigate the outage”."
          />
        ) : rules.length === 0 ? (
          <FilteredEmpty query={q || undefined} what="automations" onClear={clearFilters} />
        ) : (
          <Table label="Automations">
            <thead>
              <tr>
                <th>Automation</th>
                <th className="hidden sm:table-cell">Trigger</th>
                <th className="hidden md:table-cell">Created</th>
                <th className="w-24 text-right">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((a) => (
                <Row key={a.id} onOpen={() => setOpenId(a.id)} selected={a.id === openId}>
                  <td className="max-w-0 min-w-[10rem]">
                    <p className="flex items-center gap-2 font-medium text-zinc-900">
                      <Lightning size={14} className="shrink-0 text-zinc-500" aria-hidden="true" />
                      <span className="truncate">{a.name}</span>
                    </p>
                    <p className="font-data truncate pl-[22px] text-xs text-zinc-500" title={a.objective_template}>
                      {a.objective_template}
                    </p>
                  </td>
                  <td className="hidden sm:table-cell">
                    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-zinc-600">
                      <span className="font-data">{a.trigger_service_name}</span>
                      <span aria-hidden="true">→</span>
                      <ServiceStatusChip status={a.trigger_status} />
                    </span>
                  </td>
                  <td className="hidden text-zinc-600 md:table-cell">
                    <RelativeTime value={a.created_at} />
                  </td>
                  <td className="text-right">
                    <Switch checked={a.enabled} label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`} disabled={!canMutate} title={mutateTitle} pending={updating.has(a.id)} onChange={(next) => void toggle(a, next)} />
                  </td>
                </Row>
              ))}
            </tbody>
          </Table>
        )
      ) : runs === null ? (
        <TableSkeleton rows={4} columns={4} />
      ) : triggeredRuns?.length === 0 ? (
        <EmptyState
          icon={<Lightning size={22} weight="duotone" />}
          title="No automation-triggered runs yet"
          description="When a service flips to a status an enabled automation watches, the run it starts is listed here."
          example={
            <>
              Flip a service on the{' '}
              <Link to="/services" className="ui-btn-link">
                Services
              </Link>{' '}
              page to try it.
            </>
          }
        />
      ) : runs.length === 0 ? (
        <FilteredEmpty query={q || undefined} what="runs" onClear={clearFilters} />
      ) : (
        <Table label="Automation-triggered runs">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th className="hidden md:table-cell">Automation</th>
              <th className="hidden sm:table-cell">Started</th>
              <th className="w-10">
                <span className="sr-only">Open run</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <Row key={run.run_id} onOpen={() => navigate(`/runs/${run.run_id}`)}>
                <td className="max-w-0 min-w-[10rem]">
                  <p className="truncate font-medium text-zinc-900" title={run.objective}>
                    {run.objective}
                  </p>
                  <p className="font-data truncate text-xs text-zinc-500">{run.run_id}</p>
                </td>
                <td>
                  <StatusBadge status={run.status as RunStatus} />
                </td>
                <td className="hidden max-w-[12rem] truncate text-zinc-600 md:table-cell">{nameOf.get(run.triggered_by_automation_id) ?? run.triggered_by_automation_id}</td>
                <td className="hidden text-zinc-600 sm:table-cell">
                  <RelativeTime value={run.started_at} />
                </td>
                <td className="text-right">
                  <Link to={`/runs/${run.run_id}`} className="ui-btn-link inline-flex items-center" aria-label={`Open run ${run.run_id}`} title="Open run">
                    <ArrowSquareOut size={14} aria-hidden="true" />
                  </Link>
                </td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}

      {openId && (
        <AutomationSheet
          automation={automations?.find((a) => a.id === openId) ?? null}
          loading={automations === null}
          runs={triggeredRuns ?? []}
          canMutate={canMutate}
          reason={mutateTitle}
          pending={updating.has(openId)}
          onToggle={(next) => {
            const a = automations?.find((x) => x.id === openId)
            if (a) void toggle(a, next)
          }}
          onClose={() => setOpenId('')}
          onPrev={rules && rules.length > 1 ? () => step(-1) : undefined}
          onNext={rules && rules.length > 1 ? () => step(1) : undefined}
        />
      )}

      {create && (
        <CreateAutomationSheet
          services={services ?? []}
          canMutate={canMutate}
          reason={mutateTitle}
          onClose={() => setCreate('')}
          onCreated={(created) => setAutomations((prev) => (prev ? [...prev, created] : prev))}
        />
      )}
    </div>
  )
}

interface AutomationSheetProps {
  automation: Automation | null
  loading: boolean
  runs: AutomationTriggeredRun[]
  canMutate: boolean
  reason?: string
  pending: boolean
  onToggle: (enabled: boolean) => void
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
}

/** One automation: its trigger, objective, enable switch and the runs it has
 * started. Deep link: `/automations?open=<id>`. */
function AutomationSheet({ automation, loading, runs, canMutate, reason, pending, onToggle, onClose, onPrev, onNext }: AutomationSheetProps) {
  useDocumentTitle(automation?.name ?? null)
  const started = automation ? runsForAutomation(runs, automation.id) : []
  return (
    <Sheet
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      eyebrow="Automations"
      label={automation?.name ?? 'Automation'}
      title={automation?.name ?? 'Automation'}
      status={
        automation ? (
          <Chip tone={automation.enabled ? 'ok' : 'muted'} dot>
            {automation.enabled ? 'Enabled' : 'Disabled'}
          </Chip>
        ) : undefined
      }
      meta={
        automation && (
          <>
            <span>{describeTrigger(automation)}</span>
            <span aria-hidden="true">·</span>
            <CopyId value={automation.id} label="automation ID" />
          </>
        )
      }
    >
      {!automation ? (
        <p className="text-[13px] text-zinc-500">{loading ? 'Loading the automation…' : 'This automation no longer exists.'}</p>
      ) : (
        <>
          <SheetSection title="Overview">
            <div className="flex items-center justify-between gap-3 rounded-[10px] bg-zinc-950/[0.03] px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-zinc-900">Starts runs automatically</p>
                <p className="text-xs text-zinc-600">{reason ?? 'Only an enabled automation reacts to status changes.'}</p>
              </div>
              <Switch checked={automation.enabled} onChange={onToggle} label={`${automation.enabled ? 'Disable' : 'Enable'} ${automation.name}`} disabled={!canMutate} title={reason} pending={pending} />
            </div>
            <div className="mt-3">
              <FactList
                items={[
                  { label: 'Service', value: <span className="font-data text-xs">{automation.trigger_service_name}</span> },
                  { label: 'Flips to', value: <ServiceStatusChip status={automation.trigger_status} /> },
                  { label: 'Created', value: <RelativeTime value={automation.created_at} /> },
                  { label: 'Owner', value: <span className="font-data text-xs">{automation.owner_id}</span> },
                ]}
              />
            </div>
          </SheetSection>
          <SheetSection title="Objective">
            <p className="font-data rounded-[10px] bg-zinc-950/[0.04] px-3 py-2 text-xs whitespace-pre-wrap text-zinc-800 [overflow-wrap:anywhere]">{automation.objective_template}</p>
          </SheetSection>
          <SheetSection title={`Runs started · ${started.length}`}>
            {started.length === 0 ? (
              <p className="text-[13px] text-zinc-500">No run has been started by this automation yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {started.slice(0, 8).map((r) => (
                  <li key={r.run_id}>
                    <Link to={`/runs/${r.run_id}`} className="ui-card ui-card-hover block p-3">
                      <p className="line-clamp-2 text-[13px] text-zinc-900">{r.objective}</p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        <StatusBadge status={r.status as RunStatus} />
                        <span className="font-data">{r.run_id}</span>
                        <RelativeTime value={r.started_at} />
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SheetSection>
        </>
      )}
    </Sheet>
  )
}

interface CreateAutomationSheetProps {
  services: Service[]
  canMutate: boolean
  reason?: string
  onClose: () => void
  onCreated: (created: Automation) => void
}

/** Create an automation. Validates on blur, asks before discarding edits, and
 * toasts on success (the API has no delete, so there is nothing to undo). */
function CreateAutomationSheet({ services, canMutate, reason, onClose, onCreated }: CreateAutomationSheetProps) {
  const formId = useId()
  const toast = useToast()
  const [name, setName] = useState('')
  const [serviceName, setServiceName] = useState('any')
  const [status, setStatus] = useState<ServiceStatus>('down')
  const [objective, setObjective] = useState('')
  const [touched, setTouched] = useState({ name: false, objective: false })
  const [saving, setSaving] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const nameError = validateAutomationName(name)
  const objectiveError = validateObjective(objective)
  const dirty = name.trim() !== '' || objective.trim() !== '' || serviceName !== 'any' || status !== 'down'
  const requestClose = () => (dirty && !saving ? setConfirmClose(true) : onClose())

  const submit = async () => {
    setTouched({ name: true, objective: true })
    if (!canMutate || nameError || objectiveError) return
    setSaving(true)
    try {
      const created = await api.createAutomation({
        name: name.trim(),
        trigger_service_name: serviceName,
        trigger_status: status,
        objective_template: objective.trim(),
      })
      onCreated(created)
      toast({ title: `Created “${created.name}”`, description: 'It reacts to the next matching status change.' })
      onClose()
    } catch (err) {
      toast({ tone: 'error', title: "Couldn't create the automation", description: errorText(err, 'Try again.') })
      setSaving(false)
    }
  }

  return (
    <Sheet
      open
      onClose={requestClose}
      eyebrow="Automations"
      title="New automation"
      meta={<span>Starts a real run when a service flips to the chosen status.</span>}
      footer={
        confirmClose ? (
          <DiscardFooter onKeep={() => setConfirmClose(false)} onDiscard={onClose} />
        ) : (
          <>
            {!canMutate && <span className="mr-auto text-xs text-zinc-600">{reason}</span>}
            <Button variant="ghost" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId} variant="primary" loading={saving} disabled={!canMutate} title={reason}>
              Create automation
            </Button>
          </>
        )
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <SheetSection title="Automation">
          <div className="space-y-4">
            <Field label="Name" error={touched.name ? nameError : null}>
              {(p) => (
                <Input
                  {...p}
                  name="new-automation-name"
                  autoComplete="off"
                  value={name}
                  disabled={!canMutate}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  placeholder="e.g. Investigate search-index outages…"
                  className="w-full"
                />
              )}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="When this service">
                {(p) => (
                  <Select id={p.id} name="trigger-service" value={serviceName} disabled={!canMutate} onChange={(e) => setServiceName(e.target.value)} className="w-full">
                    <option value="any">any service</option>
                    {services.map((svc) => (
                      <option key={svc.name} value={svc.name}>
                        {svc.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Flips to">
                {(p) => (
                  <Select id={p.id} name="trigger-status" value={status} disabled={!canMutate} onChange={(e) => setStatus(e.target.value as ServiceStatus)} className="w-full">
                    {STATUS_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Objective" hint="The run starts with this objective." error={touched.objective ? objectiveError : null}>
              {(p) => (
                <Textarea
                  {...p}
                  name="automation-objective"
                  autoComplete="off"
                  rows={4}
                  value={objective}
                  disabled={!canMutate}
                  onChange={(e) => setObjective(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, objective: true }))}
                  placeholder="e.g. Investigate search-index and summarise the cause…"
                  className="w-full"
                />
              )}
            </Field>
          </div>
        </SheetSection>
      </form>
    </Sheet>
  )
}
