import type {
  AppCategory,
  AppSettings,
  GameEventData,
  GameId,
  InboundMessage,
  PetClip,
  Point,
  TokenUsage
} from '../../shared/types'
import type { Animator } from './animator'
import type { BubbleAction, BubbleHost } from './bubbles'
import type { TokenChip } from './chip'
import type { MotionSnapshot } from './motion'

export type PetBehavior = 'idle' | 'walk' | 'sleep' | 'rest' | 'alert' | 'happy' | 'flee' | 'paused'

export interface BrainSnapshot {
  behavior: PetBehavior
  clip: PetClip
  look: -1 | 0 | 1
  /** true while the overlay must keep running rAF */
  wantsFrames: boolean
  deepSleep: boolean
}

export interface BrainDeps {
  bubbles: BubbleHost
  chip: TokenChip
  animator: Animator
  settings: () => AppSettings
  muted: () => boolean
  openGame: (game: GameId | 'menu') => void
  /** called whenever something needs a redraw / loop restart */
  requestFrame: () => void
  today: () => string
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

const ALERT_MS = 2400
const HAPPY_MS = 1500
const NOTIFICATION_ALERT_MS = 1400
const DUPLICATE_WINDOW_MS = 60_000
const OFFER_TIMEOUT_MS = 30_000

/**
 * The pet's behaviour: maps backend events to animations + bubbles, decides when
 * the robot sleeps, and knows when the overlay may stop its render loop.
 *
 * Reaction table (from the product spec):
 *   active_app  browser -> alert animation + notification bubble
 *   active_app  editor  -> token-usage chip (no bubble, no interruption)
 *   active_app  other   -> neutral idle, no visible change
 *   screen_time_warning -> alert + speech bubble, repeat-safe (deduped)
 *   notification        -> bubble with Dismiss -> sends "dismiss"
 *   reminder            -> bubble with Dismiss -> sends "dismiss"
 *   idle_state idle     -> after a delay, offers "Play a game?"
 *   token_usage         -> chip update (+ warning bubble when over budget)
 */
export class Brain {
  private behavior: PetBehavior = 'idle'
  private override: { clip: PetClip; until: number } | null = null
  private lastInteraction = performance.now()
  private sleepStartedAt = 0
  private deepSleep = false
  private backendIdle = false
  private idleOfferAt = 0
  private idleOfferShown = false
  private lastApp: string | null = null
  private lastTokenUsage: TokenUsage | null = null
  private panelOpen = false
  private gameOpen = false
  private hovered = false
  private look: -1 | 0 | 1 = 0
  private readonly warningsSeen = new Map<string, number>()
  private readonly remindersSeen = new Map<string, number>()

  constructor(private readonly deps: BrainDeps) {}

  /* ------------------------------------------------------------------ input */

  handleMessage(msg: InboundMessage): void {
    switch (msg.type) {
      case 'active_app':
        this.onActiveApp(msg.data.category, msg.data.app, msg.data.title, msg.data.tokens)
        break
      case 'screen_time_warning':
        this.onScreenTimeWarning(msg.data.minutes, msg.data.limit, msg.data.message)
        break
      case 'notification':
        this.markActivity('notification')
        this.overrideClip('alert', NOTIFICATION_ALERT_MS)
        this.show({
          id: msg.data.id,
          kind: 'notification',
          title: msg.data.title ?? (msg.data.urgent ? 'Urgent' : 'Notification'),
          text: msg.data.body,
          tone: msg.data.urgent ? 'warning' : 'info',
          durationMs: msg.data.urgent ? 0 : undefined
        })
        break
      case 'reminder':
        this.onReminder(msg.data.id, msg.data.text, msg.data.dueAt)
        break
      case 'idle_state':
        this.onIdleState(msg.data.idle)
        break
      case 'token_usage':
        this.onTokenUsage(msg.data)
        break
      case 'hello':
        this.deps.log('info', `backend hello: ${JSON.stringify(msg.data)}`)
        this.markActivity('hello')
        break
      case 'error':
        this.deps.log('warn', `backend error: ${msg.data.message}`)
        if (this.deps.settings().showDebug) {
          this.show({ kind: 'bubble', title: 'Backend error', text: msg.data.message, tone: 'warning' })
        }
        break
      case 'screen_time_stats':
      case 'ack':
      case 'pong':
      default:
        break
    }
    this.deps.requestFrame()
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open
    if (open) {
      this.markActivity('panel')
      this.deps.bubbles.dismissByKind('offer')
    } else {
      this.idleOfferShown = false
    }
  }

