import WebSocket from 'ws'
import { encodeOutbound, parseInbound } from '../shared/protocol'
import type { BackendState, BackendStatus, InboundMessage, OutboundMessage } from '../shared/types'
import { log } from './log'

const HEARTBEAT_MS = 15_000
const PONG_TIMEOUT_MS = 45_000
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 30_000
const FACTOR = 1.8

/**
 * WebSocket client with exponential backoff + jitter. The renderer never talks
 * to the network directly: main owns the connection and re-broadcasts parsed,
 * validated messages. A dead or missing backend is therefore always recoverable
 * - the pet simply keeps roaming while we retry in the background.
 */
export class BackendClient {
  private socket: WebSocket | null = null
  private state: BackendState = 'idle'
  private attempt = 0
  private nextRetryAt: number | null = null
  private lastError: string | undefined
  private since = Date.now()
  private heartbeat: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private lastPongAt = Date.now()
  private disposed = false

  private readonly messageListeners = new Set<(msg: InboundMessage) => void>()
  private readonly statusListeners = new Set<(status: BackendStatus) => void>()

  constructor(private url: string) {}

  /* --------------------------------------------------------------- public */

  connect(): void {
    this.disposed = false
    this.open()
  }

  disconnect(): void {
    this.disposed = true
    this.clearTimers()
    this.closeSocket()
    this.setState('closed')
  }

  setUrl(url: string): void {
    if (url === this.url) return
    this.url = url
    this.attempt = 0
    if (this.disposed) return
    this.closeSocket()
    this.setState('connecting')
    this.scheduleRetry(null)
  }

  send(message: OutboundMessage): void {
    if (this.socket && this.socket.readyState === 1) {
      try {
        this.socket.send(encodeOutbound(message))
      } catch (err) {
        log.warn('ws: send failed', err)
      }
      return
    }
    log.debug('ws: dropping outbound message while disconnected', message.type)
  }

  status(): BackendStatus {
    return {
      url: this.url,
      state: this.state,
      attempt: this.attempt,
      since: this.since,
      nextRetryAt: this.nextRetryAt ?? undefined,
      lastError: this.lastError
    }
  }

  onMessage(cb: (msg: InboundMessage) => void): () => void {
    this.messageListeners.add(cb)
    return () => this.messageListeners.delete(cb)
  }

  onStatus(cb: (status: BackendStatus) => void): () => void {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  /* -------------------------------------------------------------- private */

  private open(): void {
    this.clearTimers()
    this.closeSocket()
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting')

    let socket: WebSocket
    try {
      socket = new WebSocket(this.url, { handshakeTimeout: 6000, maxPayload: 4 * 1024 * 1024 })
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.scheduleRetry(null)
      return
    }

    this.socket = socket
    this.lastPongAt = Date.now()

    socket.on('open', () => {
      this.attempt = 0
      this.lastError = undefined
      this.setState('open')
      log.info('ws: connected to', this.url)
      this.send({
        type: 'hello',
        data: { client: 'qbit-desktop-pet', version: '0.1.0', platform: process.platform }
      })
      this.startHeartbeat()
    })

    socket.on('message', (raw: unknown) => {
      const msg = parseInbound(raw as string | Uint8Array)
      if (!msg) {
        log.debug('ws: ignored malformed frame')
        return
      }
      if (msg.type === 'hello') {
        log.info('ws: backend hello', msg.data)
      } else if (msg.type === 'pong') {
        this.lastPongAt = Date.now()
        return
      }
      for (const listener of this.messageListeners) {
        try {
          listener(msg)
        } catch (err) {
          log.error('ws: message handler threw', err)
        }
      }
    })

    socket.on('error', (err: Error) => {
      this.lastError = err.message
      log.warn('ws: error', err.message)
    })

    socket.on('close', (code: number, reason: Buffer) => {
      this.stopHeartbeat()
      this.socket = null
      if (this.disposed) {
        this.setState('closed')
        return
      }
      const detail = reason && reason.length ? `${code} ${reason.toString()}` : String(code)
      log.warn('ws: closed', detail)
      this.scheduleRetry(`closed (${detail})`)
    })
  }

  private scheduleRetry(error: string | null): void {
    if (this.disposed) return
    if (error) this.lastError = error
    this.attempt += 1

    const raw = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(FACTOR, Math.max(0, this.attempt - 1)))
    const jitter = 0.75 + Math.random() * 0.5 // +-25%
    const delay = Math.round(raw * jitter)
    this.nextRetryAt = Date.now() + delay
    this.setState('reconnecting')

    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.nextRetryAt = null
      if (!this.disposed) this.open()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (!this.socket || this.socket.readyState !== 1) return
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        log.warn('ws: pong timeout, reconnecting')
        this.lastError = 'heartbeat timeout'
        this.closeSocket()
        this.scheduleRetry('heartbeat timeout')
        return
      }
      this.send({ type: 'ping', data: { t: Date.now() } })
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    this.clearRetryTimer()
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    try {
      socket.removeAllListeners()
      socket.terminate()
    } catch {
      /* ignore */
    }
  }

  private setState(state: BackendState): void {
    if (this.state === state) {
      // still notify: attempt/nextRetryAt may have changed
    } else {
      this.state = state
      this.since = Date.now()
    }
    const status = this.status()
    for (const listener of this.statusListeners) {
      try {
        listener(status)
      } catch (err) {
        log.error('ws: status handler threw', err)
      }
    }
  }
}
