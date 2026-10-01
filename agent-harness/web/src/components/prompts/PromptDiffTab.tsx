import { ArrowRight } from '@phosphor-icons/react'
import type { PromptDetail } from '../../lib/api-types'
import { Card, EmptyState, Field, Select } from '../ui'
import { DiffView } from '../ui/DiffView'

interface PromptDiffTabProps {
  detail: PromptDetail
  /** Version ids on the two sides; null falls back to active / newest other. */
  fromId: string | null
  toId: string | null
  onChange: (next: { from: string; to: string }) => void
}

/** Line diff between any two versions (default: active vs the newest other). */
export function PromptDiffTab({ detail, fromId, toId, onChange }: PromptDiffTabProps) {
  const { versions } = detail
  if (versions.length < 2) {
    return <EmptyState size="compact" icon={<ArrowRight size={18} />} title="Nothing to compare yet" description="A prompt needs at least two versions to diff. Create another version from the draft tab." />
  }
  const activeId = detail.active_version?.id ?? versions[0].id
  const from = versions.find((v) => v.id === fromId) ?? versions.find((v) => v.id === activeId) ?? versions[0]
  const to = versions.find((v) => v.id === toId && v.id !== from.id) ?? versions.find((v) => v.id !== from.id) ?? versions[0]

  const label = (v: (typeof versions)[number]) => `v${v.version}${v.id === activeId ? ' (active)' : ''}`
  const options = versions.map((v) => (
    <option key={v.id} value={v.id}>
      {label(v)}
    </option>
  ))

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From" className="min-w-40">
          {({ id }) => (
            <Select id={id} value={from.id} onChange={(e) => onChange({ from: e.target.value, to: to.id })} className="w-full">
              {options}
            </Select>
          )}
        </Field>
        <ArrowRight size={16} className="mb-2 text-zinc-400" aria-hidden="true" />
        <Field label="To" className="min-w-40">
          {({ id }) => (
            <Select id={id} value={to.id} onChange={(e) => onChange({ from: from.id, to: e.target.value })} className="w-full">
              {options}
            </Select>
          )}
        </Field>
      </div>
      <DiffView before={from.content} after={to.content} />
    </Card>
  )
}
