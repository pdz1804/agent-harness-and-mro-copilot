import { FloppyDisk, Play, Trash } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AgentTestChat } from '../components/agents/AgentTestChat'
import { AgentUsagePanel } from '../components/agents/AgentUsagePanel'
import {
  Button,
  Card,
  CardHeader,
  Chip,
  ConfirmPopover,
  CopyId,
  ErrorBanner,
  ErrorState,
  Field,
  Input,
  PageHeader,
  RowActions,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Textarea,
  useToast,
} from '../components/ui'
import { canWriteResource, disabledReason, useMe } from '../hooks/useMe'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useUrlEnum } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { Agent, PreviewRouteResult, PromptSummary, Skill, SkillMode, ToolCatalogEntry } from '../lib/api-types'
import {
  EMPTY_AGENT_FORM,
  agentEditorPath,
  agentToForm,
  isAgentFormDirty,
  slugify,
  validateAgentForm,
  type AgentFormState,
} from '../lib/agents-form'

export type AgentEditorTab = 'settings' | 'test' | 'usage'
const TABS: readonly AgentEditorTab[] = ['settings', 'test', 'usage']

const MODE_OPTIONS: { value: SkillMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'auto', label: 'Auto' },
]

interface EditorData {
  agent: Agent | null
  prompts: PromptSummary[]
  skills: Skill[]
  tools: ToolCatalogEntry[]
}

/** The full-page agent editor (create or edit): `/agents/:agentId` (`new` creates one).
 * Loads the agent plus the prompts, skills and tools it can bind, then hands
 * off to the form. `onClose` returns to the list. */
export function AgentEditorPage({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const isNew = agentId === 'new'
  const [data, setData] = useState<EditorData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    Promise.all([isNew ? Promise.resolve(null) : api.getAgent(agentId), api.listPrompts(), api.listSkills({ enabled: true }), api.listTools()]).then(
      ([agent, prompts, skills, tools]) => {
        if (!cancelled) setData({ agent, prompts, skills, tools })
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Could not load this agent.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [agentId, isNew, attempt])

  if (error) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Agent" description="The agent could not be loaded." actions={<Button onClick={onClose}>Back to agents</Button>} />
        <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title={<Skeleton className="mt-1 h-7 w-56" />} />
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    )
  }
  return <AgentEditorForm key={data.agent?.id ?? 'new'} {...data} onClose={onClose} />
}

