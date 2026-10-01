import { describe, expect, it } from 'vitest'
import { countMatches, splitForHighlight, tokenizeQuery } from '../src/lib/kb-highlight'

describe('tokenizeQuery', () => {
  it('lowercases, dedupes and keeps hyphenated ids like the backend tokenizer', () => {
    expect(tokenizeQuery('Auth-Service outage, auth-service!')).toEqual(['auth-service', 'outage'])
  })

  it('returns nothing for punctuation-only input', () => {
    expect(tokenizeQuery('?! ...')).toEqual([])
  })
})

describe('splitForHighlight', () => {
  it('marks whole-token, case-insensitive matches and preserves the original casing', () => {
    expect(splitForHighlight('Restart the Connection pool, then check pooling.', ['pool'])).toEqual([
      { text: 'Restart the Connection ', match: false },
      { text: 'pool', match: true },
      { text: ', then check pooling.', match: false },
    ])
  })

  it('handles several terms, longest first, without losing text', () => {
    const segments = splitForHighlight('auth-service down: auth restart', ['auth', 'auth-service'])
    expect(segments.map((s) => s.text).join('')).toBe('auth-service down: auth restart')
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['auth-service', 'auth'])
  })

  it('treats regex metacharacters in terms literally', () => {
    expect(splitForHighlight('a+b (c)', ['a+b']).some((s) => s.match)).toBe(true)
    expect(() => splitForHighlight('x', ['(', '[', '*'])).not.toThrow()
  })

  it('returns a single plain segment with no terms, and nothing for empty text', () => {
    expect(splitForHighlight('hello', [])).toEqual([{ text: 'hello', match: false }])
    expect(splitForHighlight('', ['x'])).toEqual([])
  })
})

describe('countMatches', () => {
  it('counts highlighted occurrences', () => {
    expect(countMatches('cache cache Cache miss', ['cache'])).toBe(3)
  })
})
