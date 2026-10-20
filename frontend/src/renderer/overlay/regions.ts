import type { Rect } from '../../shared/types'

/**
 * The renderer is the only side that knows where the robot, its speech bubbles
 * and its chips actually are, but the main process is the only side that can
 * toggle click-through. This class marshals the interactive rectangles across
 * the IPC boundary, but only when they actually change (the robot's bounding
 * box moves most frames, so we throttle to ~16 Hz and drop duplicate states).
 */
export class RegionHub {
  private pending: Rect[] = []
  private lastKey = ''
  private lastSentAt = 0

  constructor(
    private readonly send: (regions: Rect[]) => void,
    private readonly minIntervalMs = 60
  ) {}

  /** Called every frame (or every layout change) with the full region list. */
  set(regions: Rect[]): void {
    this.pending = regions
  }

  /** Also called when the loop is stopped, so regions never go stale. */
  flush(force = false): void {
    const key = keyOf(this.pending)
    const now = performance.now()
    if (key === this.lastKey) return
    if (!force && now - this.lastSentAt < this.minIntervalMs) return
    this.lastKey = key
    this.lastSentAt = now
    this.send(this.pending)
  }

  /** Used when the overlay must become fully click-through (roaming paused/quit). */
  clearRegions(): void {
    this.pending = []
    this.lastKey = ''
    this.send([])
  }
}

function keyOf(regions: Rect[]): string {
  return regions
    .map((r) => `${Math.round(r.x / 2)},${Math.round(r.y / 2)},${Math.round(r.width / 2)},${Math.round(r.height / 2)}`)
    .join('|')
}
