import { ShieldCheck } from '@phosphor-icons/react'
import { useEffect, useId, useState } from 'react'
import { disabledReason, useMe } from '../../hooks/useMe'
import { ApiError, api } from '../../lib/api'
import type { Integration, IntegrationDetail } from '../../lib/api-types'
import { formatErrorRate, formatLatency } from '../../lib/integration-limits'
import { ErrorBanner } from '../ErrorBanner'
import { Skeleton } from '../Skeleton'
import { LimitsForm } from './LimitsForm'
import { RecentCalls } from './RecentCalls'
import { SchemaTabs } from './SchemaTabs'

interface ToolDetailProps {
  tool: string
  /** Bump to refetch (page Refresh button). */
  refreshToken: number
  onLimitsSaved: (updated: Integration) => void
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-600">{label}</dt>
      <dd className="text-base font-semibold text-zinc-900 tabular-nums">{value}</dd>
    </div>
  )
}

/** Detail panel for one tool: description, stats from persisted traces,
 * effective limits (editable by admins), schemas and recent calls. */
export function ToolDetail({ tool, refreshToken, onLimitsSaved }: ToolDetailProps) {
  const uid = useId()
  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_integrations') : true
  const [detail, setDetail] = useState<IntegrationDetail | null>(null)
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    api
      .getIntegration(tool)
      .then((data) => {
        if (!cancelled) setDetail(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const notFound = err instanceof ApiError && err.status === 404
        setError({
          message: notFound
            ? `No tool named "${tool}" exists. Pick another from the list.`
            : err instanceof ApiError
              ? err.message
              : 'Failed to load this tool.',
          notFound,
        })
      })
    return () => {
      cancelled = true
    }
  }, [tool, refreshToken, reloadToken])

  const retry = () => {
    setError(null)
    setReloadToken((n) => n + 1)
  }

  if (error) {
    return (
      <ErrorBanner message={error.message} onRetry={error.notFound ? undefined : retry} />
    )
  }

  if (!detail) {
    return (
      <div className="ui-card space-y-3 p-4" aria-busy="true" aria-label="Loading tool details">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const { stats } = detail
  const noCalls = stats.calls === 0
  const scope = me?.role === 'admin' ? 'all runs' : 'your own runs'

  return (
    <div className="ui-card space-y-5 p-4">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-data text-base font-semibold text-zinc-900 [overflow-wrap:anywhere]">{detail.tool_name}</h2>
          {detail.requires_approval && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 ring-inset">
              <ShieldCheck size={12} weight="fill" aria-hidden="true" />
              Needs approval
            </span>
          )}
        </div>
        <p className="mt-1 text-[13px] text-zinc-700 [overflow-wrap:anywhere]">{detail.description}</p>
      </header>

      <section aria-labelledby={`${uid}-stats`}>
        <h3 id={`${uid}-stats`} className="ui-section-label mb-2">
          Usage
        </h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Calls" value={String(stats.calls)} />
          <Stat label="Error rate" value={formatErrorRate(stats.error_rate)} />
          <Stat label="Avg latency" value={formatLatency(stats.avg_latency_ms)} />
          <Stat label="Errors" value={String(stats.errors)} />
        </dl>
        <p className="mt-2 text-xs text-zinc-600">
          {noCalls
            ? `No calls yet. Stats appear after ${scope} use this tool.`
            : `Computed from the saved traces of ${scope}.`}
        </p>
      </section>

      <section aria-labelledby={`${uid}-limits`}>
        <h3 id={`${uid}-limits`} className="ui-section-label mb-2">
          Limits
        </h3>
        <LimitsForm
          key={detail.tool_name}
          tool={detail.tool_name}
          detail={detail}
          canMutate={canMutate}
          disabledTitle={canMutate ? undefined : disabledReason(me, 'mutate_integrations')}
          onSaved={(updated) => {
            onLimitsSaved(updated)
            setReloadToken((n) => n + 1)
          }}
        />
      </section>

      <section aria-labelledby={`${uid}-schema`}>
        <h3 id={`${uid}-schema`} className="ui-section-label mb-2">
          Schema
        </h3>
        <SchemaTabs inputSchema={detail.input_schema} outputSchema={detail.output_schema} />
      </section>

      <section aria-labelledby={`${uid}-calls`}>
        <h3 id={`${uid}-calls`} className="ui-section-label mb-2">
          Recent calls
        </h3>
        {detail.recent_calls.length > 0 ? (
          <RecentCalls calls={detail.recent_calls} />
        ) : (
          <p className="text-[13px] text-zinc-600">
            No recorded calls. Start a run that uses this tool and each call appears here with its outcome and latency.
          </p>
        )}
      </section>
    </div>
  )
}
