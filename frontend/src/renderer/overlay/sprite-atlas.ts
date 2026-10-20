import { api } from '../lib/bridge'
import type { AtlasClip, AtlasMeta, PetClip, SpriteAtlasPayload } from '../../shared/types'

/**
 * Sprite source.
 *
 * Two implementations behind one interface:
 *   1. `sheet`      - real art: sprites/robot.json + robot.png (see sprites/README.md),
 *                     loaded through the main process (which reads the file and
 *                     hands us a data: URL - the renderer has no fs access).
 *   2. `procedural` - the placeholder robot below: vector shapes drawn straight
 *                     onto the overlay canvas, so this project has no art
 *                     dependency at all and the pet can be animated (eyes
 *                     following the cursor, hover glow) beyond what a sheet can do.
 *
 * Everything downstream (animator, painter, games) only talks to `Atlas` and
 * `drawPet()`, so dropping real art in never requires code changes.
 */

export type PetEyes = 'open' | 'blink' | 'closed' | 'wide' | 'happy'

export interface PetPose {
  /** vertical bob in units (positive = up) */
  bob: number
  /** lean in units - applied as horizontal shear of the head/body */
  tilt: number
  armL: number
  armR: number
  legL: number
  legR: number
  eyes: PetEyes
  /** -1 look left, 0 ahead, 1 look right */
  look: -1 | 0 | 1
  /** 0..1 antenna glow */
  antenna: number
  /** 0 = none, 1/2 = sparkle frame */
  sparkle: number
  /** extra lift in units (jumping) */
  jump: number
  /** 0..3 number of z's to show while sleeping */
  zzz: number
  mark: '!' | '?' | null
}

export interface Atlas {
  kind: 'procedural' | 'sheet'
  meta: AtlasMeta
  image?: CanvasImageSource
  source?: string
}

export const PROCEDURAL_META: AtlasMeta = {
  frameWidth: 64,
  frameHeight: 64,
  image: 'procedural',
  renderScale: 1,
  anchor: { x: 0.5, y: 0.9375 },
  clips: {
    idle: { row: 0, frames: 6, fps: 6, loop: true },
    walk: { row: 1, frames: 8, fps: 10, loop: true },
    sleep: { row: 2, frames: 4, fps: 3, loop: true },
    alert: { row: 3, frames: 6, fps: 12, loop: true },
    happy: { row: 4, frames: 8, fps: 12, loop: false }
  }
}

const PALETTE = {
  outline: '#1b2230',
  shell: '#dbe4f0',
  shellShade: '#b2bed0',
  accent: '#4f9dff',
  face: '#131a26',
  eye: '#7ef0ff',
  eyeShade: '#2c7f96',
  antenna: '#ffd166',
  antennaDim: '#8b7a4a',
  shadow: 'rgba(10,14,22,0.35)'
}

/* ----------------------------------------------------------------- atlas load */

export async function loadAtlas(): Promise<Atlas> {
  try {
    const payload = await api().loadSpriteAtlas()
    if (payload) {
      const image = await loadImage(payload.imageDataUrl)
      const meta = normalizeSheetMeta(payload)
      return { kind: 'sheet', meta, image, source: payload.source }
    }
  } catch (err) {
    console.warn('[qbit] custom sprite atlas unavailable, using procedural robot', err)
  }
  return { kind: 'procedural', meta: PROCEDURAL_META }
}

function normalizeSheetMeta(payload: SpriteAtlasPayload): AtlasMeta {
  const meta = payload.meta
  const clips: Partial<Record<PetClip, AtlasClip>> = {}
  const names: PetClip[] = ['idle', 'walk', 'sleep', 'alert', 'happy']
  for (const name of names) {
    const clip = meta.clips?.[name]
    if (!clip) continue
    clips[name] = { row: clip.row, frames: maxFrames(clip.frames), fps: clip.fps, loop: clip.loop }
  }
  return {
    frameWidth: meta.frameWidth,
    frameHeight: meta.frameHeight,
    image: meta.image,
    renderScale: meta.renderScale > 0 ? meta.renderScale : 1,
    anchor: { x: meta.anchor?.x ?? 0.5, y: meta.anchor?.y ?? 1 },
    clips
  }
}

