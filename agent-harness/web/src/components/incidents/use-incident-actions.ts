import { useCallback, useState } from 'react'
import { useMe } from '../../hooks/useMe'
import { api, errorText } from '../../lib/api'
import type { Incident } from '../../lib/api-types'
import { UNDO_WINDOW_MS, deferAction } from '../../lib/deferred-action'
import { acknowledgePatch, withPatch } from '../../lib/incident-lifecycle'
import { useToast } from '../ui'

/** Optimistic overlays keyed by incident id. The overlay survives list
 * reloads, so a reload during the Undo window cannot flip a row back to open
 * while the acknowledge is still waiting to be sent. */
export function useIncidentOverrides() {
  const [overrides, setOverrides] = useState<Record<string, Partial<Incident>>>({})
  const setOverride = useCallback((id: string, patch: Partial<Incident>) => setOverrides((o) => ({ ...o, [id]: patch })), [])
  const clearOverride = useCallback(
    (id: string) =>
      setOverrides((o) => {
        if (!(id in o)) return o
        const next = { ...o }
        delete next[id]
        return next
      }),
    [],
  )
  const merge = useCallback(<T extends Incident>(incident: T): T => withPatch(incident, overrides[incident.id]), [overrides])
  return { overrides, setOverride, clearOverride, merge }
}

interface ActionDeps {
  setOverride: (id: string, patch: Partial<Incident>) => void
  clearOverride: (id: string) => void
  /** Refetch whatever the caller shows (list or detail). */
  reload: () => Promise<unknown> | void
}

/** Acknowledge and resolve with the right Undo for each.
 *
 * Acknowledge has no reverse transition in the API (there is no
 * acknowledged -> open), so the UI changes at once and the request is held for
 * the Undo window via `deferAction`; Undo cancels it before it is sent.
 * Resolve is a real call; its Undo is `reopenIncident` (resolved -> acknowledged). */
export function useIncidentActions({ setOverride, clearOverride, reload }: ActionDeps) {
  const toast = useToast()
  const { me } = useMe()

  /** Acknowledge one or many open incidents with a single toast and Undo. */
  const acknowledge = useCallback(
    (incidents: Incident[]) => {
      const targets = incidents.filter((i) => i.status === 'open')
      if (targets.length === 0) return
      const held: { id: string; cancel: () => boolean }[] = []
      for (const incident of targets) {
        const id = incident.id
        setOverride(id, acknowledgePatch(new Date(), me?.id ?? null))
        const cancel = deferAction(
          `incident-ack:${id}`,
          async () => {
            await api.acknowledgeIncident(id)
            // Hold the overlay until fresh data is in, so the row never flickers back to open.
            await reload()
            clearOverride(id)
          },
          UNDO_WINDOW_MS,
          (err) => {
            clearOverride(id)
            reload()
            toast({ tone: 'error', title: `Couldn't acknowledge ${id}`, description: errorText(err, 'Refresh and try again.') })
          },
        )
        held.push({ id, cancel })
      }
      toast({
        title: targets.length === 1 ? `Acknowledged ${targets[0].id}` : `Acknowledged ${targets.length} incidents`,
        description: 'Saved in a few seconds unless you undo.',
        duration: UNDO_WINDOW_MS - 500,
        action: {
          label: 'Undo',
          run: () => {
            let late = 0
            for (const { id, cancel } of held) {
              if (cancel()) clearOverride(id)
              else late += 1
            }
            if (late > 0) throw new Error(late === held.length ? 'It was already saved' : `${late} were already saved`)
          },
        },
      })
    },
    [setOverride, clearOverride, reload, me?.id, toast],
  )

  /** Resolve with an optional note. Resolves to `true` on success so the
   * caller can clear its form; failures toast and resolve to `false`. */
  const resolve = useCallback(
    async (incident: Incident, note: string): Promise<boolean> => {
      const id = incident.id
      try {
        await api.resolveIncident(id, note.trim())
      } catch (err) {
        toast({ tone: 'error', title: `Couldn't resolve ${id}`, description: errorText(err, 'Refresh and try again.') })
        return false
      }
      reload()
      toast({
        title: `Resolved ${id}`,
        action: {
          label: 'Undo',
          run: async () => {
            await api.reopenIncident(id)
            reload()
            toast({ title: `Reopened ${id}`, description: 'Back to acknowledged.' })
          },
        },
      })
      return true
    },
    [reload, toast],
  )

  /** Reopen a resolved incident (resolved -> acknowledged). Resolves to
   * `true` on success; failures toast and resolve to `false`. */
  const reopen = useCallback(
    async (incident: Incident): Promise<boolean> => {
      const id = incident.id
      try {
        await api.reopenIncident(id)
      } catch (err) {
        toast({ tone: 'error', title: `Couldn't reopen ${id}`, description: errorText(err, 'Refresh and try again.') })
        return false
      }
      reload()
      toast({ title: `Reopened ${id}`, description: 'Back to acknowledged.' })
      return true
    },
    [reload, toast],
  )

  return { acknowledge, resolve, reopen }
}
