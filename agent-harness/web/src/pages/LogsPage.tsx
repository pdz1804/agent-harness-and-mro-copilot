import { ArrowClockwise, ArrowSquareOut, DownloadSimple, Export, ListMagnifyingGlass, Warning } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { downloadText, exportFileName, toJsonl } from '../lib/export-file'
import { Link } from 'react-router-dom'
import {
  Button,
  Chip,
  CopyId,
  EmptyState,
  ErrorState,
  FactList,
  FilteredEmpty,
  Input,
  LinkButton,
  PageHeader,
  RelativeTime,
  Row,
  RowActions,
  SearchInput,
  Select,
  Sheet,
  SheetSection,
  SortHeader,
  StatusBadge,
  Table,
  TableSkeleton,
  useToast,
  type RowAction,
} from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { Agent, Incident, RunSummary } from '../lib/api-types'
import { LOG_SORT_COLUMNS, LOG_STATUSES, filterLogRuns, hasLogFilters, logSortKey, runIdsWithIncident, type IncidentFilter } from '../lib/logs-filters'
import { formatSort, nextSort, parseSort, sortRows } from '../lib/table-sort'

const FILTER_KEYS = ['q', 'status', 'incident', 'from', 'to']

async function downloadExport(runId: string) {
  const trace = await api.exportRun(runId)
  downloadText(`run-${runId}.json`, JSON.stringify(trace, null, 2), 'application/json')
}

/** Logs: every persisted run (PostgreSQL-backed, so traces survive restarts)
 * as an audit table, filterable by status, incident, date range and search,
 * with a per-run trace export (`GET /runs/{id}/export`). Filters, sort and the
 * open run (`?open=<runId>`) live in the URL. Exporting is read-only, so
 * there is nothing to undo. */
