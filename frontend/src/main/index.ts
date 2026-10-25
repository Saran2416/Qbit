import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, screen, shell } from 'electron'
import { IPC, type PetCommand } from '../shared/ipc'
import type { AppSettings, GameEventData, GameId, InboundMessage, Rect, VirtualLayout } from '../shared/types'
import type { AppContext } from './context'
import { registerIpcHandlers } from './ipc-handlers'
import { computeLayout } from './layout'
import { initLogFile, log } from './log'
import { ReminderScheduler } from './reminders'
import { SettingsStore } from './settings-store'
import { watchSpriteDirs } from './sprites'
import { StatsStore } from './stats-store'
import { TrayController } from './tray'
import { BackendClient } from './ws-client'
import { GameWindow, OverlayWindow, PanelWindow, markQuitting } from './windows'

/* --------------------------------------------------------------------------
 * Command line switches. These MUST be set before the app is ready.
 * ------------------------------------------------------------------------ */

if (process.platform === 'linux') {
  /*
   * Linux: force X11 (XWayland is fine on Wayland desktops).
   *
   * Electron defaults to native Wayland on a Wayland session, where
   *   - there is no global cursor polling at all (no equivalent of XQueryPointer),
   *   - windows cannot be positioned freely (no global coordinates) and
   *   - click-through via setIgnoreMouseEvents is not implemented.
   * Our whole design (flee-the-cursor, a full-virtual-desktop overlay, per-pixel
   * click-through) therefore needs X11/XWayland. Passing the switch explicitly
   * also fixes the common case where the user runs the AppImage under Wayland.
   */
  const userAsked = process.argv.some((arg) => arg.startsWith('--ozone-platform'))
  if (!userAsked) app.commandLine.appendSwitch('ozone-platform', 'x11')
  // Helps some X11 drivers/shadow-mitigation setups render a truly transparent window.
  app.commandLine.appendSwitch('enable-transparent-visuals')
}

app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// Set the app name explicitly: Electron defaults to "Qbit Pet" from the
// productName in package.json, which makes the settings path
// ~/.config/Qbit Pet on Linux (spaces).
app.setName('qbit-pet')

/* --------------------------------------------------------------------------
 * GPU fallback.
 *
 * Some driver stacks (VA-API on hybrid GPUs, VMs, broken Intel/NVIDIA combos)
 * segfault Chromium's GPU process: it dies and respawns once a second, forever,
 * flooding the log with vaInitialize / GpuControl noise. Worse, every
 * in-process workaround on an XWayland setup either keeps the crash loop or
 * hides the pet entirely:
 *
 *   app.disableHardwareAcceleration()  -> X11 software bitmap presenter, window
 *                                         never maps (pet invisible)
 *   LIBGL_ALWAYS_SOFTWARE=1 env vars   -> no crash, but the window still never maps
 *   app.commandLine.appendSwitch(...)  -> GPU switches are read before JS runs
 *
 * The only thing that both silences the crashes and maps the window is
 * Chromium's SwiftShader backend selected via REAL argv flags, before Electron
 * starts:
 *
 *   --use-gl=angle --use-angle=swiftshader
 *
 * After two GPU crashes we remember the choice in the data directory and
 * relaunch with those flags (packaged / `electron .` runs). A relaunch in dev
 * mode would kill the vite dev server (electron-vite exits when this process
 * closes), so `npm run dev` goes through tools/dev.mjs, which reads the same
 * marker and hands the flags to electron-vite via ELECTRON_CLI_ARGS.
 *
 *   QBIT_DISABLE_GPU=1   force software rendering
 *   QBIT_ENABLE_GPU=1    ignore the marker, try hardware acceleration again
 * ------------------------------------------------------------------------ */

const GPU_FALLBACK_MARKER = 'gpu-software-rendering'
/**
 * SwiftShader flags. On Linux they only take effect together with
 * --ozone-platform=x11 on the REAL argv: with the GPU process in software
 * mode the window fails to map when the browser process started as native
 * Wayland (appendSwitch is too late for both switches).
 */
