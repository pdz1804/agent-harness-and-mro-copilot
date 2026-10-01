import { ArrowDown, ArrowLeft, ChatCircleDots, FlagCheckered, HandPalm, Package, SlidersHorizontal, WarningCircle, WaveSine } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChatTurn } from '../components/chat/ChatTurn'
import { Composer } from '../components/chat/Composer'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { InspectorPanel } from '../components/inspector/InspectorPanel'
import { StatusBadge } from '../components/StatusBadge'
import { TimelineSkeleton } from '../components/Skeleton'
import { TraceWaterfall } from '../components/TraceWaterfall'
import { WorkspacePanel } from '../components/workspace/WorkspacePanel'
import { useSessionArtifacts } from '../hooks/useSessionArtifacts'
import { stalledFor, type ArtifactRef } from '../lib/tool-call-view'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { useRunStream } from '../hooks/useRunStream'
import { useSessionThread } from '../hooks/useSessionThread'
import { useStickToBottom } from '../hooks/useStickToBottom'
import { api, ApiError } from '../lib/api'
import { TERMINAL_STATUSES, type Agent, type RunTokenTotals } from '../lib/api-types'
import { shouldShowJumpPill } from '../lib/scroll-follow'

function formatStartedAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString()
}

/** Compact start time for the header line (today: time only; otherwise date + time). */
function formatStartedTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

/** Per-run token usage badge — real Postgres aggregation via the already-
 * tested `GET /runs/{id}/tokens` (11d), not a client-side sum over the
 * event stream. Polls while the run is live (LLM calls keep adding to the
 * total) and fetches once more for a terminal run. */
function useRunTokens(runId: string | undefined, live: boolean, status: string | undefined): RunTokenTotals | null {
  const [tokens, setTokens] = useState<RunTokenTotals | null>(null)

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    const load = () => {
      api
        .getRunTokens(runId)
        .then((data) => {
          if (!cancelled) setTokens(data)
        })
        .catch(() => {
          /* token badge is best-effort */
        })
    }
    load()
    if (!live) return
    const interval = setInterval(load, 3_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [runId, live, status])

  return tokens
}

/** A chat session as one continuous thread: every earlier turn above, the
 * live/current turn below it, a composer docked at the bottom. While tokens
 * stream the view follows the bottom only if the reader is at the bottom
 * (a "Jump to latest" pill appears otherwise), and an approval request is
 * rendered inline at the point the run paused — sticky above the composer
 * and scrolled into view. */
