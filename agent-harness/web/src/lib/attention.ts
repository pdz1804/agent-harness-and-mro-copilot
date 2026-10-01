/** The New run greeting: what currently needs attention, built from the live
 * services and open incidents (never invented). */

import type { Incident, Service } from './api-types'

export interface AttentionChip {
  key: string
  label: string
  tone: 'warn' | 'danger' | 'neutral' | 'ok'
  to: string
}

/** Down services first, then degraded, then the open-incident count. When
 * nothing is wrong a single "All services operational" chip is returned. */
export function attentionChips(services: Pick<Service, 'name' | 'status'>[], openIncidents: Pick<Incident, 'id'>[]): AttentionChip[] {
  const rank = { down: 0, degraded: 1, operational: 2 } as const
  const unhealthy = services.filter((s) => s.status !== 'operational').sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name))
  const chips: AttentionChip[] = unhealthy.map((s) => ({
    key: `svc-${s.name}`,
    label: `${s.name} ${s.status}`,
    tone: s.status === 'down' ? 'danger' : 'warn',
    to: `/services?open=${encodeURIComponent(s.name)}`,
  }))
  if (openIncidents.length > 0) {
    const n = openIncidents.length
    chips.push({ key: 'incidents', label: `${n} open incident${n === 1 ? '' : 's'}`, tone: 'neutral', to: '/incidents?status=open' })
  }
  if (chips.length === 0 && services.length > 0) chips.push({ key: 'ok', label: 'All services operational', tone: 'ok', to: '/services' })
  return chips
}

/** First name for the greeting ("Alice Admin" → "Alice"); empty when unknown. */
export function firstName(displayName: string | null | undefined): string {
  return (displayName ?? '').trim().split(/\s+/)[0] ?? ''
}
