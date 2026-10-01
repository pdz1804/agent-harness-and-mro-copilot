import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { PendingApprovalItem } from '../lib/api-types'
import { sameItems } from '../lib/pending-approvals'

const POLL_MS = 3_000

/** Runs currently paused on a human approval that the signed-in user may
 * resolve, polled live (`GET /approvals/pending`). Polling pauses while the tab
 * is hidden and refreshes the moment it becomes visible again; the state only
 * changes when the waiting set does, so the header does not re-render every
 * poll. A failed poll keeps the last known list. */
export function usePendingApprovals(): PendingApprovalItem[] {
  const [items, setItems] = useState<PendingApprovalItem[]>([])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      if (document.visibilityState === 'hidden') return
      api
        .listPendingApprovals()
        .then((next) => {
          if (!cancelled) setItems((prev) => (sameItems(prev, next) ? prev : next))
        })
        .catch(() => {
          /* the badge is best-effort; keep the last known list */
        })
    }
    load()
    const interval = setInterval(load, POLL_MS)
    document.addEventListener('visibilitychange', load)
    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', load)
    }
  }, [])

  return items
}
