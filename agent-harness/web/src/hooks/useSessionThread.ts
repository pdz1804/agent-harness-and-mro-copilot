import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { RunSnapshot, RunSummary } from '../lib/api-types'

/** The other turns of a chat session, oldest first, as full snapshots (final
 * answer, tool calls, activity) so the page can render a continuous thread
 * instead of one run per page. The run currently streaming is NOT included:
 * `useRunStream` owns it. Past turns are terminal, so each is fetched once and
 * cached by run id; the list is re-resolved whenever the session or the
 * current run changes (a follow-up turns the previous current run into a past
 * one). Previously loaded turns stay on screen while the refresh is in flight,
 * so a follow-up never flashes an empty thread. */
export function useSessionThread(
  sessionId: string | null | undefined,
  currentRunId: string | undefined,
): { turns: RunSnapshot[]; summaries: RunSummary[] } {
  const cache = useRef<Map<string, RunSnapshot>>(new Map())
  const [turns, setTurns] = useState<RunSnapshot[]>([])
  const [summaries, setSummaries] = useState<RunSummary[]>([])

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    api
      .getSession(sessionId)
      .then(async (session) => {
        const ordered = [...session.runs].sort((a, b) => a.started_at - b.started_at)
        const others = ordered.filter((r) => r.run_id !== currentRunId)
        const snapshots = await Promise.all(
          others.map(async (run) => {
            const hit = cache.current.get(run.run_id)
            if (hit) return hit
            try {
              const snapshot = await api.getRun(run.run_id)
              // Only terminal snapshots are immutable and safe to cache.
              if (snapshot.status !== 'running' && snapshot.status !== 'pending_approval') {
                cache.current.set(run.run_id, snapshot)
              }
              return snapshot
            } catch {
              return null
            }
          }),
        )
        if (cancelled) return
        setSummaries(ordered)
        setTurns(snapshots.filter((s): s is RunSnapshot => s !== null))
      })
      .catch(() => {
        /* the thread is an enhancement: the current turn still renders on its own */
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, currentRunId])

  return { turns: sessionId ? turns : [], summaries: sessionId ? summaries : [] }
}
