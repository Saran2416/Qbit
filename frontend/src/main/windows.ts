import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { anchorWindow, displayAt } from '../shared/geometry'
import type { GameId, Rect, VirtualLayout } from '../shared/types'
import { log } from './log'

const PRELOAD = join(__dirname, '../preload/index.js')
const RENDERER_DIR = join(__dirname, '../renderer')

/**
 * Set while the app is shutting down so a dying renderer (which is normal during
 * quit) does not try to recreate its window.
 */
let quitting = false

export function markQuitting(): void {
  quitting = true
}

async function loadPage(win: BrowserWindow, page: string, query?: Record<string, string>): Promise<void> {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  try {
    if (devServer) {
      const base = devServer.replace(/\/+$/, '')
      const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
      await win.loadURL(`${base}/${page}${qs}`)
    } else {
      await win.loadFile(join(RENDERER_DIR, page), query ? { query } : undefined)
    }
  } catch (err) {
    log.error(`window: failed to load ${page}`, err)
  }
}

function webPreferences() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    // The overlay must keep animating even when unfocused/occluded.
    backgroundThrottling: false,
    spellcheck: false,
    devTools: !process.env.QBIT_NO_DEVTOOLS
  }
}

/* ------------------------------------------------------------------ overlay */

/** Smallest overlay window (a pet at default scale needs ~160 px). */
const VIEWPORT_MIN = { width: 160, height: 160 }
/** Extra window space around the interactive content. */
const VIEWPORT_PAD = 24
/** Content must leave this margin before the window re-positions (stick-slip). */
const VIEWPORT_KEEP = 64

function initialBounds(desktop: VirtualLayout): Rect {
  const primary = desktop.displays.find((d) => d.primary) ?? desktop.displays[0]!
  const area = primary.workArea
  return {
    x: Math.round(area.x + (area.width - VIEWPORT_MIN.width) / 2),
    y: Math.round(area.y + (area.height - VIEWPORT_MIN.height) / 2),
    width: VIEWPORT_MIN.width,
    height: VIEWPORT_MIN.height
  }
}

function withWindowBounds(desktop: VirtualLayout, bounds: Rect): VirtualLayout {
  return {
    origin: { x: bounds.x, y: bounds.y },
    size: { width: bounds.width, height: bounds.height },
    scaleFactor: desktop.scaleFactor,
    displays: desktop.displays
  }
}

/**
 * A small transparent, frameless, always-on-top window that hugs whatever the
 * pet is showing (itself, a speech bubble, the token chip) and follows it
 * around the virtual desktop.
 *
 * This replaces the old design: one fullscreen window, click-through except in
 * regions chosen by polling the global cursor position. That design cannot
 * work on Wayland/XWayland - the global cursor query reports a stale 0,0 there,
 * and Electron's mouse-move "forwarding" for click-through windows delivers
 * nothing on Linux - so the overlay could never learn where the cursor was and
 * stayed click-through forever: nothing, including reminder Done buttons, was
 * ever clickable.
 *
 * Because this window only ever covers interactive content, it is a normal
 * input-accepting window: enter/move/click arrive natively on every display
 * server, and everything the pet does not claim (the rest of the screen) still
 * belongs to the desktop.
 */
export class OverlayWindow {
  private win: BrowserWindow | null = null
  /** Full virtual desktop (display list, virtual bounds). */
  private desktop: VirtualLayout
  /** What the renderer renders against: origin/size describe the window itself. */
  private layout: VirtualLayout

  constructor(private readonly getLayout: () => VirtualLayout) {
    this.desktop = getLayout()
    this.layout = withWindowBounds(this.desktop, initialBounds(this.desktop))
  }

  /** The layout the renderer maps through (origin = window position). */
  rendererLayout(): VirtualLayout {
    return this.layout
  }

  create(): void {
    if (this.win && !this.win.isDestroyed()) return
    this.desktop = this.getLayout()
    const bounds = this.clampBounds({
      x: this.layout.origin.x,
      y: this.layout.origin.y,
      width: this.layout.size.width,
      height: this.layout.size.height
    })
    this.layout = withWindowBounds(this.desktop, bounds)

    const options: BrowserWindowConstructorOptions = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      acceptFirstMouse: true,
      show: false,
      type: process.platform === 'linux' ? 'toolbar' : undefined,
      webPreferences: webPreferences()
    }

