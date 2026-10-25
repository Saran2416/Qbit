import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { anchorWindow } from '../shared/geometry'
import type { GameId, Point, Rect, VirtualLayout } from '../shared/types'
import { layoutBounds } from './layout'
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

/** An invisible catcher window plus the rects it currently stands for. */
interface HitSlot {
  win: BrowserWindow
  /** screen-space rect (== the window's bounds) */
  screen: Rect
  /** overlay-local rect (used to map events into the overlay renderer) */
  local: Rect
}

/**
 * The catcher's whole UI: a blank page whose DOM listeners re-send every mouse
 * event to main over IPC. (webContents' own mouse-* events are macOS/Windows
 * only, so the catcher's own renderer is the only cross-platform event source.)
 */
const HIT_SCRIPT = `
  const { ipcRenderer } = require('electron')
  const send = (type, e) => ipcRenderer.send('${IPC.hitEvent}', {
    type,
    x: e.clientX,
    y: e.clientY,
    button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
    clickCount: e.detail || 1
  })
  document.addEventListener('mousemove', (e) => send('mouseMove', e))
  document.addEventListener('mousedown', (e) => { e.preventDefault(); send('mouseDown', e) })
  document.addEventListener('mouseup', (e) => send('mouseUp', e))
  document.addEventListener('contextmenu', (e) => e.preventDefault())
`
const HIT_PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><meta charset="utf-8">' +
      '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style>' +
      `<script>${HIT_SCRIPT}</script>`
  )

/**
 * Invisible input windows, one per interactive region the renderer reports.
 *
 * Each catcher is a tiny transparent, always-on-top window placed exactly over
 * content the pet wants clicks for (its own bbox, a speech bubble, the token
 * chip). Native mouse events on a catcher are re-injected into the overlay's
 * renderer at region-relative coordinates, so buttons behave like ordinary DOM
 * input while the overlay itself stays permanently click-through.
 *
 * This split - a never-moving fullscreen canvas for visuals plus invisible
 * catchers for input - is what makes the pet work on Wayland/XWayland: the
 * global cursor query reports a stale 0,0 there and Electron forwards no mouse
 * moves through a click-through window on Linux, so any design where the
 * overlay must *detect* the cursor is dead on arrival. The overlay also never
 * moves or resizes, so roaming cannot glitch: a moving window drags its
 * contents along and the renderer can only repaint a frame or two later.
 */
class HitWindows {
  private slots: HitSlot[] = []
  private active = 0
  private overlay: Electron.WebContents | null = null
  private paused = false

  attach(overlay: Electron.WebContents): void {
    this.overlay = overlay
  }

  /** regions in screen coords; origin maps them into overlay-local space. */
  setRegions(regions: Rect[], origin: Point): void {
    if (!this.overlay || this.overlay.isDestroyed()) return
    this.active = regions.length
    while (this.slots.length < regions.length) this.slots.push(this.make(this.slots.length))
    regions.forEach((r, i) => {
      const slot = this.slots[i]!
      slot.screen = r
      slot.local = { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height }
    })
    this.apply()
  }

  /** Hide the catchers while another window owns input (panel, game). */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    this.apply()
  }

  destroy(): void {
    for (const slot of this.slots) {
      if (!slot.win.isDestroyed()) slot.win.destroy()
    }
    this.slots = []
  }

  private apply(): void {
    let visibilityChanged = false
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!
      if (slot.win.isDestroyed()) continue
      if (!this.paused && i < this.active) {
        const r = slot.screen
        slot.win.setBounds({
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.max(1, Math.round(r.width)),
          height: Math.max(1, Math.round(r.height))
        })
        if (!slot.win.isVisible()) {
          slot.win.showInactive()
          visibilityChanged = true
        }
      } else if (slot.win.isVisible()) {
        slot.win.hide()
        visibilityChanged = true
      }
    }
    if (visibilityChanged) {
      // Overlapping regions must resolve like the renderer's z-order: the pet
      // first, bubbles/chip later. Window managers restack by creation time,
      // so re-assert the order explicitly whenever the set changes.
      for (let i = 0; i < this.active && i < this.slots.length; i++) {
        const slot = this.slots[i]!
        if (!slot.win.isDestroyed() && slot.win.isVisible()) slot.win.moveTop()
      }
    }
  }

  private make(index: number): HitSlot {
    const win = new BrowserWindow({
      width: 2,
      height: 2,
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
      // The catcher page is our own inline data: URL (no remote content); it
      // needs require('ipcRenderer') to re-send mouse events to main.
      webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: true }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setSkipTaskbar(true)
    win.setFocusable(false)

    const slot: HitSlot = { win, screen: { x: 0, y: 0, width: 2, height: 2 }, local: { x: 0, y: 0, width: 2, height: 2 } }

    // A dead catcher keeps its window mapped and hit-testable but forwards
    // nothing - the GPU process dying takes every renderer with it, and from
    // then on every click on that region (Done button, the pet itself) is
    // silently lost. Rebuild the slot in place so input recovers by itself.
    win.webContents.on('render-process-gone', () => {
      const current = this.slots[index]
      if (!current || current.win !== win) return
      if (!win.isDestroyed()) win.destroy()
      setTimeout(() => {
        const prev = this.slots[index]
        if (!prev || prev.win !== win) return // app is shutting down or slot replaced
        const fresh = this.make(index)
        fresh.screen = prev.screen
        fresh.local = prev.local
        this.slots[index] = fresh
        this.apply()
      }, 500)
    })

    void win.loadURL(HIT_PAGE)
    return slot
  }

  /** Route a mouse event observed by one catcher into the overlay renderer. */
  forwardFrom(sender: Electron.WebContents, raw: unknown): void {
    const target = this.overlay
    if (!target || target.isDestroyed() || this.paused) return
    const slot = this.slots.find((s) => !s.win.isDestroyed() && s.win.webContents === sender)
    if (!slot) return
    const p = raw as { type?: string; x?: number; y?: number; button?: string; clickCount?: number }
    if (!p || (p.type !== 'mouseMove' && p.type !== 'mouseDown' && p.type !== 'mouseUp')) return
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return
    const x = slot.local.x + p.x
    const y = slot.local.y + p.y
    const button = p.button === 'middle' || p.button === 'right' ? p.button : 'left'
    if (p.type === 'mouseMove') {
      target.sendInputEvent({ type: 'mouseMove', x, y, button })
    } else {
      target.sendInputEvent({
        type: p.type,
        x,
        y,
        button,
        clickCount: p.clickCount && p.clickCount > 0 ? p.clickCount : 1
      })
    }
  }
}

