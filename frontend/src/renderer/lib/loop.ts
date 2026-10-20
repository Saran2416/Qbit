/**
 * requestAnimationFrame loop with a hard frame-rate cap.
 *
 * The pet is a background consumer: it must never be the reason a laptop fan
 * spins up. So the frame budget is capped (30 fps by default, lower for the
 * sleep animation) and - more importantly - the loop is *stopped* entirely when
 * nothing on screen is changing (see overlay/main.ts: `wantsFrames()`). While
 * stopped there is no rAF callback at all, which is the only way to get a
 * genuinely idle Electron renderer.
 */
export class Ticker {
  private handle: number | null = null
  private last = 0
  private readonly minDelta: number
  private running = false

  constructor(
    readonly fps: number,
    private readonly onFrame: (dtMs: number) => void
  ) {
    this.minDelta = 1000 / fps
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    this.handle = requestAnimationFrame(this.tick)
  }

  stop(): void {
    this.running = false
    if (this.handle !== null) {
      cancelAnimationFrame(this.handle)
      this.handle = null
    }
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return
    const delta = now - this.last
    if (delta >= this.minDelta) {
      // Clamp: after a suspend/resume or a long GC pause we do not want the pet
      // to teleport across the screen.
      this.last = now - (delta % this.minDelta)
      this.onFrame(Math.min(delta, 200))
    }
    this.handle = requestAnimationFrame(this.tick)
  }
}

/** One-shot interval that does its own cleanup (used for the sleep heartbeat). */
export function every(ms: number, fn: () => void): () => void {
  const id = setInterval(fn, ms)
  return () => clearInterval(id)
}
