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

/** The rectangle the feet walk on, inset so the sprite never clips an edge. */
interface Frame {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function speedOf(mode: MotionMode, base: number): number {
  return mode === 'flee' ? base * FLEE_SPEED_MULTIPLIER : base
}

function perimeterLength(frame: Frame): number {
  return 2 * (frame.maxX - frame.minX + (frame.maxY - frame.minY))
}

function mod(value: number, m: number): number {
  return ((value % m) + m) % m
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

/**
 * Roaming AI.
 *
 * The pet roams the *perimeter* of whichever monitor it is on: it walks the
 * bottom, right, top and left edges in sequence (inset so the sprite never
 * clips), turning the corners, so it visits every edge of the display instead
 * of patrolling the bottom band. It occasionally migrates to a neighbouring
 * monitor in a straight line - but only if that line actually stays on a
 * display, so L-shaped desks do not make it walk through the void - and it
 * still runs away when the cursor gets closer than `avoidRadius`, re-attaching
 * to the nearest edge afterwards.
 *
 * All coordinates are virtual-desktop CSS px, feet-anchored, upright.
 */
export class Motion {
  private pos: Point = { x: 0, y: 0 }
  private facing: 1 | -1 = 1
  private mode: MotionMode = 'idle'
  private target: Point | null = null
  /** arc position along the current display's perimeter (null = straight walk) */
  private edgeS = 0
  private targetS: number | null = null
  private edgeDir: 1 | -1 = 1
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
    // the arc was measured on the old display geometry: drop the walk
    this.targetS = null
    this.target = null
    if (this.mode === 'walk') {
      this.mode = 'idle'
      this.pauseUntil = performance.now() + 400
    }
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
    this.targetS = null
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
      this.targetS = null
      return this.snapshot(now)
    }

    this.lastCursorDistance = cursor ? distance(this.pos, cursor) : Number.POSITIVE_INFINITY
    const near = cursor !== null && this.lastCursorDistance < this.opts.avoidRadius

    if (near && this.mode !== 'paused') {
      if (this.mode !== 'flee' || now >= this.fleeRecalcAt) {
        this.mode = 'flee'
        this.targetS = null // fleeing is always a straight dash
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

    if (this.mode === 'walk' && this.targetS !== null) {
      this.walkPerimeter(dtSec, speedOf(this.mode, this.opts.speed), now)
    } else if ((this.mode === 'walk' || this.mode === 'flee') && this.target) {
      const speed = speedOf(this.mode, this.opts.speed)
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

  /** One step of the perimeter walk: advance the arc position toward targetS. */
  private walkPerimeter(dtSec: number, speed: number, now: number): void {
    const frame = this.frameOf(displayAt(this.layout, this.pos).workArea)
    const per = perimeterLength(frame)
    const target = this.targetS!
    if (per < 40) {
      // degenerate frame (display smaller than the sprite): fall back to idle
      this.targetS = null
      this.mode = 'idle'
      this.pauseUntil = now + this.pauseDuration()
      return
    }

    // distance still to cover along the arc, in the walking direction
    const remaining =
      this.edgeDir > 0 ? mod(target - this.edgeS, per) : mod(this.edgeS - target, per)
    const step = speed * dtSec

    if (step >= remaining) {
      this.edgeS = target
      this.pos = this.pointAt(frame, target)
      this.targetS = null
      this.target = null
      this.mode = 'idle'
      this.pauseUntil = now + this.pauseDuration()
      return
    }

    this.edgeS = mod(this.edgeS + this.edgeDir * step, per)
    const next = this.pointAt(frame, this.edgeS)
    const dx = next.x - this.pos.x
    if (Math.abs(dx) > 0.2) this.facing = dx > 0 ? 1 : -1 // else keep facing on vertical runs
    this.pos = next
    this.lastMovedAt = now
    this.clampToWalkable()
  }

  /* ---------------------------------------------------------------- targets */

  private pickTarget(): Point {
    const displays = this.layout.displays
    const current = displayAt(this.layout, this.pos)
    const roll = this.rng()

    // 10%: migrate to another monitor, straight line over the desktop.
    if (roll < 0.10 && displays.length > 1) {
      const others = displays.filter((d) => d.id !== current.id)
      const other = others[Math.floor(this.rng() * others.length)]
      if (other) {
        const candidate = this.edgePointIn(other.workArea)
        if (pathStaysOnDisplays(this.layout, this.pos, candidate)) {
          this.targetS = null
          return candidate
        }
      }
    }

    const frame = this.frameOf(current.workArea)
    const per = perimeterLength(frame)
    if (per < 40) return this.clampPoint({ x: current.workArea.x + this.rng() * current.workArea.width, y: current.workArea.y + current.workArea.height * 0.6 })

    const projected = this.projectOntoFrame(frame, this.pos)
    if (projected.dist > ARRIVE_EPS * 2) {
      // off the rim (fled the cursor, or freshly placed): walk back onto it
      this.targetS = null
      return projected.point
    }

    // Keep the current heading (80%) or reverse (20%), and travel a quarter to
    // two thirds of the rim - far enough that every edge gets its turn.
    this.edgeDir = this.rng() < 0.2 ? ((-this.edgeDir) as 1 | -1) : this.edgeDir
    const travel = per * (0.25 + this.rng() * 0.4)
    this.edgeS = projected.s
    this.targetS = mod(projected.s + this.edgeDir * travel, per)
    return this.pointAt(frame, this.targetS)
  }

  /** A random point on a display's perimeter (migration landing spot). */
  private edgePointIn(area: Rect): Point {
    const frame = this.frameOf(area)
    const s = this.rng() * perimeterLength(frame)
    return this.pointAt(frame, s)
  }

  /**
   * The feet-anchored rectangle the pet walks on for a work area: the sprite
   * is inset half a pet from the left/right edges, one pet + a margin from the
   * top (so its head never clips), and stands on the bottom edge.
   */
  private frameOf(area: Rect): Frame {
    const half = this.opts.petWidth / 2
    return {
      minX: area.x + half + 6,
      maxX: area.x + area.width - half - 6,
      minY: area.y + this.opts.petHeight + 6,
      maxY: area.y + area.height - EDGE_MARGIN
    }
  }

  /** Point at arc position `s`: bottom (left→right), right, top, left. */
  private pointAt(frame: Frame, s: number): Point {
    const w = frame.maxX - frame.minX
    const h = frame.maxY - frame.minY
    const t = mod(s, 2 * (w + h))
    if (t < w) return { x: frame.minX + t, y: frame.maxY }
    if (t < w + h) return { x: frame.maxX, y: frame.maxY - (t - w) }
    if (t < 2 * w + h) return { x: frame.maxX - (t - w - h), y: frame.minY }
    return { x: frame.minX, y: frame.minY + (t - 2 * w - h) }
  }

  /** Nearest point on the perimeter and its arc position. */
  private projectOntoFrame(frame: Frame, p: Point): { point: Point; s: number; dist: number } {
    const cx = Math.min(Math.max(p.x, frame.minX), frame.maxX)
    const cy = Math.min(Math.max(p.y, frame.minY), frame.maxY)
    const sides = [
      { point: { x: cx, y: frame.maxY }, dist: Math.abs(p.y - frame.maxY) },
      { point: { x: frame.maxX, y: cy }, dist: Math.abs(p.x - frame.maxX) },
      { point: { x: cx, y: frame.minY }, dist: Math.abs(p.y - frame.minY) },
      { point: { x: frame.minX, y: cy }, dist: Math.abs(p.x - frame.minX) }
    ]
    let best = sides[0]!
    for (const side of sides) if (side.dist < best.dist) best = side
    return { point: best.point, s: this.arcOf(frame, best.point), dist: distance(p, best.point) }
  }

  /** Arc position of a point that lies on the perimeter (corners round down). */
  private arcOf(frame: Frame, p: Point): number {
    const w = frame.maxX - frame.minX
    const h = frame.maxY - frame.minY
    const eps = 1.5
    if (Math.abs(p.y - frame.maxY) <= eps) return clamp(p.x - frame.minX, 0, w)
    if (Math.abs(p.x - frame.maxX) <= eps) return w + clamp(frame.maxY - p.y, 0, h)
    if (Math.abs(p.y - frame.minY) <= eps) return w + h + clamp(frame.maxX - p.x, 0, w)
    return 2 * w + h + clamp(p.y - frame.minY, 0, h)
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
