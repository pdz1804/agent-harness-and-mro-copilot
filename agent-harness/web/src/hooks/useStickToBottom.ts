import { useCallback, useEffect, useRef, useState } from 'react'
import { isNearBottom, nextFollowing } from '../lib/scroll-follow'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** Keep a scroll container pinned to its bottom ONLY while the reader is at the
 * bottom (see `lib/scroll-follow.ts` for the rules).
 *
 * - Opening: whenever `resetKey` changes (a different run/thread is shown) the
 *   hook resumes following and pins to the bottom, so a freshly opened or
 *   newly started page always lands on the latest message — even if the reader
 *   had scrolled up on the previous page.
 * - Growth: a `ResizeObserver` on the content element re-pins whenever it
 *   changes height while following, whatever caused it (streamed tokens, a tool
 *   card, a late-rendering markdown block or a loaded earlier turn). It stays on
 *   for finished runs too: while the reader sits at the bottom, content that
 *   settles after first paint keeps the view on the latest message; once they
 *   scroll up, following stops and nothing yanks them back.
 * - Smoothness: follow-scrolls are plain `scrollTop = scrollHeight` writes
 *   coalesced to one per animation frame (a `behavior: 'smooth'` animation per
 *   streamed token restarts constantly and visibly janks); only the explicit
 *   "Jump to latest" and approval-card scrolls animate, and not at all under
 *   `prefers-reduced-motion`. */
export function useStickToBottom(resetKey?: string) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const followingRef = useRef(true)
  const lastTopRef = useRef(0)
  const frameRef = useRef(0)
  const [following, setFollowingState] = useState(true)

  const setFollowing = useCallback((value: boolean) => {
    followingRef.current = value
    setFollowingState((prev) => (prev === value ? prev : value))
  }, [])

  const pinToBottom = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      const el = scrollRef.current
      // Re-check: the reader may have scrolled up between the resize and this frame.
      if (!el || !followingRef.current) return
      el.scrollTop = el.scrollHeight
      lastTopRef.current = el.scrollTop
    })
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const next = nextFollowing(followingRef.current, el, lastTopRef.current)
    lastTopRef.current = el.scrollTop
    setFollowing(next)
  }, [setFollowing])

  // Land on the latest message whenever a different thread is opened.
  useEffect(() => {
    setFollowing(true)
    pinToBottom()
  }, [resetKey, setFollowing, pinToBottom])

  // Intent beats position: the first upward wheel notch, touch drag or
  // navigation key stops following at once, before any scroll event has
  // reported where the reader ended up (a pending re-pin must not win).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Only when there is something above to scroll to (short content cannot move).
    const stop = () => {
      if (el.scrollTop > 0) setFollowing(false)
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stop()
    }
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) stop()
    }
    let touchY = 0
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent) => {
      // Finger moving down = content moving down = reading earlier text.
      if ((event.touches[0]?.clientY ?? 0) > touchY + 2) stop()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKey)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
    }
  }, [setFollowing])

  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followingRef.current) pinToBottom()
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frameRef.current)
    }
  }, [pinToBottom])

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setFollowing(true)
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [setFollowing])

  /** Smoothly bring an element (e.g. the approval card) into view. */
  const scrollToElement = useCallback(
    (target: HTMLElement | null) => {
      const el = scrollRef.current
      if (!el || !target) return
      target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      // If that lands at the bottom the scroll handler re-enables following;
      // otherwise the user is deliberately positioned on the element.
      setFollowing(isNearBottom(el))
    },
    [setFollowing],
  )

  return { scrollRef, contentRef, following, onScroll, jumpToLatest, scrollToElement, setFollowing }
}
