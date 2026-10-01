import { ArrowClockwise, ChatCircleDots, Copy, PlusCircle, Robot, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { AgentUsageSummary } from '../components/agents/AgentUsageSummary'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { PageHeader } from '../components/ui/PageHeader'
import { VisibilityBadge } from '../components/ui/VisibilityBadge'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import { getCurrentUserId } from '../lib/identity'
import type { Agent, PromptSummary, Skill, ToolCatalogEntry } from '../lib/api-types'
import { AgentEditorForm, type AgentEditorTab } from './AgentEditorPage'

const MODE_LABEL: Record<Agent['skill_mode'], string> = {
  none: 'None',
  assigned: 'Assigned',
  auto: 'Auto',
}

const MODE_BADGE_CLASS: Record<Agent['skill_mode'], string> = {
  none: 'bg-zinc-100 text-zinc-700',
  assigned: 'bg-sky-100 text-sky-800',
  auto: 'bg-violet-100 text-violet-800',
}

/** Agents: a named, ownable entity binding a prompt (+ optional pinned
 * version), a skill-routing mode (none/assigned/auto), and a base tool set.
 * Session/run creation resolves an `agent_id` (defaulting to the one marked
 * `is_default`) through `agent_harness.agent_runtime`. Each card also shows
 * real usage stats and offers a test chat and a clone. */
export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [prompts, setPrompts] = useState<PromptSummary[] | null>(null)
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [tools, setTools] = useState<ToolCatalogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [editing, setEditing] = useState<Agent | 'new' | null>(null)
  const [editorTab, setEditorTab] = useState<AgentEditorTab>('settings')
  const [cloningId, setCloningId] = useState<string | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    Promise.all([api.listAgents(), api.listPrompts(), api.listSkills({ enabled: true }), api.listTools()])
      .then(([a, p, s, t]) => {
        if (cancelled) return
        setAgents(a)
        setPrompts(p)
        setSkills(s)
        setTools(t)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load agents.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const refresh = () => setRefreshToken((n) => n + 1)
  const currentUserId = getCurrentUserId()
  const ready = agents && prompts && skills && tools
  const { me } = useMe()
  const canCreate = me ? me.permissions.includes('mutate_agents') : true

  const openEditor = (agent: Agent | 'new', tab: AgentEditorTab = 'settings') => {
    setEditorTab(tab)
    setEditing(agent)
  }

  const cloneAgent = async (agent: Agent) => {
    setCloningId(agent.id)
    setCloneError(null)
    setNotice(null)
    try {
      const copy = await api.cloneAgent(agent.id)
      setNotice(`Cloned "${agent.name}" as "${copy.name}".`)
      refresh()
      openEditor(copy)
    } catch (err) {
      setCloneError(err instanceof ApiError ? err.message : `Failed to clone "${agent.name}". Try again.`)
    } finally {
      setCloningId(null)
    }
  }

  const newAgentButton = (
    <button
      type="button"
      onClick={() => openEditor('new')}
      disabled={!canCreate}
      title={canCreate ? undefined : disabledReason(me, 'mutate_agents')}
      className="ui-btn ui-btn-primary"
    >
      <PlusCircle size={14} weight="bold" aria-hidden="true" />
      New agent
    </button>
  )

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Agents"
        description="A named agent binds a prompt, a skill-routing mode, and a base tool set. Sessions and runs resolve an agent (the default if none is chosen) at run start."
        actions={
          <>
            <button type="button" onClick={refresh} className="ui-btn ui-btn-secondary">
              <ArrowClockwise size={14} weight="bold" aria-hidden="true" />
              Refresh
            </button>
            {newAgentButton}
          </>
        }
      />

      <div className="mt-4">
        {error && <ErrorBanner message={error} onRetry={refresh} />}
        {cloneError && <ErrorBanner message={cloneError} />}
        {notice && (
          <p role="status" className="mb-3 text-xs text-zinc-700">
            {notice}
          </p>
        )}

        {!error && !ready ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-48 w-full rounded-lg" />
            ))}
          </div>
        ) : ready && agents.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => {
              const prompt = prompts.find((p) => p.id === agent.prompt_id)
              const agentSkills = skills.filter((s) => agent.skill_ids.includes(s.id))
              return (
                <div key={agent.id} className="ui-card ui-card-hover flex flex-col">
                  <button
                    type="button"
                    onClick={() => openEditor(agent)}
                    aria-label={`Edit ${agent.name}`}
                    className="flex flex-1 flex-col items-start gap-2 p-4 text-left"
                  >
                    <div className="flex w-full items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white"
                          style={{ backgroundColor: agent.avatar_color }}
                        >
                          <Robot size={14} weight="bold" aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-zinc-900">{agent.name}</p>
                          <p className="font-data truncate text-xs text-zinc-600">/{agent.slug}</p>
                        </div>
                      </div>
                      <VisibilityBadge visibility={agent.visibility} className="mt-1" />
                    </div>
                    <p className="line-clamp-2 text-xs text-zinc-600 [overflow-wrap:anywhere]">{agent.description}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${MODE_BADGE_CLASS[agent.skill_mode]}`}
                      >
                        Skills: {MODE_LABEL[agent.skill_mode]}
                      </span>
                      {prompt && (
                        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-700">
                          {prompt.slug}
                          {agent.prompt_version_id ? ' (pinned)' : ''}
                        </span>
                      )}
                      {agentSkills.map((s) => (
                        <span
                          key={s.id}
                          className="font-data rounded-full bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-800"
                        >
                          /{s.slug}
                        </span>
                      ))}
                    </div>
                    <div className="mt-auto flex w-full items-center justify-between pt-1 text-xs text-zinc-600">
                      <span>{agent.owner_id === currentUserId ? 'You' : agent.owner_id}</span>
                      {agent.is_default && (
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800">
                          Default
                        </span>
                      )}
                    </div>
                  </button>
                  <div className="flex flex-col gap-2 border-t border-zinc-100 px-4 py-3">
                    <AgentUsageSummary agentId={agent.id} refreshKey={refreshToken} />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openEditor(agent, 'test')}
                        className="ui-btn ui-btn-secondary ui-btn-sm"
                      >
                        <ChatCircleDots size={13} weight="bold" aria-hidden="true" />
                        Test chat
                      </button>
                      <button
                        type="button"
                        onClick={() => void cloneAgent(agent)}
                        disabled={!canCreate || cloningId !== null}
                        title={canCreate ? 'Duplicate this agent as a private copy' : disabledReason(me, 'mutate_agents')}
                        className="ui-btn ui-btn-secondary ui-btn-sm"
                      >
                        <Copy size={13} weight="bold" aria-hidden="true" />
                        {cloningId === agent.id ? 'Cloning…' : 'Clone'}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          !error && (
            <EmptyState
              icon={<Robot size={28} />}
              title="No agents found"
              description="Create an agent to bind a prompt, skill-routing mode, and tool set for chat."
              action={newAgentButton}
            />
          )
        )}
      </div>

      {editing && ready && (
        <div className="fixed inset-0 z-50 flex justify-end bg-zinc-900/40">
          <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5">
              <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-900">
                {editing === 'new' ? 'New agent' : editing.name}
              </h2>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="ui-btn ui-btn-ghost ui-btn-icon"
                aria-label="Close"
              >
                <X size={16} weight="bold" aria-hidden="true" />
              </button>
            </div>
            <AgentEditorForm
              key={`${editing === 'new' ? 'new' : editing.id}:${editorTab}`}
              agent={editing === 'new' ? null : editing}
              initialTab={editorTab}
              prompts={prompts}
              skills={skills}
              tools={tools}
              onSaved={() => {
                setEditing(null)
                refresh()
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