const GPU_SOFTWARE_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  ...(process.platform === 'linux' && !process.argv.some((a) => a.startsWith('--ozone-platform'))
    ? ['--ozone-platform=x11']
    : [])
]

function gpuFallbackMarkerPath(): string {
  return join(app.getPath('userData'), GPU_FALLBACK_MARKER)
}

/** True when this process already carries the SwiftShader flags. */
function gpuHasSoftwareArgs(): boolean {
  return process.argv.includes('--use-gl=angle') && process.argv.includes('--use-angle=swiftshader')
}

/**
 * Remember the choice and move to SwiftShader. Packaged builds can relaunch
 * with the flags; in dev mode the vite dev server lives in electron-vite,
 * which exits when this process exits, so we only write the marker and tell
 * the user to restart `npm run dev` (the launcher passes the flags then).
 */
function switchToSoftwareGpu(reason: string): void {
  const devMode = !!process.env.ELECTRON_RENDERER_URL
  try {
    writeFileSync(gpuFallbackMarkerPath(), `${new Date().toISOString()} reason=${reason}\n`)
  } catch {
    /* best effort */
  }
  log.info(
    `gpu: remembered in ${gpuFallbackMarkerPath()} - delete it or set QBIT_ENABLE_GPU=1 to retry hardware acceleration`
  )
  if (devMode) {
    log.warn(`gpu: cannot relaunch with software rendering in dev mode (${reason}) - restart via "npm run dev" to apply`)
    return
  }
  if (gpuHasSoftwareArgs()) return // already running on SwiftShader
  log.info(`gpu: relaunching with SwiftShader software rendering (${reason})`)
  app.relaunch({ args: [...process.argv.slice(1), ...GPU_SOFTWARE_ARGS] })
  app.exit(0)
}

/* -------------------------------------------------------------------------
 * Dev/test affordance: run against a different data directory. This also
 * lifts the single-instance lock (it lives in userData), so a second copy -
 * e.g. on a scratch Xvfb display - can be E2E-tested without touching the
 * live session, its settings, or its sqlite.
 *
 *   QBIT_USER_DATA=/tmp/qbit-test npm start
 * ------------------------------------------------------------------------ */
if (process.env.QBIT_USER_DATA) app.setPath('userData', process.env.QBIT_USER_DATA)

const gpuForcedOff = process.env.QBIT_DISABLE_GPU === '1'
const gpuWantedOn = process.env.QBIT_ENABLE_GPU === '1'
const gpuArgsPresent = gpuHasSoftwareArgs()

let gpuRemembered = false
if (!gpuWantedOn && !gpuArgsPresent) {
  try {
    gpuRemembered = gpuForcedOff || existsSync(gpuFallbackMarkerPath())
  } catch {
    gpuRemembered = gpuForcedOff // the marker is a hint, never a hard failure
  }
}
if (gpuRemembered) switchToSoftwareGpu(gpuForcedOff ? 'QBIT_DISABLE_GPU=1' : 'remembered marker')
else if (gpuArgsPresent) log.info('gpu: hardware acceleration off - software rendering (SwiftShader argv)')

let gpuGoneCount = 0
app.on('child-process-gone', (_event, details) => {
  if (String(details.type).toLowerCase() !== 'gpu' || details.reason === 'clean-exit') return
  gpuGoneCount += 1
  if (gpuWantedOn || gpuArgsPresent) {
    log.warn(`gpu: process gone again (${details.reason})`)
    return
  }
  log.warn(`gpu: process gone (${details.reason}), ${gpuGoneCount}/2 before falling back`)
  if (gpuGoneCount < 2) return
  switchToSoftwareGpu(`crashed ${gpuGoneCount} times (${details.reason})`)
})

const TICK_MS = 5_000
const PERSIST_MS = 30_000

