import type { Skill } from './api-types'

export interface SkillFormState {
  slug: string
  name: string
  description: string
  instructions: string
  allowed_tools: string[]
  examples: string
  visibility: 'private' | 'shared'
  enabled: boolean
}

export const EMPTY_SKILL_FORM: SkillFormState = {
  slug: '',
  name: '',
  description: '',
  instructions: '',
  allowed_tools: [],
  examples: '',
  visibility: 'private',
  enabled: true,
}

export function skillToForm(skill: Skill): SkillFormState {
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

/** One example per line, blanks dropped. */
export function parseExamples(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** True when the form differs from its starting point (drives "Discard changes?"). */
export function isSkillFormDirty(current: SkillFormState, initial: SkillFormState): boolean {
  return (
    current.slug !== initial.slug ||
    current.name !== initial.name ||
    current.description !== initial.description ||
    current.instructions !== initial.instructions ||
    current.examples !== initial.examples ||
    current.visibility !== initial.visibility ||
    current.enabled !== initial.enabled ||
    current.allowed_tools.length !== initial.allowed_tools.length ||
    current.allowed_tools.some((t) => !initial.allowed_tools.includes(t))
  )
}

// Mirrors repos.skills.validate_slug: 2-41 chars, lowercase kebab-case, minus reserved names.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
const RESERVED_SLUGS = new Set(['help', 'clear'])

export interface SkillFormErrors {
  slug: string | null
  name: string | null
  description: string | null
  allowed_tools: string | null
}

export function validateSkillForm(form: SkillFormState, isNew: boolean): SkillFormErrors {
  const slug = form.slug.trim()
  return {
    slug: !isNew
      ? null
      : !slug
        ? 'Enter a slug.'
        : !SLUG_RE.test(slug)
          ? 'Use 2 to 41 lowercase letters, numbers and hyphens.'
          : RESERVED_SLUGS.has(slug)
            ? `"${slug}" is reserved for a chat command. Pick another slug.`
            : null,
    name: form.name.trim() ? null : 'Enter a name.',
    description: form.description.trim() ? null : 'Describe when this skill applies: the router reads it.',
    allowed_tools: form.allowed_tools.length ? null : 'Allow at least one tool.',
  }
}

export function hasErrors(errors: object): boolean {
  return Object.values(errors).some(Boolean)
}

export type EnabledFilter = 'all' | 'enabled' | 'disabled'

/** Search slug, name, description; then apply the enabled filter. */
export function filterSkills(skills: readonly Skill[], query: string, enabled: EnabledFilter): Skill[] {
  const q = query.trim().toLowerCase()
  return skills.filter((s) => {
    if (enabled === 'enabled' && !s.enabled) return false
    if (enabled === 'disabled' && s.enabled) return false
    return !q || s.slug.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  })
}
