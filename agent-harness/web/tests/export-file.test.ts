import { describe, expect, it } from 'vitest'
import { exportFileName, toCsv, toJsonl } from '../src/lib/export-file'

describe('toCsv', () => {
  it('quotes fields with commas, quotes and newlines and blanks nulls', () => {
    expect(toCsv(['a', 'b'], [['x, y', 'say "hi"'], ['line\nbreak', null], [3, undefined]])).toBe(
      'a,b\r\n"x, y","say ""hi"""\r\n"line\nbreak",\r\n3,\r\n',
    )
  })
  it('writes only the header for an empty list', () => {
    expect(toCsv(['id'], [])).toBe('id\r\n')
  })
})

describe('toJsonl', () => {
  it('writes one object per line', () => {
    expect(toJsonl([{ a: 1 }, { b: 'x' }])).toBe('{"a":1}\n{"b":"x"}\n')
    expect(toJsonl([])).toBe('')
  })
})

describe('exportFileName', () => {
  it('dates the file with zero padding', () => {
    expect(exportFileName('sessions', 'csv', new Date(2026, 9, 2))).toBe('sessions-2026-10-02.csv')
  })
})
