import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/** One query-string parameter as React state. Filters, sort, tab and the open
 * sheet live in the URL, so Back, reload and a shared link all restore them.
 * Writing the default value removes the parameter (clean URLs). Updates
 * replace the history entry, except `open`, which pushes one so Back closes a
 * sheet instead of leaving the page. */
export function useUrlState(key: string, defaultValue = ''): [string, (next: string) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get(key) ?? defaultValue
  const setValue = useCallback(
    (next: string) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev)
          if (!next || next === defaultValue) copy.delete(key)
          else copy.set(key, next)
          return copy
        },
        { replace: key !== 'open' },
      )
    },
    [key, defaultValue, setParams],
  )
  return [value, setValue]
}

/** A typed enum parameter: values outside `allowed` fall back to the default,
 * so a hand-edited or stale URL never puts the page in an impossible state. */
export function useUrlEnum<T extends string>(key: string, allowed: readonly T[], defaultValue: T): [T, (next: T) => void] {
  const [raw, set] = useUrlState(key, defaultValue)
  const value = (allowed as readonly string[]).includes(raw) ? (raw as T) : defaultValue
  return [value, set as (next: T) => void]
}

/** Clear several parameters at once ("Clear filters"). */
export function useClearUrlParams(): (keys: string[]) => void {
  const [, setParams] = useSearchParams()
  return useCallback(
    (keys: string[]) =>
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev)
          for (const k of keys) copy.delete(k)
          return copy
        },
        { replace: true },
      ),
    [setParams],
  )
}
