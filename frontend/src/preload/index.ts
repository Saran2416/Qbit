import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type PetCommand, type QbitApi, type Unsubscribe } from '../shared/ipc'
import type {
  AppSettings,
  AppStateSnapshot,
  BackendStatus,
  GameEventData,
  GameId,
  InboundMessage,
  OutboundMessage,
  Point,
  Rect,
  ScreenTimeStats,
  SpriteAtlasPayload,
  VirtualLayout
} from '../shared/types'

/**
 * The only bridge between the sandboxed renderer and the main process. Every
 * method is a thin, typed wrapper: no Node, no fs, no network in the renderer.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: QbitApi = {
  /* ------------------------------------------------------------ push events */
  onBackendMessage: (cb: (msg: InboundMessage) => void) => subscribe(IPC.evBackendMessage, cb),
  onBackendStatus: (cb: (status: BackendStatus) => void) => subscribe(IPC.evBackendStatus, cb),
  onCursor: (cb: (p: Point) => void) => subscribe(IPC.evCursor, cb),
  onLayout: (cb: (layout: VirtualLayout) => void) => subscribe(IPC.evLayout, cb),
  onSettings: (cb: (settings: AppSettings) => void) => subscribe(IPC.evSettings, cb),
  onStats: (cb: (stats: ScreenTimeStats) => void) => subscribe(IPC.evStats, cb),
  onPetCommand: (cb: (cmd: PetCommand) => void) => subscribe(IPC.evPetCommand, cb),
  onPanelState: (cb: (open: boolean) => void) => subscribe(IPC.evPanelState, cb),
  onGameResult: (cb: (data: GameEventData) => void) => subscribe(IPC.evGameResult, cb),

  /* ---------------------------------------------------------------- queries */
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot) as Promise<AppStateSnapshot>,
  getStats: () => ipcRenderer.invoke(IPC.getStats) as Promise<ScreenTimeStats>,
  loadSpriteAtlas: () => ipcRenderer.invoke(IPC.loadSpriteAtlas) as Promise<SpriteAtlasPayload | null>,

  /* ---------------------------------------------------------------- actions */
  updateSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC.updateSettings, patch) as Promise<AppSettings>,
  setRegions: (regions: Rect[]) => ipcRenderer.send(IPC.setRegions, regions),
  openPanel: (anchor: Rect) => ipcRenderer.invoke(IPC.openPanel, anchor) as Promise<void>,
  closePanel: () => ipcRenderer.invoke(IPC.closePanel) as Promise<void>,
  openGame: (game: GameId | 'menu') => ipcRenderer.invoke(IPC.openGame, game) as Promise<void>,
  closeGame: () => ipcRenderer.invoke(IPC.closeGame) as Promise<void>,
  reportGame: (data: GameEventData) => ipcRenderer.send(IPC.reportGame, data),
  addReminder: (text: string, dueAt?: number) => ipcRenderer.invoke(IPC.addReminder, text, dueAt) as Promise<void>,
  setLimit: (minutes: number) => ipcRenderer.invoke(IPC.setLimit, minutes) as Promise<AppSettings>,
  dismiss: (id?: string, kind?: string) => ipcRenderer.invoke(IPC.dismiss, id, kind) as Promise<void>,
  send: (msg: OutboundMessage) => ipcRenderer.send(IPC.sendOutbound, msg),
  saveCanvasSnapshot: (dataUrl: string) => ipcRenderer.send(IPC.canvasSnapshot, dataUrl),
  quit: () => ipcRenderer.send(IPC.quit),
  log: (level, message) => ipcRenderer.send(IPC.log, level, message)
}

contextBridge.exposeInMainWorld('qbit', api)
