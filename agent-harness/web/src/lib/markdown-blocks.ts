/** Block-level markdown parser for chat answers (pure, no DOM): paragraphs,
 * `#` headings, `-`/`*`/`1.` lists, `>` quotes, `---` rules and fenced code.
 * Inline markers inside each block are parsed separately by
 * `parseInlineMarkdown`. Partial input (mid-stream) degrades gracefully: an
 * unterminated fence is treated as code-so-far. */
export type MarkdownBlock =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'hr' }

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence (or past the end while streaming)
      blocks.push({ kind: 'code', lang: fence[1], code: body.join('\n') })
      continue
    }
    if (/^\s*$/.test(line)) {
      i++
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] })
      i++
      continue
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }
    const listKind = /^\s*[-*•]\s+/.test(line) ? 'ul' : /^\s*\d+[.)]\s+/.test(line) ? 'ol' : null
    if (listKind) {
      const pattern = listKind === 'ul' ? /^\s*[-*•]\s+/ : /^\s*\d+[.)]\s+/
      const items: string[] = []
      while (i < lines.length && pattern.test(lines[i])) items.push(lines[i++].replace(pattern, ''))
      blocks.push({ kind: listKind, items })
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', lines: quote })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i++])
    }
    if (para.length === 0) para.push(lines[i++])
    blocks.push({ kind: 'p', lines: para })
  }
  return blocks
}

