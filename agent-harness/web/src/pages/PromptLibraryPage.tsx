import { ArrowsClockwise, FileText, Lock, PencilSimple, PlusCircle, ShareNetwork, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ForbiddenState } from '../components/prompts/ForbiddenState'
import { PromptCreateSheet } from '../components/prompts/PromptCreateSheet'
import { PromptDetail } from '../components/prompts/PromptDetail'
import {
  Button,
  Chip,
  CopyId,
  EmptyState,
  ErrorState,
  FilteredEmpty,
  PageHeader,
  RelativeTime,
  Row,
  RowActions,
  SearchInput,
  Segmented,
  SortHeader,
  Table,
  TableSkeleton,
  useToast,
  type RowAction,
} from '../components/ui'
import { disabledReason, useMe } from '../hooks/useMe'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { PromptKind, PromptSummary } from '../lib/api-types'
import { isForbidden } from '../lib/prompts-access'
import { filterPrompts, PROMPT_KIND_LABELS, PROMPT_KINDS } from '../lib/prompts-list'
import { formatSort, nextSort, parseSort, sortRows } from '../lib/table-sort'

const KIND_VALUES = ['all', ...PROMPT_KINDS] as const
const SORT_COLUMNS = ['name', 'kind', 'versions', 'updated'] as const
const FILTER_KEYS = ['q', 'kind']

/** Prompts: the versioned library. `/prompts` is the table; `/prompts/:id` is
 * the full detail page (versions, diff, draft + verify, playground), which
 * needs more room than a sheet gives it. */
export function PromptLibraryPage() {
  const { promptId } = useParams<{ promptId?: string }>()
  return promptId ? <PromptDetail key={promptId} promptId={promptId} /> : <PromptList />
}

