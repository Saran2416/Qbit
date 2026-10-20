import { screen } from 'electron'
import type { Point } from '../shared/types'

/**
 * Polls the global cursor position. This single poll drives three things:
 *
 *   1. click-through: the overlay only accepts mouse events while the cursor is
 *      inside one of the interactive regions reported by the renderer;
 *   2. the pet's "run away from the cursor" behaviour (renderer side);
 *   3. hover visuals.
 *
 * `screen.getCursorScreenPoint()` is a cheap native call, so 30 Hz costs
 * nothing measurable - and it keeps working even though the overlay window is
 * click-through, which mouse events alone would not guarantee.
 */
export class CursorTracker {
  private timer: NodeJS.Timeout | null = null
  private last: Point = { x: -1, y: -1 }

  constructor(
    private readonly onMove: (point: Point, moved: boolean) => void,
    private readonly hz = 30
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.poll(), Math.round(1000 / this.hz))
    this.poll()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  point(): Point {
    return this.last
  }

  private poll(): void {
    let point: Point
    try {
      point = screen.getCursorScreenPoint()
    } catch {
      return
    }
    const moved = point.x !== this.last.x || point.y !== this.last.y
    this.last = point
    this.onMove(point, moved)
  }
}
