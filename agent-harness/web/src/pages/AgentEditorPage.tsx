import { useState } from 'react'
import { AgentTestChat } from '../components/agents/AgentTestChat'
import { AgentUsagePanel } from '../components/agents/AgentUsagePanel'
import { ErrorBanner } from '../components/ErrorBanner'
import { ToolPicker } from '../components/ui/ToolPicker'
import { canWriteResource, disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { Agent, PromptSummary, Skill, SkillMode, ToolCatalogEntry } from '../lib/api-types'
import { ConfirmButton } from '../components/ui/ConfirmButton'

interface AgentFormState {
  slug: string
  name: string
  description: string
  prompt_id: string
  pin_version: boolean
  skill_mode: SkillMode
  skill_ids: string[]
  base_tools: string[]
  max_steps: string
  visibility: 'private' | 'shared'
}

function toFormState(agent: Agent): AgentFormState {
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    prompt_id: agent.prompt_id,
    pin_version: agent.prompt_version_id != null,
    skill_mode: agent.skill_mode,
    skill_ids: agent.skill_ids,
    base_tools: agent.base_tools,
    max_steps: agent.max_steps != null ? String(agent.max_steps) : '',
    visibility: agent.visibility,
  }
}

const EMPTY_FORM: AgentFormState = {
  slug: '',
  name: '',
  description: '',
  prompt_id: '',
  pin_version: false,
  skill_mode: 'none',
  skill_ids: [],
  base_tools: [],
  max_steps: '',
  visibility: 'private',
}

export type AgentEditorTab = 'settings' | 'test' | 'usage'

const TABS: { id: AgentEditorTab; label: string }[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'test', label: 'Test chat' },
  { id: 'usage', label: 'Usage' },
]

/** The agent create/edit form (phase 04) — used by `AgentsPage`'s slide-over
 * drawer. Exported as a plain component (not a routed page) since the
 * grid+drawer pattern (matching `SkillsPage`) doesn't need a separate
 * `/agents/:id` route for editing. */
