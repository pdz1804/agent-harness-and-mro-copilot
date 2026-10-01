import { Check, Copy } from '@phosphor-icons/react'
import { useState } from 'react'
import { JsonTree } from '../ui/JsonTree'

type Tab = 'input' | 'output'

/** Input / Output JSON Schema viewer with a visible copy button. */
export function SchemaTabs({
  inputSchema,
  outputSchema,
}: {
  inputSchema: Record<string, unknown> | null
  outputSchema: Record<string, unknown> | null
}) {
  const [tab, setTab] = useState<Tab>('input')
  const [copied, setCopied] = useState(false)
  const schema = tab === 'input' ? inputSchema : outputSchema

  const copy = () => {
    if (!schema || !navigator.clipboard) return
    navigator.clipboard
      .writeText(JSON.stringify(schema, null, 2))
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        /* clipboard denied: the schema stays visible and selectable */
      })
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div role="tablist" aria-label="Schema" className="inline-flex rounded-md border border-zinc-300 p-0.5">
          {(['input', 'output'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`schema-tab-${t}`}
              aria-selected={tab === t}
              aria-controls="schema-panel"
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  setTab(t === 'input' ? 'output' : 'input')
                }
              }}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === t ? 'bg-sky-50 text-sky-800' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              {t === 'input' ? 'Input' : 'Output'}
            </button>
          ))}
        </div>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={copy} disabled={!schema}>
          {copied ? <Check size={12} weight="bold" aria-hidden="true" /> : <Copy size={12} weight="bold" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy schema'}
        </button>
      </div>
      <div id="schema-panel" role="tabpanel" aria-labelledby={`schema-tab-${tab}`}>
        {schema ? (
          <JsonTree value={schema} />
        ) : (
          <p className="text-[13px] text-zinc-600">This tool declares no {tab} schema.</p>
        )}
      </div>
    </div>
  )
}
