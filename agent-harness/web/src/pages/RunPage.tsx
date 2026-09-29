import { ArrowLeft, ChatCircleDots, FlagCheckered, WaveSine } from '@phosphor-icons/react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApprovalPanel } from '../components/ApprovalPanel'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { StatusBadge } from '../components/StatusBadge'
import { TimelineSkeleton } from '../components/Skeleton'
import { TraceTimeline } from '../components/TraceTimeline'
import { TraceWaterfall } from '../components/TraceWaterfall'
import { useRunStream } from '../hooks/useRunStream'
import { api } from '../lib/api'

function formatStartedAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString()
}

export function RunPage() {
  const { runId } = useParams<{ runId: string }>()
  const { snapshot, loading, error, notFound, live, refresh } = useRunStream(runId)
  const [view, setView] = useState<'chat' | 'trace'>('chat')

  if (notFound) {
    return (
      <EmptyState
        icon={<FlagCheckered size={32} weight="duotone" />}
        title="Run not found"
        description={`No run with id "${runId}" exists. It may have been from a previous session.`}
        action={
          <Link to="/history" className="text-sm font-medium text-sky-400 hover:text-sky-300">
            View run history
          </Link>
        }
      />
    )
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/history"
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-300"
      >
        <ArrowLeft size={12} weight="bold" />
        All runs
      </Link>

      {loading && !snapshot ? (
        <div className="space-y-4">
          <div className="h-6 w-2/3 animate-pulse rounded bg-zinc-800/80" />
          <TimelineSkeleton />
        </div>
      ) : snapshot ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-data text-xs text-zinc-600">{snapshot.run_id}</p>
              <h1 className="mt-0.5 text-lg font-semibold break-words text-zinc-100">{snapshot.objective}</h1>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                Started {formatStartedAt(snapshot.started_at)} · {snapshot.steps_taken} step
                {snapshot.steps_taken === 1 ? '' : 's'}
                {live && (
                  <span className="inline-flex items-center gap-1 text-emerald-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                    live
                  </span>
                )}
              </p>
            </div>
            <StatusBadge status={snapshot.status} />
          </div>

          <div className="mt-4 inline-flex rounded-md border border-zinc-800 bg-zinc-900/40 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setView('chat')}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium transition ${
                view === 'chat' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <ChatCircleDots size={14} weight="bold" />
              Chat
            </button>
            <button
              type="button"
              onClick={() => setView('trace')}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium transition ${
                view === 'trace' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <WaveSine size={14} weight="bold" />
              Trace
            </button>
          </div>

          {error && <div className="mt-4"><ErrorBanner message={error} /></div>}

          {snapshot.status === 'pending_approval' && snapshot.pending_approval && (
            <div className="mt-4">
              <ApprovalPanel
                pending={snapshot.pending_approval}
                onDecide={async (approved) => {
                  await api.approveRun(snapshot.run_id, approved)
                  refresh()
                }}
              />
            </div>
          )}

          {snapshot.status === 'failed' && snapshot.error && (
            <div className="mt-4">
              <ErrorBanner message={`Run failed unexpectedly: ${snapshot.error}`} />
            </div>
          )}

          {view === 'chat' ? (
            <>
              <div className="mt-4 ml-8 rounded-lg rounded-tr-sm border border-sky-500/30 bg-sky-500/[0.06] p-3">
                <p className="mb-1 text-[10px] font-semibold tracking-wide text-sky-400 uppercase">
                  Objective
                </p>
                <p className="text-sm text-sky-100">{snapshot.objective}</p>
              </div>

              <section className="mt-4">
                <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
                  Agent activity
                </h2>
                <TraceTimeline events={snapshot.history} />
              </section>

              {snapshot.final_answer && (
                <div className="mt-4 flex items-start gap-2 rounded-lg rounded-tl-sm border border-emerald-500/30 bg-emerald-500/[0.04] p-4">
                  <FlagCheckered size={18} weight="fill" className="mt-0.5 shrink-0 text-emerald-400" />
                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] font-semibold tracking-wide text-emerald-400 uppercase">
                      Final answer
                    </p>
                    <p className="text-sm text-emerald-100">{snapshot.final_answer}</p>
                  </div>
                </div>
              )}
            </>
          ) : (
            <section className="mt-4">
              <TraceWaterfall events={snapshot.history} />
            </section>
          )}
        </>
      ) : (
        <ErrorBanner message={error ?? 'Failed to load run.'} onRetry={refresh} />
      )}
    </div>
  )
}
