import { describe, expect, it } from 'vitest'
import { isSafeHref, parseInlineMarkdown } from '../src/lib/markdown'

describe('parseInlineMarkdown', () => {
  it('parses bold markers', () => {
    expect(parseInlineMarkdown('auth-service is **operational**.')).toEqual([
      { type: 'text', text: 'auth-service is ' },
      { type: 'bold', text: 'operational' },
      { type: 'text', text: '.' },
    ])
  })

  it('parses italic, code, and link markers', () => {
    expect(parseInlineMarkdown('see `get_service_status` — _fast_ [docs](https://example.com)')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'code', text: 'get_service_status' },
      { type: 'text', text: ' — ' },
      { type: 'italic', text: 'fast' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'docs', href: 'https://example.com' },
    ])
  })

  it('leaves plain text with no markers untouched', () => {
    expect(parseInlineMarkdown('no markers here')).toEqual([{ type: 'text', text: 'no markers here' }])
  })

  it('does not misread bold as two italics', () => {
    const tokens = parseInlineMarkdown('**bold**')
    expect(tokens).toEqual([{ type: 'bold', text: 'bold' }])
  })

  it('treats an unmatched marker as literal text', () => {
    expect(parseInlineMarkdown('this * is not closed')).toEqual([
      { type: 'text', text: 'this * is not closed' },
    ])
  })
})

describe('isSafeHref', () => {
  it('allows http(s) urls', () => {
    expect(isSafeHref('https://example.com')).toBe(true)
    expect(isSafeHref('http://example.com')).toBe(true)
  })

  it('rejects javascript: and other non-http schemes', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false)
  })
})
