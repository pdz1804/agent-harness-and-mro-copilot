import { describe, expect, it } from 'vitest'
import { filterPrompts, previousActiveId, validatePromptDraft } from '../src/lib/prompts-list'

const rows = [
  { slug: 'ops-system', name: 'Ops assistant', description: 'Runs every agent' },
  { slug: 'eval-judge', name: 'Judge', description: null },
]

describe('filterPrompts', () => {
  it('keeps everything for a blank query', () => {
    expect(filterPrompts(rows, '  ')).toHaveLength(2)
  })
  it('matches slug, name and description case-insensitively', () => {
    expect(filterPrompts(rows, 'OPS')).toHaveLength(1)
    expect(filterPrompts(rows, 'judge')[0].slug).toBe('eval-judge')
    expect(filterPrompts(rows, 'every agent')[0].slug).toBe('ops-system')
  })
  it('returns nothing when no field matches', () => {
    expect(filterPrompts(rows, 'zzz')).toEqual([])
  })
})

describe('validatePromptDraft', () => {
  it('accepts a valid draft', () => {
    expect(validatePromptDraft({ slug: 'my-prompt', name: 'N', content: 'c' })).toEqual({ slug: null, name: null, content: null })
  })
  it('rejects empty and malformed fields', () => {
    const e = validatePromptDraft({ slug: 'Bad Slug', name: ' ', content: '' })
    expect(e.slug).toMatch(/lowercase/)
    expect(e.name).toBeTruthy()
    expect(e.content).toBeTruthy()
    expect(validatePromptDraft({ slug: '', name: 'n', content: 'c' }).slug).toBe('Enter a slug.')
  })
})

describe('previousActiveId', () => {
  it('returns the active version id or null', () => {
    expect(previousActiveId({ active_version: { id: 'v1' } })).toBe('v1')
    expect(previousActiveId({ active_version: null })).toBeNull()
  })
})