export function AgentEditorForm({
  agent,
  prompts,
  skills,
  tools,
  onSaved,
  initialTab = 'settings',
}: {
  agent: Agent | null
  prompts: PromptSummary[]
  skills: Skill[]
  tools: ToolCatalogEntry[]
  onSaved: () => void
  initialTab?: AgentEditorTab
}) {
  const [tab, setTab] = useState<AgentEditorTab>(agent ? initialTab : 'settings')
  const [form, setForm] = useState<AgentFormState>(agent ? toFormState(agent) : EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [routeTestObjective, setRouteTestObjective] = useState('')
  const [routeTestResult, setRouteTestResult] = useState<{
    selected: string[]
    rationale: string
    confidence: number
  } | null>(null)
  const [routeTesting, setRouteTesting] = useState(false)

  const isNew = agent === null
  const { me } = useMe()
  // Real gate: server requires `mutate_agents` AND (owner or admin) — mirror
  // both here so the form disables before a doomed save round-trips a 403.
  const hasMutatePermission = me ? me.permissions.includes('mutate_agents') : true
  const canWrite = hasMutatePermission && (isNew || canWriteResource(me, agent))

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const maxSteps = form.max_steps.trim() ? Number(form.max_steps) : null
      const promptVersionId = form.pin_version
        ? agent?.prompt_version_id ?? prompts.find((p) => p.id === form.prompt_id)?.active_version?.id ?? null
        : null
      if (isNew) {
        await api.createAgent({
          slug: form.slug,
          name: form.name,
          description: form.description,
          prompt_id: form.prompt_id,
          prompt_version_id: promptVersionId,
          skill_mode: form.skill_mode,
          skill_ids: form.skill_ids,
          base_tools: form.base_tools,
          max_steps: maxSteps,
          visibility: form.visibility,
        })
      } else {
        await api.updateAgent(agent!.id, {
          name: form.name,
          description: form.description,
          prompt_id: form.prompt_id,
          prompt_version_id: promptVersionId,
          skill_mode: form.skill_mode,
          skill_ids: form.skill_ids,
          base_tools: form.base_tools,
          max_steps: maxSteps,
          visibility: form.visibility,
        })
      }
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save agent.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!agent) return
    setSaving(true)
    setError(null)
    try {
      await api.deleteAgent(agent.id)
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete agent.')
      setSaving(false)
    }
  }

  const handleTestRouting = async () => {
    if (!agent || !routeTestObjective.trim()) return
    setRouteTesting(true)
    setRouteTestResult(null)
    setError(null)
    try {
      const result = await api.previewRoute(agent.id, routeTestObjective)
      setRouteTestResult(result)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to test routing.')
    } finally {
      setRouteTesting(false)
    }
  }

  const promptRow = agent ? prompts.find((p) => p.id === agent.prompt_id) : undefined
  const promptLabel = promptRow
    ? agent!.prompt_version_id
      ? `${promptRow.slug} (pinned version)`
      : `${promptRow.slug} (active v${promptRow.active_version?.version ?? '?'})`
    : 'prompt not found'

  return (
    <>
      {!isNew && (
        <div role="tablist" aria-label="Agent sections" className="flex gap-1 border-b border-zinc-200 px-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`agent-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`agent-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
                tab === t.id ? 'border-sky-600 text-sky-800' : 'border-transparent text-zinc-600 hover:text-zinc-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {!isNew && agent && (
        <div
          role="tabpanel"
          id="agent-panel-test"
          aria-labelledby="agent-tab-test"
          className={tab === 'test' ? 'flex-1 px-5 py-4' : 'hidden'}
        >
          <p className="mb-3 text-xs text-zinc-600">Tests the saved agent; unsaved edits on the Settings tab are not applied.</p>
          <AgentTestChat agent={agent} promptLabel={promptLabel} />
        </div>
      )}

      {!isNew && agent && tab === 'usage' && (
        <div role="tabpanel" id="agent-panel-usage" aria-labelledby="agent-tab-usage" className="flex-1 px-5 py-4">
          <AgentUsagePanel agentId={agent.id} />
        </div>
      )}

      <div
        role={isNew ? undefined : 'tabpanel'}
        id="agent-panel-settings"
        aria-labelledby={isNew ? undefined : 'agent-tab-settings'}
        className={tab === 'settings' ? 'contents' : 'hidden'}
      >
      <div className="flex-1 space-y-4 px-5 py-4">
        {error && <ErrorBanner message={error} />}

        {!canWrite && !isNew && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            You can view this agent but not edit it (owned by {agent!.owner_id}).
          </p>
        )}

        {isNew && (
          <label className="block text-xs font-medium text-zinc-600">
            Slug
            <input name="input" autoComplete="off"
              type="text"
              value={form.slug}
              onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
              placeholder="ops-assistant…"
              className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm font-mono focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
          </label>
        )}

        <label className="block text-xs font-medium text-zinc-600">
          Name
          <input name="input" autoComplete="off"
            type="text"
            value={form.name}
            disabled={!canWrite}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
          />
        </label>

        <label className="block text-xs font-medium text-zinc-600">
          Description
          <textarea name="textarea" autoComplete="off"
            value={form.description}
            disabled={!canWrite}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            rows={2}
            className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
          />
        </label>

        <div className="flex items-end gap-2">
          <label className="block flex-1 text-xs font-medium text-zinc-600">
            Prompt
            <select name="select"
              value={form.prompt_id}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, prompt_id: e.target.value }))}
              className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
            >
              <option value="">Select a prompt…</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.slug} ({p.kind})
                </option>
              ))}
            </select>
          </label>
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-600">
            <input name="input"
              type="checkbox"
              checked={form.pin_version}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, pin_version: e.target.checked }))}
              className="h-3.5 w-3.5 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
            />
            Pin version
          </label>
        </div>
        <p className="-mt-2 text-xs text-zinc-500">
          Unpinned follows whichever version is active when a run starts.
        </p>

        <div>
          <p className="mb-1.5 text-xs font-medium text-zinc-600">Skill mode</p>
          <div className="inline-flex rounded-md border border-zinc-200 p-0.5">
            {(['none', 'assigned', 'auto'] as SkillMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={!canWrite}
                onClick={() => setForm((f) => ({ ...f, skill_mode: mode }))}
                className={`rounded px-2.5 py-1 text-xs font-medium capitalize transition disabled:opacity-60 ${
                  form.skill_mode === mode ? 'bg-sky-600 text-white' : 'text-zinc-600 hover:bg-zinc-100'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {form.skill_mode !== 'none' && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-zinc-600">
              {form.skill_mode === 'assigned' ? 'Assigned skills' : 'Candidate skills (empty = all readable)'}
            </p>
            <div className="space-y-1 rounded-md border border-zinc-200 p-2">
              {skills.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-xs text-zinc-700">
                  <input name="input"
                    type="checkbox"
                    checked={form.skill_ids.includes(s.id)}
                    disabled={!canWrite}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        skill_ids: e.target.checked ? [...f.skill_ids, s.id] : f.skill_ids.filter((id) => id !== s.id),
                      }))
                    }
                    className="h-3.5 w-3.5 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
                  />
                  /{s.slug} — {s.name}
                </label>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-xs font-medium text-zinc-600">
            Base tools {form.skill_mode !== 'none' ? '(used when no skill ends up active)' : ''}
          </p>
          <ToolPicker
            tools={tools}
            selected={form.base_tools}
            onChange={(next) => canWrite && setForm((f) => ({ ...f, base_tools: next }))}
          />
        </div>

        <label className="block text-xs font-medium text-zinc-600">
          Max steps override (blank = harness default)
          <input name="input" autoComplete="off"
            type="number"
            min={1}
            value={form.max_steps}
            disabled={!canWrite}
            onChange={(e) => setForm((f) => ({ ...f, max_steps: e.target.value }))}
            className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
          />
        </label>

        <label className="block text-xs font-medium text-zinc-600">
          Visibility
          <select name="select"
            value={form.visibility}
            disabled={!canWrite}
            onChange={(e) => setForm((f) => ({ ...f, visibility: e.target.value as 'private' | 'shared' }))}
            className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
          >
            <option value="private">Private</option>
            <option value="shared">Shared</option>
          </select>
        </label>

        {!isNew && form.skill_mode === 'auto' && (
          <div className="rounded-md border border-zinc-200 p-3">
            <p className="mb-1.5 text-xs font-medium text-zinc-600">Test routing</p>
            <div className="flex gap-2">
              <input name="input" autoComplete="off"
                type="text"
                value={routeTestObjective}
                onChange={(e) => setRouteTestObjective(e.target.value)}
                placeholder="how do we roll back a bad deploy…"
                className="flex-1 rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              />
              <button
                type="button"
                onClick={() => void handleTestRouting()}
                disabled={routeTesting || !routeTestObjective.trim()}
                className="ui-btn ui-btn-secondary ui-btn-sm"
              >
                {routeTesting ? 'Testing…' : 'Test'}
              </button>
            </div>
            {routeTestResult && (
              <div className="mt-2 rounded-md bg-zinc-50 p-2 text-xs text-zinc-700">
                <p>
                  <span className="font-medium">Selected:</span>{' '}
                  {routeTestResult.selected.length ? routeTestResult.selected.map((s) => `/${s}`).join(', ') : 'none'}
                </p>
                <p>
                  <span className="font-medium">Confidence:</span> {routeTestResult.confidence.toFixed(2)}
                </p>
                <p>
                  <span className="font-medium">Rationale:</span> {routeTestResult.rationale}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3">
        {!isNew && canWrite ? (
          <ConfirmButton
            prompt={`Delete agent "${agent!.name}"? This cannot be undone.`}
            onConfirm={() => void handleDelete()}
            disabled={saving || agent!.is_default}
            title={agent!.is_default ? 'The default agent cannot be deleted' : undefined}
            className="ui-btn ui-btn-danger ui-btn-sm"
          >
            Delete
          </ConfirmButton>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !form.name || !form.prompt_id || !canWrite}
          title={canWrite ? undefined : disabledReason(me, 'mutate_agents')}
          className="ui-btn ui-btn-primary"
        >
          {saving ? 'Saving…' : isNew ? 'Create agent' : 'Save changes'}
        </button>
      </div>
      </div>
    </>
  )
}
