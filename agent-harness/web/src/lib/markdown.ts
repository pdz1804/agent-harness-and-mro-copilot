/** Minimal, safe inline-markdown tokenizer for chat final answers.
 *
 * Scope is deliberately narrow (bold/italic/inline-code/links only — no
 * headings, tables, block HTML) because the only observed problem is raw
 * `**bold**`/`` `code` `` markers showing up literally in the final-answer
 * bubble. No HTML is parsed or rendered: every token's `text` is rendered
 * through React as a plain string (never `dangerouslySetInnerHTML`), so
 * there is no XSS surface even if the model echoes back `<script>` or the
 * like — it renders as inert text either way. */

export type MarkdownToken =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string }

// Order matters: bold (**/__) before italic (*/_) so `**x**` isn't read as
// two italic markers; link before the rest; inline code checked first of
// all so markup characters inside a code span are never re-interpreted.
const INLINE_PATTERN =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g

/** Parse one line/paragraph of text into a flat list of inline tokens.
 * Unmatched text between/around markers is preserved verbatim as `text`
 * tokens (including any literal `*`/`` ` `` that isn't part of a valid
 * pair) so nothing is ever silently dropped. */
export function parseInlineMarkdown(input: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = []
  let lastIndex = 0
  INLINE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_PATTERN.exec(input)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: input.slice(lastIndex, match.index) })
    }
    const [, code, bold1, bold2, italic1, italic2, linkText, linkHref] = match
    if (code !== undefined) {
      tokens.push({ type: 'code', text: code })
    } else if (bold1 !== undefined || bold2 !== undefined) {
      tokens.push({ type: 'bold', text: (bold1 ?? bold2)! })
    } else if (linkText !== undefined && linkHref !== undefined) {
      tokens.push({ type: 'link', text: linkText, href: linkHref })
    } else if (italic1 !== undefined || italic2 !== undefined) {
      tokens.push({ type: 'italic', text: (italic1 ?? italic2)! })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < input.length) {
    tokens.push({ type: 'text', text: input.slice(lastIndex) })
  }
  return tokens
}

/** A link target is only ever rendered if it looks like an http(s) URL —
 * anything else (e.g. `javascript:`) degrades to plain text, closing off
 * the one realistic injection vector for a "link". */
export function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}