function maxFrames(frames: number): number {
  return Math.max(1, Math.floor(frames))
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('sprite sheet failed to decode'))
    image.src = src
  })
}

/* --------------------------------------------------------------- clip access */

export function clipFor(atlas: Atlas, clip: PetClip): AtlasClip {
  return atlas.meta.clips[clip] ?? atlas.meta.clips.idle ?? { row: 0, frames: 1, fps: 1, loop: true }
}

/** Size of the pet in CSS px at the given user scale. */
export function petSize(atlas: Atlas, scale: number): { width: number; height: number } {
  return {
    width: atlas.meta.frameWidth * atlas.meta.renderScale * scale,
    height: atlas.meta.frameHeight * atlas.meta.renderScale * scale
  }
}

/* -------------------------------------------------------------------- posing */

export function poseFor(clip: PetClip, frame: number, frames: number, look: -1 | 0 | 1): PetPose {
  const phase = frames > 0 ? frame / frames : 0
  const tau = phase * Math.PI * 2

  const base: PetPose = {
    bob: 0,
    tilt: 0,
    armL: 0,
    armR: 0,
    legL: 0,
    legR: 0,
    eyes: 'open',
    look,
    antenna: 0.5,
    sparkle: 0,
    jump: 0,
    zzz: 0,
    mark: null
  }

  switch (clip) {
    case 'walk': {
      const swing = Math.sin(tau)
      return {
        ...base,
        bob: Math.abs(swing) * 0.9,
        tilt: swing * 0.7,
        legL: swing * 2.4,
        legR: -swing * 2.4,
        armL: -swing * 1.8,
        armR: swing * 1.8,
        antenna: 0.6 + Math.abs(swing) * 0.4,
        eyes: 'open'
      }
    }
    case 'sleep':
      return {
        ...base,
        bob: Math.sin(tau) * 0.5 - 0.5,
        eyes: 'closed',
        armL: -0.6,
        armR: 0.6,
        antenna: 0.12,
        zzz: Math.min(3, 1 + Math.floor(phase * 4))
      }
    case 'alert': {
      const jitter = frame % 2 === 0 ? 0.45 : -0.45
      return {
        ...base,
        bob: jitter,
        tilt: jitter,
        eyes: 'wide',
        armL: -1.6,
        armR: -1.6,
        antenna: 0.7 + Math.abs(Math.sin(tau * 2)) * 0.3,
        mark: '!'
      }
    }
    case 'happy': {
      const arc = Math.sin(phase * Math.PI)
      return {
        ...base,
        jump: arc * 6,
        bob: arc * 1.5,
        eyes: 'happy',
        armL: -3.4,
        armR: -3.4,
        legL: arc * 1.6,
        legR: arc * 1.6,
        antenna: 1,
        sparkle: 1 + (frame % 2)
      }
    }
    default:
      return {
        ...base,
        bob: Math.sin(tau) * 0.7,
        eyes: frame === 3 ? 'blink' : 'open',
        armL: Math.sin(tau) * 0.4,
        armR: -Math.sin(tau) * 0.4,
        antenna: 0.45 + Math.abs(Math.sin(tau * 0.5)) * 0.55
      }
  }
}

/* ------------------------------------------------------------------- drawing */

export interface DrawPetSpec {
  clip: PetClip
  frame: number
  /** feet position in CSS px */
  x: number
  y: number
  facing: 1 | -1
  scale: number
  look: -1 | 0 | 1
  hovered: boolean
  /** ms timestamp, used for the sleep zzz + sparkle drift */
  time: number
}

export function drawPet(ctx: CanvasRenderingContext2D, atlas: Atlas, spec: DrawPetSpec): void {
  const { meta } = atlas
  const scale = meta.renderScale * spec.scale
  const width = meta.frameWidth * scale
  const height = meta.frameHeight * scale

  ctx.save()
  ctx.translate(Math.round(spec.x), Math.round(spec.y))
  if (spec.facing < 0) ctx.scale(-1, 1)
  ctx.translate(-width * meta.anchor.x, -height * meta.anchor.y)

  if (atlas.kind === 'sheet' && atlas.image) {
    const frameW = meta.frameWidth
    const frameH = meta.frameHeight
    const frame = Math.max(0, Math.floor(spec.frame))
    const sx = frame * frameW
    const sy = clipFor(atlas, spec.clip).row * frameH
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(atlas.image, sx, sy, frameW, frameH, 0, 0, width, height)
  } else {
    drawProcedural(ctx, poseFor(spec.clip, spec.frame, clipFor(atlas, spec.clip).frames, spec.look), scale, spec)
  }

  ctx.restore()
}

