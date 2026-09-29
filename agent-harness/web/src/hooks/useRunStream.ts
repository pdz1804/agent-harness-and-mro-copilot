import { useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../lib/api'
import { TERMINAL_STATUSES, type AgentEvent, type EventType, type RunSnapshot } from '../lib/api-types'

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
  'final_answer',
  'step_limit_exceeded',
  'time_limit_exceeded',
]

function eventKey(event: AgentEvent): string {
  return `${event.step}:${event.event_type}:${event.timestamp}`
}

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
  const seenKeys = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    let source: EventSource | null = null
    setLoading(true)
    setError(null)
    setNotFound(false)
    setLive(false)
    seenKeys.current = new Set()

    const refetchSnapshot = async () => {
      try {
        const next = await api.getRun(runId)
        if (cancelled) return
        seenKeys.current = new Set(next.history.map(eventKey))
        setSnapshot(next)
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
        setSnapshot((prev) => (prev ? { ...prev, history: [...prev.history, event] } : prev))
      }

      for (const type of ALL_EVENT_TYPES) {
        source.addEventListener(type, appendEvent as EventListener)
      }

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

    return () => {
      cancelled = true
      source?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, refreshToken])

  // Stop treating the connection as "live" once a terminal status is
  // reached, even if stream_end hasn't round-tripped yet.
  const effectiveLive = live && !(snapshot && TERMINAL_STATUSES.has(snapshot.status))

  return {
    snapshot,
    loading,
    error,
    notFound,
    live: effectiveLive,
    refresh: () => setRefreshToken((n) => n + 1),
  }
}
