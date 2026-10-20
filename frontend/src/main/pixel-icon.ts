import { nativeImage, type NativeImage } from 'electron'
import { encodePng } from './png'

/**
 * The tray icon is drawn in code (16x16 logical units, upscaled with nearest
 * neighbour) so the repo has no binary assets and the icon works identically on
 * Windows and Linux. `tools/make-icons.mjs` renders the same robot in higher
 * resolution for the installer / AppImage icon.
 */

type RGBA = readonly [number, number, number, number]

const C = {
  none: [0, 0, 0, 0] as RGBA,
  outline: [27, 34, 48, 255] as RGBA,
  shell: [219, 228, 240, 255] as RGBA,
  accent: [79, 157, 255, 255] as RGBA,
  face: [19, 26, 38, 255] as RGBA,
  eye: [126, 240, 255, 255] as RGBA,
  eyeMuted: [122, 132, 148, 255] as RGBA,
  antenna: [255, 209, 102, 255] as RGBA,
  shadow: [12, 16, 24, 120] as RGBA,
  mute: [232, 96, 96, 255] as RGBA
}

class Grid {
  readonly size: number
  private readonly px: Uint8Array

  constructor(size: number) {
    this.size = size
    this.px = new Uint8Array(size * size * 4)
  }

  /** Fills a rectangle in logical (16x16) units with nearest-neighbour scaling. */
  rect(x: number, y: number, w: number, h: number, color: RGBA): void {
    const scale = this.size / 16
    const x0 = Math.round(x * scale)
    const y0 = Math.round(y * scale)
    const x1 = Math.round((x + w) * scale)
    const y1 = Math.round((y + h) * scale)
    for (let py = Math.max(0, y0); py < Math.min(this.size, y1); py++) {
      for (let px = Math.max(0, x0); px < Math.min(this.size, x1); px++) {
        this.set(px, py, color)
      }
    }
  }

  /** A rect whose four corner units are knocked out, to fake rounded corners. */
  roundedRect(x: number, y: number, w: number, h: number, color: RGBA): void {
    this.rect(x, y, w, h, color)
    this.rect(x, y, 1, 1, C.none)
    this.rect(x + w - 1, y, 1, 1, C.none)
    this.rect(x, y + h - 1, 1, 1, C.none)
    this.rect(x + w - 1, y + h - 1, 1, 1, C.none)
  }

  diagonal(fromX: number, fromY: number, toX: number, toY: number, thickness: number, color: RGBA): void {
    const steps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY))
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps
      const x = fromX + (toX - fromX) * t
      const y = fromY + (toY - fromY) * t
      this.rect(Math.round(x), Math.round(y), thickness, thickness, color)
    }
  }

  set(x: number, y: number, color: RGBA): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return
    if (color[3] === 0) return
    const i = (y * this.size + x) * 4
    this.px[i] = color[0]
    this.px[i + 1] = color[1]
    this.px[i + 2] = color[2]
    this.px[i + 3] = color[3]
  }

  toBuffer(): Buffer {
    return encodePng(this.size, this.size, this.px)
  }
}

function drawRobot(size: number, muted: boolean): Buffer {
  const g = new Grid(size)
  const eye = muted ? C.eyeMuted : C.eye

  // ground shadow
  g.rect(3, 14, 10, 1, C.shadow)
  // antennae
  g.rect(5, 1, 1, 3, C.outline)
  g.rect(10, 1, 1, 3, C.outline)
  g.rect(5, 0, 1, 1, muted ? C.eyeMuted : C.antenna)
  g.rect(10, 0, 1, 1, muted ? C.eyeMuted : C.antenna)
  // head
  g.roundedRect(2, 4, 12, 6, C.outline)
  g.rect(3, 5, 10, 4, C.shell)
  // screen face
  g.rect(4, 5, 8, 4, C.face)
  g.rect(5, 6, 2, 2, eye)
  g.rect(9, 6, 2, 2, eye)
  // body
  g.roundedRect(3, 10, 10, 4, C.outline)
  g.rect(4, 11, 8, 2, muted ? C.shell : C.accent)
  // legs
  g.rect(4, 14, 2, 1, C.outline)
  g.rect(10, 14, 2, 1, C.outline)
  // feet
  g.rect(3, 15, 3, 1, C.outline)
  g.rect(10, 15, 3, 1, C.outline)

  if (muted) {
    g.diagonal(3, 12, 12, 3, 1, C.mute)
  }

  return g.toBuffer()
}

export function petIconPng(size = 32, muted = false): Buffer {
  return drawRobot(size, muted)
}

export function petNativeImage(size = 32, muted = false): NativeImage {
  const image = nativeImage.createFromBuffer(petIconPng(size, muted))
  return image.isEmpty() ? nativeImage.createEmpty() : image
}
