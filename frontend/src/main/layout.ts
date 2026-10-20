import { screen } from 'electron'
import type { DisplayInfo, Rect, VirtualLayout } from '../shared/types'

/**
 * Display layout. All pet coordinates are in "virtual desktop" space: the
 * origin is the top-left corner of the union of every display, which matches
 * the overlay window's client area 1:1 (renderer CSS px == virtual px).
 * Monitors left of / above the primary display produce negative Electron
 * coordinates, so we normalise once here instead of everywhere in the renderer.
 */

export function toDisplayInfo(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: d.label || `Display ${d.id}`,
    primary: d.id === primaryId,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    workArea: { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height },
    scaleFactor: d.scaleFactor
  }))
}

export function computeLayout(): VirtualLayout {
  const displays = toDisplayInfo()
  const minX = Math.min(...displays.map((d) => d.bounds.x))
  const minY = Math.min(...displays.map((d) => d.bounds.y))
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width))
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height))
  const primary = displays.find((d) => d.primary) ?? displays[0]

  return {
    origin: { x: minX, y: minY },
    size: { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) },
    // One backing-store scale for the whole overlay: mixed-DPI setups are a
    // documented limitation (see README).
    scaleFactor: primary?.scaleFactor ?? 1,
    displays
  }
}

export function layoutBounds(layout: VirtualLayout): Rect {
  return { x: layout.origin.x, y: layout.origin.y, width: layout.size.width, height: layout.size.height }
}
