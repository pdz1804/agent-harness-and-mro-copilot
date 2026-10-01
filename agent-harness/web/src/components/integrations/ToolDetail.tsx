import { Copy, ShieldCheck } from '@phosphor-icons/react'
import { useCallback, useEffect, useId, useState } from 'react'
import { disabledReason, useMe } from '../../hooks/useMe'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { ApiError, api, errorText } from '../../lib/api'
import type { Integration, IntegrationDetail } from '../../lib/api-types'
import { formatErrorRate, formatLatency } from '../../lib/integration-limits'
import { Button, Chip, ErrorState, RowActions, Sheet, SheetSection, SheetSkeleton, Switch, useToast } from '../ui'
import { DiscardFooter } from '../guardrails/DiscardFooter'
import { LimitsForm, type LimitsFormStatus } from './LimitsForm'
import { RecentCalls } from './RecentCalls'
import { SchemaTabs } from './SchemaTabs'

interface ToolDetailProps {
  tool: string
  /** The row as listed (instant header and enable state while the detail loads). */
  listed: Integration | null
  /** Bump to refetch (page Refresh button). */
  refreshToken: number
  onLimitsSaved: (updated: Integration) => void
  enabledPending: boolean
  onToggle: (enabled: boolean) => void
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  /** Reports unsaved limit edits so the page can guard switching rows. */
  onDirtyChange: (dirty: boolean) => void
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-600">{label}</dt>
      <dd className="text-base font-semibold text-zinc-900 tabular-nums">{value}</dd>
    </div>
  )
}

/** Sheet for one tool: description, usage from persisted traces, effective
 * limits (editable by roles with `mutate_integrations`), schemas and recent
 * calls. Deep link: `/settings/integrations?open=<tool>`. Closing or stepping
 * away with unsaved limits asks first. */
export function ToolDetail({ tool, listed, refreshToken, onLimitsSaved, enabledPending, onToggle, onClose, onPrev, onNext, onDirtyChange }: ToolDetailProps) {
  const formId = useId()
  const toast = useToast()
  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_integrations') : true
  const mutateReason = canMutate ? undefined : disabledReason(me, 'mutate_integrations')
  const [detail, setDetail] = useState<IntegrationDetail | null>(null)
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [form, setForm] = useState<LimitsFormStatus>({ dirty: false, canSave: false, saving: false })
  const [pendingExit, setPendingExit] = useState<(() => void) | null>(null)
  useDocumentTitle(tool)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api.getIntegration(tool).then(
      (data) => {
        if (!cancelled) setDetail(data)
      },
      (err: unknown) => {
        if (cancelled) return
        const notFound = err instanceof ApiError && err.status === 404
        setError({ message: notFound ? `No tool named "${tool}" exists. Pick another from the list.` : errorText(err, 'Failed to load this tool.'), notFound })
      },
    )
    return () => {
      cancelled = true
    }
  }, [tool, refreshToken, reloadToken])

  useEffect(() => {
    onDirtyChange(form.dirty)
    return () => onDirtyChange(false)
  }, [form.dirty, onDirtyChange])

  const onStatus = useCallback((status: LimitsFormStatus) => setForm(status), [])

  const guard = (action: (() => void) | undefined) => (action ? () => (form.dirty ? setPendingExit(() => action) : action()) : undefined)

  const current = detail?.tool_name === tool ? detail : null
  const enabled = listed?.enabled ?? current?.enabled ?? false
  const stats = current?.stats
  const scope = me?.role === 'admin' ? 'all runs' : 'your own runs'

  return (
    <Sheet
      open
      width="xl"
      onClose={guard(onClose)!}
      onPrev={guard(onPrev)}
      onNext={guard(onNext)}
      eyebrow="Integrations"
      label={tool}
      title={<span className="font-data text-[15px]">{tool}</span>}
      status={
        <>
          <Chip tone={enabled ? 'ok' : 'muted'} dot>
            {enabled ? 'Enabled' : 'Disabled'}
          </Chip>
          {current?.requires_approval && (
            <Chip tone="warn" icon={<ShieldCheck size={12} weight="fill" aria-hidden="true" />}>
              Needs approval
            </Chip>
          )}
        </>
      }
      headerActions={
        <RowActions
          visibility="always"
          label={`More actions for ${tool}`}
          items={[
            {
              label: 'Copy tool name',
              icon: <Copy size={14} />,
              onSelect: () => {
                void navigator.clipboard?.writeText(tool)?.then(() => toast({ title: 'Tool name copied' }), () => undefined)
              },
            },
          ]}
        />
      }
      footer={
        pendingExit ? (
          <DiscardFooter
            onKeep={() => setPendingExit(null)}
            onDiscard={() => {
              const action = pendingExit
              setPendingExit(null)
              onDirtyChange(false)
              action()
            }}
          />
        ) : (
          <>
            {!canMutate && <span className="mr-auto text-xs text-zinc-600">{mutateReason}</span>}
            <Button type="submit" form={formId} variant="primary" disabled={!canMutate || !form.canSave} loading={form.saving} title={mutateReason}>
              Save limits
            </Button>
          </>
        )
      }
    >
      {error && !current ? (
        <ErrorState
          message={error.message}
          onRetry={
            error.notFound
              ? undefined
              : () => {
                  setError(null)
                  setReloadToken((n) => n + 1)
                }
          }
        />
      ) : !current ? (
        <SheetSkeleton />
      ) : (
        <>
          <SheetSection title="Overview">
            <p className="text-[13px] text-zinc-700 [overflow-wrap:anywhere]">{current.description}</p>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-[10px] bg-zinc-950/[0.03] px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-zinc-900">Available to agents</p>
                <p className="text-xs text-zinc-600">{mutateReason ?? 'A disabled tool is removed from the next run, not just hidden.'}</p>
              </div>
              <Switch checked={enabled} onChange={onToggle} label={`${enabled ? 'Disable' : 'Enable'} ${tool}`} disabled={!canMutate} title={mutateReason} pending={enabledPending} />
            </div>
          </SheetSection>

          <SheetSection title="Usage">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Calls" value={String(stats?.calls ?? 0)} />
              <Stat label="Error rate" value={formatErrorRate(stats?.error_rate)} />
              <Stat label="Avg latency" value={formatLatency(stats?.avg_latency_ms)} />
              <Stat label="Errors" value={String(stats?.errors ?? 0)} />
            </dl>
            <p className="text-xs text-zinc-600">{stats && stats.calls === 0 ? `No calls yet. Stats appear after ${scope} use this tool.` : `Computed from the saved traces of ${scope}.`}</p>
          </SheetSection>

          <SheetSection title="Limits">
            <LimitsForm
              key={current.tool_name}
              tool={current.tool_name}
              detail={current}
              canMutate={canMutate}
              disabledTitle={mutateReason}
              formId={formId}
              onStatus={onStatus}
              onSaved={(updated) => {
                onLimitsSaved(updated)
                setReloadToken((n) => n + 1)
              }}
            />
          </SheetSection>

          <SheetSection title="Schema">
            <SchemaTabs key={current.tool_name} inputSchema={current.input_schema} outputSchema={current.output_schema} />
          </SheetSection>

          <SheetSection title={`Recent calls${current.recent_calls.length ? ` · ${current.recent_calls.length}` : ''}`}>
            {current.recent_calls.length > 0 ? (
              <RecentCalls calls={current.recent_calls} />
            ) : (
              <p className="text-[13px] text-zinc-600">No recorded calls. Start a run that uses this tool and each call appears here with its outcome and latency.</p>
            )}
          </SheetSection>
        </>
      )}
    </Sheet>
  )
}