    const win = new BrowserWindow(options)
    this.win = win

    // Above normal always-on-top windows (notification bubbles, docks, ...),
    // without hijacking fullscreen video.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
    win.setSkipTaskbar(true)
    win.setFocusable(false)
    // Deliberately never setIgnoreMouseEvents: the window only covers content
    // the pet wants clicks for (see class docs).

    win.once('ready-to-show', () => {
      win.showInactive() // never steal focus from the app the user is using
      log.info('overlay: shown', bounds)
    })
    win.on('closed', () => {
      this.win = null
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      if (quitting) return
      log.error('overlay: renderer gone, recreating', details.reason)
      this.win = null
      setTimeout(() => {
        if (!quitting) this.create()
      }, 1000)
    })

    void loadPage(win, 'index.html')
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  send(channel: string, payload?: unknown): void {
    if (!this.win || this.win.isDestroyed()) return
    try {
      this.win.webContents.send(channel, payload)
    } catch {
      /* window is going away */
    }
  }

  /** Called when displays are added/removed/rescaled. */
  syncLayout(desktop: VirtualLayout): void {
    this.desktop = desktop
    const win = this.win
    const current =
      win && !win.isDestroyed()
        ? win.getBounds()
        : {
            x: this.layout.origin.x,
            y: this.layout.origin.y,
            width: this.layout.size.width,
            height: this.layout.size.height
          }
    this.applyBounds(this.clampBounds(current))
    this.send(IPC.evLayout, this.layout) // display list may have changed
  }

  /**
   * Interactive rectangles the renderer is currently drawing (robot bbox,
   * bubble, chip - overlay-local CSS px). The window hugs their union: big
   * enough to show everything, small enough to leave the desktop alone.
   */
  setContentRect(localRects: Rect[]): void {
    const origin = this.layout.origin
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const r of localRects) {
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue
      if (!(r.width > 0) || !(r.height > 0)) continue
      x0 = Math.min(x0, r.x)
      y0 = Math.min(y0, r.y)
      x1 = Math.max(x1, r.x + r.width)
      y1 = Math.max(y1, r.y + r.height)
    }
    if (!Number.isFinite(x0)) return // nothing on screen: keep the window as-is
    const want: Rect = {
      x: origin.x + x0 - VIEWPORT_PAD,
      y: origin.y + y0 - VIEWPORT_PAD,
      width: x1 - x0 + VIEWPORT_PAD * 2,
      height: y1 - y0 + VIEWPORT_PAD * 2
    }
    const win = this.win
    const cur =
      win && !win.isDestroyed()
        ? win.getBounds()
        : { x: origin.x, y: origin.y, width: this.layout.size.width, height: this.layout.size.height }
    // Stick-slip: only move when content would leave the keep-in margin, so a
    // roaming pet translates the window a few times a minute, not 30x a second.
    const fits =
      want.x >= cur.x + VIEWPORT_KEEP &&
      want.y >= cur.y + VIEWPORT_KEEP &&
      want.x + want.width <= cur.x + cur.width - VIEWPORT_KEEP &&
      want.y + want.height <= cur.y + cur.height - VIEWPORT_KEEP
    if (fits) return
    this.applyBounds(this.clampBounds(want))
  }

  /** Keep a window rect fully inside the display it mostly sits on. */
  private clampBounds(b: Rect): Rect {
    const display = displayAt(this.desktop, { x: b.x + b.width / 2, y: b.y + b.height / 2 })
    const area = display.workArea
    const width = Math.min(Math.max(b.width, VIEWPORT_MIN.width), area.width)
    const height = Math.min(Math.max(b.height, VIEWPORT_MIN.height), area.height)
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width)
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height)
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  }

  private applyBounds(bounds: Rect): void {
    this.layout = withWindowBounds(this.desktop, bounds)
    const win = this.win
    if (!win || win.isDestroyed()) return
    const cur = win.getBounds()
    if (cur.x === bounds.x && cur.y === bounds.y && cur.width === bounds.width && cur.height === bounds.height) {
      return
    }
    win.setBounds(bounds)
    this.send(IPC.evLayout, this.layout)
  }

  /**
   * Screenshots the overlay's own contents (works even on X servers that cannot
   * do XGetImage on the root window). Used by the QBIT_CAPTURE debug hook.
   */
  async capture(): Promise<Buffer | null> {
    const win = this.win
    if (!win || win.isDestroyed()) return null
    try {
      const image = await win.capturePage()
      return image.isEmpty() ? null : image.toPNG()
    } catch (err) {
      log.warn('overlay: capture failed', err)
      return null
    }
  }
}

