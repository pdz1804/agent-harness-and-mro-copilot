import { ArrowClockwise, ChatCircleDots, Copy, Lock, PencilSimple, Play, Plus, Robot, ShareNetwork, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { AgentUsagePanel } from '../components/agents/AgentUsagePanel'
import { AgentUsageSummary } from '../components/agents/AgentUsageSummary'
import {
  Button,
  Card,
  CardGridSkeleton,
  Chip,
  CopyId,
  EmptyState,
  ErrorState,
  FactList,
  FilteredEmpty,
  LinkButton,
  PageHeader,
  RelativeTime,
  RowActions,
  SearchInput,
  Sheet,
  SheetSection,
  SheetSkeleton,
  useToast,
  type RowAction,
} from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { canWriteResource, disabledReason, useMe } from '../hooks/useMe'
import { useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { Agent, PromptSummary, Skill } from '../lib/api-types'
import { agentEditorPath, filterAgents, legacyAgentEditTarget } from '../lib/agents-form'
import { getCurrentUserId } from '../lib/identity'
import { AgentEditorPage } from './AgentEditorPage'

const SEARCH_DEBOUNCE_MS = 250

const MODE_LABEL: Record<Agent['skill_mode'], string> = {
  none: 'None',
  assigned: 'Assigned',
  auto: 'Auto',
}

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
  return letters.join('') || '?'
}

function Avatar({ agent, size = 32 }: { agent: Pick<Agent, 'name' | 'avatar_color'>; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
      style={{ backgroundColor: agent.avatar_color, width: size, height: size }}
    >
      {initials(agent.name)}
    </span>
  )
}

/** `/agents` is the list (with `?open=<id>` for the quick-inspect sheet). The
 * full-page editor lives at `/agents/:agentId` (`new` creates one); old
 * `/agents?edit=<id>` links redirect there. */
export function AgentsPage() {
  const location = useLocation()
  const legacy = legacyAgentEditTarget(location.search)
  if (legacy) return <Navigate to={legacy} replace />
  return <AgentsList />
}

/** `/agents/:agentId[?tab=settings|test|usage]` — the editor. */
export function AgentEditorRoute() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  if (!agentId) return <Navigate to="/agents" replace />
  return <AgentEditorPage key={agentId} agentId={agentId} onClose={() => navigate('/agents')} />
}

/** Agents: a named, ownable entity binding a prompt (+ optional pinned
 * version), a skill-routing mode (none/assigned/auto), and a base tool set.
 * Session/run creation resolves an `agent_id` (defaulting to the one marked
 * `is_default`) through `agent_harness.agent_runtime`. Search and the open
 * agent live in the URL. Delete is soft (Undo restores it). */
