/** Minimal block-level markdown parser for the knowledge-base viewer: headings,
 * paragraphs, bullet/numbered lists, fenced code, blockquotes and rules —
 * exactly what the runbooks use. Inline formatting is left to
 * `parseInlineMarkdown`. Pure and HTML-free: blocks carry plain strings that
 * React renders as text, so there is no XSS surface. */

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; text: string }
  | { type: 'rule' }

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const ORDERED = /^\s{0,3}\d+[.)]\s+(.*)$/
const FENCE = /^```(\S*)\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  const startsNewBlock = (line: string): boolean =>
    HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || FENCE.test(line) || line.startsWith('>') || RULE.test(line)

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1 // closing fence (or EOF for an unterminated block)
      blocks.push({ type: 'code', lang: fence[1], text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, text: heading[2] })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', text: quoted.join('\n') })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet || ordered) {
      const isOrdered = !bullet
      const pattern = isOrdered ? ORDERED : BULLET
      const items: string[] = []
      while (i < lines.length) {
        const m = pattern.exec(lines[i])
        if (m) {
          items.push(m[1])
          i += 1
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length > 0) {
          items[items.length - 1] += ` ${lines[i].trim()}` // wrapped continuation line
          i += 1
        } else {
          break
        }
      }
      blocks.push({ type: 'list', ordered: isOrdered, items })
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && (paragraph.length === 0 || !startsNewBlock(lines[i]))) {
      paragraph.push(lines[i].trim())
      i += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}
