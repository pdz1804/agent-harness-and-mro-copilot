import { Fragment } from 'react'
import { splitForHighlight } from '../../lib/kb-highlight'

/** Plain text with query terms wrapped in <mark>. */
export function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {splitForHighlight(text, terms).map((segment, i) =>
        segment.match ? (
          <mark key={i} className="rounded bg-amber-200/80 px-0.5 text-zinc-900" data-hit="true">
            {segment.text}
          </mark>
        ) : (
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </>
  )
}
