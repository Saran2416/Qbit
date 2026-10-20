import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, patchSettings, sanitizeSettings } from '../shared/settings'
import type { AppSettings } from '../shared/types'
import { log } from './log'

/**
 * Persisted user settings (`settings.json` in userData). Writes are debounced
 * and atomic (tmp + rename) so a crash mid-write can never corrupt the file.
 */
export class SettingsStore {
  private settings: AppSettings
  private readonly file: string
  private readonly listeners = new Set<(s: AppSettings) => void>()
  private writeTimer: NodeJS.Timeout | null = null

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'settings.json')
    let raw: unknown = null
    try {
      if (existsSync(this.file)) raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      log.warn('settings: could not read, falling back to defaults', err)
    }
    this.settings = raw ? sanitizeSettings(raw) : { ...DEFAULT_SETTINGS }
  }

  get(): AppSettings {
    return this.settings
  }

  patch(patch: Partial<AppSettings>): AppSettings {
    this.settings = patchSettings(this.settings, patch)
    this.scheduleWrite()
    for (const listener of this.listeners) listener(this.settings)
    return this.settings
  }

  onChange(cb: (s: AppSettings) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.write()
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.write()
    }, 400)
  }

  private write(): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.settings, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      log.error('settings: write failed', err)
    }
  }
}