export function LogsPage() {
  const toast = useToast()
  const [q, setQ] = useUrlState('q')
  const [status, setStatus] = useUrlState('status')
  const [incident, setIncident] = useUrlEnum<IncidentFilter>('incident', ['all', 'yes', 'no'], 'all')
  const [from, setFrom] = useUrlState('from')
  const [to, setTo] = useUrlState('to')
  const [sortRaw, setSortRaw] = useUrlState('sort')
  const [openId, setOpenId] = useUrlState('open')
  const clearParams = useClearUrlParams()

  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [incidents, setIncidents] = useState<Incident[] | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [loading, setLoading] = useState(false)
  const [exportingId, setExportingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([api.listRuns(), api.listIncidents()])
      .then(([runsData, incidentsData]) => {
        if (cancelled) return
        setRuns(runsData)
        setIncidents(incidentsData)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Failed to load logs.'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  useEffect(() => {
    let cancelled = false
    api.listAgents().then(
      (data) => {
        if (!cancelled) setAgents(data)
      },
      () => {
        /* Agent names are a nicety: facts fall back to the raw agent id. */
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  const agentLabel = (id: string | null) => (id ? (agentNames.get(id) ?? id) : 'No agent')
  const withIncident = useMemo(() => runIdsWithIncident(incidents ?? []), [incidents])
  const incidentByRun = useMemo(() => new Map((incidents ?? []).filter((i) => i.run_id).map((i) => [i.run_id as string, i])), [incidents])

  const filters = { q, status, incident, from, to }
  const active = hasLogFilters(filters)
  const sort = parseSort(sortRaw, LOG_SORT_COLUMNS)
  const onSort = (column: string) => setSortRaw(formatSort(nextSort(sort, column)))
  const rows = useMemo(
    () => (runs ? sortRows(filterLogRuns(runs, { q, status, incident, from, to }, withIncident), sort ?? { column: 'started', dir: 'desc' }, logSortKey) : null),
    [runs, q, status, incident, from, to, withIncident, sort],
  )

  const exportRun = async (runId: string) => {
    setExportingId(runId)
    try {
      await downloadExport(runId)
      toast({ title: `Exported run-${runId}.json` })
    } catch (err) {
      toast({ tone: 'error', title: "Couldn't export the trace", description: errorText(err, 'Try again.') })
    } finally {
      setExportingId(null)
    }
  }

  // The filtered run list, one summary per line (per-run traces export from the row menu).
  const exportList = () => {
    if (!rows?.length) return
    const name = exportFileName('runs', 'jsonl')
    downloadText(name, toJsonl(rows), 'application/x-ndjson')
    toast({ title: `Exported ${rows.length} run${rows.length === 1 ? '' : 's'}`, description: name })
  }

  const clearFilters = () => clearParams(FILTER_KEYS)
  const reload = () => {
    setError(null)
    setRefreshToken((n) => n + 1)
  }

  const conversationPath = (run: RunSummary) => (run.session_id ? `/sessions/${run.session_id}` : `/runs/${run.run_id}`)

  const rowActions = (run: RunSummary): RowAction[] => [
    { label: 'Export trace as JSON', icon: <DownloadSimple size={14} />, disabled: exportingId === run.run_id, onSelect: () => exportRun(run.run_id) },
  ]

  const openIndex = rows ? rows.findIndex((r) => r.run_id === openId) : -1
  const step = (delta: 1 | -1) => {
    if (!rows?.length) return
    setOpenId(rows[(Math.max(0, openIndex) + delta + rows.length) % rows.length].run_id)
  }
  const openRun = runs?.find((r) => r.run_id === openId) ?? null

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Logs"
        description="Every persisted run trace: an audit log with evidence export. Traces survive restarts."
        actions={
          <>
            <Button icon={<ArrowClockwise size={14} weight="bold" />} onClick={reload} loading={loading && runs !== null}>
              Refresh
            </Button>
            <Button
              icon={<Export size={14} weight="bold" />}
              disabled={!rows?.length}
              title={rows?.length ? 'Download the runs this view shows, one JSON object per line' : 'Nothing to export'}
              onClick={exportList}
            >
              Export JSONL
            </Button>
          </>
        }
        toolbar={
          <>
            <SearchInput label="Search runs" placeholder="Search objective or ID" value={q} onValueChange={setQ} className="w-full sm:w-64" />
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {LOG_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}
                </option>
              ))}
            </Select>
            <Select aria-label="Incident" value={incident} onChange={(e) => setIncident(e.target.value as IncidentFilter)}>
              <option value="all">Any incident state</option>
              <option value="yes">Has incident</option>
              <option value="no">No incident</option>
            </Select>
            <Input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="tabular-nums" />
            <Input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="tabular-nums" />
            {active && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            {runs && (
              <span className="ml-auto text-xs text-zinc-500 tabular-nums" aria-live="polite">
                {active && rows ? `${rows.length} of ${runs.length}` : runs.length} runs
              </span>
            )}
          </>
        }
      />

      {error && runs === null ? (
        <ErrorState message={error} onRetry={reload} />
      ) : rows === null ? (
        <TableSkeleton rows={6} columns={4} />
      ) : runs?.length === 0 ? (
        <EmptyState
          icon={<ListMagnifyingGlass size={22} weight="duotone" />}
          title="No runs yet"
          description="Every run is recorded here with its full trace, ready to export as evidence."
          action={
            <LinkButton to="/chat" variant="primary">
              New run
            </LinkButton>
          }
          example="Try: “Why is payments-api slow right now?”"
        />
      ) : rows.length === 0 ? (
        <FilteredEmpty query={q || undefined} what="runs" onClear={clearFilters} />
      ) : (
        <>
          {error && <p className="mb-2 text-xs text-rose-700">Refresh failed: {error} Showing the last loaded list.</p>}
          <Table label="Runs">
            <thead>
              <tr>
                <SortHeader column="objective" sort={sort} onSort={onSort}>
                  Run
                </SortHeader>
                <SortHeader column="status" sort={sort} onSort={onSort}>
                  Status
                </SortHeader>
                <th className="hidden md:table-cell">Incident</th>
                <SortHeader column="started" sort={sort ?? { column: 'started', dir: 'desc' }} onSort={onSort} className="hidden sm:table-cell">
                  Started
                </SortHeader>
                <th className="w-12">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <Row key={run.run_id} onOpen={() => setOpenId(run.run_id)} selected={run.run_id === openId} className={exportingId === run.run_id ? 'opacity-60' : ''}>
                  <td className="max-w-0 min-w-[12rem]">
                    <p className="truncate font-medium text-zinc-900" title={run.objective}>
                      {run.objective}
                    </p>
                    <p className="font-data truncate text-xs text-zinc-500">{run.run_id}</p>
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="hidden md:table-cell">
                    {withIncident.has(run.run_id) ? (
                      <Chip tone="danger" dot>
                        Incident opened
                      </Chip>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="hidden text-zinc-600 sm:table-cell">
                    <RelativeTime value={run.started_at} />
                  </td>
                  <td className="text-right">
                    <RowActions label={`Actions for run ${run.run_id}`} items={rowActions(run)} />
                  </td>
                </Row>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {openId && (
        <RunLogSheet
          run={openRun}
          loading={runs === null}
          agentLabel={agentLabel}
          incident={incidentByRun.get(openId) ?? null}
          conversationPath={conversationPath}
          exporting={exportingId === openId}
          onExport={() => void exportRun(openId)}
          onClose={() => setOpenId('')}
          onPrev={rows && rows.length > 1 ? () => step(-1) : undefined}
          onNext={rows && rows.length > 1 ? () => step(1) : undefined}
        />
      )}
    </div>
  )
}

interface RunLogSheetProps {
  run: RunSummary | null
  loading: boolean
  agentLabel: (id: string | null) => string
  incident: Incident | null
  conversationPath: (run: RunSummary) => string
  exporting: boolean
  onExport: () => void
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
}

/** Run facts for the audit log. Deep link: `/logs?open=<runId>`. */
function RunLogSheet({ run, loading, agentLabel, incident, conversationPath, exporting, onExport, onClose, onPrev, onNext }: RunLogSheetProps) {
  useDocumentTitle(run ? run.objective : null)
  return (
    <Sheet
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      eyebrow="Logs"
      label={run?.objective ?? 'Run'}
      title={run?.objective ?? 'Run'}
      status={run ? <StatusBadge status={run.status} /> : undefined}
      meta={
        run && (
          <>
            <CopyId value={run.run_id} label="run ID" />
            <span aria-hidden="true">·</span>
            <RelativeTime value={run.started_at} />
          </>
        )
      }
      headerActions={
        run && (
          <RowActions
            visibility="always"
            label={`More actions for run ${run.run_id}`}
            items={[
              { label: 'Export trace as JSON', icon: <DownloadSimple size={14} />, disabled: exporting, onSelect: onExport },
            ]}
          />
        )
      }
      footer={
        run && (
          <>
            <Button icon={<DownloadSimple size={14} />} onClick={onExport} loading={exporting}>
              Export JSON
            </Button>
            <LinkButton to={conversationPath(run)} variant="primary" icon={<ArrowSquareOut size={14} weight="bold" />}>
              Open conversation
            </LinkButton>
          </>
        )
      }
    >
      {!run ? (
        loading ? (
          <p className="text-[13px] text-zinc-500">Loading the run…</p>
        ) : (
          <ErrorState message="This run is not in the log (it may have been removed, or you may not have access)." />
        )
      ) : (
        <>
          <SheetSection title="Overview">
            <FactList
              items={[
                { label: 'Started', value: <RelativeTime value={run.started_at} /> },
                { label: 'Agent', value: agentLabel(run.agent_id) },
                { label: 'Session', value: run.session_id ? <CopyId value={run.session_id} label="session ID" /> : 'None' },
                { label: 'Owner', value: <span className="font-data text-xs">{run.owner_id}</span> },
                { label: 'Prompt version', value: run.prompt_version_id ? <span className="font-data text-xs">{run.prompt_version_id}</span> : 'Default' },
                { label: 'Skills', value: run.skill_ids.length ? <span className="font-data text-xs">{run.skill_ids.join(', ')}</span> : 'None' },
                {
                  label: 'Triggered by',
                  value: run.triggered_by_automation_id ? (
                    <Link to="/automations" className="ui-btn-link font-data text-xs">
                      Automation {run.triggered_by_automation_id}
                    </Link>
                  ) : (
                    'A person'
                  ),
                },
              ]}
            />
          </SheetSection>
          <SheetSection title="Incident">
            {incident ? (
              <Link to={`/incidents/${incident.id}`} className="ui-card ui-card-hover flex items-start gap-2.5 p-3">
                <Warning size={16} weight="fill" className="mt-0.5 shrink-0 text-rose-600" aria-hidden="true" />
                <span className="min-w-0 text-[13px]">
                  <span className="block font-medium text-zinc-900">{incident.title}</span>
                  <span className="text-xs text-zinc-500">
                    {incident.severity} · {incident.status}
                  </span>
                </span>
              </Link>
            ) : (
              <p className="text-[13px] text-zinc-500">No incident was opened from this run.</p>
            )}
          </SheetSection>
          <SheetSection title="Trace">
            <p className="text-[13px] text-zinc-600">
              <Link to={`/runs/${run.run_id}`} className="ui-btn-link">
                Open the live trace
              </Link>{' '}
              for steps, tool calls and the inspector, or export the full trace as JSON.
            </p>
          </SheetSection>
        </>
      )}
    </Sheet>
  )
}
