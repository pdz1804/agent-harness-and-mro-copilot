/** Marks a scroll container with `data-scrolling` while it scrolls (and for
 * `idleMs` after), so the CSS overlay scrollbar can show its thumb during
 * scroll as well as on hover. One capturing listener for the whole document
 * (scroll events don't bubble, but they do reach capture listeners). */

const IDLE_MS = 800

export function installScrollActivity(doc: Document = document, idleMs: number = IDLE_MS): () => void {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
  const onScroll = (event: Event) => {
    const target = event.target === doc ? doc.scrollingElement : (event.target as Element | null)
    if (!target || typeof (target as Element).setAttribute !== 'function') return
    const el = target as Element
    if (!el.hasAttribute('data-scrolling')) el.setAttribute('data-scrolling', '')
    const previous = timers.get(el)
    if (previous) clearTimeout(previous)
    timers.set(
      el,
      setTimeout(() => el.removeAttribute('data-scrolling'), idleMs),
    )
  }
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => doc.removeEventListener('scroll', onScroll, { capture: true })
}
