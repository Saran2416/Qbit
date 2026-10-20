import type { Rect, TokenUsage } from '../../shared/types'
import { positionAnchored, rectOf } from '../lib/anchor'
import { el } from '../lib/dom'
import { formatTokens } from '../lib/format'

export interface TokenChipOptions {
  layer: HTMLElement
  bounds: { width: number; height: number }
  /** how long the chip stays visible after the last update */
  ttlMs: number
}

/**
 * The little "token usage" chip shown when the backend reports an editor in
 * focus. It is deliberately not a bubble: no text, no buttons, no interruption -
 * just a glanceable number plus a progress bar, and it disappears on its own.
 */
export class TokenChip {
  private element: HTMLElement | null = null
  private label: HTMLElement | null = null
  private bar: HTMLElement | null = null
  private expiresAt = 0

  constructor(private readonly opts: TokenChipOptions) {}

  get active(): boolean {
    return !!this.element
  }

  show(usage: TokenUsage, app?: string): void {
    if (!this.element) {
      this.element = el('div', { class: 'token-chip' })
      this.label = el('div', { class: 'token-chip-label' })
      const track = el('div', { class: 'token-chip-track' })
      this.bar = el('i', { class: 'token-chip-fill' })
      track.append(this.bar)
      this.element.append(el('div', { class: 'token-chip-dot' }), this.label, track)
      this.element.addEventListener('pointerdown', (event) => event.stopPropagation())
      this.opts.layer.append(this.element)
    }

    const ratio = usage.limit && usage.limit > 0 ? Math.min(1, usage.used / usage.limit) : 0
    const text = formatTokens(usage)
    if (this.label) {
      this.label.textContent = app ? `${app} · ${text} tokens` : `${text} tokens`
      this.label.title = usage.model ? `${text} tokens · ${usage.model}` : `${text} tokens`
    }
    if (this.bar) {
      this.bar.style.width = `${Math.round(ratio * 100)}%`
      this.bar.classList.toggle('warn', ratio >= 0.8)
      this.bar.classList.toggle('over', ratio >= 1)
    }
    this.element.classList.toggle('compact', usage.limit === undefined)

    if (!this.element.isConnected) this.opts.layer.append(this.element)
    this.element.classList.remove('visible')
    void this.element.offsetWidth
    this.element.classList.add('visible')
    this.expiresAt = performance.now() + this.opts.ttlMs
  }

  hide(): void {
    if (!this.element) return
    this.element.remove()
    this.element = null
    this.label = null
    this.bar = null
  }

  /** Returns true when the chip expired on this tick. */
  update(now = performance.now()): boolean {
    if (!this.element) return false
    if (now < this.expiresAt) return false
    this.hide()
    return true
  }

  layout(petRect: Rect, bounds = this.opts.bounds): Rect[] {
    if (!this.element) return []
    return [positionAnchored(this.element, petRect, bounds, 'right', 10)]
  }

  setBounds(bounds: { width: number; height: number }): void {
    this.opts.bounds = bounds
  }

  currentRects(): Rect[] {
    return this.element ? [rectOf(this.element)] : []
  }
}
