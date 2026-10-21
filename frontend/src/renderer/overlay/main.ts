import type { PetCommand } from '../../shared/ipc'
import { containsPoint, distance, toLocal, toVirtual } from '../../shared/geometry'
import type { Point, Rect, VirtualLayout } from '../../shared/types'
import { api, installErrorReporting } from '../lib/bridge'
import { qs } from '../lib/dom'
import { Ticker, every } from '../lib/loop'
import { Animator } from './animator'
import { Brain } from './brain'
import { BubbleHost } from './bubbles'
import { TokenChip } from './chip'
import { Motion } from './motion'
import { Painter, type PetVisual } from './painter'
import { RegionHub } from './regions'
import { loadAtlas, petSize, type Atlas } from './sprite-atlas'

/**
 * The overlay renderer: one transparent canvas covering every monitor.
 *
 * Rendering contract with the main process:
 *   - every frame we report the rectangles that are currently interactive
 *     (robot bbox, bubbles, chip) via `setRegions`; main toggles
 *     `setIgnoreMouseEvents` from the polled cursor position, so the overlay is
 *     click-through everywhere else, always;
 *   - the 30 fps loop stops completely once the pet is in deep sleep and nothing
 *     is on screen. A 4 Hz supervisor (plus any incoming event) restarts it.
 */
