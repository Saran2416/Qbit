#!/usr/bin/env node
/**
 * Generates every raster asset electron-builder needs (no binary blobs in git):
 *
 *   build/icon.png            512x512  (Windows master -> .ico + Linux fallback)
 *   build/icon.ico            multi-size ICO for Windows
 *   build/icons/NNxNN.png     Linux icon set (AppImage / desktop entry)
 *   build/tray.png            32x32 tray fallback
 *
 * Run with: npm run icons   (also runs automatically on postinstall)
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'build')

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0))
  ])
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = []
  let offset = 6 + pngs.length * 16
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32BE(0, 8)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

/* ------------------------------------------------------------------ art ---- */

// Colours mirror src/main/pixel-icon.ts
const C = {
  none: [0, 0, 0, 0],
  outline: [27, 34, 48, 255],
  shell: [219, 228, 240, 255],
  shellDark: [178, 190, 208, 255],
  accent: [79, 157, 255, 255],
  face: [19, 26, 38, 255],
  eye: [126, 240, 255, 255],
  antenna: [255, 209, 102, 255],
  shadow: [12, 16, 24, 90]
}

class Grid {
  constructor(units, size) {
    this.units = units
    this.size = size
    this.px = new Uint8Array(size * size * 4)
    this.scale = size / units
  }

  rect(x, y, w, h, color) {
    const x0 = Math.round(x * this.scale)
    const y0 = Math.round(y * this.scale)
    const x1 = Math.round((x + w) * this.scale)
    const y1 = Math.round((y + h) * this.scale)
    for (let py = Math.max(0, y0); py < Math.min(this.size, y1); py++) {
      for (let px = Math.max(0, x0); px < Math.min(this.size, x1); px++) this.set(px, py, color)
    }
  }

  rounded(x, y, w, h, color, corner = 1) {
    this.rect(x, y, w, h, color)
    this.rect(x, y, corner, corner, C.none)
    this.rect(x + w - corner, y, corner, corner, C.none)
    this.rect(x, y + h - corner, corner, corner, C.none)
    this.rect(x + w - corner, y + h - corner, corner, corner, C.none)
  }

  circle(cx, cy, r, color) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        if (dx * dx + dy * dy <= r * r) this.rect(x, y, 1, 1, color)
      }
    }
  }

  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || color[3] === 0) return
    const i = (y * this.size + x) * 4
    this.px[i] = color[0]
    this.px[i + 1] = color[1]
    this.px[i + 2] = color[2]
    this.px[i + 3] = color[3]
  }
}

/** The Qbit robot on a 32x32 unit grid, used for both app and tray icons. */
function drawRobot(size, { simplified = false } = {}) {
  const g = new Grid(32, size)
  const u = 1 // unit

  // shadow
  g.rect(9, 29, 14, 2, C.shadow)

  if (!simplified) {
    // antennae
    g.rect(10, 2, 1, 5, C.outline)
    g.rect(21, 2, 1, 5, C.outline)
    g.circle(10.5, 2.5, 1.6, C.antenna)
    g.circle(21.5, 2.5, 1.6, C.antenna)
  } else {
    g.rect(10, 4, 1, 4, C.outline)
    g.rect(21, 4, 1, 4, C.outline)
    g.rect(10, 3, 1, 1, C.antenna)
    g.rect(21, 3, 1, 1, C.antenna)
  }

  // head shell
  g.rounded(6, 8, 20, 11, C.outline, 2)
  g.rect(7, 9, 18, 9, C.shell)
  // face screen
  g.rect(8, 10, 16, 7, C.face)
  // eyes (rounded 3x3 units each)
  for (const ex of [11, 18]) {
    g.rect(ex, 11, 3, 3, C.eye)
    g.rect(ex, 11, 1, 1, C.none)
    g.rect(ex + 2, 13, 1, 1, C.none)
  }
  // grille mouth
  g.rect(13, 15, 6, 1, C.accent)

  // body
  g.rounded(9, 19, 14, 8, C.outline, 2)
  g.rect(10, 20, 12, 6, C.shellDark)
  g.rect(11, 21, 10, 3, C.accent)
  g.rect(12, 25, 8, 1, C.outline)

  // arms
  g.rect(5, 20, 3, 6, C.outline)
  g.rect(6, 21, 1, 4, C.shell)
  g.rect(24, 20, 3, 6, C.outline)
  g.rect(25, 21, 1, 4, C.shell)

  // legs + feet
  g.rect(11, 27, 3, 2, C.outline)
  g.rect(18, 27, 3, 2, C.outline)
  g.rounded(9, 29, 6, 2, C.outline, u)
  g.rounded(17, 29, 6, 2, C.outline, u)

  return g.px
}

/* ---------------------------------------------------------------- writing -- */

mkdirSync(join(BUILD, 'icons'), { recursive: true })

const master = 512
writeFileSync(join(BUILD, 'icon.png'), encodePng(master, master, drawRobot(master)))

const linuxSizes = [16, 24, 32, 48, 64, 128, 256, 512]
for (const size of linuxSizes) {
  writeFileSync(join(BUILD, 'icons', `${size}x${size}.png`), encodePng(size, size, drawRobot(size, { simplified: size < 48 })))
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
writeFileSync(
  join(BUILD, 'icon.ico'),
  encodeIco(icoSizes.map((size) => ({ size, data: encodePng(size, size, drawRobot(size, { simplified: size < 48 })) })))
)

writeFileSync(join(BUILD, 'tray.png'), encodePng(32, 32, drawRobot(32, { simplified: true })))

console.log(`[icons] wrote build/icon.png, build/icon.ico, build/tray.png and ${linuxSizes.length} Linux sizes`)
