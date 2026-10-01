/** Pure placement maths for popovers anchored to a trigger (menus, confirms).
 * Fixed positioning against the viewport, so a popover is never clipped by an
 * `overflow: auto` table or card it was opened from. */

export interface Rect {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface Placement {
  top: number
  left: number
  /** `true` when there was no room below and the layer opens upward. */
  above: boolean
}

const GAP = 6
const MARGIN = 8

/** Place a `layer`-sized box under `anchor` (aligned to its start or end
 * edge), flipping above when it would overflow the bottom, and clamped so it
 * always stays `MARGIN` px inside the viewport. */
export function placeLayer(
  anchor: Rect,
  layer: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end' = 'end',
): Placement {
  const roomBelow = viewport.height - anchor.bottom - GAP - MARGIN
  const roomAbove = anchor.top - GAP - MARGIN
  const above = layer.height > roomBelow && roomAbove > roomBelow
  const rawTop = above ? anchor.top - GAP - layer.height : anchor.bottom + GAP
  const rawLeft = align === 'end' ? anchor.right - layer.width : anchor.left
  const maxLeft = Math.max(MARGIN, viewport.width - layer.width - MARGIN)
  const maxTop = Math.max(MARGIN, viewport.height - layer.height - MARGIN)
  return {
    top: Math.min(Math.max(MARGIN, rawTop), maxTop),
    left: Math.min(Math.max(MARGIN, rawLeft), maxLeft),
    above,
  }
}
