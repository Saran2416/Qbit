import type { DisplayInfo, Point, Rect, VirtualLayout } from './types'

/**
 * Pure geometry shared by the main process (window placement, hit testing) and
 * the renderer (roaming). No Electron imports, so both sides can use it.
 */

export function containsPoint(rect: Rect, p: Point, pad = 0): boolean {
  return (
    p.x >= rect.x - pad && p.x <= rect.x + rect.width + pad && p.y >= rect.y - pad && p.y <= rect.y + rect.height + pad
  )
}

export function clampToRect(rect: Rect, p: Point, margin = 0): Point {
  const minX = rect.x + margin
  const minY = rect.y + margin
  const maxX = rect.x + rect.width - margin
  const maxY = rect.y + rect.height - margin
  return {
    x: Math.min(Math.max(p.x, Math.min(minX, maxX)), Math.max(minX, maxX)),
    y: Math.min(Math.max(p.y, Math.min(minY, maxY)), Math.max(minY, maxY))
  }
}

export function displayAt(layout: VirtualLayout, p: Point): DisplayInfo {
  const hit = layout.displays.find((d) => containsPoint(d.bounds, p))
  return hit ?? layout.displays.find((d) => d.primary) ?? layout.displays[0]!
}

export function displayWorkAreaAt(layout: VirtualLayout, p: Point): Rect {
  return displayAt(layout, p).workArea
}

/** True when a straight line between two points never leaves the desktop. */
export function pathStaysOnDisplays(layout: VirtualLayout, from: Point, to: Point, samples = 12): boolean {
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
    if (!layout.displays.some((d) => containsPoint(d.bounds, p))) return false
  }
  return true
}

/** Virtual desktop coords -> overlay-local CSS px. */
export function toLocal(layout: VirtualLayout, p: Point): Point {
  return { x: p.x - layout.origin.x, y: p.y - layout.origin.y }
}

export function toVirtual(layout: VirtualLayout, p: Point): Point {
  return { x: p.x + layout.origin.x, y: p.y + layout.origin.y }
}

export function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Places a UI window of `size` next to `anchor`, fully inside one display. */
export function anchorWindow(
  layout: VirtualLayout,
  anchor: Rect,
  size: { width: number; height: number },
  gap = 12,
  pad = 8
): Point {
  const display = displayAt(layout, centerOf(anchor))
  const area = display.workArea
  const right = { x: anchor.x + anchor.width + gap, y: anchor.y + anchor.height / 2 - size.height / 2 }
  const left = { x: anchor.x - size.width - gap, y: right.y }

  const fitsRight = right.x + size.width <= area.x + area.width - pad
  const fitsLeft = left.x >= area.x + pad
  const x = fitsRight ? right.x : fitsLeft ? left.x : area.x + area.width - size.width - pad
  let y = right.y
  if (y + size.height > area.y + area.height - pad) y = area.y + area.height - size.height - pad
  if (y < area.y + pad) y = area.y + pad
  const clampedX = Math.min(Math.max(x, area.x + pad), area.x + area.width - size.width - pad)
  return { x: Math.round(clampedX), y: Math.round(y) }
}
