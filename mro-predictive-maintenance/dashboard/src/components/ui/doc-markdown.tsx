import { createElement, useMemo } from "react";
import { parseDocBlocks } from "../../lib/doc-blocks";
import { SafeMarkdown } from "../copilot/SafeMarkdown";

/** Renders a knowledge-base document. Block structure comes from the pure
 * parser; inline formatting goes through SafeMarkdown (no raw HTML). */
export function DocMarkdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseDocBlocks(source), [source]);
  return (
    <div className="kb-doc prose">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return createElement(`h${b.level}`, { key: i }, <SafeMarkdown text={b.text} />);
          case "quote":
            return (
              <blockquote key={i}>
                <SafeMarkdown text={b.text} />
              </blockquote>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <SafeMarkdown text={it} />
                  </li>
                ))}
              </Tag>
            );
          }
          case "code":
            return <pre key={i}>{b.text}</pre>;
          case "table":
            return (
              <div className="table-scroll" key={i}>
                <table className="dt">
                  <thead>
                    <tr>
                      {b.header.map((h, j) => (
                        <th key={j}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>
                            <SafeMarkdown text={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return (
              <p key={i}>
                <SafeMarkdown text={b.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
