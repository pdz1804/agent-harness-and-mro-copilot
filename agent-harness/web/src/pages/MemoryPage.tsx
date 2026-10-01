import { Brain, PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { MemorySheet } from '../components/memory/MemorySheet'
import {
  Button,
  Chip,
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
import { useMe } from '../hooks/useMe'
import { useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { Memory } from '../lib/api-types'
import { MEMORY_SORT_COLUMNS, memoryBlockedReason, memorySortKey } from '../lib/memory-list'
import { formatSort, nextSort, parseSort, sortRows } from '../lib/table-sort'

const SEARCH_DEBOUNCE_MS = 250
const SCOPES = ['mine', 'all'] as const
type Scope = (typeof SCOPES)[number]
const MAX_ROW_TAGS = 3

/** Long-term memory: the facts agents keep across conversations. Everything
 * shown is read from `/memories`. Search, scope, sort, the open memory
 * (`?open=<id>`) and the add flow (`?add=1`) live in the URL. Deleting toasts
 * with Undo (`restoreMemory`); editing toasts with an Undo that writes the
 * previous fact and tags back. */
export function MemoryPage() {
  const toast = useToast()
  const { me } = useMe()
  const isAdmin = me?.role === 'admin'

  const [q, setQ] = useUrlState('q')
  const [scope, setScope] = useUrlEnum<Scope>('scope', SCOPES, 'mine')
  const [sortRaw, setSortRaw] = useUrlState('sort')
  const [openId, setOpenId] = useUrlState('open')
  const [addFlag, setAddFlag] = useUrlState('add')

  const [searchInput, setSearchInput] = useState(q)
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [adding, setAdding] = useState(false)
  const [editOnOpen, setEditOnOpen] = useState(false)
  const [lookedUp, setLookedUp] = useState<{ id: string; memory: Memory | null } | null>(null)

  // A non-admin must never stay on the oversight scope (e.g. after an identity switch).
  const effectiveScope: Scope = isAdmin ? scope : 'mine'
  const reload = useCallback(() => setRefreshToken((n) => n + 1), [])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== q) setQ(searchInput.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, q, setQ])

  useEffect(() => {
    let cancelled = false
    api.listMemories({ q: q || undefined, scope: effectiveScope }).then(
      (data) => {
        if (cancelled) return
        setMemories(data)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Failed to load memories.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [q, effectiveScope, refreshToken])

  // `?add=1` (command palette "Remember a fact") opens the add sheet once, then clears the flag.
  useEffect(() => {
    if (addFlag !== '1') return
    setAddFlag('')
    setAdding(true)
  }, [addFlag, setAddFlag])

  const sort = parseSort(sortRaw, MEMORY_SORT_COLUMNS)
  const onSort = (column: string) => setSortRaw(formatSort(nextSort(sort, column)))
  const rows = useMemo(() => sortRows(memories ?? [], sort, memorySortKey), [memories, sort])

  // A deep link can name a memory the current search or scope hides: look it
  // up unfiltered once, so the sheet still opens.
  const listed = memories?.find((m) => m.id === openId) ?? null
  useEffect(() => {
    if (!openId || memories === null || listed) return
    let cancelled = false
    api.listMemories({ scope: isAdmin ? 'all' : 'mine' }).then(
      (all) => {
        if (!cancelled) setLookedUp({ id: openId, memory: all.find((m) => m.id === openId) ?? null })
      },
      () => {
        if (!cancelled) setLookedUp({ id: openId, memory: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [openId, memories, listed, isAdmin])

  const openMemory = listed ?? (lookedUp?.id === openId ? lookedUp.memory : null)
  const lookup = listed ? 'ready' : lookedUp?.id === openId ? (lookedUp.memory ? 'ready' : 'missing') : 'loading'

  const closeSheet = () => {
    setOpenId('')
    setAdding(false)
    setEditOnOpen(false)
  }
  const openIndex = rows.findIndex((m) => m.id === openId)
  const step = (delta: 1 | -1) => {
    if (!rows.length) return
    setEditOnOpen(false)
    setOpenId(rows[(Math.max(0, openIndex) + delta + rows.length) % rows.length].id)
  }
  const openRow = (id: string, edit: boolean) => {
    setEditOnOpen(edit)
    setOpenId(id)
  }

  const active = q !== '' || effectiveScope !== 'mine'
  const clearFilters = () => {
    setSearchInput('')
    setQ('')
    setScope('mine')
  }

  const addMemory = async (fact: string, tags: string[]) => {
    const created = await api.createMemory({ fact, tags })
    setAdding(false)
    reload()
    toast({
      title: 'Saved to memory',
      description: created.fact,
      action: { label: 'Open', run: () => openRow(created.id, false) },
    })
  }

  const updateMemory = async (memory: Memory, fact: string, tags: string[]) => {
    const previous = { fact: memory.fact, tags: memory.tags }
    const updated = await api.updateMemory(memory.id, { fact, tags })
    setMemories((list) => list && list.map((m) => (m.id === updated.id ? updated : m)))
    setLookedUp((prev) => (prev?.id === updated.id ? { id: updated.id, memory: updated } : prev))
    toast({
      title: 'Memory updated',
      action: {
        label: 'Undo',
        run: async () => {
          await api.updateMemory(memory.id, previous)
          reload()
          setLookedUp(null)
        },
      },
    })
  }

  /** Soft-delete; Undo restores. Reports its own failures. */
  const deleteMemory = async (memory: Memory) => {
    try {
      await api.deleteMemory(memory.id)
    } catch (err) {
      toast({ tone: 'error', title: "Couldn't delete the memory", description: errorText(err, 'Try again.') })
      return
    }
    setMemories((list) => list && list.filter((m) => m.id !== memory.id))
    if (openId === memory.id) closeSheet()
    toast({
      title: 'Deleted the memory',
      description: memory.fact.length > 80 ? `${memory.fact.slice(0, 80)}…` : memory.fact,
      action: {
        label: 'Undo',
        run: async () => {
          await api.restoreMemory(memory.id)
          reload()
          setLookedUp(null)
          toast({ title: 'Delete undone' })
        },
      },
    })
  }

  const rowActions = (memory: Memory): RowAction[] => {
    const blocked = memoryBlockedReason(me, memory)
    return [
      {
        label: 'Edit',
        icon: <PencilSimple size={14} />,
        disabled: blocked !== null,
        disabledReason: blocked ?? undefined,
        onSelect: () => openRow(memory.id, true),
      },
      {
        label: 'Delete',
        icon: <Trash size={14} />,
        destructive: true,
        disabled: blocked !== null,
        disabledReason: blocked ?? undefined,
        confirm: { title: 'Delete this memory?', description: 'It stops being recalled. You can undo for a few seconds.' },
        onSelect: () => deleteMemory(memory),
      },
    ]
  }

  const addButton = (
    <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setAdding(true)} disabled={adding}>
      Add memory
    </Button>
  )
  const showOwner = effectiveScope === 'all'

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Memory"
        description="Facts your agents keep across conversations. They save one with the remember tool and bring it back with recall; you can also add, correct or remove facts here."
        actions={addButton}
        toolbar={
          <>
            <SearchInput label="Search memories" placeholder="Search facts and tags" value={searchInput} onValueChange={setSearchInput} className="w-full sm:w-72" />
            {isAdmin && (
              <Segmented
                label="Whose memories"
                value={scope}
                onChange={setScope}
                options={[
                  { value: 'mine', label: 'Mine' },
                  { value: 'all', label: 'All users' },
                ]}
              />
            )}
            {active && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            {memories && (
              <span className="ml-auto text-xs text-zinc-500 tabular-nums" aria-live="polite">
                {memories.length} {memories.length === 1 ? 'memory' : 'memories'}
                {q ? ` matching “${q}”` : ''}
                {showOwner ? ' across all users' : ''}
              </span>
            )}
          </>
        }
      />

      {error && memories === null ? (
        <ErrorState
          message={`${error} Check that the backend is running.`}
          onRetry={() => {
            setError(null)
            reload()
          }}
        />
      ) : memories === null ? (
        <TableSkeleton rows={5} columns={4} />
      ) : memories.length === 0 ? (
        active ? (
          <FilteredEmpty query={q || undefined} what="memories" onClear={clearFilters} />
        ) : (
          <EmptyState
            icon={<Brain size={22} weight="duotone" />}
            title="Nothing remembered yet"
            description="Saved facts appear here, whether an agent saved them in a chat or you wrote them yourself."
            action={addButton}
            example="Try: “Remember that the on-call rota rotates every Monday.”"
          />
        )
      ) : (
        <Table label="Memories">
          <thead>
            <tr>
              <SortHeader column="fact" sort={sort} onSort={onSort}>
                Fact
              </SortHeader>
              <th className="hidden md:table-cell">Tags</th>
              {showOwner && <th className="hidden sm:table-cell">Owner</th>}
              <SortHeader column="used" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                Recalled
              </SortHeader>
              <SortHeader column="saved" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                Saved
              </SortHeader>
              <th className="w-12">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <Row key={m.id} onOpen={() => openRow(m.id, false)} selected={m.id === openId}>
                <td className="max-w-0 min-w-[14rem] !whitespace-normal">
                  <p className="line-clamp-2 text-[13px] text-zinc-900 [overflow-wrap:anywhere]" title={m.fact}>
                    {m.fact}
                  </p>
                  {m.tags.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1 md:hidden">
                      {m.tags.slice(0, MAX_ROW_TAGS).map((tag) => (
                        <Chip key={tag}>{tag}</Chip>
                      ))}
                    </p>
                  )}
                </td>
                <td className="hidden md:table-cell">
                  <div className="flex max-w-[16rem] flex-wrap gap-1">
                    {m.tags.slice(0, MAX_ROW_TAGS).map((tag) => (
                      <Chip key={tag}>{tag}</Chip>
                    ))}
                    {m.tags.length > MAX_ROW_TAGS && <Chip tone="muted">+{m.tags.length - MAX_ROW_TAGS}</Chip>}
                  </div>
                </td>
                {showOwner && <td className="hidden text-zinc-600 sm:table-cell">{m.owner_name}</td>}
                <td className="hidden text-zinc-600 tabular-nums sm:table-cell">{m.use_count === 0 ? 'Never' : `${m.use_count}×`}</td>
                <td className="hidden text-zinc-600 sm:table-cell">
                  <RelativeTime value={m.created_at} />
                </td>
                <td className="text-right">
                  <RowActions label="Actions for this memory" items={rowActions(m)} />
                </td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}

      {adding && !openId && <MemorySheet memory={null} blockedReason={null} showOwner={false} onClose={closeSheet} onSave={addMemory} onDelete={async () => undefined} />}

      {openId && (
        <MemorySheet
          key={`${openId}:${editOnOpen}`}
          memory={openMemory}
          lookup={lookup}
          startEditing={editOnOpen}
          blockedReason={openMemory ? memoryBlockedReason(me, openMemory) : null}
          showOwner={showOwner}
          onClose={closeSheet}
          onPrev={rows.length > 1 ? () => step(-1) : undefined}
          onNext={rows.length > 1 ? () => step(1) : undefined}
          onSave={(fact, tags) => (openMemory ? updateMemory(openMemory, fact, tags) : Promise.resolve())}
          onDelete={() => (openMemory ? deleteMemory(openMemory) : Promise.resolve())}
        />
      )}
    </div>
  )
}
