import {
  ArrowClockwise,
  Lightning,
  MagnifyingGlass,
  PlusCircle,
  Trash,
  Wrench,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { RoutingTester } from '../components/skills/RoutingTester'
import { PageHeader } from '../components/ui/PageHeader'
import { ToolPicker } from '../components/ui/ToolPicker'
import { VisibilityBadge } from '../components/ui/VisibilityBadge'
import { canWriteResource, disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import { getCurrentUserId } from '../lib/identity'
import type { Skill, ToolCatalogEntry } from '../lib/api-types'
import { ConfirmButton } from '../components/ui/ConfirmButton'

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

interface SkillFormState {
  slug: string
  name: string
  description: string
  instructions: string
  allowed_tools: string[]
  examples: string
  visibility: 'private' | 'shared'
  enabled: boolean
}

const EMPTY_FORM: SkillFormState = {
  slug: '',
  name: '',
  description: '',
  instructions: '',
  allowed_tools: [],
  examples: '',
  visibility: 'private',
  enabled: true,
}

function toFormState(skill: Skill): SkillFormState {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    allowed_tools: skill.allowed_tools,
    examples: skill.examples.join('\n'),
    visibility: skill.visibility,
    enabled: skill.enabled,
  }
}

/** Skills (phase 03): a reusable capability package — instructions +
 * `allowed_tools` (a subset of the tool registry) + a description that is
 * the routing signal phase 04's skill auto-discover / slash commands will
 * read. Not versioned (unlike prompts) — editing just updates the row in
 * place, `updated_at`/`updated_by` track the last edit. */
export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [tools, setTools] = useState<ToolCatalogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    Promise.all([api.listSkills(), api.listTools()])
      .then(([skillData, toolData]) => {
        if (cancelled) return
        setSkills(skillData)
        setTools(toolData)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load skills.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const filtered = useMemo(() => {
    if (!skills) return null
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (s) =>
        s.slug.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    )
  }, [skills, query])

  const refresh = () => setRefreshToken((n) => n + 1)

  const currentUserId = getCurrentUserId()
  const { me } = useMe()
  const canCreate = me ? me.permissions.includes('mutate_skills') : true

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Skills"
        description="Reusable capability packages: instructions plus a scoped subset of tools. Used to route and scope an agent's behavior for a class of objective."
        actions={
          <>
            <button type="button" onClick={refresh} className="ui-btn ui-btn-secondary">
              <ArrowClockwise size={14} weight="bold" aria-hidden="true" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setEditing('new')}
              disabled={!canCreate}
              title={canCreate ? undefined : disabledReason(me, 'mutate_skills')}
              className="ui-btn ui-btn-primary"
            >
              <PlusCircle size={14} weight="bold" aria-hidden="true" />
              New skill
            </button>
          </>
        }
      />

      <RoutingTester skills={skills} />

      <div className="mt-4 flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <MagnifyingGlass size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
          <input
            type="text"
            name="skill-search"
            autoComplete="off"
            aria-label="Search skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            className="ui-input w-full pl-8"
          />
        </div>
      </div>

      <div className="mt-4">
        {error && <ErrorBanner message={error} onRetry={refresh} />}

        {!error && filtered === null ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-40 w-full rounded-lg" />
            ))}
          </div>
        ) : filtered && filtered.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => setEditing(skill)}
                className="ui-card flex flex-col items-start gap-2 p-4 text-left transition hover:border-sky-300 hover:shadow-sm"
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-900">{skill.name}</p>
                    <p className="font-data text-xs text-sky-700">/{skill.slug}</p>
                  </div>
                  <VisibilityBadge visibility={skill.visibility} className="mt-1" />
                </div>
                <p className="line-clamp-2 text-xs text-zinc-500">{skill.description}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {skill.allowed_tools.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-600"
                    >
                      <Wrench size={9} />
                      {t}
                    </span>
                  ))}
                </div>
                <div className="mt-auto flex w-full items-center justify-between pt-1 text-xs text-zinc-500">
                  <span>{skill.owner_id === currentUserId ? 'You' : skill.owner_id}</span>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${
                      skill.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-500'
                    }`}
                  >
                    <Lightning size={9} weight="fill" />
                    {skill.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          !error && (
            <EmptyState
              icon={<Wrench size={28} />}
              title="No skills found"
              description="Create a skill to scope an agent's tools and instructions for a class of objective."
              action={
                <button
                  type="button"
                  onClick={() => setEditing('new')}
                  disabled={!canCreate}
                  title={canCreate ? undefined : disabledReason(me, 'mutate_skills')}
                  className="ui-btn ui-btn-primary"
                >
                  <PlusCircle size={14} weight="bold" aria-hidden="true" />
                  New skill
                </button>
              }
            />
          )
        )}
      </div>

      {editing && tools && (
        <SkillEditorDrawer
          skill={editing === 'new' ? null : editing}
          tools={tools}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function SkillEditorDrawer({
  skill,
  tools,
  onClose,
  onSaved,
}: {
  skill: Skill | null
  tools: ToolCatalogEntry[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<SkillFormState>(skill ? toFormState(skill) : EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isNew = skill === null
  const { me } = useMe()
  const hasMutatePermission = me ? me.permissions.includes('mutate_skills') : true
  const canWrite = hasMutatePermission && (isNew || canWriteResource(me, skill))

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const examples = form.examples
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      if (isNew) {
        await api.createSkill({
          slug: form.slug,
          name: form.name,
          description: form.description,
          instructions: form.instructions,
          allowed_tools: form.allowed_tools,
          examples,
          visibility: form.visibility,
          enabled: form.enabled,
        })
      } else {
        await api.updateSkill(skill!.id, {
          name: form.name,
          description: form.description,
          instructions: form.instructions,
          allowed_tools: form.allowed_tools,
          examples,
          visibility: form.visibility,
          enabled: form.enabled,
        })
      }
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save skill.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!skill) return
    setSaving(true)
    setError(null)
    try {
      await api.deleteSkill(skill.id)
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete skill.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-900/40">
      <div className="flex h-full w-full max-w-lg flex-col overflow-y-auto bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-zinc-900">
            {isNew ? 'New skill' : `Edit ${skill!.name}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100"
            aria-label="Close"
          >
            <X size={16} weight="bold" />
          </button>
        </div>

        <div className="flex-1 space-y-4 px-5 py-4">
          {error && <ErrorBanner message={error} />}

          {!canWrite && !isNew && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              You can view this skill but not edit it (owned by {skill!.owner_id}).
            </p>
          )}

          {isNew && (
            <label className="block text-xs font-medium text-zinc-600">
              Slug
              <input name="input" autoComplete="off"
                type="text"
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                placeholder="triage-outage…"
                className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm font-mono focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              />
              <span className="mt-1 block text-xs text-zinc-500">
                Lowercase, kebab-case. Used as the /slug slash command in chat (phase 04).
              </span>
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
            Description (routing signal)
            <textarea name="textarea" autoComplete="off"
              value={form.description}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={2}
              className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
            />
            <span className="mt-1 block text-xs text-zinc-500">
              Shown to the skill router (phase 04) to decide when this skill applies.
            </span>
          </label>

          <label className="block text-xs font-medium text-zinc-600">
            Instructions (markdown, appended to the system prompt)
            <textarea name="textarea" autoComplete="off"
              value={form.instructions}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
              rows={6}
              className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm font-mono focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
            />
          </label>

          <div>
            <p className="mb-1.5 text-xs font-medium text-zinc-600">Allowed tools</p>
            <ToolPicker
              tools={tools}
              selected={form.allowed_tools}
              onChange={(next) => canWrite && setForm((f) => ({ ...f, allowed_tools: next }))}
            />
          </div>

          <label className="block text-xs font-medium text-zinc-600">
            Examples (one per line — sample user intents)
            <textarea name="textarea" autoComplete="off"
              value={form.examples}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, examples: e.target.value }))}
              rows={3}
              placeholder={'auth-service is returning errors\nwhy is checkout down'}
              className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
            />
          </label>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs font-medium text-zinc-600">
              <select name="select"
                value={form.visibility}
                disabled={!canWrite}
                onChange={(e) =>
                  setForm((f) => ({ ...f, visibility: e.target.value as 'private' | 'shared' }))
                }
                className="rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
              >
                <option value="private">Private</option>
                <option value="shared">Shared</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-600">
              <input name="input"
                type="checkbox"
                checked={form.enabled}
                disabled={!canWrite}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                className="h-3.5 w-3.5 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
              />
              Enabled
            </label>
          </div>

          {!isNew && (
            <p className="text-xs text-zinc-500">
              Last updated {formatTimestamp(skill!.updated_at)} by {skill!.updated_by}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3">
          {!isNew && canWrite ? (
            <ConfirmButton
              prompt={`Delete skill "${skill!.name}"? This cannot be undone.`}
              onConfirm={() => void handleDelete()}
              disabled={saving}
              className="ui-btn ui-btn-danger ui-btn-sm"
            >
              <Trash size={13} weight="bold" />
              Delete
            </ConfirmButton>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !form.name || !form.description || form.allowed_tools.length === 0 || !canWrite}
            title={canWrite ? undefined : disabledReason(me, 'mutate_skills')}
            className="ui-btn ui-btn-primary"
          >
            {saving ? 'Saving…' : isNew ? 'Create skill' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
