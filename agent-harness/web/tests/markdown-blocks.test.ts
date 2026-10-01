import { describe, expect, it } from 'vitest'
import { parseMarkdownBlocks } from '../src/lib/markdown-blocks'

describe('parseMarkdownBlocks', () => {
  it('turns "- " lines into a real list instead of literal dashes', () => {
    const blocks = parseMarkdownBlocks(
      'The current status of the payments-api is degraded:\n\n- **Latency**: 812 ms\n- **Error Rate**: 4.1%\n\nIt is not fully down.',
    )
    expect(blocks).toEqual([
      { kind: 'p', lines: ['The current status of the payments-api is degraded:'] },
      { kind: 'ul', items: ['**Latency**: 812 ms', '**Error Rate**: 4.1%'] },
      { kind: 'p', lines: ['It is not fully down.'] },
    ])
  })

  it('parses a list that directly follows a paragraph line', () => {
    expect(parseMarkdownBlocks('Details:\n- a\n- b')).toEqual([
      { kind: 'p', lines: ['Details:'] },
      { kind: 'ul', items: ['a', 'b'] },
    ])
  })

  it('parses ordered lists, headings, quotes and rules', () => {
    expect(parseMarkdownBlocks('## Next steps\n1. Page on-call\n2) Roll back\n> note\n---')).toEqual([
      { kind: 'h', level: 2, text: 'Next steps' },
      { kind: 'ol', items: ['Page on-call', 'Roll back'] },
      { kind: 'quote', lines: ['note'] },
      { kind: 'hr' },
    ])
  })

  it('keeps fenced code verbatim, including an unterminated fence mid-stream', () => {
    expect(parseMarkdownBlocks('```sql\nSELECT 1;\n```')).toEqual([{ kind: 'code', lang: 'sql', code: 'SELECT 1;' }])
    expect(parseMarkdownBlocks('```\n- not a list')).toEqual([{ kind: 'code', lang: '', code: '- not a list' }])
  })

  it('keeps multi-line paragraphs together and skips blank lines', () => {
    expect(parseMarkdownBlocks('line one\nline two\n\n\nnext')).toEqual([
      { kind: 'p', lines: ['line one', 'line two'] },
      { kind: 'p', lines: ['next'] },
    ])
  })
})
