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
  private readonly timers = new Map<string, NodeJS.Timeout>()
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
    this.timers.set(id, timer)
    log.info(`reminders: "${text}" scheduled in ${Math.round(delay / 60000)} min`)
    return id
  }

  cancel(id: string): void {
    const timer = this.timers.get(id)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(id)
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
