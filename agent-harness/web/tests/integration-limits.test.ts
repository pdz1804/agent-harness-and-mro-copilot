import { describe, expect, it } from 'vitest'
import {
  describeLimit,
  formatErrorRate,
  formatLatency,
  parseRetries,
  parseTimeout,
  summarizeArgs,
} from '../src/lib/integration-limits'

describe('parseTimeout', () => {
  it('accepts the bounds and decimals', () => {
    expect(parseTimeout('0.1')).toEqual({ ok: true, value: 0.1 })
    expect(parseTimeout(' 300 ')).toEqual({ ok: true, value: 300 })
    expect(parseTimeout('2.5')).toEqual({ ok: true, value: 2.5 })
  })
  it('treats blank as clear (null)', () => {
    expect(parseTimeout('  ')).toEqual({ ok: true, value: null })
  })
  it('rejects out of range and non-numbers', () => {
    expect(parseTimeout('0.05').ok).toBe(false)
    expect(parseTimeout('301').ok).toBe(false)
    expect(parseTimeout('abc').ok).toBe(false)
    expect(parseTimeout('Infinity').ok).toBe(false)
  })
})

describe('parseRetries', () => {
  it('accepts 0..10 integers and blank', () => {
    expect(parseRetries('0')).toEqual({ ok: true, value: 0 })
    expect(parseRetries('10')).toEqual({ ok: true, value: 10 })
    expect(parseRetries('')).toEqual({ ok: true, value: null })
  })
  it('rejects fractions, negatives, too large', () => {
    expect(parseRetries('1.5').ok).toBe(false)
    expect(parseRetries('-1').ok).toBe(false)
    expect(parseRetries('11').ok).toBe(false)
    expect(parseRetries('x').ok).toBe(false)
  })
})

describe('formatters', () => {
  it('describeLimit', () => {
    expect(describeLimit(30, true)).toBe('30 (overridden)')
    expect(describeLimit(2, false)).toBe('2 (global default)')
  })
  it('formatErrorRate', () => {
    expect(formatErrorRate(null)).toBe('—')
    expect(formatErrorRate(0)).toBe('0%')
    expect(formatErrorRate(0.25)).toBe('25%')
    expect(formatErrorRate(1 / 3)).toBe('33.3%')
  })
  it('formatLatency', () => {
    expect(formatLatency(null)).toBe('—')
    expect(formatLatency(12.6)).toBe('13 ms')
  })
  it('summarizeArgs', () => {
    expect(summarizeArgs(null, 20)).toBe('—')
    expect(summarizeArgs({}, 20)).toBe('—')
    expect(summarizeArgs({ a: 1 }, 20)).toBe('{"a":1}')
    const long = summarizeArgs({ query: 'x'.repeat(50) }, 20)
    expect(long).toHaveLength(20)
    expect(long.endsWith('…')).toBe(true)
  })
})
