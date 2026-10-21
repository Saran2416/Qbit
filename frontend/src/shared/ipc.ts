import type {
  AppSettings,
  AppStateSnapshot,
  BackendStatus,
  GameEventData,
  GameId,
  InboundMessage,
  OutboundMessage,
  Rect,
  ScreenTimeStats,
  SpriteAtlasPayload,
  VirtualLayout
} from './types'

/** Channel names. Prefixed so they are easy to grep from either side. */
export const IPC = {
  /* renderer -> main */
  getSnapshot: 'qbit:get-snapshot',
  getStats: 'qbit:get-stats',
  updateSettings: 'qbit:update-settings',
  setRegions: 'qbit:set-regions',
  openPanel: 'qbit:open-panel',
  closePanel: 'qbit:close-panel',
  openGame: 'qbit:open-game',
  closeGame: 'qbit:close-game',
  reportGame: 'qbit:report-game',
  addReminder: 'qbit:add-reminder',
  setLimit: 'qbit:set-limit',
  dismiss: 'qbit:dismiss',
  sendOutbound: 'qbit:send-outbound',
  loadSpriteAtlas: 'qbit:load-sprite-atlas',
  canvasSnapshot: 'qbit:canvas-snapshot',
  quit: 'qbit:quit',
  log: 'qbit:log',

  /* main -> renderer */
  evBackendMessage: 'qbit:ev-backend-message',
  evBackendStatus: 'qbit:ev-backend-status',
  evLayout: 'qbit:ev-layout',
  evSettings: 'qbit:ev-settings',
  evStats: 'qbit:ev-stats',
  evPetCommand: 'qbit:ev-pet-command',
  evPanelState: 'qbit:ev-panel-state',
  evGameResult: 'qbit:ev-game-result'
} as const

export type Unsubscribe = () => void

/** Fire-and-forget hints pushed from main to the overlay. */
export interface PetCommand {
  kind: 'wake' | 'happy' | 'alert' | 'sleep' | 'reload-sprites' | 'snapshot-canvas'
  reason?: string
}

/**
 * The API exposed on `window.qbit` in every renderer window (preload/index.ts
 * implements it, renderer/lib/bridge.ts consumes it).
 */
export interface QbitApi {
  /* push subscriptions */
  onBackendMessage(cb: (msg: InboundMessage) => void): Unsubscribe
  onBackendStatus(cb: (status: BackendStatus) => void): Unsubscribe
  onLayout(cb: (layout: VirtualLayout) => void): Unsubscribe
  onSettings(cb: (settings: AppSettings) => void): Unsubscribe
  onStats(cb: (stats: ScreenTimeStats) => void): Unsubscribe
  onPetCommand(cb: (cmd: PetCommand) => void): Unsubscribe
  onPanelState(cb: (open: boolean) => void): Unsubscribe
  onGameResult(cb: (data: GameEventData) => void): Unsubscribe

  /* queries */
  getSnapshot(): Promise<AppStateSnapshot>
  getStats(): Promise<ScreenTimeStats>
  loadSpriteAtlas(): Promise<SpriteAtlasPayload | null>

  /* actions */
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  setRegions(regions: Rect[]): void
  openPanel(anchor: Rect): Promise<void>
  closePanel(): Promise<void>
  openGame(game: GameId | 'menu'): Promise<void>
  closeGame(): Promise<void>
  reportGame(data: GameEventData): void
  addReminder(text: string, dueAt?: number): Promise<void>
  setLimit(minutes: number): Promise<AppSettings>
  dismiss(id?: string, kind?: string): Promise<void>
  send(msg: OutboundMessage): void
  /** Debug only: hands the overlay canvas to main, which writes it to disk. */
  saveCanvasSnapshot(dataUrl: string): void
  quit(): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}
