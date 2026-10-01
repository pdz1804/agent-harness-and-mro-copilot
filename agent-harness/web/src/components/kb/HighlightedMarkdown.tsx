import type { ReactNode } from 'react'
import { parseMarkdownBlocks } from '../../lib/kb-markdown'
import { isSafeHref, parseInlineMarkdown } from '../../lib/markdown'
import { Marked } from './Marked'

/** One line of inline markdown with query terms highlighted inside every
 * kind of span (plain, bold, italic, code, link text). */
export function HighlightedInline({ text, terms }: { text: string; terms: string[] }): ReactNode {
  return parseInlineMarkdown(text).map((token, i) => {
    switch (token.type) {
      case 'bold':
        return (
          <strong key={i}>
            <Marked text={token.text} terms={terms} />
          </strong>
        )
      case 'italic':
        return (
          <em key={i}>
            <Marked text={token.text} terms={terms} />
          </em>
        )
      case 'code':
        return (
          <code key={i} className="rounded bg-zinc-100 px-1 py-0.5 font-data text-[0.9em]">
            <Marked text={token.text} terms={terms} />
          </code>
        )
      case 'link':
        return isSafeHref(token.href) ? (
          <a key={i} href={token.href} target="_blank" rel="noopener noreferrer" className="text-teal-700 underline underline-offset-2">
            <Marked text={token.text} terms={terms} />
          </a>
        ) : (
          <Marked key={i} text={token.text} terms={terms} />
        )
      default:
        return <Marked key={i} text={token.text} terms={terms} />
    }
  })
}

/** A document rendered as real headings, paragraphs, lists, quotes and code
 * (React elements only, never `dangerouslySetInnerHTML`), with every query
 * term highlighted. */
export function HighlightedMarkdown({ source, terms }: { source: string; terms: string[] }) {
  const blocks = parseMarkdownBlocks(source)
  return (
    <div className="space-y-3 text-sm leading-relaxed text-zinc-800" data-testid="kb-rendered">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading': {
            const size = ['text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm', 'text-sm'][block.level - 1]
            return (
              <p key={i} role="heading" aria-level={block.level} className={`${size} mt-4 font-semibold text-zinc-900 first:mt-0`}>
                <HighlightedInline text={block.text} terms={terms} />
              </p>
            )
          }
          case 'paragraph':
            return (
              <p key={i}>
                <HighlightedInline text={block.text} terms={terms} />
              </p>
            )
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul'
            return (
              <Tag key={i} className={`${block.ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <HighlightedInline text={item} terms={terms} />
                  </li>
                ))}
              </Tag>
            )
          }
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-zinc-300 pl-3 text-zinc-600">
                <HighlightedInline text={block.text} terms={terms} />
              </blockquote>
            )
          case 'code':
            return (
              <pre key={i} className="font-data overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs text-zinc-100">
                <Marked text={block.text} terms={terms} />
              </pre>
            )
          case 'rule':
            return <hr key={i} className="border-zinc-200" />
        }
      })}
    </div>
  )
}
