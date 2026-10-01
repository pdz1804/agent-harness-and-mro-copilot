import { useEffect, useState } from 'react'

/** Small `useState` wrapper that persists to `localStorage` under `key`.
 * Read failures (private browsing, corrupted JSON, SSR) fall back to
 * `initial` silently — this is UI convenience state, never a source of
 * truth for anything the server owns. */
export function useLocalStorageState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // best-effort persistence only
    }
  }, [key, value])

  return [value, setValue]
}
