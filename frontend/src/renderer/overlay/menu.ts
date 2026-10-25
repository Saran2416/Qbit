import type { Point, Rect } from '../../shared/types'

export interface MenuItem {
  /** Ignored on separators. */
  label?: string
  /** Right-aligned secondary text (shortcut hint, state). */
  hint?: string
  /** Renders a checkmark - used for toggle rows. */
  checked?: boolean
  /** Red text, for destructive actions (quit). */
  danger?: boolean
  separator?: boolean
  onSelect?: () => void
}

/** Safety net: the overlay never gets "click outside" events for the bare
 * desktop, so an abandoned menu would otherwise linger forever. */
const AUTO_CLOSE_MS = 45_000

/**
 * The pet's right-click menu - a small DOM panel floating in the overlay's UI
 * layer. The overlay is click-through everywhere, so the reported menu rect is
 * what lets the input catchers deliver clicks here (same path as bubble
 * buttons). The header shows a live clock while the menu is open.
 */
export class ContextMenu {
  private root: HTMLDivElement | null = null
  private clockEl: HTMLElement | null = null
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private closeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly host: HTMLElement) {}

  get isOpen(): boolean {
    return this.root !== null
  }

  /** Menu rect in overlay-local CSS px (null while closed). */
  get rect(): Rect | null {
    if (!this.root) return null
    const r = this.root.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  show(at: Point, items: MenuItem[], bounds: Rect): void {
    this.hide()

    const root = document.createElement('div')
    root.className = 'ctx-menu'

    const head = document.createElement('div')
    head.className = 'ctx-head'
    const title = document.createElement('span')
    title.className = 'ctx-title'
    title.textContent = 'Qbit'
    const clock = document.createElement('span')
    clock.className = 'ctx-clock'
    head.append(title, clock)
    root.appendChild(head)

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div')
        sep.className = 'ctx-sep'
        root.appendChild(sep)
        continue
      }
      const button = document.createElement('button')
      button.className = `ctx-item${item.danger ? ' danger' : ''}`
      const label = document.createElement('span')
      label.className = 'ctx-label'
      label.textContent = item.label ?? ''
      button.appendChild(label)
      if (item.checked) {
        const check = document.createElement('span')
        check.className = 'ctx-check'
        check.textContent = '✓'
        button.appendChild(check)
      } else if (item.hint) {
        const hint = document.createElement('span')
        hint.className = 'ctx-hint'
        hint.textContent = item.hint
        button.appendChild(hint)
      }
      button.addEventListener('click', () => {
        this.hide()
        item.onSelect?.()
      })
      root.appendChild(button)
    }

    this.host.appendChild(root)

    // Clamp on-screen: flip to the left of the cursor if there is no room to
    // the right, and never hang past the desktop edge.
    const width = root.offsetWidth
    const height = root.offsetHeight
    let x = at.x + 6
    let y = at.y + 4
    if (x + width > bounds.x + bounds.width - 8) x = at.x - width - 6
    if (y + height > bounds.y + bounds.height - 8) y = bounds.y + bounds.height - 8 - height
    root.style.left = `${Math.round(Math.max(bounds.x + 8, Math.min(x, bounds.x + bounds.width - width - 8)))}px`
    root.style.top = `${Math.round(Math.max(bounds.y + 8, Math.min(y, bounds.y + bounds.height - height - 8)))}px`

    this.root = root
    this.clockEl = clock
    this.tickClock()
    this.clockTimer = setInterval(() => this.tickClock(), 1000)
    this.closeTimer = setTimeout(() => this.hide(), AUTO_CLOSE_MS)
  }

  hide(): void {
    if (this.clockTimer !== null) clearInterval(this.clockTimer)
    if (this.closeTimer !== null) clearTimeout(this.closeTimer)
    this.clockTimer = null
    this.closeTimer = null
    this.clockEl = null
    this.root?.remove()
    this.root = null
  }

  private tickClock(): void {
    if (!this.clockEl) return
    this.clockEl.textContent = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }
}
