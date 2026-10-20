import { clampToRect, displayAt, distance, pathStaysOnDisplays } from '../../shared/geometry'
import type { Point, Rect, VirtualLayout } from '../../shared/types'

export type MotionMode = 'idle' | 'walk' | 'flee' | 'paused'

export interface MotionOptions {
  /** walking speed, CSS px per second */
  speed: number
  /** the cursor is avoided inside this radius */
  avoidRadius: number
  petWidth: number
  petHeight: number
}

export interface MotionSnapshot {
  x: number
  y: number
  facing: 1 | -1
  mode: MotionMode
  moving: boolean
  cursorDistance: number
  /** ms since the pet last moved: drives the sleep timer */
  idleForMs: number
}

const EDGE_MARGIN = 10
const ARRIVE_EPS = 7
const FLEE_DISTANCE = 260
const FLEE_SPEED_MULTIPLIER = 2.6

/**
 * Roaming AI.
 *
 * The pet lives on the bottom band of whichever monitor it is on, walks to
 * random waypoints there, occasionally climbs a screen edge or migrates to a
 * neighbouring monitor (only if the straight path actually stays on a display,
 * so L-shaped desks do not make it walk through the void), and runs away when
 * the cursor gets closer than `avoidRadius`.
 *
 * All coordinates are virtual-desktop CSS px, feet-anchored.
 */
export class Motion {
  private pos: Point = { x: 0, y: 0 }
  private facing: 1 | -1 = 1
  private mode: MotionMode = 'idle'
  private target: Point | null = null
  private pauseUntil = 0
  private fleeRecalcAt = 0
  private lastMovedAt = performance.now()
  private lastCursorDistance = Number.POSITIVE_INFINITY

  constructor(
    private layout: VirtualLayout,
    private opts: MotionOptions,
    private readonly rng: () => number = Math.random
  ) {
    this.place()
  }

  /* --------------------------------------------------------------- control */

  setLayout(layout: VirtualLayout): void {
    this.layout = layout
    this.clampToWalkable()
  }

  setOptions(patch: Partial<MotionOptions>): void {
    this.opts = { ...this.opts, ...patch }
    this.clampToWalkable()
  }

  /** Force an immediate new decision (used when the user wakes the pet). */
  wake(): void {
    this.pauseUntil = 0
    if (this.mode === 'idle') this.mode = 'walk'
  }

  /** Teleport to a sensible spot (screen change, first run). */
  place(displayIndex = -1): void {
    const displays = this.layout.displays
    const display = displayIndex >= 0 ? displays[displayIndex % displays.length] : displays.find((d) => d.primary)
    const area = (display ?? displays[0]!).workArea
    this.pos = {
      x: area.x + area.width * 0.5,
      y: area.y + area.height - EDGE_MARGIN
    }
    this.target = null
    this.mode = 'idle'
    this.pauseUntil = performance.now() + 1200
  }

  snapshot(now = performance.now()): MotionSnapshot {
    return {
      x: this.pos.x,
      y: this.pos.y,
      facing: this.facing,
      mode: this.mode,
      moving: this.mode === 'walk' || this.mode === 'flee',
      cursorDistance: this.lastCursorDistance,
      idleForMs: now - this.lastMovedAt
    }
  }

  /* ----------------------------------------------------------------- update */

  update(dtMs: number, cursor: Point | null, opts: { paused: boolean; blocked: boolean }): MotionSnapshot {
    const dtSec = Math.min(0.2, dtMs / 1000)
    const now = performance.now()

    if (opts.paused) {
      this.mode = 'paused'
      this.target = null
      return this.snapshot(now)
    }

    this.lastCursorDistance = cursor ? distance(this.pos, cursor) : Number.POSITIVE_INFINITY
    const near = cursor !== null && this.lastCursorDistance < this.opts.avoidRadius

    if (near && this.mode !== 'paused') {
      if (this.mode !== 'flee' || now >= this.fleeRecalcAt) {
        this.mode = 'flee'
        this.target = this.fleeTarget(cursor!)
        this.fleeRecalcAt = now + 220
      }
    } else if (this.mode === 'flee' && this.lastCursorDistance > this.opts.avoidRadius * 1.35) {
      this.mode = 'idle'
      this.target = null
      this.pauseUntil = now + 500
    }

    if (this.mode === 'idle') {
      if (opts.blocked || now < this.pauseUntil) return this.snapshot(now)
      this.target = this.pickTarget()
      this.mode = 'walk'
    }

    if ((this.mode === 'walk' || this.mode === 'flee') && this.target) {
      const speed = this.mode === 'flee' ? this.opts.speed * FLEE_SPEED_MULTIPLIER : this.opts.speed
      const distanceToTarget = distance(this.pos, this.target)
      if (distanceToTarget <= ARRIVE_EPS) {
        this.pos = { ...this.target }
        this.target = null
        this.mode = 'idle'
        this.pauseUntil = now + this.pauseDuration()
      } else {
        const step = Math.min(distanceToTarget, speed * dtSec)
        const dir = { x: (this.target.x - this.pos.x) / distanceToTarget, y: (this.target.y - this.pos.y) / distanceToTarget }
        this.pos = { x: this.pos.x + dir.x * step, y: this.pos.y + dir.y * step }
        if (Math.abs(dir.x) > 0.05) this.facing = dir.x > 0 ? 1 : -1
        this.lastMovedAt = now
        this.clampToWalkable()
      }
    }

    return this.snapshot(now)
  }

