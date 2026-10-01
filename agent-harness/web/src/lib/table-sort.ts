/** Pure column-sort helpers shared by every sortable table. */

export type SortDir = 'asc' | 'desc'
export interface SortState {
  column: string
  dir: SortDir
}

/** Next sort for a header click: a new column starts ascending; the same
 * column flips direction. */
export function nextSort(current: SortState | null, column: string): SortState {
  if (current?.column !== column) return { column, dir: 'asc' }
  return { column, dir: current.dir === 'asc' ? 'desc' : 'asc' }
}

/** "title:asc" <-> SortState, so the sort can live in the URL. Unknown
 * columns or malformed values give `null` (unsorted / page default). */
export function parseSort(raw: string, allowed: readonly string[]): SortState | null {
  const [column, dir] = raw.split(':')
  if (!column || !allowed.includes(column) || (dir !== 'asc' && dir !== 'desc')) return null
  return { column, dir }
}

export function formatSort(sort: SortState | null): string {
  return sort ? `${sort.column}:${sort.dir}` : ''
}

type Key = string | number | null | undefined

/** A stable sorted copy. Missing values sort last in both directions;
 * strings compare case-insensitively with numeric awareness ("run 2" < "run 10"). */
export function sortRows<T>(rows: readonly T[], sort: SortState | null, keyOf: (row: T, column: string) => Key): T[] {
  if (!sort) return [...rows]
  const sign = sort.dir === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index, key: keyOf(row, sort.column) }))
    .sort((a, b) => {
      const aMissing = a.key === null || a.key === undefined || a.key === ''
      const bMissing = b.key === null || b.key === undefined || b.key === ''
      if (aMissing || bMissing) return aMissing === bMissing ? a.index - b.index : aMissing ? 1 : -1
      const cmp =
        typeof a.key === 'number' && typeof b.key === 'number'
          ? a.key - b.key
          : String(a.key).localeCompare(String(b.key), undefined, { sensitivity: 'base', numeric: true })
      return cmp === 0 ? a.index - b.index : cmp * sign
    })
    .map((x) => x.row)
}