/**
 * One transparent, frameless, always-on-top window covering the whole virtual
 * desktop (all monitors): the canvas the pet roams on. It NEVER moves and is
 * permanently click-through; all input is served by the HitWindows catchers.
 */
export class OverlayWindow {
  private win: BrowserWindow | null = null
  private layout: VirtualLayout
  private readonly hits = new HitWindows()

  constructor(private readonly getLayout: () => VirtualLayout) {
    this.layout = getLayout()
  }

  /** The layout the renderer maps through (origin = desktop origin). */
  rendererLayout(): VirtualLayout {
    return this.layout
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
    win.setFocusable(false)
    // Permanently click-through: input belongs to the invisible catcher windows
    // (HitWindows), which re-inject native events into this window's renderer.
    win.setIgnoreMouseEvents(true)
    this.hits.attach(win.webContents)

    win.once('ready-to-show', () => {
      win.showInactive() // never steal focus from the app the user is using
      // Mutter (XWayland) clamps a fullscreen-size window to the work area at
      // map time: the overlay would silently come up 1365x739 on a 1366x768
      // desktop and clip the pet's feet at the canvas edge. The clamp only
      // applies to the initial map, so re-asserting the real bounds after
      // showing gets through - then the canvas covers the whole desktop.
      const mapped = win.getBounds()
      if (
        mapped.x !== bounds.x ||
        mapped.y !== bounds.y ||
        mapped.width !== bounds.width ||
        mapped.height !== bounds.height
      ) {
        log.warn('overlay: WM clamped the window at map time', mapped, '-> restoring', bounds)
        win.setBounds(bounds)
        // Same X11 input-shape race as syncLayout (electron#54423): after a
        // resize, keep asserting click-through so the overlay never eats input.
        try {
          win.setIgnoreMouseEvents(true)
        } catch (err) {
          log.debug('overlay: setIgnoreMouseEvents after map resize failed', err)
        }
      }
      log.info('overlay: shown', bounds)
    })
    win.on('closed', () => {
      this.win = null
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      if (quitting) return
      log.error('overlay: renderer gone, recreating', details.reason)
      // Destroy the dead window before replacing it: recreating without
      // destroying leaks a mapped fullscreen zombie window that lingers
      // above the input catchers.
      if (!win.isDestroyed()) win.destroy()
      this.win = null
      setTimeout(() => {
        if (!quitting) this.create()
      }, 1000)
    })

    void loadPage(win, 'index.html')
  }

  destroy(): void {
    this.hits.destroy()
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
        // Input-shape changes have historically raced X11 resizes (electron#54423).
        try {
          win.setIgnoreMouseEvents(true)
        } catch (err) {
          log.debug('overlay: setIgnoreMouseEvents after resize failed', err)
        }
      }
    }
    this.send(IPC.evLayout, layout)
  }

  /** Interactive regions (overlay-local CSS px): drive the input catchers. */
  setContentRect(localRects: Rect[]): void {
    const origin = this.layout.origin
    this.hits.setRegions(
      localRects.map((r) => ({ x: r.x + origin.x, y: r.y + origin.y, width: r.width, height: r.height })),
      origin
    )
  }

  /** Hide/restore the input catchers (used while panel or game owns input). */
  setCatchersPaused(paused: boolean): void {
    this.hits.setPaused(paused)
  }

  /** A catcher window observed a mouse event; route it into the renderer. */
  forwardHitEvent(sender: Electron.WebContents, payload: unknown): void {
    this.hits.forwardFrom(sender, payload)
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
