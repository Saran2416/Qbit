#!/usr/bin/env node
/**
 * Wire integration test: connects to a running petd daemon (backend/) and
 * plays the exact role of the Electron main process (src/main/ws-client.ts +
 * src/main/index.ts), validating every inbound frame with the frontend's own
 * parser (src/shared/protocol.ts). It also replays the historical petd
 * dialect (backend/fake_client.py) to prove both command vocabularies work.
 *
 *   # terminal 1
 *   cd backend && .venv/bin/python -m petd
 *   # terminal 2
 *   npm run test:wire              # or: node tools/wire-test.mjs
 *   QBIT_WS_URL=ws://127.0.0.1:9000 npm run test:wire   # custom port
 *
 * Exits 0 when every check passes. It creates and dismisses one reminder and
 * temporarily changes the daily limit (restored afterwards).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL = process.env.QBIT_WS_URL ?? 'ws://127.0.0.1:8765'

/* --- compile src/shared/protocol.ts so we can use the real parseInbound() -- */

const buildDir = mkdtempSync(join(tmpdir(), 'qbit-protocol-'))
let parseInbound, encodeOutbound
try {
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      join(ROOT, 'src', 'shared', 'protocol.ts'),
      '--target', 'es2022',
      '--module', 'es2022',
      '--moduleResolution', 'bundler',
      '--outDir', buildDir,
      '--skipLibCheck'
    ],
    { stdio: 'pipe' }
  )
  ;({ parseInbound, encodeOutbound } = await import(
    pathToFileURL(join(buildDir, 'protocol.js')).href
  ))
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ checks */

const received = [] // frames the UI would see, already parsed
const dropped = [] // frames parseInbound() rejected = messages the UI would lose
let failures = 0

