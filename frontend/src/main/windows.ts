import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { anchorWindow, containsPoint, toLocal } from '../shared/geometry'
import type { GameId, Point, Rect, VirtualLayout } from '../shared/types'
import { layoutBounds } from './layout'
import { log } from './log'

const PRELOAD = join(__dirname, '../preload/index.js')
const RENDERER_DIR = join(__dirname, '../renderer')

/** Padding around interactive regions to make fast clicks less likely to slip through. */
const HIT_PADDING = 4

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

/**
 * One transparent, frameless, always-on-top window covering the whole virtual
 * desktop (all monitors). The robot is drawn inside it, so roaming is pure
 * canvas maths instead of moving an OS window around at 30 fps.
 *
 * Click-through is enforced here, in the main process: the renderer reports the
 * handful of rectangles that are currently interactive (the robot's bounding
 * box, a speech bubble, the token chip) and we toggle
 * `setIgnoreMouseEvents` based on the polled cursor position. A hung renderer
 * therefore makes the overlay *more* transparent to input, never less.
 */
export class OverlayWindow {
  private win: BrowserWindow | null = null
  private layout: VirtualLayout
  private regions: Rect[] = []
  private ignoring = true
  private interactive = false

  constructor(private readonly getLayout: () => VirtualLayout) {
    this.layout = getLayout()
  }

  create(): void {
    if (this.win && !this.win.isDestroyed()) return
    this.layout = this.getLayout()
    const bounds = layoutBounds(this.layout)

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
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setFocusable(false)

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
  syncLayout(layout: VirtualLayout): void {
    this.layout = layout
    const bounds = layoutBounds(layout)
    const win = this.win
    if (win && !win.isDestroyed()) {
      const current = win.getBounds()
      if (
        current.x !== bounds.x ||
        current.y !== bounds.y ||
        current.width !== bounds.width ||
        current.height !== bounds.height
      ) {
        win.setBounds(bounds)
      }
    }
    this.send(IPC.evLayout, layout)
  }

  /** Interactive rectangles in overlay-local CSS px, reported by the renderer. */
  setRegions(regions: Rect[]): void {
    this.regions = regions
  }

  applyHitTest(point: Point): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const local = toLocal(this.layout, point)
    const inside = this.regions.some((r) => containsPoint(r, local, HIT_PADDING + (r.width < 8 ? 6 : 0)))
    if (inside === this.interactive) return
    this.interactive = inside
    this.ignoring = !inside
    try {
      win.setIgnoreMouseEvents(this.ignoring, { forward: true })
    } catch (err) {
      log.debug('overlay: setIgnoreMouseEvents failed', err)
    }
  }

  /** Used when the pet must not react to the mouse at all (e.g. roaming paused). */
  forceClickThrough(): void {
    this.regions = []
    this.interactive = false
    this.ignoring = true
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.setIgnoreMouseEvents(true, { forward: true })
      } catch {
        /* ignore */
      }
    }
  }

  isInteractive(): boolean {
    return this.interactive
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
