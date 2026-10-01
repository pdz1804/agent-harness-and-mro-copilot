import { ShieldWarning } from '@phosphor-icons/react'
import type { ToolCatalogEntry } from '../../lib/api-types'

/** Multi-select over the harness's tool registry (`GET /tools`), used by the
 * Skills editor's `allowed_tools` field. Shows an "approval required" badge
 * for tools that gate on a human approval step, and dims a tool that is
 * currently disabled in Integrations (still selectable — the skill/tool
 * intersection is only resolved at run time, per phase 04 — but flagged so
 * an author isn't surprised). */
export function ToolPicker({
  tools,
  selected,
  onChange,
}: {
  tools: ToolCatalogEntry[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (name: string) => {
    onChange(selected.includes(name) ? selected.filter((t) => t !== name) : [...selected, name])
  }

  return (
    <div className="space-y-1.5">
      {tools.map((tool) => {
        const checked = selected.includes(tool.name)
        return (
          <label
            key={tool.name}
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm transition ${
              checked ? 'border-sky-300 bg-sky-50' : 'border-zinc-200 hover:border-zinc-300'
            } ${!tool.enabled ? 'opacity-60' : ''}`}
          >
            <input name="tool-enabled"
              type="checkbox"
              checked={checked}
              onChange={() => toggle(tool.name)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-data text-xs font-medium text-zinc-900">{tool.name}</span>
                {tool.requires_approval && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                    <ShieldWarning size={10} weight="bold" />
                    Approval required
                  </span>
                )}
                {!tool.enabled && (
                  <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-xs font-medium text-zinc-600">
                    Disabled in Integrations
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-xs text-zinc-500">{tool.description}</span>
            </span>
          </label>
        )
      })}
    </div>
  )
}
