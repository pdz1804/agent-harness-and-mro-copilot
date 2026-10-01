import { describe, expect, it } from 'vitest'
import { isBareKey, isTypingTarget } from '../src/lib/keyboard'
import { groupContainsPath, isGroupOpen, navGroupStorageKey } from '../src/lib/nav-fold'

describe('nav fold rules', () => {
  it('persists per group label', () => {
    expect(navGroupStorageKey('Workspace')).toBe('nav.groups.Workspace')
  })
  it('keeps the group holding the current page open even if folded', () => {
    expect(isGroupOpen(false, true)).toBe(true)
    expect(isGroupOpen(false, false)).toBe(false)
    expect(isGroupOpen(true, false)).toBe(true)
  })
  it('matches a page and its detail routes, not prefixes of other words', () => {
    const paths = ['/incidents', '/knowledge']
    expect(groupContainsPath(paths, '/incidents')).toBe(true)
    expect(groupContainsPath(paths, '/incidents/INC-1')).toBe(true)
    expect(groupContainsPath(paths, '/incidentsx')).toBe(false)
    expect(groupContainsPath(paths, '/agents')).toBe(false)
  })
})

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, getAttribute: () => null, ...extra }) as unknown as EventTarget

describe('keyboard guards', () => {
  it('treats text fields, selects, contenteditable and comboboxes as typing', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true)
    expect(isTypingTarget(el('textarea'))).toBe(true)
    expect(isTypingTarget(el('SELECT'))).toBe(true)
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true)
    expect(isTypingTarget(el('DIV', { getAttribute: (n: string) => (n === 'role' ? 'combobox' : null) }))).toBe(true)
    expect(isTypingTarget(el('BUTTON'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
  it('a bare key needs no modifier and no text focus', () => {
    const base = { key: 'a', ctrlKey: false, metaKey: false, altKey: false, target: el('BODY') }
    expect(isBareKey(base, 'a')).toBe(true)
    expect(isBareKey({ ...base, key: 'A' }, 'a')).toBe(true)
    expect(isBareKey({ ...base, ctrlKey: true }, 'a')).toBe(false)
    expect(isBareKey({ ...base, target: el('INPUT') }, 'a')).toBe(false)
    expect(isBareKey(base, 'd')).toBe(false)
  })
})
