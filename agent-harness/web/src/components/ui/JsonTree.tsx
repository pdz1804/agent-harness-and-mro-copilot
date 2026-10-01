import { Copy } from '@phosphor-icons/react'
import { useState } from 'react'

/** Minimal collapsed-by-default JSON viewer with a copy-to-clipboard
 * affordance — used by the inspector's Tools/Raw tabs for args/results.
 * Deliberately not a full tree-expand-per-node widget (YAGNI for this
 * codebase's trace payload sizes); renders pretty-printed JSON with a
 * single expand/collapse toggle past a line threshold. */
export function JsonTree({ value, label }: { value: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false)
  const text = JSON.stringify(value, null, 2) ?? 'null'
  const lines = text.split('\n')
  const isLong = lines.length > 8
  const shown = expanded || !isLong ? text : `${lines.slice(0, 8).join('\n')}\n…`

  const copy = () => {
    void navigator.clipboard?.writeText(text).catch(() => {
      /* clipboard access denied — non-fatal, best effort */
    })
  }

  return (
    <div className="relative">
      {label && <p className="mb-1 text-xs font-semibold text-zinc-500 ">{label}</p>}
      <div className="group relative rounded-md bg-zinc-50 ring-1 ring-zinc-200">
        <button
          type="button"
          onClick={copy}
          aria-label="Copy JSON"
          className="absolute top-1 right-1 rounded p-1 text-zinc-500 opacity-0 transition hover:bg-zinc-200 hover:text-zinc-700 group-hover:opacity-100"
        >
          <Copy size={12} weight="bold" />
        </button>
        <pre className="font-data overflow-x-auto p-2 text-xs text-zinc-700">{shown}</pre>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full border-t border-zinc-200 py-1 text-center text-xs text-zinc-500 hover:text-zinc-800"
          >
            {expanded ? 'Show less' : `Show all ${lines.length} lines`}
          </button>
        )}
      </div>
    </div>
  )
}
