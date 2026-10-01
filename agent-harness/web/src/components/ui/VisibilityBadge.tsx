import { Lock, ShareNetwork } from '@phosphor-icons/react'

/** Small lock/share icon for a resource's `visibility` (private vs shared) —
 * shared by the Prompt Library, Skills, and (from phase 04/06) Agents and
 * Dashboards pages, all of which follow the same ownership+visibility RBAC
 * shape (`agent_harness.rbac.Resource`). */
export function VisibilityBadge({
  visibility,
  className = '',
}: {
  visibility: 'private' | 'shared'
  className?: string
}) {
  return visibility === 'private' ? (
    <Lock size={12} className={`shrink-0 text-zinc-500 ${className}`} aria-label="Private" />
  ) : (
    <ShareNetwork size={12} className={`shrink-0 text-zinc-500 ${className}`} aria-label="Shared" />
  )
}