function check(name, condition, detail = '') {
  const ok = !!condition
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function noDropped(name) {
  check(`${name}: no frames the UI would drop`, dropped.length === 0, dropped.join(', '))
}

function waitFor(predicate, timeoutMs = 4000, label = 'message', since = 0) {
  return new Promise((resolve, reject) => {
    const scan = () => {
      const index = received.findIndex((msg, i) => i >= since && predicate(msg))
      if (index >= 0) {
        clearTimeout(timer)
        clearInterval(interval)
        resolve(received[index])
        return true
      }
      return false
    }
    const timer = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`))
    }, timeoutMs)
    const interval = setInterval(scan, 25)
    scan()
  })
}

/* --------------------------------------------------------------------- run */

const socket = new WebSocket(URL)
socket.on('message', (raw) => {
  const text = raw.toString()
  const msg = parseInbound(text)
  if (msg) received.push(msg)
  else dropped.push(text.slice(0, 160))
})

let mark = 0 // index in `received`: lets a wait ignore older, similar frames
let ack
let stats

try {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  console.log(`connected to ${URL}\n`)

  /* -------------------------------------------------------- 1. handshake */

  const hello = await waitFor((m) => m.type === 'hello', 4000, 'hello')
  check('hello.server', hello.data.server === 'petd', JSON.stringify(hello.data))

  stats = await waitFor((m) => m.type === 'screen_time_stats', 4000, 'initial stats')
  const initialLimitMinutes = stats.data.limitMinutes
  check('stats.date is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(stats.data.date ?? ''))
  check('stats.totalSeconds is a number', typeof stats.data.totalSeconds === 'number')
  check('stats.limitMinutes is a number', typeof stats.data.limitMinutes === 'number')
  check('stats.apps is an array', Array.isArray(stats.data.apps))
  check(
    'stats.apps rows use {app, category, seconds}',
    stats.data.apps.every((a) => typeof a.app === 'string' && typeof a.seconds === 'number'),
    JSON.stringify(stats.data.apps.slice(0, 2))
  )
  noDropped('handshake')

  // The frontend greets the backend right after opening.
  socket.send(encodeOutbound({ type: 'hello', data: { client: 'qbit-desktop-pet', version: '0.1.0', platform: process.platform } }))
  await waitFor((m) => m.type === 'hello' && received.filter((x) => x.type === 'hello').length >= 2, 4000, 'hello reply')
  await waitFor((m) => m.type === 'screen_time_stats' && received.filter((x) => x.type === 'screen_time_stats').length >= 2, 4000, 'stats on hello')

  /* -------------------------------------------------------- 2. heartbeat */

  const t = Date.now()
  socket.send(encodeOutbound({ type: 'ping', data: { t } }))
  const pong = await waitFor((m) => m.type === 'pong', 3000, 'pong (heartbeat)')
  check('pong echoes t', pong.data.t === t, `${pong.data.t} vs ${t}`)
  noDropped('heartbeat')

  /* -------------------------------------------------------- 3. set_limit */

  socket.send(encodeOutbound({ type: 'set_limit', data: { limitMinutes: 120 } }))
  ack = await waitFor((m) => m.type === 'ack' && m.data.of === 'set_limit', 3000, 'set_limit ack')
  check('set_limit ack ok', ack.data.ok === true)

  socket.send(encodeOutbound({ type: 'get_stats' })) // native dialect, like fake_client.py
  stats = await waitFor(
    (m) => m.type === 'screen_time_stats' && m.data.limitMinutes === 120,
    4000,
    'limit persisted (120 min)'
  )
  check('set_limit {limitMinutes} reached SQLite', stats.data.limitMinutes === 120)
  noDropped('set_limit')

  /* ----------------------------------------------------- 4. reminder_add */

  const dueAt = Date.now() + 1500
  socket.send(encodeOutbound({ type: 'reminder_add', data: { text: 'Drink water 💧', dueAt } }))
  ack = await waitFor((m) => m.type === 'ack' && m.data.of === 'reminder_add', 3000, 'reminder_add ack')
  check('reminder_add ack carries id', typeof ack.data.id === 'string' && ack.data.id.length > 0)

  const reminder = await waitFor((m) => m.type === 'reminder' && m.data.text === 'Drink water 💧', 6000, 'reminder event')
  check('reminder.id is a string', typeof reminder.data.id === 'string')
  check(
    'reminder.dueAt is epoch milliseconds',
    typeof reminder.data.dueAt === 'number' && Math.abs(reminder.data.dueAt - dueAt) < 5000,
    `dueAt=${reminder.data.dueAt} expected≈${dueAt}`
  )
  check('reminder.source is backend', reminder.data.source === 'backend')

  // Dismissing it (the bubble sends {id, kind}) must not produce an error.
  socket.send(encodeOutbound({ type: 'dismiss', data: { id: reminder.data.id, kind: 'reminder' } }))
  ack = await waitFor((m) => m.type === 'ack' && m.data.of === 'dismiss' && m.data.kind === 'reminder', 3000, 'dismiss reminder ack')
  check('reminder dismiss ack ok', ack.data.ok === true)
  noDropped('reminder flow')

  /* -------------------------------------------------------- 5. dismiss UI */

  socket.send(encodeOutbound({ type: 'dismiss', data: { kind: 'screen_time_warning' } }))
  await waitFor((m) => m.type === 'ack' && m.data.of === 'dismiss' && m.data.kind === 'screen_time_warning', 3000, 'warning dismiss ack')

  // Bubbles that only exist in the UI (auto ids like "bubble-3") must be no-ops.
  socket.send(encodeOutbound({ type: 'dismiss', data: { id: 'bubble-3', kind: 'notification' } }))
  await waitFor((m) => m.type === 'ack' && m.data.of === 'dismiss' && m.data.kind === 'notification', 3000, 'notification dismiss ack')

  // A locally scheduled reminder (id "local-...") has nothing stored in petd.
  socket.send(encodeOutbound({ type: 'dismiss', data: { id: 'local-1771-1', kind: 'reminder' } }))
  await waitFor(
    (m) => m.type === 'ack' && m.data.of === 'dismiss' && m.data.kind === 'reminder' && m.data.id === 'local-1771-1',
    3000,
    'local reminder dismiss ack'
  )
  noDropped('dismiss')

  /* ---------------------------------------------- 6. frontend-only commands */

  socket.send(encodeOutbound({ type: 'set_muted', data: { muted: true } }))
  await waitFor((m) => m.type === 'ack' && m.data.of === 'set_muted', 3000, 'set_muted ack')
  mark = received.length
  socket.send(encodeOutbound({ type: 'set_muted', data: { muted: false } }))
  await waitFor((m) => m.type === 'ack' && m.data.of === 'set_muted', 3000, 'set_muted ack', mark)
  socket.send(encodeOutbound({ type: 'game_event', data: { game: 'reaction', event: 'end', score: 412 } }))
  await waitFor((m) => m.type === 'ack' && m.data.of === 'game_event', 3000, 'game_event ack')
  noDropped('frontend-only commands')

  /* ----------------------------------------------- 7. native petd dialect */

  mark = received.length
  socket.send(encodeOutbound({ type: 'set_limit', data: { limit_seconds: 7200 } }))
  await waitFor((m) => m.type === 'ack' && m.data.of === 'set_limit', 3000, 'native set_limit ack', mark)

  socket.send(encodeOutbound({ type: 'set_reminder', data: { message: 'native reminder', due_in_seconds: 600 } }))
  ack = await waitFor((m) => m.type === 'ack' && m.data.of === 'set_reminder', 3000, 'native set_reminder ack')
  check('native set_reminder ack id', typeof ack.data.id === 'string')

  socket.send(encodeOutbound({ type: 'dismiss', data: { target: 'warning' } }))
  await waitFor((m) => m.type === 'ack' && m.data.of === 'dismiss' && m.data.target === 'warning', 3000, 'native warning ack')

  const nativeReminderId = ack.data.id
  socket.send(encodeOutbound({ type: 'dismiss', data: { target: 'reminder', id: nativeReminderId } }))
  await waitFor(
    (m) => m.type === 'ack' && m.data.of === 'dismiss' && m.data.id === nativeReminderId,
    3000,
    'native reminder ack'
  )

  // Unknown commands must still be rejected (documented petd behaviour).
  socket.send(encodeOutbound({ type: 'definitely_not_a_command', data: {} }))
  const err = await waitFor((m) => m.type === 'error', 3000, 'error for unknown command')
  check('unknown command -> error', err.data.code === 'UNKNOWN_COMMAND', JSON.stringify(err.data))

  /* ------------------------------------------------- 8. invalid arguments */

  socket.send(encodeOutbound({ type: 'set_limit', data: { limitMinutes: 'lots' } }))
  const argErr = await waitFor((m) => m.type === 'error' && m.data.code === 'INVALID_ARG', 3000, 'INVALID_ARG for bad set_limit')
  check('bad set_limit -> INVALID_ARG', argErr.data.code === 'INVALID_ARG')

  // Restore the original limit so the daemon's setting is untouched.
  mark = received.length
  socket.send(encodeOutbound({ type: 'set_limit', data: { limit_seconds: initialLimitMinutes * 60 } }))
  await waitFor((m) => m.type === 'ack' && m.data.of === 'set_limit', 3000, 'restore ack', mark)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (error) {
  console.error(`\nTEST ABORTED: ${error.message}`)
  if (dropped.length) console.error('frames the UI would drop:', dropped)
  process.exitCode = 1
} finally {
  socket.close()
}
