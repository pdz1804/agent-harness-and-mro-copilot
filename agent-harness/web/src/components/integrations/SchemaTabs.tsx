import { Check, Copy } from '@phosphor-icons/react'
import { useState } from 'react'
import { Button, Segmented } from '../ui'
import { JsonTree } from '../ui/JsonTree'

type Tab = 'input' | 'output'

/** Input / Output JSON Schema viewer with a visible copy button. */
export function SchemaTabs({ inputSchema, outputSchema }: { inputSchema: Record<string, unknown> | null; outputSchema: Record<string, unknown> | null }) {
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
        <Segmented
          label="Schema"
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'input', label: 'Input' },
            { value: 'output', label: 'Output' },
          ]}
        />
        <Button variant="ghost" size="sm" onClick={copy} disabled={!schema} icon={copied ? <Check size={12} weight="bold" aria-hidden="true" /> : <Copy size={12} weight="bold" aria-hidden="true" />}>
          {copied ? 'Copied' : 'Copy schema'}
        </Button>
      </div>
      <div role="tabpanel" aria-label={`${tab} schema`}>
        {schema ? <JsonTree value={schema} /> : <p className="text-[13px] text-zinc-600">This tool declares no {tab} schema.</p>}
      </div>
    </div>
  )
}