export function RunPage({ runIdOverride }: { runIdOverride?: string } = {}) {
  const params = useParams<{ runId: string; sessionId: string }>()
  const runId = runIdOverride ?? params.runId
  const navigate = useNavigate()
  const { snapshot, loading, error, notFound, live, refresh, streamingFinalAnswer, streamingToolArgs } =
    useRunStream(runId)
  const { turns: otherTurns } = useSessionThread(snapshot?.session_id, runId)
  const [view, setView] = useState<'chat' | 'trace'>('chat')
  const tokens = useRunTokens(runId, live, snapshot?.status)
  const [inspectorOpen, setInspectorOpen] = useLocalStorageState('inspector.open', false)
  const [focusedToolCallKey, setFocusedToolCallKey] = useState<string | null>(null)
  const [workspaceOpen, setWorkspaceOpen] = useLocalStorageState('workspace.open', false)
  const [artifactFocus, setArtifactFocus] = useState<ArtifactRef | null>(null)
  // The inspector and the workspace share the right edge: opening one closes the other.
  const showInspector = (open: boolean) => {
    setInspectorOpen(open)
    if (open) setWorkspaceOpen(false)
  }
  const showWorkspace = (open: boolean) => {
    setWorkspaceOpen(open)
    if (open) setInspectorOpen(false)
  }
  const sidePanelOpen = workspaceOpen || inspectorOpen
  const openArtifact = (artifact: ArtifactRef) => {
    setArtifactFocus(artifact)
    showWorkspace(true)
  }

  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [followUpAgentId, setFollowUpAgentId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const { scrollRef, contentRef, following, onScroll, jumpToLatest, scrollToElement } = useStickToBottom(runId)
  const approvalRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    api
      .listAgents()
      .then((list) => {
        setAgents(list)
        setFollowUpAgentId(snapshot?.agent_id ?? list.find((a) => a.is_default)?.id ?? list[0]?.id ?? '')
      })
      .catch(() => setAgents([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.session_id])

  // Bring the approval card into view exactly when a new approval request
  // arrives (keyed by how many requests the run has made), not on every render.
  const approvalKey = snapshot?.pending_approval
    ? `${snapshot.run_id}:${snapshot.history.filter((e) => e.event_type === 'approval_requested').length}`
    : null
  useEffect(() => {
    if (!approvalKey) return
    const frame = requestAnimationFrame(() => scrollToElement(approvalRef.current))
    return () => cancelAnimationFrame(frame)
  }, [approvalKey, scrollToElement])

  // The "needs your approval" chip only points at the approval card while the
  // card is scrolled out of view; it never sits over the Approve/Deny buttons.
  const [approvalInView, setApprovalInView] = useState(false)
  useEffect(() => {
    setApprovalInView(false)
    const target = approvalRef.current
    const root = scrollRef.current
    if (!approvalKey || !target || !root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setApprovalInView(entry.isIntersecting), { root, threshold: 0.15 })
    observer.observe(target)
    return () => observer.disconnect()
  }, [approvalKey, scrollRef, view])

  // A bare run permalink (`/runs/:id`) is canonicalized to its session URL
  // once the run's session is known.
  const canonicalSessionId = snapshot?.session_id
  useEffect(() => {
    if (!runIdOverride && !params.sessionId && canonicalSessionId && runId) {
      navigate(`/sessions/${canonicalSessionId}/runs/${runId}`, { replace: true })
    }
  }, [runIdOverride, params.sessionId, canonicalSessionId, runId, navigate])

  const turnsBefore = useMemo(
    () => (snapshot ? otherTurns.filter((t) => t.started_at < snapshot.started_at) : []),
    [otherTurns, snapshot],
  )
  const turnsAfter = useMemo(
    () => (snapshot ? otherTurns.filter((t) => t.started_at > snapshot.started_at) : []),
    [otherTurns, snapshot],
  )

  const allTurns = useMemo(
    () => (snapshot ? [...turnsBefore, snapshot, ...turnsAfter] : []),
    [turnsBefore, snapshot, turnsAfter],
  )
  const artifacts = useSessionArtifacts(workspaceOpen ? allTurns : [])

  // Never an endless spinner: a live run that has emitted nothing for 60s gets
  // a calm "no activity" notice with Stop / Refresh.
  const lastActivityAt = snapshot ? (snapshot.history[snapshot.history.length - 1]?.timestamp ?? snapshot.started_at) : null
  const [nowMs, setNowMs] = useState(() => Date.now())
  const watchStall = snapshot?.status === 'running'
  useEffect(() => {
    if (!watchStall) return
    setNowMs(Date.now())
    const t = setInterval(() => setNowMs(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [watchStall])
  const stalledSeconds = snapshot ? stalledFor(lastActivityAt, nowMs, snapshot.status) : null

  if (notFound) {
    return (
      <EmptyState
        icon={<FlagCheckered size={32} weight="duotone" />}
        title="Run not found"
        description={`No run with id "${runId}" exists. It may have been from a previous session.`}
        action={
          <Link to="/sessions" className="text-sm font-medium text-sky-700 hover:text-sky-800">
            View sessions
          </Link>
        }
      />
    )
  }

  const isRunning = snapshot ? !TERMINAL_STATUSES.has(snapshot.status) : false
  const lastTurnIsCurrent = turnsAfter.length === 0

  const startFollowUp = async (objective: string) => {
    if (!snapshot?.session_id) return
    setSubmitting(true)
    setActionError(null)
    try {
      const { run_id } = await api.startRun({
        objective,
        session_id: snapshot.session_id,
        agent_id: followUpAgentId || undefined,
      })
      navigate(`/sessions/${snapshot.session_id}/runs/${run_id}`)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to continue the conversation.')
    } finally {
      setSubmitting(false)
    }
  }

  const stop = async () => {
    if (!snapshot) return
    setStopping(true)
    setActionError(null)
    try {
      await api.cancelRun(snapshot.run_id)
      refresh()
    } catch (err) {
      // 409: it just finished on its own - nothing to stop any more.
      if (!(err instanceof ApiError && err.status === 409)) {
        setActionError(err instanceof ApiError ? err.message : 'Failed to stop the run.')
      }
      refresh()
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100%+3rem)] md:-mx-8 md:-my-8 md:h-[calc(100%+4rem)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--color-line)] px-4 py-2.5 md:px-8">
          <div className="mx-auto flex max-w-[47.5rem] items-center justify-between gap-3">
            <div className="min-w-0">
              <Link
                to="/sessions"
                className="inline-flex items-center gap-1 rounded text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900"
              >
                <ArrowLeft size={12} weight="bold" />
                All sessions
              </Link>
              {snapshot && (
                <p
                  data-testid="run-meta"
                  className="font-data mt-1 hidden min-w-0 items-center gap-x-2 overflow-hidden text-[11.5px] whitespace-nowrap text-zinc-500 sm:flex"
                >
                  <span className="text-zinc-700">{snapshot.run_id}</span>
                  <span className={sidePanelOpen ? 'hidden 2xl:contents' : 'contents'}>
                    <span aria-hidden="true" className="text-zinc-300">·</span>
                    <span title={formatStartedAt(snapshot.started_at)}>{formatStartedTime(snapshot.started_at)}</span>
                  </span>
                  {live && (
                    <>
                      <span aria-hidden="true" className="text-zinc-300">·</span>
                      <span className="inline-flex items-center gap-1 font-sans text-emerald-600">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
                        live
                      </span>
                    </>
                  )}
                  {tokens && tokens.llm_calls > 0 && (
                    <>
                      <span aria-hidden="true" className="text-zinc-300">·</span>
                      <span
                        className="tabular-nums"
                        title={`${tokens.llm_calls} LLM call${tokens.llm_calls === 1 ? '' : 's'} · prompt ${tokens.prompt_tokens} + completion ${tokens.completion_tokens}`}
                      >
                        {tokens.total_tokens.toLocaleString()} tokens
                      </span>
                    </>
                  )}
                  {snapshot.prompt_version_id && (
                    <span className={sidePanelOpen ? 'hidden 2xl:contents' : 'hidden xl:contents'}>
                      <span aria-hidden="true" className="text-zinc-300">·</span>
                      <span className="min-w-0 truncate" title="Prompt version used to build this run's agent">
                        {snapshot.prompt_version_id}
                      </span>
                    </span>
                  )}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {snapshot && <StatusBadge status={snapshot.status} />}
              {snapshot && (
                <div className="ui-segmented text-xs" role="tablist" aria-label="Run view">
                  <span
                    aria-hidden="true"
                    className={`absolute top-[2px] bottom-[2px] left-[2px] w-[calc(50%-2px)] rounded-md bg-white shadow-[var(--shadow-sm)] ring-1 ring-[var(--color-line)] transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${view === 'trace' ? 'translate-x-full' : ''}`}
                  />
                  {(
                    [
                      ['chat', 'Chat', <ChatCircleDots key="c" size={14} weight="bold" />],
                      ['trace', 'Trace', <WaveSine key="t" size={14} weight="bold" />],
                    ] as const
                  ).map(([value, label, icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={view === value}
                      onClick={() => setView(value)}
                      className={`relative z-10 inline-flex h-7 w-9 items-center sm:w-[4.75rem] justify-center gap-1.5 rounded-md font-medium transition-colors duration-150 ${
                        view === value ? 'text-zinc-950' : 'text-zinc-500 hover:text-zinc-800'
                      }`}
                    >
                      {icon}
                      <span className="sr-only sm:not-sr-only">{label}</span>
                    </button>
                  ))}
                </div>
              )}
              {snapshot && (
                <button
                  type="button"
                  onClick={() => showWorkspace(!workspaceOpen)}
                  aria-pressed={workspaceOpen}
                  title="Things this session produced"
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors duration-150 ${
                    workspaceOpen ? 'bg-sky-50 text-sky-700 ring-1 ring-sky-200 ring-inset' : 'text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-900'
                  }`}
                >
                  <Package size={14} weight="bold" />
                  <span className={sidePanelOpen ? 'sr-only' : 'hidden sm:inline'}>Workspace</span>
                  {!sidePanelOpen && <span className="sr-only sm:hidden">Workspace</span>}
                </button>
              )}
              {snapshot && (
                <button
                  type="button"
                  onClick={() => showInspector(!inspectorOpen)}
                  aria-pressed={inspectorOpen}
                  title="Toggle run inspector (Ctrl+.)"
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors duration-150 ${
                    inspectorOpen ? 'bg-sky-50 text-sky-700 ring-1 ring-sky-200 ring-inset' : 'text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-900'
                  }`}
                >
                  <SlidersHorizontal size={14} weight="bold" />
                  <span className={sidePanelOpen ? 'sr-only' : 'hidden sm:inline'}>Inspector</span>
                </button>
              )}
            </div>
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            data-testid="chat-scroll"
            className="h-full overflow-y-auto overscroll-contain px-4 py-6 md:px-8"
            style={{ overflowAnchor: following ? 'none' : 'auto' }}
          >
            <div ref={contentRef} className="mx-auto max-w-[47.5rem] space-y-10 pb-6">
              {error && <ErrorBanner message={error} />}
              {loading && !snapshot && (
                <div className="space-y-4">
                  <div className="ui-skeleton ml-auto h-10 w-2/3 rounded-2xl" />
                  <TimelineSkeleton />
                </div>
              )}

              {snapshot && view === 'chat' && (
                <>
                  {turnsBefore.map((turn) => (
                    <ChatTurn
                      key={turn.run_id}
                      snapshot={turn}
                      live={false}
                      onOpenArtifact={openArtifact}
                      onFocusToolCall={() => navigate(turn.session_id ? `/sessions/${turn.session_id}/runs/${turn.run_id}` : `/runs/${turn.run_id}`)}
                    />
                  ))}

                  <ChatTurn
                    key={snapshot.run_id}
                    snapshot={snapshot}
                    live={live}
                    streamingFinalAnswer={streamingFinalAnswer}
                    streamingToolArgs={streamingToolArgs}
                    onFocusToolCall={(key) => {
                      setFocusedToolCallKey(key)
                      showInspector(true)
                    }}
                    onRegenerate={
                      !isRunning && lastTurnIsCurrent && snapshot.session_id
                        ? () => void startFollowUp(snapshot.objective)
                        : undefined
                    }
                    approval={
                      snapshot.status === 'pending_approval' && snapshot.pending_approval
                        ? {
                            pending: snapshot.pending_approval,
                            onDecide: async (approved) => {
                              await api.approveRun(snapshot.run_id, approved)
                              refresh()
                            },
                          }
                        : undefined
                    }
                    approvalAnchorRef={approvalRef}
                    onOpenArtifact={openArtifact}
                  />

                  {turnsAfter.map((turn) => (
                    <ChatTurn
                      key={turn.run_id}
                      snapshot={turn}
                      live={false}
                      onOpenArtifact={openArtifact}
                      onFocusToolCall={() => navigate(turn.session_id ? `/sessions/${turn.session_id}/runs/${turn.run_id}` : `/runs/${turn.run_id}`)}
                    />
                  ))}

                </>
              )}

              {snapshot && view === 'trace' && (
                <section>
                  <TraceWaterfall events={snapshot.history} />
                </section>
              )}
            </div>
          </div>

          {shouldShowJumpPill(following, live) && snapshot?.status !== 'pending_approval' && (
            <button
              type="button"
              onClick={jumpToLatest}
              data-testid="jump-to-latest"
              aria-label="Jump to the latest message"
              className="absolute bottom-4 left-1/2 z-30 inline-flex h-9 -translate-x-1/2 animate-rise items-center gap-1.5 rounded-full bg-white px-3.5 text-xs font-semibold text-zinc-800 shadow-[var(--shadow-lg)] ring-1 ring-[var(--color-line-strong)] transition-colors hover:bg-zinc-50"
            >
              <ArrowDown size={14} weight="bold" />
              Jump to latest
            </button>
          )}
        </div>

        {snapshot && view === 'chat' && snapshot.session_id && (
          <div className="relative shrink-0 px-3 pt-1 pb-3 md:px-8 md:pb-4">
            {snapshot.status !== 'pending_approval' && (
              <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-[var(--color-sheet)] to-transparent" />
            )}
            <div className="mx-auto max-w-[47.5rem]">
              {actionError && (
                <div className="mb-2">
                  <ErrorBanner message={actionError} />
                </div>
              )}
              {snapshot.status === 'pending_approval' && snapshot.pending_approval && !approvalInView && (
                <div className="mb-2 flex justify-center">
                  <button
                    type="button"
                    onClick={() => scrollToElement(approvalRef.current)}
                    data-testid="approval-chip"
                    className="inline-flex h-8 animate-rise items-center gap-2 rounded-full bg-amber-50 pr-3 pl-2.5 text-xs font-medium text-amber-900 ring-1 ring-amber-300/80 ring-inset transition-colors hover:bg-amber-100"
                  >
                    <HandPalm size={14} weight="bold" aria-hidden="true" />1 action needs your approval
                    <ArrowDown size={12} weight="bold" aria-hidden="true" className="rotate-180" />
                  </button>
                </div>
              )}
              {stalledSeconds !== null && (
                <div
                  role="status"
                  className="mb-2 flex animate-rise flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white px-3.5 py-2.5 text-[13px] text-zinc-700 shadow-[var(--shadow-sm)] ring-1 ring-[var(--color-line-strong)]"
                >
                  <WarningCircle size={16} weight="fill" className="shrink-0 text-amber-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    No activity for {stalledSeconds}s. The run may be stuck.
                  </span>
                  <span className="flex gap-1.5">
                    <button type="button" onClick={refresh} className="ui-btn ui-btn-secondary ui-btn-sm">
                      Refresh
                    </button>
                    <button type="button" onClick={() => void stop()} disabled={stopping} className="ui-btn ui-btn-danger ui-btn-sm">
                      {stopping ? 'Stopping…' : 'Stop'}
                    </button>
                  </span>
                </div>
              )}
              <Composer
                agents={agents}
                agentId={followUpAgentId}
                onAgentChange={setFollowUpAgentId}
                submitting={submitting}
                running={isRunning}
                onStop={() => void stop()}
                stopping={stopping}
                placeholder="Continue this conversation… (type / for skill commands)…"
                onSubmit={(text) => void startFollowUp(text)}
              />
            </div>
          </div>
        )}
      </div>

      {snapshot && (
        <WorkspacePanel artifacts={artifacts} open={workspaceOpen} onOpenChange={showWorkspace} focus={artifactFocus} />
      )}
      {snapshot && (
        <InspectorPanel
          snapshot={snapshot}
          open={inspectorOpen}
          onOpenChange={showInspector}
          focusedToolCallKey={focusedToolCallKey}
        />
      )}
    </div>
  )
}
