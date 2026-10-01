import { describe, expect, it } from 'vitest'
import { formatTags, parseTags, validateFact } from '../src/lib/memory-tags'

describe('parseTags', () => {
  it('splits, trims and lower-cases', () => {
    expect(parseTags(' Alpha , BETA,gamma ')).toEqual(['alpha', 'beta', 'gamma'])
  })
  it('collapses inner whitespace', () => {
    expect(parseTags('on   call\t rota')).toEqual(['on call rota'])
  })
  it('drops empties and duplicates', () => {
    expect(parseTags(',a,, A ,b,a,')).toEqual(['a', 'b'])
  })
  it('caps each tag at 32 chars', () => {
    const [tag] = parseTags('x'.repeat(50))
    expect(tag).toHaveLength(32)
  })
  it('caps at 8 tags', () => {
    expect(parseTags('a,b,c,d,e,f,g,h,i,j')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  })
  it('returns empty for blank input', () => {
    expect(parseTags('  ,  ')).toEqual([])
    expect(parseTags('')).toEqual([])
  })
})

describe('formatTags', () => {
  it('joins with comma and space', () => {
    expect(formatTags(['a', 'b'])).toBe('a, b')
    expect(formatTags([])).toBe('')
  })
  it('round-trips through parseTags', () => {
    expect(parseTags(formatTags(['one two', 'three']))).toEqual(['one two', 'three'])
  })
})

describe('validateFact', () => {
  it('accepts a normal fact', () => {
    expect(validateFact('Prefers metric units')).toBeNull()
  })
  it('rejects under 3 chars after trim', () => {
    expect(validateFact('  ab  ')).not.toBeNull()
    expect(validateFact('')).not.toBeNull()
  })
  it('accepts exactly 3 and 1000 chars', () => {
    expect(validateFact('abc')).toBeNull()
    expect(validateFact('a'.repeat(1000))).toBeNull()
  })
  it('rejects over 1000 chars', () => {
    expect(validateFact('a'.repeat(1001))).toMatch(/1000/)
  })
})
