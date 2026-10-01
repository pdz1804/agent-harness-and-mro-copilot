import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { IDENTITY_CHANGE_EVENT } from '../lib/identity'
import type { Action, Me } from '../lib/api-types'

/** Shared "who am I / what can I do" hook for RBAC-aware UI (phase 08
 * follow-up on phase 01's coordinator note: "disable/hide mutating
 * controls per role" instead of enabling them and only rejecting
 * afterwards). Refetches whenever the identity switcher fires
 * `IDENTITY_CHANGE_EVENT`, so every mounted page picks up a role change
 * without a reload. Server-side RBAC (`agent_harness.rbac`) stays the real
 * guard — this is purely so viewers/editors don't hit an avoidable 403. */
export function useMe(): { me: Me | null; loading: boolean } {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      setLoading(true)
      api
        .me()
        .then((result) => {
          if (!cancelled) setMe(result)
        })
        .catch(() => {
          /* best-effort: if /me fails, controls fall back to enabled and
           * the server-side 403 is still the real guard. */
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    load()
    window.addEventListener(IDENTITY_CHANGE_EVENT, load)
    return () => {
      cancelled = true
      window.removeEventListener(IDENTITY_CHANGE_EVENT, load)
    }
  }, [])

  return { me, loading }
}

/** `true` once `/me` has resolved and the role lacks `action`. While
 * loading (or if `/me` failed), returns `false` so controls default to
 * enabled rather than flash disabled/enabled. */
export function useLacksPermission(action: Action): boolean {
  const { me, loading } = useMe()
  if (loading || !me) return false
  return !me.permissions.includes(action)
}

/** Human copy for a disabled-control tooltip, reused everywhere a
 * mutating control is hidden/disabled by role. */
export function disabledReason(me: Me | null, action: Action): string {
  const what: Record<Action, string> = {
    chat: 'chat',
    mutate_integrations: 'edit integrations',
    mutate_guardrails: 'edit guardrails',
    mutate_prompts: 'edit prompts',
    mutate_skills: 'edit skills',
    mutate_agents: 'edit agents',
    mutate_automations: 'edit automations',
    mutate_artifacts: 'edit dashboards',
    mutate_services: 'edit services',
    mutate_kb: 'add or delete knowledge-base documents',
    mutate_incidents: 'acknowledge or resolve incidents',
    run_evals: 'start a scoring run',
  }
  const role = me?.role ?? 'viewer'
  return `Your role (${role}) can't ${what[action]}.`
}

/** Mirrors `agent_harness.rbac.can_write`: an owned/private resource can
 * only be written by its owner or an admin; a viewer can never write. */
export function canWriteResource(
  me: Me | null,
  resource: { owner_id: string | null } | null | undefined,
): boolean {
  if (!me) return true // unknown yet — don't flash a false-disabled state
  if (me.role === 'admin') return true
  if (me.role === 'viewer') return false
  if (!resource) return true
  return resource.owner_id === me.id
}
