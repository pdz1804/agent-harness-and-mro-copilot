import type { Me, Memory } from './api-types'

export const MEMORY_SORT_COLUMNS = ['fact', 'used', 'saved'] as const

export function memorySortKey(memory: Memory, column: string): string | number | null {
  switch (column) {
    case 'fact':
      return memory.fact
    case 'used':
      return memory.use_count
    case 'saved':
      return memory.created_at
    default:
      return null
  }
}

/** Why `me` cannot edit or delete `memory`, or null when they can. Mirrors the
 * server (`_get_manageable_or_404`): the owner and admins may manage a memory,
 * any role (viewers included) may manage their own. */
export function memoryBlockedReason(me: Me | null, memory: Pick<Memory, 'owner_id' | 'owner_name'>): string | null {
  if (!me || me.role === 'admin' || memory.owner_id === me.id) return null
  return `This memory belongs to ${memory.owner_name}. Only its owner or an admin can change it.`
}

/** "not recalled yet" / "used 3 times". */
export function memoryUsage(memory: Pick<Memory, 'use_count'>): string {
  if (memory.use_count === 0) return 'Not recalled yet'
  return `Used ${memory.use_count} ${memory.use_count === 1 ? 'time' : 'times'}`
}