let ctx: AppContext | null = null
let mockProcess: ChildProcess | null = null
let stopWatchingSprites: (() => void) | null = null

/* ------------------------------------------------------------------ helpers */

function getLayout(): VirtualLayout {
  return computeLayout()
}

/* -------------------------------------------------------------------- setup */

function bootstrap(): void {
  initLogFile(app.getPath('userData'))
  log.info(`qbit-pet starting: platform=${process.platform} electron=${process.versions.electron} packaged=${app.isPackaged}`)

  app.setAppUserModelId('com.qbit.desktoppet')
  app.dock?.hide?.()

  const settings = new SettingsStore(app.getPath('userData'))
  const stats = new StatsStore(app.getPath('userData'), settings.get().screenTimeLimitMinutes)
  const backend = new BackendClient(settings.get().wsUrl)
  const reminders = new ReminderScheduler((reminder) => {
    // Local reminders travel the same path as backend reminders.
    ctx?.broadcast(IPC.evBackendMessage, { type: 'reminder', data: reminder } satisfies InboundMessage)
  })

  const overlay = new OverlayWindow(getLayout)
  // The pet's invisible catcher windows float above normal windows, so while
  // the panel or a game owns input they must stand down.
  const syncCatchers = (): void => overlay.setCatchersPaused(panel.isOpen() || game.isOpen())
  const panel = new PanelWindow(getLayout, (open) => {
    syncCatchers()
    overlay.send(IPC.evPanelState, open)
    if (!open) overlay.send(IPC.evPetCommand, { kind: 'wake', reason: 'panel-closed' } satisfies PetCommand)
  })
  const game = new GameWindow(getLayout, () => {
    syncCatchers()
    overlay.send(IPC.evPetCommand, { kind: 'wake', reason: 'game-closed' } satisfies PetCommand)
  })

  const broadcast = (channel: string, payload?: unknown): void => {
    overlay.send(channel, payload)
    panel.send(channel, payload)
    game.send(channel, payload)
  }

  const broadcastStats = (): void => {
    const snapshot = stats.snapshot()
    overlay.send(IPC.evStats, snapshot)
    panel.send(IPC.evStats, snapshot)
  }

  const tray = new TrayController({
    isMuted: () => settings.get().muted,
    isRoamPaused: () => settings.get().roamPaused,
    getStatus: () => backend.status(),
    onToggleMute: (muted) => ctx?.applySettings({ muted }),
    onToggleRoam: (paused) => ctx?.applySettings({ roamPaused: paused }),
    onOpenPanel: () => ctx?.openPanel(),
    onPlay: (gameId) => ctx?.openGame(gameId),
    onWake: () => overlay.send(IPC.evPetCommand, { kind: 'wake', reason: 'tray' } satisfies PetCommand),
    onReloadSprites: () => overlay.send(IPC.evPetCommand, { kind: 'reload-sprites' } satisfies PetCommand),
    onOpenDataFolder: () => void shell.openPath(app.getPath('userData')),
    onQuit: () => ctx?.quit()
  })

  ctx = {
    overlay,
    panel,
    game,
    backend,
    settings,
    stats,
    tray,
    // The renderer maps virtual coordinates through the *window's* origin,
    // which now differs from the desktop origin (viewport overlay).
    getLayout: () => overlay.rendererLayout(),
    statsSnapshot: () => stats.snapshot(),
    broadcast,
    sendToOverlay: (channel, payload) => overlay.send(channel, payload),
    refreshStatus: () => {
      broadcast(IPC.evBackendStatus, backend.status())
      tray.refresh()
    },
    applySettings: (patch: Partial<AppSettings>): AppSettings => {
      const before = settings.get()
      const next = settings.patch(patch)

      if (next.wsUrl !== before.wsUrl) backend.setUrl(next.wsUrl)
      if (next.muted !== before.muted) {
        backend.send({ type: 'set_muted', data: { muted: next.muted } })
        overlay.send(IPC.evPetCommand, { kind: 'wake', reason: 'mute' } satisfies PetCommand)
      }
      if (next.screenTimeLimitMinutes !== before.screenTimeLimitMinutes) {
        stats.setLimit(next.screenTimeLimitMinutes)
        backend.send({ type: 'set_limit', data: { limitMinutes: next.screenTimeLimitMinutes } })
        broadcastStats()
      }
      broadcast(IPC.evSettings, next)
      tray.refresh()
      return next
    },
    openPanel: (anchor?: Rect): void => {
      // Without an explicit anchor (tray, second instance), open next to the
      // pet: the overlay window hugs it. The global cursor query is not usable
      // as an anchor on Wayland (stale 0,0).
      const rect: Rect =
        anchor ??
        (() => {
          const l = overlay.rendererLayout()
          return { x: l.origin.x, y: l.origin.y, width: l.size.width, height: l.size.height }
        })()
      panel.open(rect)
      // Fresh numbers the moment the panel appears.
      panel.send(IPC.evStats, stats.snapshot())
      panel.send(IPC.evBackendStatus, backend.status())
    },
    openGame: (gameId: GameId | 'menu'): void => {
      game.open(gameId)
      syncCatchers()
    },
    reportGame: (data: GameEventData): void => {
      backend.send({ type: 'game_event', data })
      if (data.event === 'end') broadcast(IPC.evGameResult, data)
    },
    addReminder: (text: string, dueAt?: number): void => {
      backend.send({ type: 'reminder_add', data: { text, dueAt } })
      reminders.add(text, dueAt)
    },
    setLimit: (minutes: number): AppSettings => {
      const clamped = Math.min(1440, Math.max(5, Math.round(minutes)))
      return ctx!.applySettings({ screenTimeLimitMinutes: clamped })
    },
    dismiss: (id?: string, kind?: string, text?: string, dueAt?: number): void => {
      backend.send({ type: 'dismiss', data: { id, kind } })
      // A pending local reminder with a backend id twin: cancel it too, or it
      // fires anyway when its own timer comes due.
      if (kind === 'reminder') {
        if (typeof text === 'string' && text) reminders.cancelMatching(text, dueAt)
        else if (typeof id === 'string' && id.startsWith('local-')) reminders.cancel(id)
      }
    },
    quit: (): void => {
      stats.persistIfDirty()
      settings.flush()
      reminders.dispose()
      app.quit()
    }
  }

  registerIpcHandlers(ctx)

  /* ------------------------------------------------------------- backend */

  backend.onStatus(() => ctx?.refreshStatus())
  backend.onMessage((msg) => handleBackendMessage(msg))

  /* -------------------------------------------------------------- windows */

  overlay.create()
  tray.create()

  if (process.env.QBIT_CAPTURE) scheduleCapture()

  if (!app.isPackaged && settings.get().backendAutoStartMock) startMockBackend()

  /* --------------------------------------------------------------- loops */

  const tickTimer = setInterval(() => {
    stats.tick()
    const { warn, totalMinutes, limitMinutes } = stats.checkLimit()
    if (warn) {
      const message = `You have been at the screen for ${Math.round(totalMinutes / 60)}h ${totalMinutes % 60}m today.`
      broadcast(IPC.evBackendMessage, {
        type: 'screen_time_warning',
        data: { minutes: totalMinutes, limit: limitMinutes * 60, message }
      } satisfies InboundMessage)
      overlay.send(IPC.evPetCommand, { kind: 'alert', reason: 'limit' } satisfies PetCommand)
    }
    broadcastStats()
  }, TICK_MS)

  const persistTimer = setInterval(() => {
    stats.persistIfDirty()
    settings.flush()
  }, PERSIST_MS)

  const refreshLayout = (): void => {
    const layout = getLayout()
    overlay.syncLayout(layout)
    broadcast(IPC.evLayout, layout)
  }
  screen.on('display-added', () => refreshLayout())
  screen.on('display-removed', () => refreshLayout())
  screen.on('display-metrics-changed', () => refreshLayout())

  stopWatchingSprites = watchSpriteDirs(() => {
    overlay.send(IPC.evPetCommand, { kind: 'reload-sprites' } satisfies PetCommand)
  })

  backend.connect()

  app.on('before-quit', () => markQuitting())

  app.on('will-quit', () => {
    clearInterval(tickTimer)
    clearInterval(persistTimer)
    stopWatchingSprites?.()
    reminders.dispose()
    stats.persistIfDirty()
    settings.flush()
    mockProcess?.kill()
  })
}

