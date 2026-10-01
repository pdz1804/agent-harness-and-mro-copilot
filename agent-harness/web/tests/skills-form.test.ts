import { describe, expect, it } from 'vitest'
import type { Skill } from '../src/lib/api-types'
import { EMPTY_SKILL_FORM, filterSkills, hasErrors, isSkillFormDirty, parseExamples, skillToForm, validateSkillForm } from '../src/lib/skills-form'

const skill = (over: Partial<Skill>): Skill => ({
  id: 's1',
  slug: 'triage-outage',
  name: 'Triage outage',
  description: 'Investigate an outage',
  instructions: '',
  allowed_tools: ['get_service_status'],
  examples: ['a', 'b'],
  owner_id: 'u1',
  visibility: 'shared',
  enabled: true,
  created_at: '',
  updated_at: '',
  updated_by: 'u1',
  ...over,
})

describe('validateSkillForm', () => {
  const valid = { ...EMPTY_SKILL_FORM, slug: 'triage-outage', name: 'N', description: 'D', allowed_tools: ['t'] }
  it('passes a valid new skill', () => {
    expect(hasErrors(validateSkillForm(valid, true))).toBe(false)
  })
  it('flags slug problems only for new skills', () => {
    expect(validateSkillForm({ ...valid, slug: 'A' }, true).slug).toMatch(/2 to 41/)
    expect(validateSkillForm({ ...valid, slug: 'help' }, true).slug).toMatch(/reserved/)
    expect(validateSkillForm({ ...valid, slug: '' }, false).slug).toBeNull()
  })
  it('requires name, description and a tool', () => {
    const e = validateSkillForm(EMPTY_SKILL_FORM, false)
    expect(e.name && e.description && e.allowed_tools).toBeTruthy()
  })
})

describe('form helpers', () => {
  it('parses examples one per line', () => {
    expect(parseExamples(' a \n\n b\n')).toEqual(['a', 'b'])
  })
  it('detects dirty state, ignoring tool order', () => {
    const initial = skillToForm(skill({ allowed_tools: ['x', 'y'] }))
    expect(isSkillFormDirty({ ...initial, allowed_tools: ['y', 'x'] }, initial)).toBe(false)
    expect(isSkillFormDirty({ ...initial, name: 'Other' }, initial)).toBe(true)
    expect(isSkillFormDirty({ ...initial, allowed_tools: ['x'] }, initial)).toBe(true)
  })
})

describe('filterSkills', () => {
  const list = [skill({ id: '1' }), skill({ id: '2', slug: 'kb-answer', name: 'KB answer', description: 'cite docs', enabled: false })]
  it('filters by enabled state', () => {
    expect(filterSkills(list, '', 'enabled').map((s) => s.id)).toEqual(['1'])
    expect(filterSkills(list, '', 'disabled').map((s) => s.id)).toEqual(['2'])
    expect(filterSkills(list, '', 'all')).toHaveLength(2)
  })
  it('searches slug, name and description', () => {
    expect(filterSkills(list, 'cite', 'all').map((s) => s.id)).toEqual(['2'])
    expect(filterSkills(list, 'OUTAGE', 'all').map((s) => s.id)).toEqual(['1'])
  })
})
