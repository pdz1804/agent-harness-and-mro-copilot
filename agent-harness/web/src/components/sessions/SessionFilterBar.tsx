import { MagnifyingGlass, X } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { Agent, ArchivedFilter } from '../../lib/api-types'
import type { SessionFilterState } from '../../lib/session-filters'

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'pending_approval', label: 'Pending approval' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Stopped' },
  { value: 'guardrail_blocked', label: 'Blocked by guardrail' },
  { value: 'idle', label: 'Idle (no run yet)' },
  { value: 'step_limit_exceeded', label: 'Step limit exceeded' },
  { value: 'time_limit_exceeded', label: 'Time limit exceeded' },
  { value: 'llm_error_exceeded', label: 'LLM error limit' },
]

const ARCHIVED_OPTIONS: { value: ArchivedFilter; label: string }[] = [
  { value: 'exclude', label: 'Active' },
  { value: 'include', label: 'Include archived' },
  { value: 'only', label: 'Archived only' },
]

interface SessionFilterBarProps {
  /** Live (un-debounced) text of the search box. */
  searchInput: string
  filters: SessionFilterState
  agents: Agent[]
  canClear: boolean
  onSearchInput: (value: string) => void
  onChange: (patch: Partial<SessionFilterState>) => void
  onClear: () => void
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="ui-section-label mb-1 block">
        {label}
      </label>
      {children}
    </div>
  )
}

export function SessionFilterBar({
  searchInput,
  filters,
  agents,
  canClear,
  onSearchInput,
  onChange,
  onClear,
}: SessionFilterBarProps) {
  return (
    <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Filter sessions">
      <div className="min-w-[14rem] flex-1">
        <Field id="session-search" label="Search">
          <div className="relative">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-zinc-500"
            />
            <input
              id="session-search"
              name="session-search"
              type="search"
              autoComplete="off"
              value={searchInput}
              onChange={(e) => onSearchInput(e.target.value)}
              placeholder="Title or objective…"
              className="ui-input w-full pl-8"
            />
          </div>
        </Field>
      </div>
      <Field id="session-status" label="Status">
        <select
          id="session-status"
          name="session-status"
          value={filters.status}
          onChange={(e) => onChange({ status: e.target.value })}
          className="ui-input"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field id="session-agent" label="Agent">
        <select
          id="session-agent"
          name="session-agent"
          value={filters.agentId}
          onChange={(e) => onChange({ agentId: e.target.value })}
          className="ui-input max-w-[12rem]"
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="session-from" label="From">
        <input
          id="session-from"
          name="session-from"
          type="date"
          autoComplete="off"
          value={filters.fromDate}
          max={filters.toDate || undefined}
          onChange={(e) => onChange({ fromDate: e.target.value })}
          className="ui-input tabular-nums"
        />
      </Field>
      <Field id="session-to" label="To">
        <input
          id="session-to"
          name="session-to"
          type="date"
          autoComplete="off"
          value={filters.toDate}
          min={filters.fromDate || undefined}
          onChange={(e) => onChange({ toDate: e.target.value })}
          className="ui-input tabular-nums"
        />
      </Field>
      <Field id="session-archived" label="Archived">
        <select
          id="session-archived"
          name="session-archived"
          value={filters.archived}
          onChange={(e) => onChange({ archived: e.target.value as ArchivedFilter })}
          className="ui-input"
        >
          {ARCHIVED_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      {canClear && (
        <button type="button" onClick={onClear} className="ui-btn ui-btn-ghost">
          <X size={14} />
          Clear filters
        </button>
      )}
    </div>
  )
}
