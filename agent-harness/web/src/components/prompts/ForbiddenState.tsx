import { Lock } from '@phosphor-icons/react'
import { disabledReason, useMe } from '../../hooks/useMe'
import type { Action } from '../../lib/api-types'
import { EmptyState, LinkButton } from '../ui'

/** Shown where the API answered 403: names what is off limits and the way back. */
export function ForbiddenState({ what, backTo, backLabel, action }: { what: string; backTo: string; backLabel: string; action?: Action }) {
  const { me } = useMe()
  return (
    <EmptyState
      icon={<Lock size={22} weight="duotone" />}
      title={`You don't have access to ${what}`}
      description={action ? disabledReason(me, action) : `Your role (${me?.role ?? 'viewer'}) can't open this. Ask an admin for access, or switch identity from the sidebar.`}
      action={
        <LinkButton to={backTo} variant="secondary">
          {backLabel}
        </LinkButton>
      }
    />
  )
}
