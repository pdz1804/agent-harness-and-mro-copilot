import { describe, expect, it } from 'vitest'
import { parseMarkdownBlocks } from '../src/lib/kb-markdown'

describe('parseMarkdownBlocks', () => {
  it('parses a typical runbook', () => {
    const blocks = parseMarkdownBlocks(
      [
        '# Runbook: auth-service outage',
        '',
        'Restart the pool first.',
        'Then verify.',
        '',
        '## Steps',
        '- Check status',
        '- Restart pool',
        '  and wait',
        '',
        '1. Page on-call',
        '2. Open an incident',
        '',
        '> Never skip approval.',
        '',
        '---',
        '',
        '```bash',
        'kubectl rollout restart deploy/auth',
        '```',
      ].join('\n'),
    )
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Runbook: auth-service outage' },
      { type: 'paragraph', text: 'Restart the pool first. Then verify.' },
      { type: 'heading', level: 2, text: 'Steps' },
      { type: 'list', ordered: false, items: ['Check status', 'Restart pool and wait'] },
      { type: 'list', ordered: true, items: ['Page on-call', 'Open an incident'] },
      { type: 'quote', text: 'Never skip approval.' },
      { type: 'rule' },
      { type: 'code', lang: 'bash', text: 'kubectl rollout restart deploy/auth' },
    ])
  })

  it('does not swallow a heading that directly follows a paragraph line', () => {
    expect(parseMarkdownBlocks('intro line\n## Next')).toEqual([
      { type: 'paragraph', text: 'intro line' },
      { type: 'heading', level: 2, text: 'Next' },
    ])
  })

  it('tolerates an unterminated code fence and CRLF input', () => {
    expect(parseMarkdownBlocks('```\r\nline 1\r\nline 2')).toEqual([{ type: 'code', lang: '', text: 'line 1\nline 2' }])
  })

  it('returns no blocks for blank input', () => {
    expect(parseMarkdownBlocks('  \n\n')).toEqual([])
  })

  it('keeps raw HTML as inert text', () => {
    expect(parseMarkdownBlocks('<script>alert(1)</script>')).toEqual([
      { type: 'paragraph', text: '<script>alert(1)</script>' },
    ])
  })
})
