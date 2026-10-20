import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActiveAppData, AppCategory, AppUsage, ScreenTimeStats, ScreenTimeStatsData } from '../shared/types'
import { log } from './log'

/** How often `tick()` is called by the main loop, in seconds. */
const TICK_SECONDS = 5
/** Stop counting when the backend has not reported an active app for this long. */
const STALE_AFTER_MS = 180_000
/** Keep this many days of history. */
const KEEP_DAYS = 21

interface DayBucket {
  apps: Record<string, { app: string; category: AppCategory; seconds: number }>
  totalSeconds: number
  warnedAt?: number
  warnedLimit?: number
}

interface StoredStats {
  days: Record<string, DayBucket>
}

/**
 * Screen time is accumulated locally from `active_app` events (time only
 * advances while the backend keeps reporting activity and the machine is not
 * idle), and can be replaced wholesale by a `screen_time_stats` message when
 * the Python service already tracks it itself.
 */
export class StatsStore {
  private data: StoredStats = { days: {} }
  private readonly file: string
  private current: ActiveAppData | null = null
  private lastActiveAt = 0
  private idle = false
  private limitMinutes: number
  private dirty = false

  constructor(
    userDataDir: string,
    limitMinutes: number
  ) {
    this.file = join(userDataDir, 'screen-time.json')
    this.limitMinutes = limitMinutes
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoredStats
        if (parsed && typeof parsed === 'object' && parsed.days) this.data = parsed
      }
    } catch (err) {
      log.warn('stats: could not read history', err)
    }
    this.prune()
  }

  /* ---------------------------------------------------------------- events */

  noteActiveApp(data: ActiveAppData): void {
    const key = data.app || 'unknown'
    this.current = { ...data, app: key }
    this.lastActiveAt = Date.now()
    this.idle = false
    this.dirty = true
  }

  setIdle(idle: boolean): void {
    this.idle = idle
    if (idle) this.current = null
  }

  setLimit(minutes: number): void {
    this.limitMinutes = minutes
    this.dirty = true
  }

  /** Backend is authoritative when it sends its own numbers. */
  applyBackendStats(data: ScreenTimeStatsData): void {
    const today = this.todayKey()
    if (data.date && data.date !== today) return
    const bucket: DayBucket = { apps: {}, totalSeconds: 0 }
    for (const app of data.apps ?? []) {
      bucket.apps[app.app] = {
        app: app.app,
        category: app.category ?? 'other',
        seconds: Math.max(0, Math.round(app.seconds))
      }
      bucket.totalSeconds += Math.max(0, Math.round(app.seconds))
    }
    if (typeof data.totalSeconds === 'number' && data.totalSeconds > bucket.totalSeconds) {
      bucket.totalSeconds = Math.round(data.totalSeconds)
    }
    const existing = this.data.days[today]
    bucket.warnedAt = existing?.warnedAt
    bucket.warnedLimit = existing?.warnedLimit
    this.data.days[today] = bucket
    if (typeof data.limitMinutes === 'number' && data.limitMinutes > 0) this.limitMinutes = data.limitMinutes
    this.dirty = true
  }

  /* ----------------------------------------------------------------- loop */

  tick(now = Date.now()): void {
    this.rollDay(now)
    const active = this.current && !this.idle && now - this.lastActiveAt < STALE_AFTER_MS
    if (!active || !this.current) return
    const bucket = this.bucket(now)
    const entry =
      bucket.apps[this.current.app] ??
      (bucket.apps[this.current.app] = { app: this.current.app, category: this.current.category, seconds: 0 })
    entry.category = this.current.category
    entry.seconds += TICK_SECONDS
    bucket.totalSeconds += TICK_SECONDS
    this.dirty = true
  }

  /** True exactly once per day per limit value: the warning cannot spam. */
  checkLimit(now = Date.now()): { warn: boolean; totalMinutes: number; limitMinutes: number } {
    const bucket = this.bucket(now)
    const totalMinutes = Math.round(bucket.totalSeconds / 60)
    const limited = this.limitMinutes > 0 && bucket.totalSeconds >= this.limitMinutes * 60
    if (!limited || bucket.warnedLimit === this.limitMinutes) {
      return { warn: false, totalMinutes, limitMinutes: this.limitMinutes }
    }
    bucket.warnedLimit = this.limitMinutes
    bucket.warnedAt = now
    this.dirty = true
    return { warn: true, totalMinutes, limitMinutes: this.limitMinutes }
  }

  snapshot(now = Date.now()): ScreenTimeStats {
    const bucket = this.bucket(now)
    const apps: AppUsage[] = Object.values(bucket.apps)
      .map((a) => ({ app: a.app, category: a.category, seconds: a.seconds }))
      .sort((a, b) => b.seconds - a.seconds)
    return {
      date: this.todayKey(now),
      totalSeconds: bucket.totalSeconds,
      limitMinutes: this.limitMinutes,
      apps,
      updatedAt: now
    }
  }

  persistIfDirty(): void {
    if (!this.dirty) return
    this.dirty = false
    this.prune()
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      log.error('stats: persist failed', err)
    }
  }

  /* ---------------------------------------------------------------- utils */

  private todayKey(now = Date.now()): string {
    const d = new Date(now)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  private rollDay(now: number): void {
    if (!this.data.days[this.todayKey(now)]) {
      this.data.days[this.todayKey(now)] = { apps: {}, totalSeconds: 0 }
      this.dirty = true
    }
  }

  private bucket(now: number): DayBucket {
    const key = this.todayKey(now)
    const bucket = this.data.days[key] ?? (this.data.days[key] = { apps: {}, totalSeconds: 0 })
    return bucket
  }

  private prune(): void {
    const keys = Object.keys(this.data.days).sort()
    while (keys.length > KEEP_DAYS) {
      const drop = keys.shift()
      if (drop) delete this.data.days[drop]
    }
  }
}
