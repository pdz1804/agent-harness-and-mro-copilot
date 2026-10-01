import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { Dashboard, Incident, RunSnapshot, UsedMemory } from '../lib/api-types'
import { artifactOf } from '../lib/tool-call-view'
import { buildToolCalls } from '../lib/trace-model'

export interface SessionArtifacts {
  dashboards: Dashboard[]
  incidents: Incident[]
  memories: UsedMemory[]
  /** Distinct prompt versions the session's turns were built with. */
  promptVersions: string[]
  loading: boolean
  error: string | null
}

/** Everything a session produced, assembled from EXISTING real endpoints —
 * there is no `GET /sessions/{id}/artifacts` yet:
 * - dashboards: `GET /dashboards` filtered by `created_by_run_id` ∈ session
 *   runs, plus any dashboard a turn's `add_widget`/`create_dashboard` result
 *   names; each loaded with its widgets via `GET /dashboards/{id}`
 * - incidents: `GET /incidents` filtered by `run_id` ∈ session runs, plus any
 *   `create_incident` result id
 * - memories: `GET /runs/{id}/memories` (`saved`) per turn
 * - prompt versions: each turn's `prompt_version_id`
 * Re-fetched when a turn is added or a turn's status changes. */
export function useSessionArtifacts(turns: RunSnapshot[]): SessionArtifacts & { reloadDashboard: (d: Dashboard) => void } {
  const runIds = useMemo(() => turns.map((t) => t.run_id), [turns])
  const statusKey = turns.map((t) => `${t.run_id}:${t.status}`).join('|')
  const refs = useMemo(
    () =>
      turns.flatMap((t) =>
        buildToolCalls(t.history)
          .map(artifactOf)
          .filter((a): a is NonNullable<typeof a> => a !== null),
      ),
    // statusKey captures every change that can add an artifact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusKey],
  )
  const [state, setState] = useState<SessionArtifacts>({
    dashboards: [],
    incidents: [],
    memories: [],
    promptVersions: [],
    loading: true,
    error: null,
  })

  useEffect(() => {
    if (runIds.length === 0) return
    let cancelled = false
    const runSet = new Set(runIds)
    const refDashboards = refs.filter((r) => r.kind === 'dashboard').map((r) => r.id)
    const refIncidents = new Set(refs.filter((r) => r.kind === 'incident').map((r) => r.id))

    const load = async () => {
      try {
        const [dashList, incidentList, memoryLists] = await Promise.all([
          api.listDashboards().catch(() => [] as Dashboard[]),
          api.listIncidents().catch(() => [] as Incident[]),
          Promise.all(runIds.map((id) => api.getRunMemories(id).catch(() => ({ used: [], saved: [] })))),
        ])
        const dashIds = [
          ...new Set([...dashList.filter((d) => d.created_by_run_id && runSet.has(d.created_by_run_id)).map((d) => d.id), ...refDashboards]),
        ]
        const dashboards = (await Promise.all(dashIds.map((id) => api.getDashboard(id).catch(() => null)))).filter(
          (d): d is Dashboard => d !== null,
        )
        const incidents = incidentList.filter((i) => (i.run_id && runSet.has(i.run_id)) || refIncidents.has(i.id))
        const seen = new Set<string>()
        const memories = memoryLists
          .flatMap((m) => m.saved)
          .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
        const promptVersions = [...new Set(turns.map((t) => t.prompt_version_id).filter((v): v is string => !!v))]
        if (!cancelled) setState({ dashboards, incidents, memories, promptVersions, loading: false, error: null })
      } catch (err) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : 'Could not load artifacts' }))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runIds.join(','), statusKey, refs])

  const reloadDashboard = useCallback((updated: Dashboard) => {
    setState((s) => ({ ...s, dashboards: s.dashboards.map((d) => (d.id === updated.id ? updated : d)) }))
  }, [])

  return { ...state, reloadDashboard }
}
