import type {
  AppSettings,
  GameEventData,
  GameId,
  Rect,
  ScreenTimeStats,
  VirtualLayout
} from '../shared/types'
import type { BackendClient } from './ws-client'
import type { GameWindow, OverlayWindow, PanelWindow } from './windows'
import type { SettingsStore } from './settings-store'
import type { StatsStore } from './stats-store'
import type { TrayController } from './tray'

/**
 * Everything the IPC layer, the tray and the backend client may touch. `index.ts`
 * builds exactly one of these; nothing else is a singleton, which keeps the
 * wiring visible in one place.
 */
export interface AppContext {
  overlay: OverlayWindow
  panel: PanelWindow
  game: GameWindow
  backend: BackendClient
  settings: SettingsStore
  stats: StatsStore
  tray: TrayController

  getLayout(): VirtualLayout
  statsSnapshot(): ScreenTimeStats

  /** Sends to every live window (overlay + panel + game). */
  broadcast(channel: string, payload?: unknown): void
  sendToOverlay(channel: string, payload?: unknown): void
  refreshStatus(): void

  applySettings(patch: Partial<AppSettings>): AppSettings
  openPanel(anchor?: Rect): void
  openGame(game: GameId | 'menu'): void
  reportGame(data: GameEventData): void
  addReminder(text: string, dueAt?: number): void
  setLimit(minutes: number): void
  /**
   * `text`/`dueAt` let us also cancel the local twin of a backend reminder
   * (panel adds create one in each place).
   */
  dismiss(id?: string, kind?: string, text?: string, dueAt?: number): void
  quit(): void
}