  setGameOpen(open: boolean): void {
    this.gameOpen = open
    if (open) {
      this.markActivity('game')
      this.deps.bubbles.dismissByKind('offer')
    }
  }

  setHovered(hovered: boolean): void {
    if (hovered && !this.hovered) this.markActivity('hover')
    this.hovered = hovered
  }

  onPetClicked(): void {
    this.markActivity('click')
    this.overrideClip('happy', 900)
  }

  /** External one-off animation (tray "wake", limits, sprite reload, ...). */
  pulse(clip: PetClip, ms: number): void {
    this.markActivity('pulse')
    this.overrideClip(clip, ms)
  }

  onGameResult(data: GameEventData): void {
    if (data.event !== 'end') return
    this.markActivity('game-result')
    this.overrideClip('happy', 2600)
    const label = data.game === 'reaction' ? 'Reaction test' : data.game === 'rps' ? 'Rock paper scissors' : 'Dodge'
    this.show({
      kind: 'game',
      title: `${label} finished`,
      text: data.score !== undefined ? `Score: ${data.score}${data.detail ? ` · ${data.detail}` : ''}` : 'Nice one!',
      tone: 'offer',
      durationMs: 9000
    })
  }

  onBubbleDismissed(kind: string): void {
    if (kind === 'offer') this.idleOfferShown = true
  }

  /** Tray / panel asked the pet to wake up. */
  wake(reason = 'manual'): void {
    this.markActivity(reason)
    this.deepSleep = false
    this.sleepStartedAt = 0
  }

  clearTransientUi(): void {
    this.deps.bubbles.dismissAll(false)
    this.deps.chip.hide()
  }

  /* ---------------------------------------------------------------- reactions */

  private onActiveApp(category: AppCategory, app: string, title?: string, tokens?: TokenUsage): void {
    this.markActivity('active_app')
    this.lastApp = app
    if (tokens) this.lastTokenUsage = tokens

    switch (category) {
      case 'browser': {
        // "browser -> robot shows notification/alert bubbles"
        this.overrideClip('alert', ALERT_MS)
        this.show({
          kind: 'active_app',
          title: app ? `Browsing: ${app}` : 'Browsing',
          text: title ?? 'You are in a browser.',
          tone: 'browser',
          durationMs: 6000,
          dedupeKey: 'active_app:browser'
        })
        break
      }
      case 'editor': {
        // "editor -> shows a token-usage chip"
        const usage: TokenUsage = this.lastTokenUsage ?? tokens ?? { used: 0, label: '—' }
        this.deps.chip.show(usage, app || 'editor')
        if (tokens) this.overrideClip('happy', 1200)
        break
      }
      default:
        // "otherwise a neutral idle behavior": stay quiet, just look around.
        this.overrideClip('idle', 600)
        break
    }
  }

  private onScreenTimeWarning(minutes: number, limitSeconds?: number, message?: string): void {
    this.markActivity('warning')
    // Repeat-safe: one key per day+limit. Inside the cooldown we only refresh the
    // text (no second animation, no second bubble); after it we pulse again but
    // reuse the same bubble.
    const key = `${this.deps.today()}|${limitSeconds ?? 'none'}`
    const seenAt = this.warningsSeen.get(key)
    const isRepeat = seenAt !== undefined && performance.now() - seenAt < DUPLICATE_WINDOW_MS
    this.warningsSeen.set(key, performance.now())

    if (isRepeat) {
      this.deps.bubbles.update('warning-bubble', {
        text: message ?? warningText(minutes, limitSeconds),
        title: `Screen time · ${minutes} min`
      })
      return
    }

    this.overrideClip('alert', 3200)
    this.deps.log('info', `screen time warning (${minutes} min)`)
    this.show({
      id: 'warning-bubble',
      kind: 'screen_time_warning',
      title: `Screen time · ${minutes} min`,
      text: message ?? warningText(minutes, limitSeconds),
      tone: 'warning',
      durationMs: 0, // stays until dismissed: it is actionable information
      actions: [
        {
          label: 'OK',
          primary: true,
          onClick: () => this.deps.bubbles.remove('warning-bubble', true)
        },
        {
          label: 'Open panel',
          onClick: () => {
            this.deps.bubbles.remove('warning-bubble', true)
            this.deps.openGame('menu')
          }
        }
      ]
    })
  }