function AgentEditorForm({ agent: initialAgent, prompts, skills, tools, onClose }: EditorData & { onClose: () => void }) {
  const toast = useToast()
  const navigate = useNavigate()
  const { me } = useMe()
  const [tab, setTab] = useUrlEnum<AgentEditorTab>('tab', TABS, 'settings')
  const [saved, setSaved] = useState<Agent | null>(initialAgent)
  const isNew = saved === null
  const baseline = useMemo(() => (saved ? agentToForm(saved) : EMPTY_AGENT_FORM), [saved])
  const [form, setForm] = useState<AgentFormState>(baseline)
  const [touched, setTouched] = useState<Partial<Record<'slug' | 'name' | 'prompt_id' | 'max_steps', boolean>>>({})
  const [slugEdited, setSlugEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [routeObjective, setRouteObjective] = useState('')
  const [routeResult, setRouteResult] = useState<PreviewRouteResult | null>(null)
  const [routeTesting, setRouteTesting] = useState(false)
  const [routeError, setRouteError] = useState<string | null>(null)

  useDocumentTitle(saved?.name ?? 'New agent')

  // Real gate: the server requires `mutate_agents` AND (owner or admin).
  // Mirror both so the form disables before a doomed save round-trips a 403.
  const hasMutatePermission = me ? me.permissions.includes('mutate_agents') : true
  const canWrite = hasMutatePermission && (isNew || canWriteResource(me, saved))
  const writeReason = hasMutatePermission ? `Only the owner (${saved?.owner_id ?? 'unknown'}) or an admin can edit this agent.` : disabledReason(me, 'mutate_agents')

  const dirty = isAgentFormDirty(form, baseline)
  const errors = validateAgentForm(form, isNew)
  const show = (key: keyof typeof errors) => (touched[key] ? errors[key] : undefined)
  const touch = (key: keyof typeof errors) => setTouched((t) => ({ ...t, [key]: true }))
  const patch = (next: Partial<AgentFormState>) => setForm((f) => ({ ...f, ...next }))

  // Closing the tab with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const promptRow = prompts.find((p) => p.id === form.prompt_id)
  const savedPromptRow = saved ? prompts.find((p) => p.id === saved.prompt_id) : undefined
  const promptLabel = savedPromptRow
    ? saved!.prompt_version_id
      ? `${savedPromptRow.slug} (pinned version)`
      : `${savedPromptRow.slug} (active v${savedPromptRow.active_version?.version ?? '?'})`
    : 'prompt not found'

  const bodyFrom = (state: AgentFormState, versionId: string | null) => ({
    name: state.name.trim(),
    description: state.description,
    prompt_id: state.prompt_id,
    prompt_version_id: versionId,
    skill_mode: state.skill_mode,
    skill_ids: state.skill_ids,
    base_tools: state.base_tools,
    max_steps: state.max_steps.trim() ? Number(state.max_steps) : null,
    visibility: state.visibility,
  })

  const handleSave = async () => {
    setTouched({ slug: true, name: true, prompt_id: true, max_steps: true })
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    setError(null)
    try {
      const keepsPinnedVersion = saved?.prompt_id === form.prompt_id ? saved.prompt_version_id : null
      const versionId = form.pin_version ? (keepsPinnedVersion ?? promptRow?.active_version?.id ?? null) : null
      const body = bodyFrom(form, versionId)
      if (isNew) {
        const created = await api.createAgent({ slug: form.slug, ...body })
        toast({
          title: `Created “${created.name}”`,
          action: { label: 'Undo', run: async () => { await api.deleteAgent(created.id); navigate('/agents', { replace: true }) } },
        })
        navigate(agentEditorPath(created.id), { replace: true })
        return
      }
      const previous = saved
      const updated = await api.updateAgent(previous.id, body)
      setSaved(updated)
      setForm(agentToForm(updated))
      setTouched({})
      toast({
        title: `Saved “${updated.name}”`,
        action: {
          label: 'Undo',
          run: async () => {
            const reverted = await api.updateAgent(previous.id, bodyFrom(agentToForm(previous), previous.prompt_version_id))
            setSaved(reverted)
            setForm(agentToForm(reverted))
          },
        },
      })
    } catch (err) {
      setError(errorText(err, 'Could not save the agent.'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!saved) return
    const target = saved
    try {
      await api.deleteAgent(target.id)
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't delete “${target.name}”`, description: errorText(err, 'Try again.') })
      return
    }
    setForm(baseline) // nothing left to protect
    onClose()
    toast({
      title: `Deleted “${target.name}”`,
      description: 'Kept in the trash for 7 days.',
      action: {
        label: 'Undo',
        run: async () => {
          await api.restoreAgent(target.id)
          toast({ title: `Restored “${target.name}”`, action: { label: 'Open', run: () => navigate(`/agents?open=${encodeURIComponent(target.id)}`) } })
        },
      },
    })
  }

  const handleTestRouting = async () => {
    if (!saved || !routeObjective.trim()) return
    setRouteTesting(true)
    setRouteResult(null)
    setRouteError(null)
    try {
      setRouteResult(await api.previewRoute(saved.id, routeObjective))
    } catch (err) {
      setRouteError(errorText(err, 'Could not test routing.'))
    } finally {
      setRouteTesting(false)
    }
  }

  const discard = () => {
    setForm(baseline)
    setTouched({})
    setError(null)
  }

  const saveButton = (
    <Button variant="primary" icon={<FloppyDisk size={14} weight="bold" />} loading={saving} disabled={!canWrite} title={canWrite ? undefined : writeReason} onClick={() => void handleSave()}>
      {isNew ? 'Create agent' : 'Save agent'}
    </Button>
  )

  const closeButton = dirty ? (
    <ConfirmPopover variant="ghost" prompt="Discard changes?" description="Your edits to this agent are not saved." confirmLabel="Discard" onConfirm={onClose}>
      Close
    </ConfirmPopover>
  ) : (
    <Button variant="ghost" onClick={onClose}>
      Close
    </Button>
  )

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={saved?.name ?? 'New agent'}
        description={isNew ? 'Bind a prompt, a skill-routing mode and a base tool set. Sessions and runs can then pick this agent.' : 'Changes apply to the next run; runs already in flight keep what they started with.'}
        meta={
          saved && (
            <>
              <CopyId value={saved.slug} label="agent slug" />
              {saved.is_default && <Chip tone="ok" dot>Default</Chip>}
              <span>Owner {saved.owner_id}</span>
            </>
          )
        }
        actions={
          <>
            {dirty && (
              <Chip tone="warn" dot>
                Unsaved changes
              </Chip>
            )}
            {dirty && (
              <Button variant="ghost" onClick={discard}>
                Discard
              </Button>
            )}
            {closeButton}
            {saveButton}
            {saved && (
              <RowActions
                visibility="always"
                label={`More actions for “${saved.name}”`}
                items={[
                  {
                    label: 'Delete agent',
                    icon: <Trash size={14} />,
                    destructive: true,
                    disabled: !canWrite || saved.is_default,
                    disabledReason: saved.is_default ? 'The default agent cannot be deleted.' : writeReason,
                    confirm: { title: `Delete “${saved.name}”?`, description: 'You can undo for a few seconds; it stays in the trash for 7 days.', confirmLabel: 'Delete agent' },
                    onSelect: handleDelete,
                  },
                ]}
              />
            )}
          </>
        }
        toolbar={
          !isNew ? (
            <Segmented
              label="Agent sections"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'settings', label: 'Settings' },
                { value: 'test', label: 'Test chat' },
                { value: 'usage', label: 'Usage' },
              ]}
            />
          ) : undefined
        }
      />

      {saved && (
        <div role="tabpanel" aria-label="Test chat" className={tab === 'test' ? 'w-full' : 'hidden'}>
          <p className="mb-3 text-xs text-zinc-600">
            {dirty ? 'Tests the saved agent. Your unsaved edits on the Settings tab are not applied yet.' : 'Tests the saved agent. Every message is a real run, visible in Sessions.'}
          </p>
          <AgentTestChat agent={saved} promptLabel={promptLabel} />
        </div>
      )}

      {saved && tab === 'usage' && (
        <div role="tabpanel" aria-label="Usage" className="w-full">
          <AgentUsagePanel agentId={saved.id} />
        </div>
      )}

      <div role={isNew ? undefined : 'tabpanel'} aria-label={isNew ? undefined : 'Settings'} className={tab === 'settings' ? 'space-y-4' : 'hidden'}>
        {error && <ErrorBanner message={error} />}
        {!canWrite && <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-xs text-amber-800">{writeReason} You can look at this agent but not change it.</p>}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-4">
            <Card className="space-y-4">
              <CardHeader title="Basics" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" error={show('name')}>
                  {(p) => (
                    <Input
                      {...p}
                      name="agent-name"
                      autoComplete="off"
                      value={form.name}
                      disabled={!canWrite}
                      onChange={(e) => patch({ name: e.target.value, ...(isNew && !slugEdited ? { slug: slugify(e.target.value) } : {}) })}
                      onBlur={() => touch('name')}
                      className="w-full"
                    />
                  )}
                </Field>
                {isNew ? (
                  <Field label="Slug" error={show('slug')} hint="Used in URLs and the API. Cannot be changed later.">
                    {(p) => (
                      <Input
                        {...p}
                        name="agent-slug"
                        autoComplete="off"
                        spellCheck={false}
                        value={form.slug}
                        disabled={!canWrite}
                        placeholder="ops-assistant"
                        onChange={(e) => {
                          setSlugEdited(true)
                          patch({ slug: e.target.value })
                        }}
                        onBlur={() => touch('slug')}
                        className="font-data w-full"
                      />
                    )}
                  </Field>
                ) : (
                  <Field label="Slug" hint="Used in URLs and the API. Cannot be changed.">
                    {(p) => <Input {...p} value={form.slug} disabled readOnly className="font-data w-full" />}
                  </Field>
                )}
              </div>
              <Field label="Description" optional>
                {(p) => <Textarea {...p} name="agent-description" autoComplete="off" rows={2} value={form.description} disabled={!canWrite} onChange={(e) => patch({ description: e.target.value })} className="!h-auto w-full resize-y py-2" />}
              </Field>
            </Card>

            <Card className="space-y-4">
              <CardHeader title="Prompt" meta="The system prompt this agent runs with." />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Prompt" error={show('prompt_id')}>
                  {(p) => (
                    <Select {...p} name="agent-prompt" value={form.prompt_id} disabled={!canWrite} onChange={(e) => patch({ prompt_id: e.target.value })} onBlur={() => touch('prompt_id')} className="w-full">
                      <option value="">Select a prompt</option>
                      {prompts.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.name} ({pr.kind})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Version" hint="Unpinned follows whichever version is active when a run starts.">
                  {(p) => (
                    <Select {...p} name="agent-prompt-version" value={form.pin_version ? 'pin' : 'follow'} disabled={!canWrite} onChange={(e) => patch({ pin_version: e.target.value === 'pin' })} className="w-full">
                      <option value="follow">Follow active{promptRow?.active_version ? ` (v${promptRow.active_version.version})` : ''}</option>
                      <option value="pin">Pin a version{promptRow?.active_version && !saved?.prompt_version_id ? ` (v${promptRow.active_version.version})` : ''}</option>
                    </Select>
                  )}
                </Field>
              </div>
            </Card>

            <Card className="space-y-3">
              <CardHeader
                title="Skills"
                meta={form.skill_mode === 'none' ? 'No skill routing: the agent only uses its base tools.' : form.skill_mode === 'assigned' ? 'Only the skills you pick below are available.' : 'The router picks a skill per objective. Leave all off to consider every readable skill.'}
                actions={<Segmented label="Skill mode" size="sm" value={form.skill_mode} onChange={(mode) => canWrite && patch({ skill_mode: mode })} options={MODE_OPTIONS} />}
              />
              {form.skill_mode !== 'none' &&
                (skills.length === 0 ? (
                  <p className="text-[13px] text-zinc-500">No enabled skills yet. Create one in Skills.</p>
                ) : (
                  <ul className="divide-y divide-[var(--color-line)] rounded-[10px] border border-[var(--color-line)]">
                    {skills.map((s) => (
                      <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                        <Switch
                          label={`Use skill ${s.name}`}
                          checked={form.skill_ids.includes(s.id)}
                          disabled={!canWrite}
                          onChange={(on) => patch({ skill_ids: on ? [...form.skill_ids, s.id] : form.skill_ids.filter((id) => id !== s.id) })}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-data block truncate text-[13px] text-zinc-900">/{s.slug}</span>
                          <span className="block truncate text-xs text-zinc-500">{s.name}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ))}
            </Card>

            <Card padding="none">
              <CardHeader className="px-4 pt-4 pb-3" title="Base tools" meta={form.skill_mode !== 'none' ? 'Used when no skill ends up active.' : 'The tools this agent can call.'} />
              <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
                {tools.map((t) => (
                  <li key={t.name} className={`flex items-center gap-3 px-4 py-2.5 ${t.enabled ? '' : 'opacity-60'}`}>
                    <Switch
                      label={`Allow ${t.name}`}
                      checked={form.base_tools.includes(t.name)}
                      disabled={!canWrite}
                      onChange={(on) => patch({ base_tools: on ? [...form.base_tools, t.name] : form.base_tools.filter((n) => n !== t.name) })}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-data text-[13px] text-zinc-900">{t.name}</span>
                        {t.requires_approval && <Chip tone="warn">Needs approval</Chip>}
                        {!t.enabled && <Chip tone="muted">Disabled in Integrations</Chip>}
                      </span>
                      <span className="block truncate text-xs text-zinc-500" title={t.description}>
                        {t.description}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="min-w-0 space-y-4">
            <Card className="space-y-4">
              <Field label="Visibility" hint={form.visibility === 'private' ? 'Only you and admins can use it.' : 'Everyone can use it; only you and admins can edit it.'}>
                {(p) => (
                  <Select {...p} name="agent-visibility" value={form.visibility} disabled={!canWrite} onChange={(e) => patch({ visibility: e.target.value as 'private' | 'shared' })} className="w-full">
                    <option value="private">Private</option>
                    <option value="shared">Shared</option>
                  </Select>
                )}
              </Field>
              <Field label="Max steps" optional error={show('max_steps')} hint="Blank uses the harness default. A run stops at this step count.">
                {(p) => (
                  <Input
                    {...p}
                    name="agent-max-steps"
                    autoComplete="off"
                    type="number"
                    min={1}
                    value={form.max_steps}
                    disabled={!canWrite}
                    onChange={(e) => patch({ max_steps: e.target.value })}
                    onBlur={() => touch('max_steps')}
                    className="w-full tabular-nums"
                  />
                )}
              </Field>
            </Card>

            {!isNew && form.skill_mode === 'auto' && (
              <Card className="space-y-3">
                <CardHeader title="Test routing" meta="Dry-run the saved skill router against an objective." />
                <div className="flex gap-2">
                  <Input
                    aria-label="Objective to route"
                    name="agent-route-objective"
                    autoComplete="off"
                    value={routeObjective}
                    placeholder="How do we roll back a bad deploy?"
                    onChange={(e) => setRouteObjective(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleTestRouting()
                    }}
                    className="min-w-0 flex-1"
                  />
                  <Button icon={<Play size={12} weight="fill" />} loading={routeTesting} disabled={!routeObjective.trim()} onClick={() => void handleTestRouting()}>
                    Test
                  </Button>
                </div>
                {routeError && <p role="alert" className="text-xs text-rose-700">{routeError}</p>}
                {routeResult && (
                  <div className="space-y-1.5 rounded-[10px] bg-zinc-950/[0.035] p-3 text-xs text-zinc-700">
                    <p className="flex flex-wrap items-center gap-1.5">
                      {routeResult.selected.length ? routeResult.selected.map((s) => <Chip key={s} tone="iris" mono>{`/${s}`}</Chip>) : <span className="text-zinc-500">No skill selected</span>}
                      <span className="ml-auto tabular-nums">Confidence {routeResult.confidence.toFixed(2)}</span>
                    </p>
                    <p className="[overflow-wrap:anywhere]">{routeResult.rationale}</p>
                  </div>
                )}
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
