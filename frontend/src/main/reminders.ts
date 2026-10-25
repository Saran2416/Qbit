import type { ReminderData } from '../shared/types'
import { log } from './log'

/** setTimeout() silently overflows above this (2^31 - 1 ms ~= 24.8 days). */
const MAX_DELAY_MS = 2_147_000_000

/**
 * Local reminder scheduler: the panel's "quick add" creates a timer here *and*
 * tells the backend, so a reminder fires even if the Python service is not
 * running (or is restarted).
 */
export class ReminderScheduler {
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; text: string; dueAt?: number }>()
  private seq = 0

  constructor(private readonly deliver: (reminder: ReminderData) => void) {}

  add(text: string, dueAt?: number): string {
    const id = `local-${Date.now()}-${++this.seq}`
    const reminder: ReminderData = { id, text, dueAt, source: 'local' }
    const delay = typeof dueAt === 'number' ? dueAt - Date.now() : 0

    if (delay > MAX_DELAY_MS) {
      log.warn('reminders: due date too far in the future, ignoring', dueAt)
      return id
    }
    if (delay <= 0) {
      this.deliver(reminder)
      return id
    }

    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.deliver(reminder)
    }, delay)
    timer.unref?.()
    this.timers.set(id, { timer, text, dueAt })
    log.info(`reminders: "${text}" scheduled in ${Math.round(delay / 60000)} min`)
    return id
  }

  cancel(id: string): void {
    const entry = this.timers.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.timers.delete(id)
  }

  /**
   * Cancel every pending timer that matches a reminder the *backend* knows by
   * id: panel-added reminders exist in both places, and cancelling only the
   * backend copy would still let the local twin fire. Due times are matched
   * with a small tolerance (wire conversion rounds to whole ms).
   */
  cancelMatching(text: string, dueAt?: number): number {
    let cancelled = 0
    for (const [id, entry] of this.timers) {
      if (entry.text !== text) continue
      if (typeof dueAt === 'number' && typeof entry.dueAt === 'number' && Math.abs(entry.dueAt - dueAt) > 1500) continue
      clearTimeout(entry.timer)
      this.timers.delete(id)
      cancelled++
    }
    if (cancelled > 0) log.info(`reminders: cancelled ${cancelled} local timer(s) for "${text}"`)
    return cancelled
  }

  dispose(): void {
    for (const entry of this.timers.values()) clearTimeout(entry.timer)
    this.timers.clear()
  }
}