function AgentsList() {
  const navigate = useNavigate()
  const toast = useToast()
  const { me } = useMe()
  const [q, setQ] = useUrlState('q')
  const [openId, setOpenId] = useUrlState('open')
  const [searchInput, setSearchInput] = useState(q)
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [prompts, setPrompts] = useState<PromptSummary[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [cloningId, setCloningId] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== q) setQ(searchInput)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, q, setQ])

  useEffect(() => {
    let cancelled = false
    setRefreshing(true)
    api.listAgents().then(
      (list) => {
        if (cancelled) return
        setAgents(list)
        setError(null)
        setRefreshing(false)
      },
      (err: unknown) => {
        if (cancelled) return
        setError(errorText(err, 'Could not load agents.'))
        setRefreshing(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  useEffect(() => {
    let cancelled = false
    // Prompt and skill names are display extras: the list still works without them.
    api.listPrompts().then(
      (p) => !cancelled && setPrompts(p),
      () => undefined,
    )
    api.listSkills({ enabled: true }).then(
      (s) => !cancelled && setSkills(s),
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [])

  const reload = useCallback(() => setRefreshToken((n) => n + 1), [])
  const currentUserId = me?.id ?? getCurrentUserId()
  const canCreate = me ? me.permissions.includes('mutate_agents') : true
  const createReason = canCreate ? undefined : disabledReason(me, 'mutate_agents')
  const rows = useMemo(() => filterAgents(agents ?? [], q), [agents, q])
  const promptFor = (agent: Agent) => prompts.find((p) => p.id === agent.prompt_id)
  const skillsFor = (agent: Agent) => skills.filter((s) => agent.skill_ids.includes(s.id))
  const owner = (agent: Agent) => (agent.owner_id === currentUserId ? 'You' : agent.owner_id)
  const editUrl = (agent: Agent, tab?: string) => agentEditorPath(agent.id, tab)

  const cloneAgent = async (agent: Agent) => {
    setCloningId(agent.id)
    try {
      const copy = await api.cloneAgent(agent.id)
      reload()
      toast({
        title: `Cloned “${agent.name}” as “${copy.name}”`,
        action: { label: 'Open', run: () => setOpenId(copy.id) },
      })
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't clone “${agent.name}”`, description: errorText(err, 'Try again.') })
    } finally {
      setCloningId(null)
    }
  }

  const deleteAgent = async (agent: Agent) => {
    try {
      await api.deleteAgent(agent.id)
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't delete “${agent.name}”`, description: errorText(err, 'Try again.') })
      return
    }
    if (openId === agent.id) setOpenId('')
    // Drop the card now: a reload would first re-fetch its stats (404 once deleted).
    setAgents((prev) => prev?.filter((a) => a.id !== agent.id) ?? prev)
    reload()
    toast({
      title: `Deleted “${agent.name}”`,
      description: 'Kept in the trash for 7 days.',
      action: {
        label: 'Undo',
        run: async () => {
          await api.restoreAgent(agent.id)
          reload()
          toast({ title: `Restored “${agent.name}”` })
        },
      },
    })
  }

  const actionsFor = (agent: Agent, includeEdit = true): RowAction[] => {
    const canWrite = canCreate && canWriteResource(me, agent)
    const writeReason = canCreate ? `Only the owner (${agent.owner_id}) or an admin can change this agent.` : disabledReason(me, 'mutate_agents')
    return [
      ...(includeEdit ? [{ label: 'Edit', icon: <PencilSimple size={14} />, onSelect: () => navigate(editUrl(agent)) }] : []),
      { label: 'Test chat', icon: <ChatCircleDots size={14} />, onSelect: () => navigate(editUrl(agent, 'test')) },
      { label: 'Clone', icon: <Copy size={14} />, disabled: !canCreate, disabledReason: createReason, onSelect: () => cloneAgent(agent) },
      {
        label: 'Delete',
        icon: <Trash size={14} />,
        destructive: true,
        disabled: !canWrite || agent.is_default,
        disabledReason: agent.is_default ? 'The default agent cannot be deleted.' : writeReason,
        confirm: { title: `Delete “${agent.name}”?`, description: 'You can undo for a few seconds; it stays in the trash for 7 days.' },
        onSelect: () => deleteAgent(agent),
      },
    ]
  }

  const openAgent = agents?.find((a) => a.id === openId) ?? null
  const openIndex = rows.findIndex((a) => a.id === openId)
  const step = (delta: 1 | -1) => {
    if (!rows.length) return
    setOpenId(rows[(Math.max(0, openIndex) + delta + rows.length) % rows.length].id)
  }

  const newAgent = (
    <Button variant="primary" icon={<Plus size={14} weight="bold" />} disabled={!canCreate} title={createReason} onClick={() => navigate(agentEditorPath('new'))}>
      New agent
    </Button>
  )

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Agents"
        description="A named agent binds a prompt, a skill-routing mode and a base tool set. Sessions and runs resolve an agent (the default if none is chosen) at run start."
        actions={
          <>
            <Button icon={<ArrowClockwise size={14} weight="bold" />} loading={refreshing && agents !== null} onClick={reload}>
              Refresh
            </Button>
            {newAgent}
          </>
        }
        toolbar={
          <>
            <SearchInput label="Search agents" placeholder="Search name, slug or description" value={searchInput} onValueChange={setSearchInput} className="w-full sm:w-72" />
            {agents && (
              <span className="ml-auto text-xs text-zinc-500 tabular-nums" aria-live="polite">
                {q ? `${rows.length} of ${agents.length} agents` : `${agents.length} agent${agents.length === 1 ? '' : 's'}`}
              </span>
            )}
          </>
        }
      />

      {error && agents === null ? (
        <ErrorState message={`${error} Check that the backend is running.`} onRetry={reload} />
      ) : agents === null ? (
        <CardGridSkeleton count={6} />
      ) : agents.length === 0 ? (
        <EmptyState
          icon={<Robot size={22} weight="duotone" />}
          title="No agents yet"
          description="An agent binds a prompt, a skill-routing mode and a tool set, so chats can run as a specialist."
          action={newAgent}
          example="Try: an incident-only agent pinned to the triage skill."
        />
      ) : rows.length === 0 ? (
        <FilteredEmpty
          query={q}
          what="agents"
          onClear={() => {
            setSearchInput('')
            setQ('')
          }}
        />
      ) : (
        <>
          {error && <p className="mb-2 text-xs text-rose-700">Refresh failed: {error} Showing the last loaded list.</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((agent) => {
              const prompt = promptFor(agent)
              const agentSkills = skillsFor(agent)
              return (
                <Card key={agent.id} as="article" interactive selected={agent.id === openId} className="relative flex flex-col gap-3">
                  <div className="flex items-start gap-2.5">
                    <Avatar agent={agent} />
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate font-[family-name:var(--font-sans)] text-sm font-semibold tracking-normal text-zinc-950">
                        <button type="button" onClick={() => setOpenId(agent.id)} className="max-w-full truncate rounded text-left after:absolute after:inset-0 after:rounded-[14px] after:content-['']">
                          {agent.name}
                        </button>
                      </h2>
                      <p className="font-data truncate text-xs text-zinc-500">/{agent.slug}</p>
                    </div>
                    {agent.is_default && (
                      <Chip tone="ok" dot>
                        Default
                      </Chip>
                    )}
                    <span className="relative z-10 -mt-1 -mr-1.5">
                      <RowActions visibility="always" label={`Actions for “${agent.name}”`} items={actionsFor(agent)} />
                    </span>
                  </div>
                  <p className="line-clamp-2 min-h-8 text-xs text-zinc-600 [overflow-wrap:anywhere]">{agent.description || 'No description.'}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip tone={agent.skill_mode === 'auto' ? 'violet' : agent.skill_mode === 'assigned' ? 'iris' : 'neutral'}>Skills: {MODE_LABEL[agent.skill_mode]}</Chip>
                    {prompt && (
                      <Chip mono>
                        {prompt.slug}
                        {agent.prompt_version_id ? ' · pinned' : ''}
                      </Chip>
                    )}
                    {agentSkills.map((s) => (
                      <Chip key={s.id} tone="iris" mono>{`/${s.slug}`}</Chip>
                    ))}
                  </div>
                  <div className="mt-auto space-y-2 border-t border-[var(--color-line)] pt-3">
                    <AgentUsageSummary agentId={agent.id} refreshKey={refreshToken} />
                    <div className="relative z-10 flex items-center gap-2">
                      <LinkButton to={editUrl(agent)} size="sm" icon={<PencilSimple size={13} weight="bold" />}>
                        Edit
                      </LinkButton>
                      <LinkButton to={editUrl(agent, 'test')} size="sm" icon={<ChatCircleDots size={13} weight="bold" />}>
                        Test chat
                      </LinkButton>
                      <span className="flex items-center gap-1 text-xs text-zinc-500">
                        {agent.visibility === 'private' ? <Lock size={11} aria-label="Private" /> : <ShareNetwork size={11} aria-label="Shared" />}
                        {owner(agent)}
                      </span>
                      <LinkButton to={`/chat?agent=${encodeURIComponent(agent.id)}`} size="sm" variant="primary" className="ml-auto" icon={<Play size={12} weight="fill" />}>
                        Start run
                      </LinkButton>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        </>
      )}

      {openId && (
        <AgentSheet
          agentId={openId}
          agent={openAgent}
          loaded={agents !== null}
          prompt={openAgent ? (promptFor(openAgent) ?? null) : null}
          skills={skills}
          owner={owner}
          cloning={cloningId === openId}
          canCreate={canCreate}
          createReason={createReason}
          canEdit={(a) => canCreate && canWriteResource(me, a)}
          editReason={(a) => (canCreate ? `Only the owner (${a.owner_id}) or an admin can edit this agent.` : (createReason ?? ''))}
          onClose={() => setOpenId('')}
          onPrev={rows.length > 1 ? () => step(-1) : undefined}
          onNext={rows.length > 1 ? () => step(1) : undefined}
          actions={(a) => actionsFor(a, false)}
          onClone={cloneAgent}
          refreshToken={refreshToken}
        />
      )}
    </div>
  )
}

interface AgentSheetProps {
  agentId: string
  agent: Agent | null
  loaded: boolean
  prompt: PromptSummary | null
  skills: Skill[]
  owner: (a: Agent) => string
  cloning: boolean
  canCreate: boolean
  createReason?: string
  canEdit: (a: Agent) => boolean
  editReason: (a: Agent) => string
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  actions: (a: Agent) => RowAction[]
  onClone: (a: Agent) => void
  refreshToken: number
}

/** Quick-inspect sheet: overview, usage, skills, tools and prompt, with the
 * way into the full editor. Deep link: `/agents?open=<id>`. */
function AgentSheet({ agent, loaded, prompt, skills, owner, cloning, canCreate, createReason, canEdit, editReason, onClose, onPrev, onNext, actions, onClone }: AgentSheetProps) {
  useDocumentTitle(agent?.name ?? null)
  const agentSkills = agent ? skills.filter((s) => agent.skill_ids.includes(s.id)) : []
  const editable = agent ? canEdit(agent) : false

  return (
    <Sheet
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      eyebrow="Agents"
      label={agent?.name ?? 'Agent'}
      title={agent?.name ?? 'Agent'}
      status={agent?.is_default ? <Chip tone="ok" dot>Default</Chip> : undefined}
      meta={
        agent && (
          <>
            <CopyId value={agent.slug} label="agent slug" />
            <span aria-hidden="true">·</span>
            <span>{owner(agent)}</span>
            <span aria-hidden="true">·</span>
            <RelativeTime value={agent.updated_at} />
          </>
        )
      }
      headerActions={agent && <RowActions visibility="always" label={`More actions for “${agent.name}”`} items={actions(agent)} />}
      footer={
        agent && (
          <>
            <Button icon={<Copy size={14} />} loading={cloning} disabled={!canCreate} title={createReason} onClick={() => onClone(agent)}>
              Clone
            </Button>
            <LinkButton to={agentEditorPath(agent.id, 'test')} icon={<ChatCircleDots size={14} />}>
              Test chat
            </LinkButton>
            {editable ? (
              <LinkButton to={agentEditorPath(agent.id)} variant="primary" icon={<PencilSimple size={14} weight="bold" />}>
                Edit
              </LinkButton>
            ) : (
              <Button variant="primary" icon={<PencilSimple size={14} weight="bold" />} disabled title={editReason(agent)}>
                Edit
              </Button>
            )}
          </>
        )
      }
    >
      {!agent ? (
        loaded ? (
          <ErrorState message="This agent was not found. It may have been deleted." />
        ) : (
          <SheetSkeleton />
        )
      ) : (
        <>
          {!editable && <p className="mb-4 rounded-[10px] bg-amber-50 px-3 py-2 text-xs text-amber-800">{editReason(agent)} You can view it and run a test chat.</p>}
          <SheetSection title="Overview">
            <p className="mb-3 text-[13px] text-zinc-700 [overflow-wrap:anywhere]">{agent.description || 'No description.'}</p>
            <FactList
              items={[
                { label: 'Skill mode', value: MODE_LABEL[agent.skill_mode] },
                { label: 'Max steps', value: agent.max_steps ?? 'Harness default' },
                { label: 'Visibility', value: agent.visibility === 'private' ? 'Private' : 'Shared' },
                { label: 'Owner', value: <span className="font-data text-xs">{agent.owner_id}</span> },
                { label: 'Created', value: <RelativeTime value={agent.created_at} /> },
                { label: 'Updated', value: <RelativeTime value={agent.updated_at} /> },
              ]}
            />
          </SheetSection>

          <SheetSection title="Usage">
            <AgentUsagePanel agentId={agent.id} />
          </SheetSection>

          <SheetSection title={`Skills · ${MODE_LABEL[agent.skill_mode]}`}>
            {agent.skill_mode === 'none' ? (
              <p className="text-[13px] text-zinc-500">Skill routing is off; the agent uses its base tools only.</p>
            ) : agentSkills.length === 0 ? (
              <p className="text-[13px] text-zinc-500">{agent.skill_mode === 'auto' ? 'No skills pinned: the router considers every readable skill.' : 'No skills assigned.'}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {agentSkills.map((s) => (
                  <Chip key={s.id} tone="iris" mono title={s.name}>{`/${s.slug}`}</Chip>
                ))}
              </div>
            )}
          </SheetSection>

          <SheetSection title={`Base tools · ${agent.base_tools.length}`}>
            {agent.base_tools.length === 0 ? (
              <p className="text-[13px] text-zinc-500">No base tools.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {agent.base_tools.map((t) => (
                  <Chip key={t} mono>
                    {t}
                  </Chip>
                ))}
              </div>
            )}
          </SheetSection>

          <SheetSection
            title="Prompt"
            actions={
              prompt && (
                <LinkButton to={`/prompts/${prompt.id}`} variant="link">
                  Open prompt
                </LinkButton>
              )
            }
          >
            {prompt ? (
              <FactList
                items={[
                  { label: 'Prompt', value: prompt.name },
                  { label: 'Slug', value: <span className="font-data text-xs">{prompt.slug}</span> },
                  { label: 'Version', value: agent.prompt_version_id ? 'Pinned version' : `Follows active${prompt.active_version ? ` (v${prompt.active_version.version})` : ''}` },
                ]}
              />
            ) : (
              <p className="text-[13px] text-zinc-500">The prompt this agent references was not found.</p>
            )}
          </SheetSection>
        </>
      )}
    </Sheet>
  )
}
