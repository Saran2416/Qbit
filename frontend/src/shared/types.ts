/**
 * Every type that crosses a boundary lives here: the WebSocket protocol with
 * the Python backend, the Electron IPC contract and the on-disk shapes.
 *
 *   backend  <--ws-->  main process  <--ipc-->  renderer windows
 *
 * Nothing in this file imports from the rest of the app on purpose: it is the
 * single source of truth the mock backend and the UI both compile against.
 */

/* ------------------------------------------------------------------ geometry */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

export interface DisplayInfo {
  id: number
  label: string
  primary: boolean
  /** Full area of the display, DIP (device independent pixels). */
  bounds: Rect
  /** Area excluding taskbars/docks/panels, DIP. */
  workArea: Rect
  scaleFactor: number
}

/**
 * The union of every display. The pet lives in this coordinate space, always
 * with (0,0) at the top-left corner of the virtual desktop, so the renderer
 * never has to think about negative monitor origins.
 */
export interface VirtualLayout {
  origin: Point
  size: Size
  scaleFactor: number
  displays: DisplayInfo[]
}

/* ------------------------------------------------------------------- backend */

export type AppCategory =
  | 'browser'
  | 'editor'
  | 'media'
  | 'terminal'
  | 'chat'
  | 'game'
  | 'meeting'
  | 'other'

export interface TokenUsage {
  used: number
  limit?: number
  label?: string
  model?: string
  updatedAt?: number
}

export interface ActiveAppData {
  app: string
  title?: string
  category: AppCategory
  pid?: number
  tokens?: TokenUsage
}

export interface ScreenTimeWarningData {
  minutes: number
  limit?: number
  message?: string
}

export interface NotificationData {
  id?: string
  title?: string
  body: string
  app?: string
  category?: AppCategory
  urgent?: boolean
}

export interface ReminderData {
  id?: string
  text: string
  /** Epoch ms. When set the UI can show "in 20 min". */
  dueAt?: number
  source?: 'backend' | 'local'
}

export interface IdleStateData {
  idle: boolean
  idleSeconds?: number
}

export interface TokenUsageData extends TokenUsage {
  app?: string
}

export interface ScreenTimeStatsData {
  date?: string
  totalSeconds: number
  apps: Array<{ app: string; category?: AppCategory; seconds: number }>
  limitMinutes?: number
}

export interface HelloData {
  version?: string
  server?: string
  clientId?: string
  serverTime?: number
}

export interface AckData {
  of?: string
  id?: string
  ok?: boolean
  error?: string
}

export interface ErrorData {
  message: string
  code?: string
}

export interface PongData {
  t?: number
}

/** backend -> UI. `data` is always present (use `{}` when there is none). */
export interface InboundMessageMap {
  hello: HelloData
  active_app: ActiveAppData
  screen_time_warning: ScreenTimeWarningData
  notification: NotificationData
  reminder: ReminderData
  idle_state: IdleStateData
  token_usage: TokenUsageData
  screen_time_stats: ScreenTimeStatsData
  ack: AckData
  error: ErrorData
  pong: PongData
}

export type InboundType = keyof InboundMessageMap

export interface InboundEnvelope<T extends InboundType = InboundType> {
  type: T
  data: InboundMessageMap[T]
  /** Optional server timestamp, echoed by the mock backend. */
  ts?: number
}

/** Discriminated union: switch (msg.type) narrows msg.data for free. */
export type InboundMessage = { [K in InboundType]: InboundEnvelope<K> }[InboundType]

/** UI -> backend. */
export interface OutboundMessageMap {
  hello: { client: string; version: string; platform: string }
  ping: { t: number }
  /** Sent when the user dismisses a bubble. */
  dismiss: { id?: string; kind?: string; all?: boolean }
  reminder_add: { text: string; dueAt?: number }
  set_limit: { limitMinutes: number }
  set_muted: { muted: boolean }
  game_event: { game: GameId; event: 'start' | 'end'; score?: number; detail?: string }
}

export type OutboundType = keyof OutboundMessageMap
export type OutboundMessage = { [K in OutboundType]: { type: K; data: OutboundMessageMap[K] } }[OutboundType]

/* ------------------------------------------------------------- app + window */

export type BackendState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface BackendStatus {
  url: string
  state: BackendState
  /** Consecutive failed attempts (0 while connected). */
  attempt: number
  since: number
  nextRetryAt?: number
  lastError?: string
}

export interface AppUsage {
  app: string
  category: AppCategory
  seconds: number
}

export interface ScreenTimeStats {
  /** Local date key, YYYY-MM-DD. */
  date: string
  totalSeconds: number
  limitMinutes: number
  apps: AppUsage[]
  updatedAt: number
}

export interface AppSettings {
  wsUrl: string
  /** Mute = no bubbles, no alert/happy animations. */
  muted: boolean
  roamPaused: boolean
  screenTimeLimitMinutes: number
  /** Cursor avoidance radius in CSS px. */
  cursorAvoidRadius: number
  /** Walk speed in CSS px per second. */
  roamSpeed: number
  petScale: number
  /** How long the backend must report "idle" before we offer a game. */
  idlePlayOfferDelayMs: number
  bubbleDurationMs: number
  maxBubbles: number
  sleepAfterMs: number
  deepSleepAfterMs: number
  /** Spawn `tools/mock-backend.mjs` automatically in development. */
  backendAutoStartMock: boolean
  showDebug: boolean
}

export interface AppStateSnapshot {
  layout: VirtualLayout
  settings: AppSettings
  stats: ScreenTimeStats
  backend: BackendStatus
}

/* --------------------------------------------------------------- mini games */

export type GameId = 'reaction' | 'rps' | 'dodge'

export interface GameEventData {
  game: GameId
  event: 'start' | 'end'
  score?: number
  detail?: string
}

/* ------------------------------------------------------------------ sprites */

export type PetClip = 'idle' | 'walk' | 'sleep' | 'alert' | 'happy'

export interface AtlasClip {
  row: number
  frames: number
  fps: number
  loop: boolean
}

export interface AtlasMeta {
  frameWidth: number
  frameHeight: number
  image: string
  /** Source px -> CSS px. */
  renderScale: number
  /** Where the pet's "feet" sit inside a frame, 0..1. */
  anchor: Point
  clips: Partial<Record<PetClip, AtlasClip>>
}

export interface SpriteAtlasPayload {
  meta: AtlasMeta
  /** data: URL so the renderer never touches the filesystem. */
  imageDataUrl: string
  source: string
}