function PromptList() {
  const navigate = useNavigate()
  const toast = useToast()
  const { me, loading: meLoading } = useMe()
  const [q, setQ] = useUrlState('q')
  const [kind, setKind] = useUrlEnum<PromptKind | 'all'>('kind', KIND_VALUES, 'all')
  const [sortRaw, setSortRaw] = useUrlState('sort')
  const [create, setCreate] = useUrlState('create')
  const clearParams = useClearUrlParams()

  const [prompts, setPrompts] = useState<PromptSummary[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const reload = useCallback(() => setRefreshToken((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    api.listPrompts(kind === 'all' ? undefined : { kind }).then(
      (data) => {
        if (cancelled) return
        setPrompts(data)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(err)
      },
    )
    return () => {
      cancelled = true
    }
  }, [kind, refreshToken])

  const canCreate = me ? me.permissions.includes('mutate_prompts') : true
  const createReason = canCreate ? undefined : disabledReason(me, 'mutate_prompts')

  // `?create=1` (palette "New prompt") opens the form; a role that can't create gets the reason instead.
  useEffect(() => {
    if (create !== '1' || meLoading || canCreate) return
    setCreate('')
    toast({ tone: 'error', title: "You can't create prompts", description: disabledReason(me, 'mutate_prompts') })
  }, [create, meLoading, canCreate, me, setCreate, toast])

  const sort = parseSort(sortRaw, SORT_COLUMNS)
  const onSort = (column: string) => setSortRaw(formatSort(nextSort(sort, column)))
  const rows = useMemo(
    () =>
      sortRows(filterPrompts(prompts ?? [], q), parseSort(sortRaw, SORT_COLUMNS), (p, column) =>
        column === 'name' ? p.name : column === 'kind' ? p.kind : column === 'versions' ? p.version_count : p.updated_at,
      ),
    [prompts, q, sortRaw],
  )

  const active = q !== '' || kind !== 'all'
  const clearFilters = () => clearParams(FILTER_KEYS)

  const remove = async (p: PromptSummary) => {
    try {
      await api.deletePrompt(p.id)
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't delete “${p.name}”`, description: errorText(err, 'Try again.') })
      return
    }
    reload()
    toast({
      title: `Deleted “${p.name}”`,
      description: 'Kept in the trash. Undo brings it back with every version.',
      action: {
        label: 'Undo',
        run: async () => {
          await api.restorePrompt(p.id)
          reload()
          toast({ title: 'Delete undone' })
        },
      },
    })
  }

  const rowActions = (p: PromptSummary): RowAction[] => [
    { label: 'Open', icon: <FileText size={14} />, onSelect: () => navigate(`/prompts/${p.id}`) },
    {
      label: 'New version',
      icon: <PencilSimple size={14} />,
      onSelect: () => navigate(`/prompts/${p.id}?tab=draft`),
      disabled: !canCreate,
      disabledReason: createReason,
    },
    {
      label: 'Delete',
      icon: <Trash size={14} />,
      destructive: true,
      disabled: !canCreate,
      disabledReason: createReason,
      confirm: { title: `Delete “${p.name}”?`, description: 'All versions go to the trash with it. You can undo for a few seconds.' },
      onSelect: () => remove(p),
    },
  ]

  const newPromptButton = (
    <Button variant="primary" icon={<PlusCircle size={14} weight="bold" />} disabled={!canCreate} title={createReason} onClick={() => setCreate('1')}>
      New prompt
    </Button>
  )

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Prompts"
        description={
          <>
            Versioned prompts. One version is active per prompt; the active version of <span className="font-data">ops-system</span> builds every new run&rsquo;s agent.
          </>
        }
        actions={
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <Button icon={<ArrowsClockwise size={14} weight="bold" />} onClick={reload}>
                Refresh
              </Button>
              {newPromptButton}
            </div>
            {createReason && <span className="max-w-xs text-right text-xs text-zinc-500">{createReason}</span>}
          </div>
        }
        toolbar={
          <>
            <SearchInput label="Search prompts" placeholder="Search name, slug, description" value={q} onValueChange={setQ} className="w-full sm:w-64" />
            <Segmented
              label="Kind"
              value={kind}
              onChange={setKind}
              options={[{ value: 'all', label: 'All' }, ...PROMPT_KINDS.map((k) => ({ value: k, label: PROMPT_KIND_LABELS[k] }))]}
            />
            {active && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </>
        }
      />

      {error && prompts === null ? (
        isForbidden(error) ? (
          <ForbiddenState what="prompts" backTo="/sessions" backLabel="Back to sessions" />
        ) : (
          <ErrorState message={`${errorText(error, 'Could not load prompts.')} Check that the backend is running.`} onRetry={reload} />
        )
      ) : prompts === null ? (
        <TableSkeleton rows={5} columns={5} />
      ) : rows.length === 0 ? (
        active ? (
          <FilteredEmpty query={q || undefined} what="prompts" onClear={clearFilters} />
        ) : (
          <EmptyState
            icon={<FileText size={22} weight="duotone" />}
            title="No prompts yet"
            description="A prompt is a named, versioned system prompt. Agents pin one and pick up its active version on their next run."
            action={newPromptButton}
            example="Try: slug “ops-system”, kind System, with your on-call assistant instructions."
          />
        )
      ) : (
        <Table label="Prompts">
          <thead>
            <tr>
              <SortHeader column="name" sort={sort} onSort={onSort}>
                Prompt
              </SortHeader>
              <SortHeader column="kind" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                Kind
              </SortHeader>
              <th>Active</th>
              <SortHeader column="versions" sort={sort} onSort={onSort} className="hidden md:table-cell">
                Versions
              </SortHeader>
              <th className="hidden lg:table-cell">Used by</th>
              <SortHeader column="updated" sort={sort} onSort={onSort} className="hidden md:table-cell">
                Updated
              </SortHeader>
              <th className="w-12">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Row key={p.id} onOpen={() => navigate(`/prompts/${p.id}`)}>
                <td className="max-w-0 min-w-[12rem]">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <p className="truncate font-medium text-zinc-900" title={p.name}>
                      {p.name}
                    </p>
                    {p.visibility === 'private' ? <Lock size={12} className="shrink-0 text-zinc-500" aria-label="Private" /> : <ShareNetwork size={12} className="shrink-0 text-zinc-500" aria-label="Shared" />}
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-zinc-500">
                    <CopyId value={p.slug} label="slug" />
                    <span className="truncate">{p.owner_id}</span>
                  </p>
                </td>
                <td className="hidden sm:table-cell">
                  <Chip>{PROMPT_KIND_LABELS[p.kind]}</Chip>
                </td>
                <td>
                  {p.active_version ? (
                    <Chip tone="ok" dot>
                      v{p.active_version.version} active
                    </Chip>
                  ) : (
                    <Chip tone="warn">None active</Chip>
                  )}
                </td>
                <td className="hidden text-zinc-600 tabular-nums md:table-cell">{p.version_count}</td>
                <td className="hidden text-zinc-600 tabular-nums lg:table-cell">
                  {p.used_by_agents} agent{p.used_by_agents === 1 ? '' : 's'}
                </td>
                <td className="hidden text-zinc-600 md:table-cell">
                  <RelativeTime value={p.updated_at} />
                </td>
                <td className="text-right">
                  <RowActions label={`Actions for “${p.name}”`} items={rowActions(p)} />
                </td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}

      {create === '1' && canCreate && (
        <PromptCreateSheet
          onClose={() => setCreate('')}
          onCreated={(created) => {
            setCreate('')
            reload()
            navigate(`/prompts/${created.id}`)
            toast({
              title: `Created “${created.name}”`,
              action: {
                label: 'Undo',
                run: async () => {
                  await api.deletePrompt(created.id)
                  navigate('/prompts')
                  toast({ title: 'Creation undone' })
                },
              },
            })
          }}
        />
      )}
    </div>
  )
}
