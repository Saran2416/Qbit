import { app } from 'electron'
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { AtlasMeta, PetClip, SpriteAtlasPayload } from '../shared/types'
import { log } from './log'

const CLIP_NAMES: PetClip[] = ['idle', 'walk', 'sleep', 'alert', 'happy']

/**
 * Optional real art. We look for `robot.json` + the sheet it points at in
 * (in order) the user's data dir, the packaged resources dir and the repo's
 * `sprites/` folder, and hand the renderer a data: URL. If nothing is found the
 * renderer generates the placeholder robot procedurally, so the app never
 * depends on art being present.
 */
export function spriteSearchPaths(): string[] {
  const paths = [join(app.getPath('userData'), 'sprites'), join(process.resourcesPath ?? '', 'sprites'), join(process.cwd(), 'sprites')]
  return paths.filter(Boolean)
}

export function loadSpriteAtlas(): SpriteAtlasPayload | null {
  for (const dir of spriteSearchPaths()) {
    try {
      const metaPath = join(dir, 'robot.json')
      if (!existsSync(metaPath)) continue

      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as AtlasMeta
      const sheetName = typeof meta.image === 'string' && meta.image ? meta.image : 'robot.png'
      const sheetPath = join(dir, sheetName)
      if (!existsSync(sheetPath)) {
        log.warn('sprites: robot.json found but sheet missing', sheetPath)
        continue
      }
      if (!isUsableMeta(meta)) {
        log.warn('sprites: robot.json is missing frameWidth/frameHeight/clips', metaPath)
        continue
      }

      const data = readFileSync(sheetPath)
      const ext = sheetName.toLowerCase().endsWith('.jpg') || sheetName.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png'
      const payload: SpriteAtlasPayload = {
        meta: normalise(meta),
        imageDataUrl: `data:image/${ext};base64,${data.toString('base64')}`,
        source: dir
      }
      log.info('sprites: loaded custom atlas from', dir)
      return payload
    } catch (err) {
      log.warn('sprites: failed to load atlas from', dir, err)
    }
  }
  return null
}

/** Watches every sprite dir so dropping in new art reloads live. */
export function watchSpriteDirs(onChange: () => void): () => void {
  const watchers: FSWatcher[] = []
  for (const dir of spriteSearchPaths()) {
    try {
      if (!existsSync(dir)) continue
      const watcher = watch(dir, { persistent: false }, () => {
        log.info('sprites: change detected in', dir)
        onChange()
      })
      watchers.push(watcher)
    } catch {
      /* watching is best-effort */
    }
  }
  return () => {
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
    }
  }
}

function isUsableMeta(meta: unknown): meta is AtlasMeta {
  if (!meta || typeof meta !== 'object') return false
  const m = meta as AtlasMeta
  return (
    typeof m.frameWidth === 'number' &&
    m.frameWidth > 0 &&
    typeof m.frameHeight === 'number' &&
    m.frameHeight > 0 &&
    !!m.clips &&
    typeof m.clips === 'object'
  )
}

function normalise(meta: AtlasMeta): AtlasMeta {
  const clips: AtlasMeta['clips'] = {}
  for (const name of CLIP_NAMES) {
    const clip = meta.clips[name]
    if (!clip) continue
    clips[name] = {
      row: Math.max(0, Math.floor(clip.row ?? 0)),
      frames: Math.max(1, Math.floor(clip.frames ?? 1)),
      fps: Math.min(60, Math.max(0.5, clip.fps ?? 8)),
      loop: clip.loop !== false
    }
  }
  return {
    frameWidth: Math.floor(meta.frameWidth),
    frameHeight: Math.floor(meta.frameHeight),
    image: typeof meta.image === 'string' ? meta.image : 'robot.png',
    renderScale: typeof meta.renderScale === 'number' && meta.renderScale > 0 ? meta.renderScale : 1,
    anchor: {
      x: typeof meta.anchor?.x === 'number' ? meta.anchor.x : 0.5,
      y: typeof meta.anchor?.y === 'number' ? meta.anchor.y : 1
    },
    clips
  }
}
