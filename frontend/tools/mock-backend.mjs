#!/usr/bin/env node
/**
 * Mock backend for developing the UI without the Python service.
 *
 *   node tools/mock-backend.mjs            # realistic pacing (seconds)
 *   node tools/mock-backend.mjs --fast     # 1.2 s between events
 *   node tools/mock-backend.mjs --port 8765
 *
 * It emits every message type from src/shared/types.ts on a loop, answers
 * `ping` with `pong`, and reacts to what the UI sends back (dismiss, set_limit,
 * reminder_add, game_event, set_muted) so the whole round trip is testable.
 */
import { WebSocketServer } from 'ws'

/* ------------------------------------------------------------------- config */

const args = process.argv.slice(2)
const FAST = args.includes('--fast')
const PORT = Number(valueOf('--port') ?? 8765)
const HOST = valueOf('--host') ?? '127.0.0.1'
const URL = `ws://${HOST}:${PORT}`

function valueOf(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const PACE = (seconds) => (FAST ? Math.max(350, seconds * 200) : seconds * 1000)

/* -------------------------------------------------------------------- state */

const startedAt = Date.now()
let tokenBudget = 30000
let tokenUsed = 4200
let screenMinutes = 87
let limitMinutes = 120
let muted = false
const reminders = []

const wss = new WebSocketServer({ host: HOST, port: PORT })

wss.on('listening', () => {
  console.log(`[mock] backend listening on ${URL}${FAST ? ' (fast mode)' : ''}`)
})

wss.on('connection', (socket, request) => {
  console.log(`[mock] client connected (${request.socket.remoteAddress})`)
  send(socket, 'hello', { version: 'mock-0.1.0', server: 'qbit-mock', clientId: `mock-${Date.now()}`, serverTime: Date.now() })
  void cycle(socket)

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      console.log('[mock] <- unparseable frame')
      return
    }
    handle(socket, message)
  })

  socket.on('close', () => console.log('[mock] client disconnected'))
})

