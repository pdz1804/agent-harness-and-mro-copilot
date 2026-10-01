import { useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../lib/api'
import { TERMINAL_STATUSES, type AgentEvent, type EventType, type RunSnapshot } from '../lib/api-types'
import { SNAPSHOT_POLL_MS, eventKey, mergeSnapshot } from '../lib/run-snapshot-merge'

interface UseRunStreamResult {
  snapshot: RunSnapshot | null
  loading: boolean
  error: string | null
  notFound: boolean
  /** True once the live SSE connection is open (informational — a chat-style
   * "live" indicator). Snapshot data is usable before this is true too,
   * from the initial fetch. */
  live: boolean
  refresh: () => void
  /** Live-only token-by-token text accumulated from `llm_token_delta`
   * events (field="final_answer") for the CURRENT in-flight LLM turn —
   * sourced from the real OpenAI streaming API (or synthetic chunks from
   * the CI-only heuristic client). Cleared once the persisted
   * `final_answer` event lands (its text becomes the source of truth) or
   * a new turn starts. Renders the chat bubble typing out in real time. */
  streamingFinalAnswer: string
  /** Same idea for `field="tool_args"` deltas: the JSON arguments for the
   * next tool call, visibly assembling character-by-character before the
   * call actually fires. */
  streamingToolArgs: string
}

const ALL_EVENT_TYPES: EventType[] = [
  'llm_decision',
  'llm_malformed_response',
  'llm_retry_exhausted',
  'tool_validation_error',
  'tool_call_started',
  'tool_call_result',
  'tool_call_error',
  'tool_call_timeout',
  'tool_call_retry',
  'tool_call_retries_exhausted',
  'approval_requested',
  'approval_granted',
  'approval_denied',
  'approval_timed_out',
  'final_answer',
  'step_limit_exceeded',
  'time_limit_exceeded',
  'run_cancelled',
  'context_compacted',
  'guardrail_blocked',
  'guardrail_severity_downgraded',
  'skill_invoked',
  'skills_assigned',
  'skill_routed',
  'skill_routing_failed',
  'no_tools_available',
]

/** Real-time run view: one `GET /runs/{id}` snapshot fetch first (so a
 * page refresh/deep-link isn't empty while the stream connects), then a
 * live `EventSource` against `/runs/{id}/events` appending new AgentEvents
 * as they arrive. `EventSource` auto-reconnects on transient network
 * drops; reconnects are deduped against already-rendered events by
 * step+event_type+timestamp so nothing renders twice. On `approval_requested`
 * and `stream_end` (run reached a terminal status, or approval state may
 * have changed) a fresh snapshot is re-fetched so `status`/`pending_approval`/
 * `final_answer` — fields the event stream itself doesn't carry — stay
 * authoritative, rather than being reconstructed client-side from event
 * data alone. */
export function useRunStream(runId: string | undefined): UseRunStreamResult {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [live, setLive] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [streamingFinalAnswer, setStreamingFinalAnswer] = useState('')
  const [streamingToolArgs, setStreamingToolArgs] = useState('')
  const seenKeys = useRef<Set<string>>(new Set())
  const terminalRef = useRef(false)
  const isTerminal = !!snapshot && TERMINAL_STATUSES.has(snapshot.status)
  useEffect(() => {
    terminalRef.current = isTerminal
    if (isTerminal) {
      // A finished run shows its real outcome, never a half-streamed fragment.
      setStreamingFinalAnswer('')
      setStreamingToolArgs('')
    }
  }, [isTerminal])

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    let source: EventSource | null = null
    setLoading(true)
    setError(null)
    setNotFound(false)
    setLive(false)
    setStreamingFinalAnswer('')
    setStreamingToolArgs('')
    seenKeys.current = new Set()
    terminalRef.current = false

    const refetchSnapshot = async () => {
      try {
        const next = await api.getRun(runId)
        if (cancelled) return
        for (const e of next.history) seenKeys.current.add(eventKey(e))
        setSnapshot((prev) => mergeSnapshot(prev, next))
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true)
          setLoading(false)
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load run.')
        setLoading(false)
      }
    }

    const start = async () => {
      await refetchSnapshot()
      if (cancelled || notFound) return

      source = new EventSource(api.eventsUrl(runId))
      source.onopen = () => {
        if (!cancelled) setLive(true)
      }
      source.onerror = () => {
        // EventSource auto-reconnects; just reflect "not currently live" —
        // no manual reconnect logic needed, and errors are transient by
        // nature of the browser's own retry.
        if (!cancelled) setLive(false)
      }

      const appendEvent = (raw: MessageEvent<string>) => {
        let event: AgentEvent
        try {
          event = JSON.parse(raw.data) as AgentEvent
        } catch {
          return
        }
        const key = eventKey(event)
        if (seenKeys.current.has(key)) return
        seenKeys.current.add(key)
        // A persisted event closes out the live-only delta overlay for
        // this turn: llm_decision/final_answer carry the full assembled
        // text already, so the streaming buffers are no longer needed.
        if (event.event_type === 'llm_decision' || event.event_type === 'final_answer') {
          setStreamingFinalAnswer('')
          setStreamingToolArgs('')
        }
        // The persisted event that ends a turn carries the whole answer: either
        // `final_answer`, or the `llm_decision` with action "final_answer" that
        // precedes it. Put the text on the snapshot in the same update that
        // clears the streaming buffer, so the answer never disappears in the gap
        // before the authoritative snapshot refetch lands (that flash shrank the
        // thread and yanked the scroll position).
        const endsTurn =
          event.event_type === 'final_answer' ||
          (event.event_type === 'llm_decision' && event.data.action === 'final_answer')
        const finalAnswer = endsTurn && typeof event.data.final_answer === 'string' ? event.data.final_answer : null
        setSnapshot((prev) =>
          prev
            ? {
                ...prev,
                history: [...prev.history, event],
                final_answer: finalAnswer ?? prev.final_answer,
              }
            : prev,
        )
      }

      for (const type of ALL_EVENT_TYPES) {
        source.addEventListener(type, appendEvent as EventListener)
      }

      // Live-only overlay: never appended to history (see run_registry.py
      // ::_on_event / trace_logger.py::emit_live). Real token-by-token text
      // as it streams from the provider.
      source.addEventListener('llm_token_delta', (raw: MessageEvent<string>) => {
        try {
          const event = JSON.parse(raw.data) as AgentEvent
          const field = event.data.field
          const delta = typeof event.data.delta === 'string' ? event.data.delta : ''
          if (field === 'final_answer') {
            setStreamingFinalAnswer((prev) => prev + delta)
          } else if (field === 'tool_args') {
            setStreamingToolArgs((prev) => prev + delta)
          }
        } catch {
          // ignore malformed payload
        }
      })

      source.addEventListener('run_snapshot', (raw: MessageEvent<string>) => {
        // Persisted-only run (not live in this process, e.g. after a
        // restart): the server sends the full history in one event instead
        // of a live trickle.
        try {
          const full = JSON.parse(raw.data) as RunSnapshot
          seenKeys.current = new Set(full.history.map(eventKey))
          if (!cancelled) setSnapshot(full)
        } catch {
          // ignore malformed payload
        }
      })

      source.addEventListener('approval_requested', () => {
        void refetchSnapshot()
      })

      source.addEventListener('stream_end', () => {
        source?.close()
        if (!cancelled) {
          setLive(false)
          void refetchSnapshot()
        }
      })
    }

    void start()

    // Safety net under the stream: while the run is in flight, re-read the
    // snapshot every few seconds so status, the pending approval and the
    // final outcome always converge, even if the EventSource never delivers.
    const poll = setInterval(() => {
      if (cancelled || terminalRef.current) return
      void refetchSnapshot()
    }, SNAPSHOT_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(poll)
      source?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, refreshToken])

  // Stop treating the connection as "live" once a terminal status is
  // reached, even if stream_end hasn't round-tripped yet.
  const effectiveLive = live && !isTerminal

  return {
    snapshot,
    loading,
    error,
    notFound,
    live: effectiveLive,
    refresh: () => setRefreshToken((n) => n + 1),
    streamingFinalAnswer,
    streamingToolArgs,
  }
}
