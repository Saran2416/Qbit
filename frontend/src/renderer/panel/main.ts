import type { AppSettings, ReminderData, ScreenTimeStats } from '../../shared/types'
import { api, installErrorReporting } from '../lib/bridge'
import { qs } from '../lib/dom'
import { categoryColor, formatDuration, truncate } from '../lib/format'
import { Ticker } from '../lib/loop'
import { PROCEDURAL_META, drawPet } from '../overlay/sprite-atlas'
import { renderBars, type BarRow } from './barchart'

/**
 * The popup panel: today's screen time, per-app breakdown, screen-time limit,
 * quick reminder and the mini-game launcher. It is a real focusable window (the
 * overlay is not), which is also what makes "close on outside click" work:
 * clicking another app blurs this window and main hides it.
 */
function boot(): void {
  const bridge = api()

  const els = {
    badge: qs<HTMLElement>('#backend-badge'),
    statusLine: qs<HTMLElement>('#status-line'),
    closeBtn: qs<HTMLButtonElement>('#close-btn'),
    todayValue: qs<HTMLElement>('#today-value'),
    todayLimit: qs<HTMLElement>('#today-limit'),
    todayApps: qs<HTMLElement>('#today-apps'),
    meter: qs<HTMLElement>('#today-meter'),
    bars: qs<HTMLCanvasElement>('#bars'),
    chartEmpty: qs<HTMLElement>('#chart-empty'),
    chartHint: qs<HTMLElement>('#chart-hint'),
    limitInput: qs<HTMLInputElement>('#limit-input'),
    limitSave: qs<HTMLButtonElement>('#limit-save'),
    reminderText: qs<HTMLInputElement>('#reminder-text'),
    reminderTime: qs<HTMLInputElement>('#reminder-time'),
    reminderAdd: qs<HTMLButtonElement>('#reminder-add'),
    reminderNow: qs<HTMLButtonElement>('#reminder-now'),
    reminderList: qs<HTMLElement>('#reminder-list'),
    toggleMute: qs<HTMLInputElement>('#toggle-mute'),
    toggleRoam: qs<HTMLInputElement>('#toggle-roam'),
    petSize: qs<HTMLInputElement>('#pet-size'),
    petSizeLabel: qs<HTMLElement>('#pet-size-label'),
    clock: qs<HTMLElement>('#clock'),
    gamesHint: qs<HTMLElement>('#games-hint'),
    backendLine: qs<HTMLElement>('#backend-line'),
    quitBtn: qs<HTMLButtonElement>('#quit-btn'),
    avatar: qs<HTMLCanvasElement>('#avatar')
  }

  let settings: AppSettings | null = null

  /* ------------------------------------------------------------- rendering */

  function renderStats(stats: ScreenTimeStats): void {
    const limitSeconds = stats.limitMinutes * 60
    const ratio = limitSeconds > 0 ? stats.totalSeconds / limitSeconds : 0

    els.todayValue.textContent = formatDuration(stats.totalSeconds)
    els.todayLimit.textContent =
      stats.limitMinutes > 0 ? `limit ${formatDuration(limitSeconds)}` : 'no limit'
    els.todayApps.textContent =
      stats.apps.length === 1 ? '1 app' : `${stats.apps.length} apps`
    els.meter.style.width = `${Math.min(100, Math.round(ratio * 100))}%`
    els.meter.classList.toggle('warn', ratio >= 0.8 && ratio < 1)
    els.meter.classList.toggle('over', ratio >= 1)

    const rows: BarRow[] = stats.apps.slice(0, 8).map((app) => ({
      label: truncate(app.app, 22),
      value: app.seconds,
      color: categoryColor(app.category)
    }))
    els.chartEmpty.style.display = rows.length === 0 ? 'block' : 'none'
    els.chartHint.textContent = rows.length > 0 ? `top ${rows.length}` : 'today'
    renderBars(els.bars, rows, (value) => formatDuration(value))
  }

  function renderSettings(next: AppSettings): void {
    settings = next
    if (document.activeElement !== els.limitInput) els.limitInput.value = String(next.screenTimeLimitMinutes)
    els.toggleMute.checked = next.muted
    els.toggleRoam.checked = next.roamPaused
    if (document.activeElement !== els.petSize) els.petSize.value = String(next.petScale)
    els.petSizeLabel.textContent = `${Math.round(next.petScale * 100)}%`
  }

  /** Pending reminders the backend still holds, newest due time first. */
  function renderReminders(list: ReminderData[]): void {
    const sorted = [...list].sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
    els.reminderList.replaceChildren()
    for (const reminder of sorted) {
      const item = document.createElement('li')
      item.className = 'reminder-item'
      const label = document.createElement('span')
      label.className = 'reminder-label'
      const when = reminder.dueAt
        ? new Date(reminder.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'now'
      label.textContent = `${when} · ${reminder.text}`
      const cancel = document.createElement('button')
      cancel.className = 'reminder-cancel'
      cancel.title = 'Cancel this reminder'
      cancel.textContent = '×'
      cancel.addEventListener('click', () => {
        // Also cancels the local twin of a panel-added reminder (see main).
        void bridge.dismiss(reminder.id, 'reminder', reminder.text, reminder.dueAt)
        item.remove()
        refreshBackendStats()
      })
      item.append(label, cancel)
      els.reminderList.appendChild(item)
    }
    els.reminderList.style.display = sorted.length > 0 ? 'flex' : 'none'
  }

  function refreshBackendStats(): void {
    bridge.send({ type: 'get_stats', data: {} })
  }

  function renderIdle(next: boolean): void {
    // Games are always playable from the panel — idle only changes the hint.
    // (The pet still *offers* a game on its own after a while of idleness.)
    els.gamesHint.textContent = next ? "you're idle — good time for a game" : 'play anytime'
  }

  function renderBackend(state: string, attempt: number, url: string): void {
    els.badge.textContent = state
    els.badge.className = `badge ${state === 'open' ? 'online' : state === 'reconnecting' || state === 'closed' ? 'offline' : ''}`
    els.statusLine.textContent =
      state === 'open'
        ? `connected to ${url}`
        : state === 'reconnecting'
          ? `offline — retry #${attempt} (Qbit keeps working)`
          : `${state} · ${url}`
    els.backendLine.textContent = `ws: ${url}`
  }

  /* ---------------------------------------------------------------- avatar */

  const avatarCtx = els.avatar.getContext('2d')
  const atlas = { kind: 'procedural' as const, meta: PROCEDURAL_META }
  if (avatarCtx) {
    let frame = 0
    const paintAvatar = (): void => {
      avatarCtx.setTransform(1, 0, 0, 1, 0, 0)
      avatarCtx.clearRect(0, 0, els.avatar.width, els.avatar.height)
      drawPet(avatarCtx, atlas, {
        clip: 'idle',
        frame: frame % 6,
        x: els.avatar.width / 2,
        y: els.avatar.height - 3,
        facing: 1,
        scale: 0.62,
        look: 0,
        hovered: false,
        time: performance.now()
      })
    }
    const avatarTicker = new Ticker(6, () => {
      frame++
      paintAvatar()
    })
    paintAvatar()
    avatarTicker.start()
  }

  /* ----------------------------------------------------------------- wiring */

  els.closeBtn.addEventListener('click', () => void bridge.closePanel())
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') void bridge.closePanel()
  })

  els.limitSave.addEventListener('click', () => {
    const minutes = Number(els.limitInput.value)
    if (!Number.isFinite(minutes)) return
    void bridge.setLimit(minutes).then(renderSettings)
  })

  for (const preset of document.querySelectorAll<HTMLButtonElement>('.presets .btn')) {
    preset.addEventListener('click', () => {
      const minutes = Number(preset.dataset.min)
      if (!Number.isFinite(minutes)) return
      els.limitInput.value = String(minutes)
      void bridge.setLimit(minutes).then(renderSettings)
    })
  }

  const addReminder = (useTime: boolean): void => {
    const text = els.reminderText.value.trim()
    if (!text) {
      els.reminderText.focus()
      return
    }
    const dueAt = useTime ? dueAtFromTime(els.reminderTime.value) : undefined
    void bridge.addReminder(text, dueAt)
    els.reminderText.value = ''
    // The list is backend-tracked: ask for a fresh one after the add lands.
    setTimeout(refreshBackendStats, 400)
  }

  els.reminderAdd.addEventListener('click', () => addReminder(true))
  els.reminderNow.addEventListener('click', () => addReminder(false))
  els.reminderText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addReminder(els.reminderTime.value.length > 0)
  })

  els.toggleMute.addEventListener('change', () => {
    void bridge.updateSettings({ muted: els.toggleMute.checked }).then(renderSettings)
  })
  els.toggleRoam.addEventListener('change', () => {
    void bridge.updateSettings({ roamPaused: els.toggleRoam.checked }).then(renderSettings)
  })

  els.petSize.addEventListener('input', () => {
    const scale = Number(els.petSize.value)
    if (!Number.isFinite(scale)) return
    els.petSizeLabel.textContent = `${Math.round(scale * 100)}%`
    void bridge.updateSettings({ petScale: scale })
  })

  // Live clock: the panel keeps real time while it is open.
  const tickClock = (): void => {
    els.clock.textContent = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }
  tickClock()
  setInterval(tickClock, 1000)

  for (const button of document.querySelectorAll<HTMLButtonElement>('.game-btn')) {
    button.addEventListener('click', () => {
      const game = button.dataset.game
      if (game !== 'reaction' && game !== 'rps' && game !== 'dodge') return
      void bridge.openGame(game)
      void bridge.closePanel()
    })
  }

  els.quitBtn.addEventListener('click', () => bridge.quit())

  window.addEventListener('resize', () => {
    if (settings) renderStats(lastStats)
  })

  /* ------------------------------------------------------------- life cycle */

  let lastStats: ScreenTimeStats = {
    date: '',
    totalSeconds: 0,
    limitMinutes: 0,
    apps: [],
    updatedAt: 0
  }

  bridge.onStats((stats) => {
    lastStats = stats
    renderStats(stats)
  })
  bridge.onSettings(renderSettings)
  bridge.onBackendStatus((status) => {
    renderBackend(status.state, status.attempt, status.url)
    // Reconnects get fresh stats pushed anyway; asking also covers the first
    // open after the panel mounted late.
    if (status.state === 'open') refreshBackendStats()
  })
  bridge.onBackendMessage((msg) => {
    if (msg.type === 'idle_state') renderIdle(msg.data.idle)
    if (msg.type === 'screen_time_stats') renderReminders(msg.data.activeReminders ?? [])
  })

  void bridge.getSnapshot().then((snapshot) => {
    renderSettings(snapshot.settings)
    lastStats = snapshot.stats
    renderStats(snapshot.stats)
    renderBackend(snapshot.backend.state, snapshot.backend.attempt, snapshot.backend.url)
  })
  void bridge.getStats().then((stats) => {
    lastStats = stats
    renderStats(stats)
  })
  renderReminders([])
  refreshBackendStats()
  renderIdle(false)
}

function dueAtFromTime(value: string): number | undefined {
  if (!value) return undefined
  const [hours, minutes] = value.split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined
  const date = new Date()
  date.setHours(hours, minutes, 0, 0)
  if (date.getTime() <= Date.now() + 5_000) date.setDate(date.getDate() + 1) // "07:30" yesterday -> tomorrow
  return date.getTime()
}

installErrorReporting('panel')

try {
  boot()
} catch (err) {
  console.error('[qbit] panel failed to start', err)
}
