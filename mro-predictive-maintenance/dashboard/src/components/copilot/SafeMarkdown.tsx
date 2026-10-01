import { Fragment, type ReactNode } from "react";

/**
 * Minimal safe markdown renderer for copilot chat text.
 *
 * Renders a constrained subset of markdown (bold, italic, inline code,
 * links, line breaks) directly to React elements. It never uses
 * `dangerouslySetInnerHTML` and never parses/produces raw HTML tags -- any
 * `<`/`>` in the source text is rendered as literal text, not a tag. This
 * makes it inherently XSS-safe: there is no HTML parser in the loop, so
 * there is nothing for injected `<script>`/`<img onerror>`-style payloads
 * to hook into.
 *
 * Supported inline syntax: `**bold**`, `*italic*`/`_italic_`, `` `code` ``,
 * `[text](https://...)` (only http/https URLs are linkified; anything else
 * -- including `javascript:` -- is rendered as plain text).
 */

export type MarkdownToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "link"; text: string; href: string };

/**
 * Pure tokenizer, exported for unit testing without a DOM/render environment.
 * Order matters: code first (so `**` inside `` `code` `` isn't treated as
 * bold), then links, then bold, then italic. Only http/https URLs become
 * link tokens; anything else (e.g. `javascript:...`) degrades to plain text.
 */
export function tokenizeInline(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|(?:\*|_)([^*_]+)(?:\*|_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: "text", value: text.slice(lastIndex, match.index) });
    }
    const [, code, linkText, linkHref, bold, italic] = match;
    if (code !== undefined) {
      tokens.push({ kind: "code", value: code });
    } else if (linkText !== undefined && linkHref !== undefined) {
      tokens.push({ kind: "link", text: linkText, href: linkHref });
    } else if (bold !== undefined) {
      tokens.push({ kind: "bold", value: bold });
    } else if (italic !== undefined) {
      tokens.push({ kind: "italic", value: italic });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return tokens;
}

let keySeed = 0;

function renderInline(text: string): ReactNode[] {
  return tokenizeInline(text).map((token) => {
    const k = `md-${keySeed++}`;
    switch (token.kind) {
      case "code":
        return <code key={k}>{token.value}</code>;
      case "link":
        return (
          <a key={k} href={token.href} target="_blank" rel="noopener noreferrer">
            {token.text}
          </a>
        );
      case "bold":
        return <strong key={k}>{token.value}</strong>;
      case "italic":
        return <em key={k}>{token.value}</em>;
      default:
        return token.value;
    }
  });
}

export function SafeMarkdown({ text }: { text: string }): JSX.Element {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {renderInline(line)}
        </Fragment>
      ))}
    </>
  );
}