  private onReminder(id: string | undefined, text: string, dueAt?: number): void {
    this.markActivity('reminder')
    // Key on the text alone: the same reminder travels twice (the local timer
    // in main and the backend's copy) under two different ids, and only one
    // bubble may ever appear for it.
    const key = text.trim()
    const seenAt = this.remindersSeen.get(key)
    if (seenAt !== undefined && performance.now() - seenAt < 30_000) return // backend + local copy
    this.remindersSeen.set(key, performance.now())

    this.overrideClip('alert', 2000)
    this.show({
      id,
      kind: 'reminder',
      title: dueAt ? `Reminder · ${clock(dueAt)}` : 'Reminder',
      text,
      tone: 'reminder',
      durationMs: 0,
      actions: [{ label: 'Done', primary: true, onClick: () => this.deps.bubbles.dismissByKind('reminder') }]
    })
  }

  private onIdleState(idle: boolean): void {
    this.backendIdle = idle
    if (!idle) {
      this.idleOfferAt = 0
      this.idleOfferShown = false
      this.deps.bubbles.dismissByKind('offer')
      this.markActivity('idle-return')
      return
    }
    this.idleOfferAt = performance.now() + this.deps.settings().idlePlayOfferDelayMs
  }

  private onTokenUsage(usage: TokenUsage & { app?: string }): void {
    this.markActivity('token_usage')
    this.lastTokenUsage = usage
    this.deps.chip.show(usage, usage.app ?? this.lastApp ?? undefined)
    if (usage.limit && usage.used >= usage.limit) {
      this.overrideClip('alert', ALERT_MS)
      this.show({
        kind: 'token_usage',
        title: 'Token budget',
        text: `${usage.label ?? 'You'} reached ${usage.used} of ${usage.limit} tokens.`,
        tone: 'warning',
        dedupeKey: 'token-over-budget',
        durationMs: 12_000
      })
    }
  }

  /* ------------------------------------------------------------------- loop */

  update(dtMs: number, motion: MotionSnapshot, cursor: Point | null, opts: { roamPaused: boolean }): BrainSnapshot {
    const now = performance.now()
    const settings = this.deps.settings()

    if (this.override && now >= this.override.until) this.override = null

    // Deep sleep is only allowed while nothing else is happening on screen.
    const hoveringNear = motion.cursorDistance < settings.cursorAvoidRadius * 1.6
    if (this.behavior === 'sleep' && hoveringNear) this.markActivity('cursor-near')

    let behavior: PetBehavior
    const clipOverride = this.override?.clip ?? null

    if (opts.roamPaused) {
      behavior = 'paused'
    } else if (motion.mode === 'flee') {
      behavior = 'flee'
    } else if (motion.mode === 'walk') {
      behavior = 'walk'
    } else if (clipOverride === 'alert' || clipOverride === 'happy') {
      behavior = clipOverride
    } else if (motion.resting) {
      // periodic 10 s break: a light doze, not real sleep (no deep-sleep timer)
      behavior = 'rest'
    } else {
      behavior = this.busy(now, settings) ? 'idle' : 'sleep'
    }

    if (behavior === 'sleep') {
      if (this.sleepStartedAt === 0) this.sleepStartedAt = now
    } else {
      this.sleepStartedAt = 0
      this.deepSleep = false
    }

    const deepCandidate =
      behavior === 'sleep' && this.sleepStartedAt > 0 && now - this.sleepStartedAt > settings.deepSleepAfterMs
    this.deepSleep =
      deepCandidate && !this.hovered && !this.panelOpen && !this.gameOpen && !this.deps.bubbles.active && !this.deps.chip.active

    this.behavior = behavior

    // eyes follow the cursor when it is on the same screen area
    this.look = cursor && motion.cursorDistance < 420 ? (cursor.x < motion.x - 8 ? -1 : cursor.x > motion.x + 8 ? 1 : 0) : 0

    const clip: PetClip =
      behavior === 'sleep' || behavior === 'rest'
        ? 'sleep'
        : behavior === 'walk' || behavior === 'flee'
          ? 'walk'
          : behavior === 'alert'
            ? 'alert'
            : behavior === 'happy'
              ? 'happy'
              : 'idle'

    this.deps.animator.play(clip)
    this.maybeOfferGame(now, opts)

    void dtMs
    return { behavior, clip, look: this.look, wantsFrames: this.needsFrames(), deepSleep: this.deepSleep }
  }

