import type { PetClip, Rect, VirtualLayout } from '../../shared/types'
import { drawPet, type Atlas } from './sprite-atlas'

export interface PetVisual {
  clip: PetClip
  frame: number
  /** feet position in overlay-local CSS px */
  x: number
  y: number
  facing: 1 | -1
  look: -1 | 0 | 1
  hovered: boolean
  scale: number
  time: number
}

const DIRTY_PAD = 6

/**
 * Canvas painter with dirty-rectangle rendering.
 *
 * The overlay window covers the whole virtual desktop (potentially several
 * megapixels), so repainting everything at 30 fps is not an option. Instead we
 * remember the previous pet rectangle, clear only the union of the old and new
 * ones and redraw a ~80x80 px area. The rest of the canvas stays empty (and
 * therefore fully transparent) and is never touched.
 */
export class Painter {
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  private prev: Rect | null = null
  private lastPaintKey = ''
  private lastRect: Rect = { x: 0, y: 0, width: 0, height: 0 }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private layout: VirtualLayout,
    private atlas: Atlas
  ) {
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
    if (!ctx) throw new Error('overlay: 2d context unavailable')
    this.ctx = ctx
    this.resize()
  }

  setLayout(layout: VirtualLayout): void {
    this.layout = layout
    this.resize()
  }

  setAtlas(atlas: Atlas): void {
    this.atlas = atlas
    this.prev = null
    this.lastPaintKey = ''
  }

  /** Rect (overlay-local CSS px) the pet currently occupies. */
  rectFor(visual: Pick<PetVisual, 'x' | 'y' | 'scale'>): Rect {
    const meta = this.atlas.meta
    const width = meta.frameWidth * meta.renderScale * visual.scale
    const height = meta.frameHeight * meta.renderScale * visual.scale
    return {
      x: visual.x - width * meta.anchor.x,
      y: visual.y - height * meta.anchor.y,
      width,
      height
    }
  }

  /** Rect of the last painted frame: used for hit tests between frames. */
  lastPetRect(): Rect {
    return this.lastRect
  }

  /** Returns true when the canvas was actually repainted. */
  paint(visual: PetVisual, force = false): boolean {
    const rect = this.rectFor(visual)
    this.lastRect = rect

    const key = `${visual.clip}|${visual.frame}|${Math.round(visual.x)}|${Math.round(visual.y)}|${visual.facing}|${visual.look}|${visual.hovered}|${visual.scale}`
    if (!force && key === this.lastPaintKey) return false
    this.lastPaintKey = key

    const dirty = unionRect(padRect(rect, DIRTY_PAD), this.prev ? padRect(this.prev, DIRTY_PAD) : null)
    this.ctx.save()
    this.ctx.clearRect(dirty.x, dirty.y, dirty.width, dirty.height)
    drawPet(this.ctx, this.atlas, {
      clip: visual.clip,
      frame: visual.frame,
      x: visual.x,
      y: visual.y,
      facing: visual.facing,
      scale: visual.scale,
      look: visual.look,
      hovered: visual.hovered,
      time: visual.time
    })
    this.ctx.restore()
    this.prev = rect
    return true
  }

  clear(): void {
    this.ctx.save()
    this.ctx.clearRect(0, 0, this.layout.size.width, this.layout.size.height)
    this.ctx.restore()
    this.prev = null
    this.lastPaintKey = ''
  }

  private resize(): void {
    this.dpr = Math.min(3, Math.max(1, this.layout.scaleFactor || 1))
    const width = this.layout.size.width
    const height = this.layout.size.height
    this.canvas.width = Math.round(width * this.dpr)
    this.canvas.height = Math.round(height * this.dpr)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.ctx.imageSmoothingEnabled = false
    this.prev = null
  }
}

function padRect(rect: Rect, pad: number): Rect {
  return { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
}

function unionRect(a: Rect, b: Rect | null): Rect {
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x, y, width: right - x, height: bottom - y }
}
