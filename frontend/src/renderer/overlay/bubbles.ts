import type { Rect } from '../../shared/types'
import { positionAnchored, rectOf } from '../lib/anchor'
import { el } from '../lib/dom'

export type BubbleTone = 'info' | 'browser' | 'editor' | 'warning' | 'reminder' | 'offer' | 'neutral'

export interface BubbleAction {
  label: string
  primary?: boolean
  onClick: () => void
}

export interface BubbleOptions {
  id?: string
  /** used for "dismiss" round-trips to the backend (notification/reminder/...) */
  kind?: string
  title?: string
  text: string
  tone?: BubbleTone
  actions?: BubbleAction[]
  /** 0 disables the auto-hide timer (user must dismiss) */
  durationMs?: number
  /** replaces an existing bubble with the same key instead of stacking */
  dedupeKey?: string
}

interface BubbleRecord extends Required<Pick<BubbleOptions, 'id' | 'kind' | 'text' | 'tone'>> {
  element: HTMLElement
  expiresAt: number
  title?: string
  actions: BubbleAction[]
  onDismissRequested: () => void
}

export interface BubbleHostOptions {
  layer: HTMLElement
  bounds: Rect
  defaultDurationMs: number
  maxBubbles: number
  /** called when the user (or the timer) closes a bubble: forwards "dismiss" */
  onDismiss: (record: { id: string; kind: string }) => void
}

/**
 * Speech bubbles. They are DOM (not canvas) so text stays crisp, selectable and
 * accessible, and so their rectangles can be reported as interactive regions -
 * which is how a click-through overlay still manages to have a clickable
 * "Dismiss" button.
 */
export class BubbleHost {
  private items: BubbleRecord[] = []
  private seq = 0

  constructor(private readonly opts: BubbleHostOptions) {}

  get count(): number {
    return this.items.length
  }

  get active(): boolean {
    return this.items.length > 0
  }

  show(options: BubbleOptions): string {
    const id = options.id ?? `bubble-${++this.seq}`

    if (options.id) {
      const sameId = this.items.find((item) => item.id === options.id)
      if (sameId) {
        this.update(sameId.id, options)
        return sameId.id
      }
    }

    if (options.dedupeKey) {
      const existing = this.items.find((item) => item.element.dataset.dedupe === options.dedupeKey)
      if (existing) {
        this.update(existing.id, options)
        return existing.id
      }
    }

    while (this.items.length >= this.opts.maxBubbles) {
      this.remove(this.items[0]!.id, false)
    }

    const tone = options.tone ?? 'info'
    const element = el('div', { class: `bubble tone-${tone}`, dataset: { bubbleId: id, dedupe: options.dedupeKey ?? '' } })
    if (options.title) element.append(el('div', { class: 'bubble-title', text: options.title }))
    element.append(el('div', { class: 'bubble-text', text: options.text }))

    const record: BubbleRecord = {
      id,
      kind: options.kind ?? 'bubble',
      text: options.text,
      title: options.title,
      tone,
      element,
      expiresAt: options.durationMs === 0 ? Number.POSITIVE_INFINITY : performance.now() + (options.durationMs ?? this.opts.defaultDurationMs),
      actions: options.actions ?? [],
      onDismissRequested: () => this.remove(id, true)
    }

    if (record.actions.length > 0) {
      const row = el('div', { class: 'bubble-actions' })
      for (const action of record.actions) {
        row.append(
          el('button', {
            class: `bubble-btn${action.primary ? ' primary' : ''}`,
            text: action.label,
            on: {
              click: (event) => {
                event.stopPropagation()
                action.onClick()
              }
            }
          })
        )
      }
      element.append(row)
    } else {
      element.append(
        el('button', {
          class: 'bubble-close',
          text: '×',
          title: 'Dismiss',
          on: {
            click: (event) => {
              event.stopPropagation()
              this.remove(id, true)
            }
          }
        })
      )
    }

    // Swallow clicks so they never reach the "clicked the robot" handler.
    element.addEventListener('pointerdown', (event) => event.stopPropagation())

    this.items.push(record)
    this.opts.layer.append(element)
    return id
  }

  update(id: string, patch: Partial<BubbleOptions>): void {
    const record = this.items.find((item) => item.id === id)
    if (!record) return
    if (patch.text !== undefined) {
      record.text = patch.text
      const target = record.element.querySelector('.bubble-text')
      if (target) target.textContent = patch.text
    }
    if (patch.title !== undefined) {
      record.title = patch.title
      let target = record.element.querySelector('.bubble-title')
      if (!target) {
        target = document.createElement('div')
        target.className = 'bubble-title'
        record.element.prepend(target)
      }
      target.textContent = patch.title
    }
    if (patch.tone) {
      record.tone = patch.tone
      record.element.className = `bubble tone-${patch.tone}`
    }
    if (patch.durationMs && record.expiresAt !== Number.POSITIVE_INFINITY) {
      record.expiresAt = performance.now() + patch.durationMs
    }
    // Re-pulse the bubble so a repeat is visible without a new element.
    record.element.classList.remove('pulse')
    void record.element.offsetWidth
    record.element.classList.add('pulse')
  }

  dismissByKind(kind: string): void {
    for (const item of [...this.items]) {
      if (item.kind === kind) this.remove(item.id, true)
    }
  }

  dismissAll(notify = false): void {
    for (const item of [...this.items]) this.remove(item.id, notify)
  }

  remove(id: string, notify: boolean): void {
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0) return
    const [record] = this.items.splice(index, 1)
    record!.element.remove()
    if (notify) this.opts.onDismiss({ id: record!.id, kind: record!.kind })
  }

  /** Ticks auto-hide timers; returns true when something was removed. */
  tick(now = performance.now()): boolean {
    let removed = false
    for (const item of [...this.items]) {
      if (now >= item.expiresAt) {
        this.remove(item.id, false)
        removed = true
      }
    }
    return removed
  }

  /** Anchors every bubble to the pet and returns their rectangles. */
  layout(petRect: Rect, bounds = this.opts.bounds): Rect[] {
    const rects: Rect[] = []
    for (const item of this.items) {
      const preference = item.tone === 'offer' ? 'above' : 'auto'
      rects.push(positionAnchored(item.element, petRect, bounds, preference))
    }
    return rects
  }

  setBounds(bounds: Rect): void {
    this.opts.bounds = bounds
  }

  currentRects(): Rect[] {
    return this.items.map((item) => rectOf(item.element))
  }
}
