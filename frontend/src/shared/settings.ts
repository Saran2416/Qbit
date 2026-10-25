import type { AppSettings } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  wsUrl: 'ws://127.0.0.1:8765',
  muted: false,
  roamPaused: false,
  screenTimeLimitMinutes: 120,
  cursorAvoidRadius: 150,
  roamSpeed: 42,
  /** A little smaller than life size: the full 128px sprite reads as huge. */
  petScale: 0.85,
  idlePlayOfferDelayMs: 8000,
  bubbleDurationMs: 9000,
  maxBubbles: 3,
  sleepAfterMs: 90_000,
  deepSleepAfterMs: 60_000,
  restEveryMinutes: 2,
  restForSeconds: 10,
  backendAutoStartMock: false,
  showDebug: false
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/** Settings come from a JSON file a user may have hand-edited: never trust them. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>
  return {
    wsUrl: str(r.wsUrl, DEFAULT_SETTINGS.wsUrl),
    muted: bool(r.muted, DEFAULT_SETTINGS.muted),
    roamPaused: bool(r.roamPaused, DEFAULT_SETTINGS.roamPaused),
    screenTimeLimitMinutes: num(r.screenTimeLimitMinutes, DEFAULT_SETTINGS.screenTimeLimitMinutes, 5, 1440),
    cursorAvoidRadius: num(r.cursorAvoidRadius, DEFAULT_SETTINGS.cursorAvoidRadius, 40, 600),
    roamSpeed: num(r.roamSpeed, DEFAULT_SETTINGS.roamSpeed, 8, 400),
    petScale: num(r.petScale, DEFAULT_SETTINGS.petScale, 0.4, 4),
    idlePlayOfferDelayMs: num(r.idlePlayOfferDelayMs, DEFAULT_SETTINGS.idlePlayOfferDelayMs, 1000, 600_000),
    bubbleDurationMs: num(r.bubbleDurationMs, DEFAULT_SETTINGS.bubbleDurationMs, 2000, 120_000),
    maxBubbles: num(r.maxBubbles, DEFAULT_SETTINGS.maxBubbles, 1, 6),
    sleepAfterMs: num(r.sleepAfterMs, DEFAULT_SETTINGS.sleepAfterMs, 10_000, 3_600_000),
    deepSleepAfterMs: num(r.deepSleepAfterMs, DEFAULT_SETTINGS.deepSleepAfterMs, 5_000, 3_600_000),
    restEveryMinutes: num(r.restEveryMinutes, DEFAULT_SETTINGS.restEveryMinutes, 0, 60),
    restForSeconds: num(r.restForSeconds, DEFAULT_SETTINGS.restForSeconds, 1, 300),
    backendAutoStartMock: bool(r.backendAutoStartMock, DEFAULT_SETTINGS.backendAutoStartMock),
    showDebug: bool(r.showDebug, DEFAULT_SETTINGS.showDebug)
  }
}

/** Applies a partial patch on top of current settings, sanitizing the result. */
export function patchSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return sanitizeSettings({ ...current, ...patch })
}
