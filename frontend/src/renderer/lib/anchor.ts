import type { Rect } from '../../shared/types'

export type AnchorPreference = 'above' | 'right' | 'auto'

/**
 * Positions a floating DOM element (speech bubble, token chip) relative to the
 * pet and keeps it inside the overlay. Elements are absolutely positioned in a
 * full-desktop layer, so `getBoundingClientRect()` yields overlay-local CSS px
 * which can be handed straight to the region hub (hit testing lives in main).
 */
export function positionAnchored(
  element: HTMLElement,
  petRect: Rect,
  bounds: { width: number; height: number },
  preference: AnchorPreference = 'auto',
  gap = 10,
  margin = 6
): Rect {
  const width = element.offsetWidth
  const height = element.offsetHeight
  const petCenterX = petRect.x + petRect.width / 2

  const wantsSide = preference === 'right'
  const sideLeft = petRect.x - width - gap
  const sideRight = petRect.x + petRect.width + gap
  const sideFitsRight = sideRight + width <= bounds.width - margin
  const sideFitsLeft = sideLeft >= margin
  // 'auto' places the bubble above the pet unless that would leave the screen.
  const preferSide = wantsSide || (preference === 'auto' && petRect.y - height - gap < margin && (sideFitsRight || sideFitsLeft))

  let left: number
  let top: number

  if (preferSide && sideFitsRight) {
    left = sideRight
    top = Math.min(petRect.y + petRect.height - height, petRect.y - height * 0.25)
  } else if (preferSide && sideFitsLeft) {
    left = sideLeft
    top = Math.min(petRect.y + petRect.height - height, petRect.y - height * 0.25)
  } else {
    left = petCenterX - width / 2
    top = petRect.y - height - gap
    if (top < margin) top = petRect.y + petRect.height * 0.35
  }

  left = Math.min(Math.max(left, margin), Math.max(margin, bounds.width - width - margin))
  top = Math.min(Math.max(top, margin), Math.max(margin, bounds.height - height - margin))

  element.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
  return rectOf(element)
}

export function rectOf(element: HTMLElement, pad = 0): Rect {
  const r = element.getBoundingClientRect()
  return { x: r.left - pad, y: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 }
}
