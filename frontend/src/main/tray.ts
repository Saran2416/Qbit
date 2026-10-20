import { Menu, Tray, app, shell } from 'electron'
import type { BackendStatus, GameId } from '../shared/types'
import { log } from './log'
import { petNativeImage } from './pixel-icon'

export interface TrayDeps {
  isMuted: () => boolean
  isRoamPaused: () => boolean
  getStatus: () => BackendStatus
  onToggleMute: (muted: boolean) => void
  onToggleRoam: (paused: boolean) => void
  onOpenPanel: () => void
  onPlay: (game: GameId | 'menu') => void
  onWake: () => void
  onReloadSprites: () => void
  onOpenDataFolder: () => void
  onQuit: () => void
}

/**
 * Tray icon: Quit / Mute / Pause roaming plus a few conveniences. On Linux this
 * needs a StatusNotifier/AppIndicator host (GNOME needs an extension) - when
 * there is none the menu simply never appears, which is a documented
 * limitation, not a crash.
 */
export class TrayController {
  private tray: Tray | null = null

  constructor(private readonly deps: TrayDeps) {}

  create(): void {
    if (this.tray) return
    try {
      this.tray = new Tray(this.bestIcon())
      this.tray.setToolTip('Qbit Pet')
      this.tray.on('click', () => {
        // Windows/Linux: left click opens the panel. (On Linux click may not
        // fire at all depending on the desktop environment.)
        this.deps.onOpenPanel()
      })
      this.refresh()
      log.info('tray: created')
    } catch (err) {
      log.error('tray: could not be created', err)
    }
  }

  refresh(): void {
    if (!this.tray) return
    const status = this.deps.getStatus()
    const muted = this.deps.isMuted()
    const paused = this.deps.isRoamPaused()

    const menu = Menu.buildFromTemplate([
      { label: 'Qbit Pet', enabled: false },
      { label: `backend: ${statusLabel(status)}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Mute notifications',
        type: 'checkbox',
        checked: muted,
        click: (item) => this.deps.onToggleMute(item.checked)
      },
      {
        label: 'Pause roaming',
        type: 'checkbox',
        checked: paused,
        click: (item) => this.deps.onToggleRoam(item.checked)
      },
      { type: 'separator' },
      { label: 'Open panel', click: () => this.deps.onOpenPanel() },
      {
        label: 'Play a game',
        submenu: [
          { label: 'Reaction test', click: () => this.deps.onPlay('reaction') },
          { label: 'Rock paper scissors', click: () => this.deps.onPlay('rps') },
          { label: 'Dodge', click: () => this.deps.onPlay('dodge') }
        ]
      },
      { label: 'Wake the robot', click: () => this.deps.onWake() },
      { label: 'Reload sprites', click: () => this.deps.onReloadSprites() },
      { type: 'separator' },
      { label: 'Open data folder', click: () => this.deps.onOpenDataFolder() },
      { label: 'Open log file', click: () => void shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { label: 'Quit Qbit', click: () => this.deps.onQuit() }
    ])

    this.tray.setContextMenu(menu)
    this.tray.setImage(this.bestIcon())
    this.tray.setToolTip(`Qbit Pet - ${statusLabel(status)}${muted ? ' (muted)' : ''}`)
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }

  private bestIcon() {
    // A muted robot is drawn with a red slash: instantly readable in the tray.
    return petNativeImage(32, this.deps.isMuted())
  }
}

function statusLabel(status: BackendStatus): string {
  switch (status.state) {
    case 'open':
      return 'online'
    case 'connecting':
      return 'connecting'
    case 'reconnecting':
      return `offline (retry #${status.attempt})`
    case 'closed':
      return 'disconnected'
    default:
      return 'idle'
  }
}
