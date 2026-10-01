import type { PromptKind, PromptSummary } from './api-types'

export const PROMPT_KINDS: readonly PromptKind[] = ['system', 'skill_router', 'judge']

export const PROMPT_KIND_LABELS: Record<PromptKind, string> = {
  system: 'System',
  skill_router: 'Skill router',
  judge: 'Judge',
}

/** Case-insensitive match on slug, name and description; blank query keeps all. */
export function filterPrompts<T extends Pick<PromptSummary, 'slug' | 'name' | 'description'>>(prompts: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...prompts]
  return prompts.filter((p) => p.slug.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q))
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

/** Mirrors the server's create-prompt rules; `null` means valid. */
export function validatePromptDraft(input: { slug: string; name: string; content: string }): { slug: string | null; name: string | null; content: string | null } {
  const slug = input.slug.trim()
  return {
    slug: !slug ? 'Enter a slug.' : !SLUG_RE.test(slug) ? 'Use lowercase letters, numbers and hyphens, starting with a letter or number.' : null,
    name: input.name.trim() ? null : 'Enter a name.',
    content: input.content.trim() ? null : 'Enter the first version of the prompt.',
  }
}

/** The id of the version to re-activate on Undo (null if there was none, so
 * Undo is not offered: there is nothing to go back to). */
export function previousActiveId(detail: { active_version: { id: string } | null }): string | null {
  return detail.active_version?.id ?? null
}