  /* ---------------------------------------------------------------- targets */

  private pickTarget(): Point {
    const displays = this.layout.displays
    const current = displayAt(this.layout, this.pos)
    const roll = this.rng()

    // 82%: stay on this monitor, 12%: migrate to another one, 6%: climb an edge.
    if (roll < 0.82 || displays.length === 1) return this.bottomBandTarget(current.workArea)

    if (roll < 0.94) {
      const others = displays.filter((d) => d.id !== current.id)
      const other = others[Math.floor(this.rng() * others.length)]
      if (other) {
        const candidate = this.bottomBandTarget(other.workArea)
        if (pathStaysOnDisplays(this.layout, this.pos, candidate)) return candidate
      }
      return this.bottomBandTarget(current.workArea)
    }

    return this.edgeTarget(current.workArea)
  }

  private bottomBandTarget(area: Rect): Point {
    const y = area.y + area.height - EDGE_MARGIN
    const minX = area.x + this.opts.petWidth / 2 + 6
    const maxX = area.x + area.width - this.opts.petWidth / 2 - 6
    let x = minX + this.rng() * Math.max(1, maxX - minX)

    // Avoid "targets" that are basically where we already are.
    if (Math.abs(x - this.pos.x) < 80) {
      const direction = this.pos.x < (minX + maxX) / 2 ? 1 : -1
      x = this.pos.x + direction * (120 + this.rng() * 240)
      x = Math.min(maxX, Math.max(minX, x))
    }
    return { x, y }
  }

  private edgeTarget(area: Rect): Point {
    const left = this.rng() < 0.5
    const x = left
      ? area.x + this.opts.petWidth / 2 + 4
      : area.x + area.width - this.opts.petWidth / 2 - 4
    const bottom = area.y + area.height - EDGE_MARGIN
    const top = area.y + area.height * 0.45
    const y = Math.min(bottom, Math.max(top, bottom - (0.3 + this.rng() * 0.55) * (bottom - top)))
    return { x, y }
  }

  private fleeTarget(cursor: Point): Point {
    const dx = this.pos.x - cursor.x
    const dy = this.pos.y - cursor.y
    const length = Math.hypot(dx, dy) || 1
    // Bias the escape to be mostly horizontal: the pet cannot outrun a cursor
    // vertically, and sliding along the bottom edge reads better.
    const biasY = Math.max(-0.35, Math.min(0.35, dy / length))
    const biasX = dx / length
    const norm = Math.hypot(biasX, biasY) || 1
    const direction = { x: biasX / norm, y: biasY / norm }

    const wanted = {
      x: this.pos.x + direction.x * FLEE_DISTANCE,
      y: this.pos.y + direction.y * FLEE_DISTANCE
    }
    return this.clampPoint(wanted)
  }

  private pauseDuration(): number {
    const roll = this.rng()
    if (roll < 0.12) return 15_000 + this.rng() * 20_000 // long daydream
    if (roll < 0.3) return 600 + this.rng() * 900 // short hop
    return 2500 + this.rng() * 6500
  }

  private clampPoint(point: Point): Point {
    const area: Rect = displayAt(this.layout, point).workArea
    return clampToRect(area, point, this.opts.petWidth / 2)
  }

  private clampToWalkable(): void {
    const area: Rect = displayAt(this.layout, this.pos).workArea
    const half = this.opts.petWidth / 2
    const minX = area.x + half
    const maxX = area.x + area.width - half
    const minY = area.y + this.opts.petHeight
    const maxY = area.y + area.height - 2
    this.pos = {
      x: Math.min(Math.max(this.pos.x, Math.min(minX, maxX)), Math.max(minX, maxX)),
      y: Math.min(Math.max(this.pos.y, Math.min(minY, maxY)), Math.max(minY, maxY))
    }
  }
}
