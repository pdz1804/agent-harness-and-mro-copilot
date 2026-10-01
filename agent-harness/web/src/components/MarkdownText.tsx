import { Check, Copy } from '@phosphor-icons/react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { isSafeHref, parseInlineMarkdown } from '../lib/markdown'
import { parseMarkdownBlocks, type MarkdownBlock as Block } from '../lib/markdown-blocks'

/** Renders a chat final answer's markdown as real React elements — never
 * `dangerouslySetInnerHTML` — so there is no HTML/XSS surface: every
 * character the model produced ends up as text content, at worst inert
 * literal markup if a marker is unmatched. Block level: paragraphs, `#`
 * headings, `-`/`*`/`1.` lists, `>` quotes and fenced code (with copy).
 * Inline level (`**bold**`, `_italic_`, `` `code` ``, links) is delegated to
 * the tested `parseInlineMarkdown`. Partial input (mid-stream) degrades to
 * plain paragraphs, and an unterminated fence renders as code so far. */

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInlineMarkdown(text).map((token, i) => {
        switch (token.type) {
          case 'bold':
            return <strong key={i}>{token.text}</strong>
          case 'italic':
            return <em key={i}>{token.text}</em>
          case 'code':
            return <code key={i}>{token.text}</code>
          case 'link':
            return isSafeHref(token.href) ? (
              <a key={i} href={token.href} target="_blank" rel="noopener noreferrer">
                {token.text}
              </a>
            ) : (
              <Fragment key={i}>{token.text}</Fragment>
            )
          default:
            return <Fragment key={i}>{token.text}</Fragment>
        }
      })}
    </>
  )
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="overflow-hidden rounded-xl bg-zinc-950 ring-1 ring-zinc-950/10">
      <div className="flex h-9 items-center justify-between border-b border-white/[0.07] pr-1.5 pl-3.5">
        <span className="font-data text-[11px] text-zinc-400">{lang || 'text'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(code)
              .then(() => setCopied(true))
              .catch(() => {
                /* clipboard unavailable (insecure context / denied) */
              })
          }}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Copy code"
        >
          {copied ? <Check size={12} weight="bold" className="text-emerald-400" /> : <Copy size={12} weight="bold" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[12.5px] leading-relaxed text-zinc-100">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'h': {
      const Tag = (`h${Math.min(block.level + 1, 4)}` as 'h2' | 'h3' | 'h4')
      return (
        <Tag key={key}>
          <Inline text={block.text} />
        </Tag>
      )
    }
    case 'ul':
    case 'ol': {
      const Tag = block.kind
      return (
        <Tag key={key}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </Tag>
      )
    }
    case 'quote':
      return (
        <blockquote key={key}>
          {block.lines.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              <Inline text={l} />
            </Fragment>
          ))}
        </blockquote>
      )
    case 'code':
      return <CodeBlock key={key} lang={block.lang} code={block.code} />
    case 'hr':
      return <hr key={key} />
    default:
      return (
        <p key={key}>
          {block.lines.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              <Inline text={l} />
            </Fragment>
          ))}
        </p>
      )
  }
}

export function MarkdownText({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`ui-prose ${className}`}>{parseMarkdownBlocks(text).map(renderBlock)}</div>
}