async function boot(): Promise<void> {
  const bridge = api()
  const snapshot = await bridge.getSnapshot()

  let layout: VirtualLayout = snapshot.layout
  let settings = snapshot.settings
  let atlas: Atlas = await loadAtlas()

  const canvas = qs<HTMLCanvasElement>('#stage')
  const layer = qs<HTMLElement>('#layer')
  /**
   * The whole desktop expressed in overlay-local CSS px. Bubbles and the chip
   * clamp to this - not to the viewport window - so they can extend past the
   * current window, whose union report then tells main to grow it around them.
   */
  const bounds = (): Rect => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const d of layout.displays) {
      x0 = Math.min(x0, d.bounds.x)
      y0 = Math.min(y0, d.bounds.y)
      x1 = Math.max(x1, d.bounds.x + d.bounds.width)
      y1 = Math.max(y1, d.bounds.y + d.bounds.height)
    }
    return { x: x0 - layout.origin.x, y: y0 - layout.origin.y, width: x1 - x0, height: y1 - y0 }
  }

  const painter = new Painter(canvas, layout, atlas)
  const motion = new Motion(layout, motionOptions(atlas, settings))
  const animator = new Animator(atlas)

  const bubbles = new BubbleHost({
    layer,
    bounds: bounds(),
    defaultDurationMs: settings.bubbleDurationMs,
    maxBubbles: settings.maxBubbles,
    onDismiss: ({ id, kind }) => {
      void bridge.dismiss(id, kind)
      brain.onBubbleDismissed(kind)
    }
  })

  const chip = new TokenChip({ layer, bounds: bounds(), ttlMs: 8000 })

  const brain = new Brain({
    bubbles,
    chip,
    animator,
    settings: () => settings,
    muted: () => settings.muted,
    openGame: (game) => {
      gameOpen = true
      brain.setGameOpen(true)
      void bridge.openGame(game)
    },
    requestFrame: () => wakeLoop(),
    today: () => new Date().toDateString(),
    log: (level, message) => bridge.log(level, message)
  })

  let lastRegionCount = -1
  const regions = new RegionHub((payload) => {
    if (payload.length !== lastRegionCount) {
      lastRegionCount = payload.length
      bridge.log(
        'info',
        `regions tx n=${payload.length} ${payload
          .map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`)
          .join(' ')}`
      )
    }
    bridge.setRegions(payload)
  })

  let cursor: Point | null = null
  let hovered = false
  let panelOpen = false
  let gameOpen = false

  const ticker = new Ticker(30, (dtMs) => frame(dtMs))
  const wakeLoop = (): void => {
    if (!ticker.isRunning) ticker.start()
  }

  function frame(dtMs: number): void {
    const motionState = motion.update(dtMs, cursor, {
      paused: settings.roamPaused,
      blocked: panelOpen || gameOpen
    })
    const brainState = brain.update(dtMs, motionState, cursor, { roamPaused: settings.roamPaused })
    animator.update(dtMs)

    const visual = toVisual(motionState.x, motionState.y, motionState.facing, brainState.look)
    const petRect = painter.rectFor(visual)

    // Hover is decided here (we already know both the cursor and the rect).
    const local = cursor ? toLocal(layout, cursor) : null
    const isHovered = !!local && containsPoint(petRect, local, 5)
    if (isHovered !== hovered) {
      hovered = isHovered
      brain.setHovered(isHovered)
      document.body.classList.toggle('hovered', isHovered)
    }

    painter.paint({ ...visual, hovered })

    bubbles.tick()
    chip.update()

    const interactive: Rect[] = [petRect, ...bubbles.layout(petRect, bounds()), ...chip.layout(petRect, bounds())]
    regions.set(interactive)
    regions.flush()

    if (!brain.needsFrames()) {
      // Deep sleep: nothing on screen is changing, stop rAF entirely.
      regions.flush(true)
      ticker.stop()
    }
  }

  function toVisual(x: number, y: number, facing: 1 | -1, look: -1 | 0 | 1): PetVisual {
    return {
      clip: animator.current,
      frame: animator.index,
      x: x - layout.origin.x,
      y: y - layout.origin.y,
      facing,
      look,
      hovered,
      scale: settings.petScale,
      time: performance.now()
    }
  }

  /* ------------------------------------------------------------------ events */

  bridge.onBackendMessage((msg) => {
    brain.handleMessage(msg)
    wakeLoop()
  })

  /** Cursor in overlay-local CSS px - one code path for every cursor source. */
  function applyLocalCursor(local: Point): void {
    cursor = toVirtual(layout, local)
    const petRect = painter.lastPetRect()
    const isHover = containsPoint(petRect, local, 5)
    if (isHover !== hovered) {
      hovered = isHover
      brain.setHovered(isHover)
      document.body.classList.toggle('hovered', isHover)
    }
    // Wake up when the cursor gets close enough to matter, or when hovering.
    const near = distance(local, { x: petRect.x + petRect.width / 2, y: petRect.y + petRect.height / 2 })
    if (isHover || near < settings.cursorAvoidRadius * 1.5) {
      brain.pulse('idle', 400)
      wakeLoop()
    }
  }

  // Native mouse events on the viewport window: hover, flee and hit-testing
  // bookkeeping all run off this (the window covers only the pet's content, so
  // no global cursor query is needed - and none is reliable on Wayland).
  // Throttled to ~30 Hz to keep per-frame work cheap.
  let lastMoveSent = -1e9
  window.addEventListener('mousemove', (event) => {
    const now = performance.now()
    if (now - lastMoveSent < 33) return
    lastMoveSent = now
    applyLocalCursor({ x: event.clientX, y: event.clientY })
  })

  bridge.onLayout((next) => {
    layout = next
    painter.setLayout(next)
    motion.setLayout(next)
    bubbles.setBounds(bounds())
    chip.setBounds(bounds())
    ensurePetVisible()
    wakeLoop()
  })

  bridge.onSettings((next) => {
    settings = next
    motion.setOptions(motionOptions(atlas, next))
    if (!next.roamPaused) motion.wake()
    document.body.classList.toggle('muted', next.muted)
    wakeLoop()
  })

  bridge.onPetCommand((command: PetCommand) => {
    switch (command.kind) {
      case 'wake':
        brain.wake(command.reason ?? 'command')
        motion.wake()
        break
      case 'happy':
        brain.pulse('happy', 2400)
        break
      case 'alert':
        brain.pulse('alert', 3200)
        break
      case 'sleep':
        brain.clearTransientUi()
        break
      case 'reload-sprites':
        void reloadAtlas()
        break
      case 'snapshot-canvas':
        try {
          bridge.saveCanvasSnapshot(canvas.toDataURL('image/png'))
        } catch (err) {
          bridge.log('warn', `canvas snapshot failed: ${String(err)}`)
        }
        break
    }
    wakeLoop()
  })

  bridge.onPanelState((open) => {
    panelOpen = open
    brain.setPanelOpen(open)
    wakeLoop()
  })

  bridge.onGameResult((data) => {
    gameOpen = false
    brain.setGameOpen(false)
    brain.onGameResult(data)
    wakeLoop()
  })

  // Clicking the robot opens the panel next to it. Bubbles/chips swallow their
  // own pointer events, so anything reaching this handler was aimed at the pet.
  window.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null
    if (target && target.closest('.bubble, .token-chip')) return
    const local = { x: event.clientX, y: event.clientY }
    const petRect = painter.lastPetRect()
    if (!containsPoint(petRect, local, 6)) return

    brain.onPetClicked()
    wakeLoop()
    const anchor: Rect = {
      x: Math.round(petRect.x + layout.origin.x),
      y: Math.round(petRect.y + layout.origin.y),
      width: Math.round(petRect.width),
      height: Math.round(petRect.height)
    }
    void bridge.openPanel(anchor)
  })

  window.addEventListener('contextmenu', (event) => {
    const target = event.target as HTMLElement | null
    if (!target || target.closest('.bubble, .token-chip')) return
    event.preventDefault()
  })

  // Safety net: if the overlay ever loses its regions (reload, crash of a child
  // window), make sure the desktop is clickable again.
  window.addEventListener('beforeunload', () => regions.clearRegions())

  /* ---------------------------------------------------------------- helpers */

  function motionOptions(currentAtlas: Atlas, currentSettings: typeof settings) {
    const size = petSize(currentAtlas, currentSettings.petScale)
    return {
      speed: currentSettings.roamSpeed,
      avoidRadius: currentSettings.cursorAvoidRadius,
      petWidth: size.width,
      petHeight: size.height
    }
  }

  function ensurePetVisible(): void {
    const state = motion.snapshot()
    if (
      state.x - layout.origin.x < 0 ||
      state.y - layout.origin.y < 0 ||
      state.x - layout.origin.x > layout.size.width ||
      state.y - layout.origin.y > layout.size.height
    ) {
      motion.place()
    }
  }

  async function reloadAtlas(): Promise<void> {
    atlas = await loadAtlas()
    painter.setAtlas(atlas)
    animator.setAtlas(atlas)
    motion.setOptions(motionOptions(atlas, settings))
    bridge.log('info', `sprite atlas reloaded (${atlas.kind}${atlas.source ? ` from ${atlas.source}` : ''})`)
  }

  /* ------------------------------------------------------------------- run */

  // Draw once immediately so the pet appears the instant the window shows.
  painter.paint({ ...toVisual(motion.snapshot().x, motion.snapshot().y, 1, 0), hovered: false }, true)
  wakeLoop()

  // 4 Hz supervisor: restarts the loop when a timer/bubble/chip needs frames and
  // re-sends regions that changed while the loop was stopped.
  every(250, () => {
    const expired = bubbles.tick() || chip.update()
    if (expired) wakeLoop()
    regions.flush()
    if (!ticker.isRunning && (brain.needsFrames() || bubbles.active || chip.active)) wakeLoop()
  })

  // Persist the pet's position roughly every 30 s so a restart does not always
  // begin at the same spot (nice-to-have, kept cheap).
  every(30_000, () => regions.flush(true))
}

installErrorReporting('overlay')

boot().catch((err) => {
  console.error('[qbit] overlay failed to start', err)
  // If the overlay crashed there is no UI left: tell main so it can decide.
  void api().log('error', `overlay boot failure: ${String(err)}`)
})