wss.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[mock] ${URL} is already in use - is the real backend (or another mock) running?`)
    process.exit(1)
  }
  console.error('[mock] server error', error)
})

/* ------------------------------------------------------------------ helpers */

function send(socket, type, data = {}, ts = true) {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(ts ? { type, data, ts: Date.now() } : { type, data }))
  console.log(`[mock] -> ${type} ${summarize(data)}`)
}

function summarize(data) {
  const text = JSON.stringify(data)
  return text.length > 96 ? `${text.slice(0, 93)}...` : text
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------- event script */

async function cycle(socket) {
  // Wait a moment so the connection settles.
  await sleep(PACE(0.8))

  // 1. browser focus -> alert bubble
  send(socket, 'active_app', {
    app: 'firefox',
    title: 'Inbox (12) - GitHub · Pull requests',
    category: 'browser',
    pid: 3312
  })
  await sleep(PACE(3.5))

  // 2. editor focus + token usage -> chip
  send(socket, 'active_app', { app: 'code', title: 'qbit/frontend - src/main/index.ts', category: 'editor', pid: 4410 })
  await sleep(PACE(1.2))
  for (const step of [1200, 2400, 3600, 5100]) {
    tokenUsed += step
    send(socket, 'token_usage', {
      app: 'code',
      used: tokenUsed,
      limit: tokenBudget,
      label: 'Qbit Pet session',
      model: 'desktop-pet-1',
      updatedAt: Date.now()
    })
    await sleep(PACE(1.4))
  }

  // 3. notification -> bubble with Dismiss
  send(socket, 'notification', {
    id: `notif-${Date.now()}`,
    title: 'Build finished',
    body: 'vite build completed in 4.2 s (0 warnings).',
    app: 'code',
    category: 'editor'
  })
  await sleep(PACE(4))

  // 4. reminder -> bubble with Dismiss
  send(socket, 'reminder', {
    id: `rem-${Date.now()}`,
    text: 'Stand up and stretch for two minutes',
    dueAt: Date.now() + PACE(30)
  })
  await sleep(PACE(4.5))

  // 5. media (neutral behaviour: no bubble)
  send(socket, 'active_app', { app: 'spotify', title: 'Lofi Beats', category: 'media', pid: 5120 })
  await sleep(PACE(3))

  // 6. idle -> the pet offers a game
  send(socket, 'idle_state', { idle: true, idleSeconds: 300 })
  await sleep(PACE(12))
  send(socket, 'idle_state', { idle: false, idleSeconds: 0 })
  await sleep(PACE(2))

  // 7. screen-time warning (repeat-safe on the UI side)
  screenMinutes += 8
  send(socket, 'screen_time_warning', {
    minutes: screenMinutes,
    limit: limitMinutes * 60,
    message: `You have been at the screen for ${screenMinutes} min today - the limit is ${limitMinutes} min.`
  })
  await sleep(PACE(3))
  send(socket, 'screen_time_warning', { minutes: screenMinutes + 1, limit: limitMinutes * 60 })
  await sleep(PACE(4))

  // 8. authoritative stats (replaces the locally accumulated numbers)
  send(socket, 'screen_time_stats', {
    date: todayKey(),
    totalSeconds: screenMinutes * 60,
    limitMinutes,
    apps: [
      { app: 'code', category: 'editor', seconds: 26 * 60 },
      { app: 'firefox', category: 'browser', seconds: 21 * 60 },
      { app: 'spotify', category: 'media', seconds: 12 * 60 },
      { app: 'alacritty', category: 'terminal', seconds: 9 * 60 },
      { app: 'slack', category: 'chat', seconds: 6 * 60 }
    ]
  })
  await sleep(PACE(5))

  // 9. terminal (neutral) + a soft error now and then
  send(socket, 'active_app', { app: 'alacritty', title: 'npm run dev', category: 'terminal', pid: 6011 })
  await sleep(PACE(3))
  if (Math.random() < 0.5) {
    send(socket, 'error', { code: 'tracker_degraded', message: 'Accessibility API unavailable; falling back to window titles.' })
  }
  await sleep(PACE(4))

  if (muted) {
    send(socket, 'active_app', { app: 'firefox', title: 'Muted: this would have shown a bubble', category: 'browser' })
    await sleep(PACE(3))
  }

  console.log(`[mock] uptime ${Math.round((Date.now() - startedAt) / 1000)}s - looping`)
  await cycle(socket)
}

/* -------------------------------------------------------- inbound handling */

function handle(socket, message) {
  const { type, data = {} } = message
  switch (type) {
    case 'hello':
      console.log(`[mock] <- hello from ${data.client} ${data.version} (${data.platform})`)
      break
    case 'ping':
      send(socket, 'pong', { t: data.t }, false)
      break
    case 'dismiss':
      console.log(`[mock] <- dismiss id=${data.id ?? '(none)'} kind=${data.kind ?? '(none)'}`)
      break
    case 'set_limit':
      limitMinutes = Number(data.limitMinutes) || limitMinutes
      console.log(`[mock] <- set_limit ${limitMinutes} min`)
      send(socket, 'ack', { of: 'set_limit', ok: true })
      break
    case 'set_muted':
      muted = !!data.muted
      console.log(`[mock] <- set_muted ${muted}`)
      break
    case 'reminder_add': {
      const dueAt = Number(data.dueAt) || Date.now() + PACE(15)
      const reminder = { id: `rem-${Date.now()}`, text: String(data.text ?? 'reminder'), dueAt }
      reminders.push(reminder)
      console.log(`[mock] <- reminder_add "${reminder.text}" (in ${Math.round((dueAt - Date.now()) / 1000)}s)`)
      send(socket, 'ack', { of: 'reminder_add', ok: true, id: reminder.id })
      setTimeout(() => {
        send(socket, 'reminder', reminder)
      }, Math.max(200, dueAt - Date.now()))
      break
    }
    case 'game_event':
      console.log(`[mock] <- game_event ${data.game} ${data.event} score=${data.score ?? '-'} ${data.detail ?? ''}`)
      if (data.event === 'end') {
        send(socket, 'notification', {
          id: `game-${Date.now()}`,
          title: 'Nice round!',
          body: `${data.game}: score ${data.score ?? '?'}${data.detail ? ` (${data.detail})` : ''}`,
          app: 'qbit-arcade'
        })
      }
      break
    default:
      console.log(`[mock] <- unknown message type "${type}"`)
  }
}

function todayKey() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

process.on('SIGINT', () => {
  console.log('\n[mock] shutting down')
  wss.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 300)
})