  /**
   * Whether the overlay still needs requestAnimationFrame at all. While awake
   * the pet always breathes/blinks, so the answer is simply "yes - unless we are
   * in deep sleep and nothing else is on screen". Once this returns false the
   * renderer stops its rAF loop completely (zero idle CPU), and the 4 Hz
   * supervisor in overlay/main.ts starts it again when anything changes.
   */
  needsFrames(): boolean {
    if (!this.deepSleep) return true
    return (
      this.hovered || this.panelOpen || this.gameOpen || this.deps.bubbles.active || this.deps.chip.active
    )
  }

  get behaviorValue(): PetBehavior {
    return this.behavior
  }

  get isDeepSleep(): boolean {
    return this.deepSleep
  }

  private busy(now: number, settings: AppSettings): boolean {
    if (this.panelOpen || this.gameOpen) return true
    if (this.deps.bubbles.active || this.deps.chip.active) return true
    if (this.override) return true
    return now - this.lastInteraction < settings.sleepAfterMs
  }

  private maybeOfferGame(now: number, opts: { roamPaused: boolean }): void {
    if (!this.backendIdle || this.idleOfferShown || this.idleOfferAt === 0) return
    if (opts.roamPaused || this.panelOpen || this.gameOpen || this.deps.muted()) return
    if (now < this.idleOfferAt) return
    if (this.deps.bubbles.count > 0) return

    this.idleOfferShown = true
    this.overrideClip('happy', HAPPY_MS)
    const actions: BubbleAction[] = [
      { label: 'Reaction', primary: true, onClick: () => this.play('reaction') },
      { label: 'Rock·Paper·Scissors', onClick: () => this.play('rps') },
      { label: 'Dodge', onClick: () => this.play('dodge') }
    ]
    this.show({
      id: 'idle-offer',
      kind: 'offer',
      title: 'Taking a break?',
      text: 'Play a game?',
      tone: 'offer',
      durationMs: OFFER_TIMEOUT_MS,
      actions
    })
  }

  private play(game: GameId): void {
    this.deps.bubbles.dismissByKind('offer')
    this.deps.openGame(game)
  }

  private show(options: Parameters<BubbleHost['show']>[0]): void {
    if (this.deps.muted() && options.tone !== 'neutral') return
    this.deps.bubbles.show(options)
  }

  private overrideClip(clip: PetClip, ms: number): void {
    this.override = { clip, until: performance.now() + ms }
  }

  private markActivity(_reason: string): void {
    this.lastInteraction = performance.now()
    if (this.deepSleep) {
      this.deepSleep = false
      this.sleepStartedAt = 0
    }
  }
}

function warningText(minutes: number, limitSeconds?: number): string {
  const limit = limitSeconds ? Math.round(limitSeconds / 60) : null
  if (limit) return `You passed your ${limit} min limit — ${minutes} min so far today.`
  return `You have been on the screen for ${minutes} min today.`
}

function clock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