/* --------------------------------------------------------- backend -> UI --- */

function handleBackendMessage(msg: InboundMessage): void {
  if (!ctx) return
  const { stats } = ctx

  switch (msg.type) {
    case 'active_app':
      stats.noteActiveApp(msg.data)
      ctx.sendToOverlay(IPC.evBackendMessage, msg)
      break

    case 'idle_state':
      stats.setIdle(msg.data.idle)
      ctx.sendToOverlay(IPC.evBackendMessage, msg)
      break

    case 'screen_time_stats':
      stats.applyBackendStats(msg.data)
      ctx.broadcast(IPC.evBackendMessage, msg)
      break

    case 'reminder':
      // Backend reminders are shown by the overlay; nothing to persist.
      ctx.broadcast(IPC.evBackendMessage, msg)
      break

    case 'notification':
    case 'screen_time_warning':
    case 'token_usage':
    case 'hello':
    case 'ack':
    case 'error':
      ctx.broadcast(IPC.evBackendMessage, msg)
      if (msg.type === 'error') log.warn('backend reported an error:', msg.data)
      break

    case 'pong':
      break

    default:
      log.debug('unhandled inbound message', msg)
  }
}

/* ------------------------------------------------------------ mock backend - */

/**
 * Debug helper: `QBIT_CAPTURE=/tmp/overlay.png QBIT_CAPTURE_EXIT=1 npm start`
 * writes a PNG of the overlay (robot included) after a few seconds. Handy on
 * machines where the desktop itself cannot be screenshotted.
 */
