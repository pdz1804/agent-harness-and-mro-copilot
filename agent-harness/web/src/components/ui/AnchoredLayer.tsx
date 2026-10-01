import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { placeLayer, type Placement } from '../../lib/anchor-position'

interface AnchoredLayerProps {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  children: ReactNode
  align?: 'start' | 'end'
  role?: 'menu' | 'dialog'
  label: string
  className?: string
}

/** The one floating layer behind menus and confirm popovers: portalled to
 * `body`, fixed-positioned next to its trigger (flips up when there is no
 * room), closed by Escape or a click outside, and it hands focus back to the
 * trigger when it closes. */
export function AnchoredLayer({ anchorRef, open, onClose, children, align = 'end', role = 'dialog', label, className = '' }: AnchoredLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      const layer = layerRef.current
      if (!anchor || !layer) return
      setPlacement(
        placeLayer(anchor, { width: layer.offsetWidth, height: layer.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, align),
      )
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, align, anchorRef])

  useEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (layerRef.current?.contains(target) || anchor?.contains(target)) return
      onCloseRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        anchor?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, anchorRef])

  if (!open) return null
  return createPortal(
    <div
      ref={layerRef}
      role={role}
      aria-label={label}
      data-anchored-layer=""
      style={{ top: placement?.top ?? -9999, left: placement?.left ?? -9999, visibility: placement ? 'visible' : 'hidden' }}
      className={`ui-glass fixed z-[60] origin-top animate-pop rounded-[20px] p-0.5 ${className}`}
    >
      {children}
    </div>,
    document.body,
  )
}