function drawProcedural(ctx: CanvasRenderingContext2D, pose: PetPose, scale: number, spec: DrawPetSpec): void {
  const u = 2 * scale // one design unit
  ctx.save()
  ctx.scale(u, u) // now every coordinate below is in design units (32x32 box)

  const dy = -(pose.bob + pose.jump)

  /* ground shadow (fades while jumping) */
  const shadowAlpha = Math.max(0, 1 - pose.jump / 8) * 0.45
  ctx.globalAlpha = shadowAlpha
  ctx.fillStyle = PALETTE.shadow
  ellipse(ctx, 16, 31.2, 8 - pose.jump * 0.2, 1.3)
  ctx.globalAlpha = 1

  /* antennae */
  ctx.fillStyle = PALETTE.outline
  rect(ctx, 10, 3 + dy, 1, 5)
  rect(ctx, 21, 3 + dy, 1, 5)
  ctx.fillStyle = pose.antenna > 0.3 ? PALETTE.antenna : PALETTE.antennaDim
  circle(ctx, 10.5, 2.6 + dy, 1.6)
  circle(ctx, 21.5, 2.6 + dy, 1.6)

  /* legs + feet */
  ctx.fillStyle = PALETTE.outline
  rect(ctx, 11, 26 + dy, 3, 3 + pose.legL * 0.2)
  rect(ctx, 18, 26 + dy, 3, 3 + pose.legR * 0.2)
  roundRect(ctx, 9 + pose.legL * 0.3, 28.6 + dy, 6, 2, 1, PALETTE.outline)
  roundRect(ctx, 17 + pose.legR * 0.3, 28.6 + dy, 6, 2, 1, PALETTE.outline)

  /* arms */
  roundRect(ctx, 5, 19 + pose.armL + dy, 3, 6.5, 1.2, PALETTE.outline)
  roundRect(ctx, 24, 19 + pose.armR + dy, 3, 6.5, 1.2, PALETTE.outline)

  /* body */
  roundRect(ctx, 9, 18 + dy, 14, 9, 2.2, PALETTE.outline)
  roundRect(ctx, 10.6, 19.4 + dy, 12.8, 7.2, 1.6, PALETTE.shellShade)
  roundRect(ctx, 11.5, 20.8 + dy, 9, 3.2, 1, pose.antenna > 0.4 ? PALETTE.accent : PALETTE.eyeShade)
  ctx.fillStyle = PALETTE.outline
  rect(ctx, 12.5, 25 + dy, 7, 0.8)

  /* head */
  const tilted = pose.tilt * 0.25
  roundRect(ctx, 6 + tilted, 8 + dy, 20, 11, 2.4, PALETTE.outline)
  roundRect(ctx, 7 + tilted, 9 + dy, 18, 9, 1.8, PALETTE.shell)
  roundRect(ctx, 8 + tilted, 10 + dy, 16, 7, 1.4, PALETTE.face)

  /* eyes */
  drawEyes(ctx, pose, tilted, dy)

  /* mouth */
  ctx.fillStyle = pose.eyes === 'happy' ? PALETTE.eye : PALETTE.accent
  if (pose.eyes === 'happy') {
    roundRect(ctx, 13.5 + tilted, 15.2 + dy, 5, 1.1, 0.5, PALETTE.eye)
  } else {
    rect(ctx, 13.5 + tilted, 15.2 + dy, 5, 0.9)
  }

  /* hover ring */
  if (spec.hovered) {
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = PALETTE.accent
    ctx.lineWidth = 0.6
    ctx.beginPath()
    ctx.ellipse(16, 30.6, 10, 2.4, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  if (pose.mark) drawMark(ctx, pose.mark, dy)
  if (pose.zzz > 0) drawZzz(ctx, pose.zzz, dy, spec.time)
  if (pose.sparkle > 0) drawSparkles(ctx, pose.sparkle, dy, spec.time)

  ctx.restore()
}

function drawEyes(ctx: CanvasRenderingContext2D, pose: PetPose, tilt: number, dy: number): void {
  const eyeY = 11.6 + dy
  const pupil = pose.look * 0.7
  const xs = [11 + tilt, 18 + tilt]

  for (const x of xs) {
    if (pose.eyes === 'closed') {
      ctx.fillStyle = PALETTE.eyeShade
      roundRect(ctx, x, eyeY + 1, 3, 0.9, 0.4, PALETTE.eyeShade)
      continue
    }
    if (pose.eyes === 'blink') {
      ctx.fillStyle = PALETTE.eye
      roundRect(ctx, x, eyeY + 0.9, 3, 1.2, 0.5, PALETTE.eye)
      continue
    }
    if (pose.eyes === 'happy') {
      ctx.fillStyle = PALETTE.eye
      ctx.beginPath()
      ctx.moveTo(x, eyeY + 2.4)
      ctx.quadraticCurveTo(x + 1.5, eyeY - 1.2, x + 3, eyeY + 2.4)
      ctx.lineTo(x + 3, eyeY + 2.9)
      ctx.quadraticCurveTo(x + 1.5, eyeY - 0.4, x, eyeY + 2.9)
      ctx.closePath()
      ctx.fill()
      continue
    }
    // open / wide
    const size = pose.eyes === 'wide' ? 3.3 : 3
    const offset = pose.eyes === 'wide' ? -0.15 : 0
    ctx.fillStyle = PALETTE.eye
    roundRect(ctx, x + offset, eyeY + offset, size, size, 0.8, PALETTE.eye)
    ctx.fillStyle = PALETTE.face
    const pupilSize = pose.eyes === 'wide' ? 1.1 : 1.5
    rect(ctx, x + offset + 0.7 + pupil, eyeY + offset + (size - pupilSize) / 2, pupilSize, pupilSize)
  }
}

function drawMark(ctx: CanvasRenderingContext2D, mark: '!' | '?', dy: number): void {
  ctx.save()
  ctx.translate(26, 4 + dy + Math.sin(performance.now() / 160) * 0.4)
  ctx.fillStyle = PALETTE.accent
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(4.4, 0)
  ctx.lineTo(2.2, 6)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 4.2px ui-monospace, "DejaVu Sans Mono", monospace'
  ctx.textAlign = 'center'
  ctx.fillText(mark, 2.2, 4.6)
  ctx.restore()
}

function drawZzz(ctx: CanvasRenderingContext2D, count: number, dy: number, time: number): void {
  ctx.save()
  ctx.fillStyle = '#cfe8ff'
  ctx.textAlign = 'center'
  for (let i = 0; i < count; i++) {
    const drift = ((time / 1200 + i * 0.4) % 1) * 4
    ctx.globalAlpha = 0.85 - i * 0.2
    ctx.font = `bold ${3 + i * 1.6}px ui-monospace, "DejaVu Sans Mono", monospace`
    ctx.fillText('z', 26 + i * 2.2, 10 + dy - i * 2.6 - drift)
  }
  ctx.restore()
}

function drawSparkles(ctx: CanvasRenderingContext2D, variant: number, dy: number, time: number): void {
  const points: Array<[number, number]> = variant === 1 ? [[4, 14], [28, 10], [8, 24]] : [[28, 22], [3, 20], [24, 6]]
  ctx.save()
  ctx.fillStyle = '#ffe9a3'
  for (const [px, py] of points) {
    const pulse = 0.6 + 0.4 * Math.sin(time / 140 + px)
    ctx.globalAlpha = pulse
    star(ctx, px, py + dy * 0.4, 2.2 * pulse)
  }
  ctx.restore()
}

/* ------------------------------------------------------------------- helpers */

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillRect(x, y, w, h)
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  color: string
): void {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()
}

function circle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
}

function ellipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  ctx.beginPath()
  ctx.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2)
  ctx.fill()
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath()
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2
    const radius = i % 2 === 0 ? r : r * 0.34
    const x = cx + Math.cos(angle) * radius
    const y = cy + Math.sin(angle) * radius
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fill()
}
