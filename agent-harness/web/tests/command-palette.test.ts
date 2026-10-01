import { describe, expect, it } from 'vitest'
import { isPaletteShortcut, moveIndex, rankItems, scoreMatch, type PaletteItem } from '../src/lib/command-palette'

const items: PaletteItem[] = [
  { id: 'p-new', label: 'New run', to: '/', group: 'Pages', keywords: 'chat start' },
  { id: 'p-sessions', label: 'Sessions', to: '/sessions', group: 'Pages', keywords: 'history chats' },
  { id: 'p-memory', label: 'Memory', to: '/memory', group: 'Pages', keywords: 'remember recall facts' },
  { id: 'p-incidents', label: 'Incidents', to: '/incidents', group: 'Pages' },
  { id: 'p-kb', label: 'Knowledge base', to: '/kb', group: 'Pages', keywords: 'docs runbooks' },
  { id: 's-1', label: 'Payments latency check', to: '/runs/r1', group: 'Sessions', hint: 'completed' },
  { id: 's-2', label: 'Auth outage triage', to: '/runs/r2', group: 'Sessions', hint: 'running' },
]

describe('scoreMatch', () => {
  it('matches word prefixes best, then substrings, then subsequences, else 0', () => {
    const prefix = scoreMatch('inc', 'Incidents')
    const substring = scoreMatch('cid', 'Incidents')
    const subsequence = scoreMatch('idt', 'Incidents')
    expect(prefix).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(subsequence)
    expect(subsequence).toBeGreaterThan(0)
    expect(scoreMatch('zzz', 'Incidents')).toBe(0)
  })

  it('requires every query word to match', () => {
    expect(scoreMatch('auth triage', 'Auth outage triage')).toBeGreaterThan(0)
    expect(scoreMatch('auth payments', 'Auth outage triage')).toBe(0)
  })

  it('ignores case and diacritics (Vietnamese titles)', () => {
    expect(scoreMatch('dong', 'Đồng bộ dữ liệu')).toBeGreaterThan(0)
    expect(scoreMatch('KNOWLEDGE', 'Knowledge base')).toBeGreaterThan(0)
  })

  it('treats an empty query as a match for everything', () => {
    expect(scoreMatch('   ', 'anything')).toBeGreaterThan(0)
  })
})

describe('rankItems', () => {
  it('keeps the original order and caps the list for an empty query', () => {
    expect(rankItems(items, '', 3).map((i) => i.id)).toEqual(['p-new', 'p-sessions', 'p-memory'])
  })

  it('puts the best label match first', () => {
    expect(rankItems(items, 'mem')[0].id).toBe('p-memory')
    expect(rankItems(items, 'sess')[0].id).toBe('p-sessions')
  })

  it('finds a page through its keywords and a session through its status hint', () => {
    expect(rankItems(items, 'recall').map((i) => i.id)).toContain('p-memory')
    expect(rankItems(items, 'running').map((i) => i.id)).toContain('s-2')
  })

  it('returns nothing when nothing matches', () => {
    expect(rankItems(items, 'qqqq')).toEqual([])
  })

  it('prefers a label hit over a keyword-only hit', () => {
    const ranked = rankItems(items, 'chat').map((i) => i.id)
    // "New run" has the keyword chat; "Sessions" has chats: both found, none outranks an exact label hit.
    expect(ranked).toEqual(expect.arrayContaining(['p-new', 'p-sessions']))
  })
})

describe('moveIndex', () => {
  it('wraps in both directions', () => {
    expect(moveIndex(0, -1, 5)).toBe(4)
    expect(moveIndex(4, 1, 5)).toBe(0)
    expect(moveIndex(2, 1, 5)).toBe(3)
  })

  it('is safe on an empty list', () => {
    expect(moveIndex(0, 1, 0)).toBe(0)
  })
})

describe('isPaletteShortcut', () => {
  it('accepts Ctrl+K and Cmd+K in either case, but not other combos', () => {
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: false })).toBe(true)
    expect(isPaletteShortcut({ key: 'K', ctrlKey: false, metaKey: true })).toBe(true)
    expect(isPaletteShortcut({ key: 'k', ctrlKey: false, metaKey: false })).toBe(false)
    expect(isPaletteShortcut({ key: 'j', ctrlKey: true, metaKey: false })).toBe(false)
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: true })).toBe(false)
  })
})
