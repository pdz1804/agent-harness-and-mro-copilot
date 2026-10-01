/** Pure helpers for the agents pages: list search, the editor's form state,
 * validation (mirrors `agent_harness.repos.agents`) and dirty tracking. */

import type { Agent, SkillMode } from './api-types'

export interface AgentFormState {
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

export const EMPTY_AGENT_FORM: AgentFormState = {
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

export function agentToForm(agent: Agent): AgentFormState {
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

/** Server rule: `^[a-z0-9][a-z0-9-]{1,40}$`. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/

/** A kebab-case slug suggestion from a display name (max 41 chars). */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/g, '')
}

export type AgentFormErrors = Partial<Record<'slug' | 'name' | 'prompt_id' | 'max_steps', string>>

export function validateAgentForm(form: AgentFormState, isNew: boolean): AgentFormErrors {
  const errors: AgentFormErrors = {}
  if (isNew && !SLUG_PATTERN.test(form.slug)) {
    errors.slug = 'Use 2 to 41 lowercase letters, digits or hyphens, starting with a letter or digit.'
  }
  if (!form.name.trim()) errors.name = 'Give the agent a name.'
  if (!form.prompt_id) errors.prompt_id = 'Choose the prompt this agent runs.'
  const steps = form.max_steps.trim()
  if (steps && (!/^\d+$/.test(steps) || Number(steps) < 1)) errors.max_steps = 'Enter a whole number of at least 1, or leave it blank.'
  return errors
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')
}

/** True when the editor holds changes that are not saved yet. */
export function isAgentFormDirty(current: AgentFormState, saved: AgentFormState): boolean {
  return (
    current.slug !== saved.slug ||
    current.name !== saved.name ||
    current.description !== saved.description ||
    current.prompt_id !== saved.prompt_id ||
    current.pin_version !== saved.pin_version ||
    current.skill_mode !== saved.skill_mode ||
    current.max_steps !== saved.max_steps ||
    current.visibility !== saved.visibility ||
    !sameSet(current.skill_ids, saved.skill_ids) ||
    !sameSet(current.base_tools, saved.base_tools)
  )
}

/** Case-insensitive match on name, slug and description; blank matches all. */
export function filterAgents<T extends Pick<Agent, 'name' | 'slug' | 'description'>>(agents: T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return agents
  return agents.filter((a) => `${a.name} ${a.slug} ${a.description}`.toLowerCase().includes(needle))
}

/** The editor's canonical URL: `/agents/<id>` (or `/agents/new`), with the
 * optional editor tab kept in the query string. */
export function agentEditorPath(agentId: string, tab?: string): string {
  return `/agents/${encodeURIComponent(agentId)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`
}

/** Old `/agents?edit=<id>[&tab=x]` links map onto the editor route; returns
 * null when the query has no `edit` parameter. Other parameters are dropped
 * because they belong to the list view. */
export function legacyAgentEditTarget(search: string): string | null {
  const params = new URLSearchParams(search)
  const edit = params.get('edit')
  if (!edit) return null
  return agentEditorPath(edit, params.get('tab') ?? undefined)
}