function scheduleCapture(): void {
  const target = process.env.QBIT_CAPTURE
  if (!target) return
  const delay = Number(process.env.QBIT_CAPTURE_DELAY ?? 6000)
  setTimeout(() => {
    void (async () => {
      ctx?.sendToOverlay(IPC.evPetCommand, { kind: 'snapshot-canvas' } satisfies PetCommand)
      const buffer = await ctx?.overlay.capture()
      if (buffer) {
        try {
          writeFileSync(target, buffer)
          log.info(`overlay screenshot written to ${target}`)
        } catch (err) {
          log.warn('could not write overlay screenshot', err)
        }
      }
      if (process.env.QBIT_CAPTURE_EXIT === '1') app.quit()
    })()
  }, Number.isFinite(delay) ? delay : 6000)
}

function startMockBackend(): void {
  const script = join(process.cwd(), 'tools', 'mock-backend.mjs')
  try {
    mockProcess = spawn(process.execPath, [script, '--fast'], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore'
    })
    mockProcess.on('exit', (code) => log.info('mock backend exited', code))
    log.info('mock backend started (QBIT auto)')
  } catch (err) {
    log.warn('could not start the mock backend', err)
  }
}

/* --------------------------------------------------------------------- app - */

app.on('window-all-closed', () => {
  // Deliberately empty: Qbit lives in the tray, closing windows must not quit.
})

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) event.preventDefault()
  })
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => ctx?.openPanel())
  app.whenReady().then(() => {
    bootstrap()
    // Make sure a stray invisible BrowserWindow can never be created by accident.
    if (BrowserWindow.getAllWindows().length === 0 && !ctx) log.warn('no windows created')
  })
}