/* -------------------------------------------------------------------- panel */

export class PanelWindow {
  private win: BrowserWindow | null = null
  private openSince = 0
  private opened = false
  private panelSize = { width: 380, height: 560 }

  constructor(
    private readonly getLayout: () => VirtualLayout,
    private readonly onStateChange: (open: boolean) => void,
    private readonly initialQuery: Record<string, string> = {}
  ) {}

  isOpen(): boolean {
    return this.opened
  }

  open(anchor: Rect): void {
    const win = this.ensure()
    const position = anchorWindow(this.getLayout(), anchor, this.panelSize)
    win.setBounds({ x: position.x, y: position.y, width: this.panelSize.width, height: this.panelSize.height })
    this.openSince = Date.now()
    this.opened = true
    win.show()
    win.focus()
    this.onStateChange(true)
  }

  close(): void {
    if (!this.win || this.win.isDestroyed()) {
      this.opened = false
      return
    }
    if (!this.opened) return
    this.opened = false
    this.win.hide()
    this.onStateChange(false)
  }

  send(channel: string, payload?: unknown): void {
    if (!this.win || this.win.isDestroyed() || !this.opened) return
    try {
      this.win.webContents.send(channel, payload)
    } catch {
      /* ignore */
    }
  }

  destroy(): void {
    this.opened = false
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    const win = new BrowserWindow({
      width: this.panelSize.width,
      height: this.panelSize.height,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      acceptFirstMouse: true,
      title: 'Qbit',
      type: process.platform === 'linux' ? 'toolbar' : undefined,
      webPreferences: webPreferences()
    })
    this.win = win
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })

    // "Auto close on outside click": when the panel loses focus because the
    // user clicked another app, hide it. The click already reached the app
    // below (we never swallow it), and a 250 ms guard avoids closing on the
    // blur that can immediately follow show()+focus().
    win.on('blur', () => {
      if (Date.now() - this.openSince < 250) return
      this.close()
    })
    win.on('closed', () => {
      this.win = null
      if (this.opened) {
        this.opened = false
        this.onStateChange(false)
      }
    })

    void loadPage(win, 'panel.html', this.initialQuery)
    return win
  }
}

/* --------------------------------------------------------------------- game */

export class GameWindow {
  private win: BrowserWindow | null = null
  private current: GameId | 'menu' | null = null
  private size = { width: 440, height: 600 }

  constructor(
    private readonly getLayout: () => VirtualLayout,
    private readonly onClosed: () => void
  ) {}

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible()
  }

  open(game: GameId | 'menu', anchor?: Rect): void {
    const win = this.ensure(game)
    if (anchor && !win.isVisible()) {
      const position = anchorWindow(this.getLayout(), anchor, this.size)
      win.setBounds({ x: position.x, y: position.y, width: this.size.width, height: this.size.height })
    }
    win.show()
    win.focus()
  }

  close(): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.close()
  }

  send(channel: string, payload?: unknown): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return
    try {
      this.win.webContents.send(channel, payload)
    } catch {
      /* ignore */
    }
  }

  ensure(game: GameId | 'menu'): BrowserWindow {
    if (this.win && !this.win.isDestroyed() && this.current === game) return this.win
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy()
      this.win = null
    }
    this.current = game

    const { x, y } = anchorWindow(
      this.getLayout(),
      { x: this.getLayout().size.width / 2, y: this.getLayout().size.height / 2, width: 0, height: 0 },
      this.size
    )
    const win = new BrowserWindow({
      x,
      y,
      width: this.size.width,
      height: this.size.height,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'Qbit arcade',
      webPreferences: webPreferences()
    })
    this.win = win
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
    win.on('closed', () => {
      this.win = null
      this.current = null
      this.onClosed()
    })
    void loadPage(win, 'game.html', { game })
    return win
  }
}
