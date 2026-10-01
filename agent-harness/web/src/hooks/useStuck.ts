import { useEffect, useRef, useState } from 'react'

/** `true` once the element after `sentinelRef` has scrolled under the top of
 * its scroll container (sticky headers frost at that point). Uses an
 * IntersectionObserver on a zero-height sentinel, so there is no scroll
 * listener and no layout read per frame. */
export function useStuck<T extends HTMLElement = HTMLDivElement>() {
  const sentinelRef = useRef<T | null>(null)
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || typeof IntersectionObserver === 'undefined') return
    let root: HTMLElement | null = sentinel.parentElement
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), { root, threshold: 0 })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  return { sentinelRef, stuck }
}
