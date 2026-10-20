import { app, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { isInboundType } from '../shared/protocol'
import type { AppSettings, GameEventData, GameId, OutboundMessage, Rect } from '../shared/types'
import type { AppContext } from './context'
import { log, type LogLevel } from './log'
import { loadSpriteAtlas } from './sprites'

const OUTBOUND_TYPES: ReadonlySet<string> = new Set<string>([
  'hello',
  'ping',
  'dismiss',
  'reminder_add',
  'set_limit',
  'set_muted',
  'game_event'
])

const MAX_REGIONS = 32

/**
 * IPC surface. The renderer is untrusted input as far as we are concerned:
 * every payload is validated before it touches the window, the settings file or
 * the socket.
 */
export function registerIpcHandlers(ctx: AppContext): void {
  /* ---------------------------------------------------------------- queries */

  ipcMain.handle(IPC.getSnapshot, () => ({
    layout: ctx.getLayout(),
    settings: ctx.settings.get(),
    stats: ctx.stats.snapshot(),
    backend: ctx.backend.status()
  }))

  ipcMain.handle(IPC.getStats, () => ctx.stats.snapshot())

  ipcMain.handle(IPC.loadSpriteAtlas, () => loadSpriteAtlas())

  /* ---------------------------------------------------------------- actions */

  ipcMain.handle(IPC.updateSettings, (_event, patch: Partial<AppSettings>) => {
    if (!patch || typeof patch !== 'object') return ctx.settings.get()
    return ctx.applySettings(patch)
  })

  ipcMain.on(IPC.setRegions, (_event, regions: unknown) => {
    ctx.overlay.setRegions(sanitizeRegions(regions))
  })

  ipcMain.handle(IPC.openPanel, (_event, anchor: unknown) => {
    const rect = sanitizeRect(anchor)
    ctx.openPanel(rect ?? undefined)
  })

  ipcMain.handle(IPC.closePanel, () => {
    ctx.panel.close()
  })

  ipcMain.handle(IPC.openGame, (_event, game: unknown) => {
    const value = typeof game === 'string' ? game : 'menu'
    const safe: GameId | 'menu' = value === 'reaction' || value === 'rps' || value === 'dodge' ? value : 'menu'
    ctx.openGame(safe)
  })

  ipcMain.handle(IPC.closeGame, () => {
    ctx.game.close()
  })

  ipcMain.on(IPC.reportGame, (_event, data: unknown) => {
    const payload = sanitizeGameEvent(data)
    if (payload) ctx.reportGame(payload)
  })

  ipcMain.handle(IPC.addReminder, (_event, text: unknown, dueAt: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return
    const due = typeof dueAt === 'number' && Number.isFinite(dueAt) ? dueAt : undefined
    ctx.addReminder(text.trim().slice(0, 400), due)
  })

  ipcMain.handle(IPC.setLimit, (_event, minutes: unknown) => {
    const value = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : 120
    return ctx.setLimit(value)
  })

  ipcMain.handle(IPC.dismiss, (_event, id: unknown, kind: unknown) => {
    ctx.dismiss(typeof id === 'string' ? id : undefined, typeof kind === 'string' ? kind : undefined)
  })

  ipcMain.on(IPC.sendOutbound, (_event, message: unknown) => {
    if (!message || typeof message !== 'object') return
    const type = (message as { type?: unknown }).type
    if (typeof type !== 'string' || !OUTBOUND_TYPES.has(type)) {
      log.warn('ipc: rejected outbound message', type)
      return
    }
    ctx.backend.send(message as OutboundMessage)
  })

  ipcMain.on(IPC.quit, () => ctx.quit())

  ipcMain.on(IPC.canvasSnapshot, (_event, dataUrl: unknown) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return
    const target = process.env.QBIT_CAPTURE
      ? process.env.QBIT_CAPTURE.replace(/\.png$/i, '') + '.canvas.png'
      : join(app.getPath('userData'), 'overlay-canvas.png')
    try {
      writeFileSync(target, Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'))
      log.info(`overlay canvas snapshot written to ${target}`)
    } catch (err) {
      log.warn('could not write canvas snapshot', err)
    }
  })

  ipcMain.on(IPC.log, (_event, level: unknown, message: unknown) => {
    const lvl: LogLevel = level === 'debug' || level === 'warn' || level === 'error' ? level : 'info'
    log[lvl]('[renderer]', typeof message === 'string' ? message : '')
  })
}

/* -------------------------------------------------------------- validation */

export function sanitizeRegions(value: unknown): Rect[] {
  if (!Array.isArray(value)) return []
  const out: Rect[] = []
  for (const item of value.slice(0, MAX_REGIONS)) {
    const rect = sanitizeRect(item)
    if (rect) out.push(rect)
  }
  return out
}

function sanitizeRect(value: unknown): Rect | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Partial<Rect>
  const nums = [r.x, r.y, r.width, r.height]
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null
  return {
    x: Math.round(r.x as number),
    y: Math.round(r.y as number),
    width: Math.max(1, Math.round(r.width as number)),
    height: Math.max(1, Math.round(r.height as number))
  }
}

function sanitizeGameEvent(value: unknown): GameEventData | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<GameEventData>
  if (v.game !== 'reaction' && v.game !== 'rps' && v.game !== 'dodge') return null
  if (v.event !== 'start' && v.event !== 'end') return null
  return {
    game: v.game,
    event: v.event,
    score: typeof v.score === 'number' && Number.isFinite(v.score) ? Math.round(v.score) : undefined,
    detail: typeof v.detail === 'string' ? v.detail.slice(0, 120) : undefined
  }
}

/** Re-exported so the mock backend and tests can reuse the same guard. */
export { isInboundType }
