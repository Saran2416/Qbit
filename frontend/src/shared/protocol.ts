import type { InboundMessage, InboundType, OutboundMessage } from './types'

/**
 * Wire protocol helpers. Kept dependency free so the mock backend and the
 * renderer can both use the exact same validation.
 */

export const INBOUND_TYPES = [
  'hello',
  'active_app',
  'screen_time_warning',
  'notification',
  'reminder',
  'idle_state',
  'token_usage',
  'screen_time_stats',
  'ack',
  'error',
  'pong'
] as const satisfies readonly InboundType[]

const INBOUND_SET: ReadonlySet<string> = new Set<string>(INBOUND_TYPES)

export function isInboundType(value: unknown): value is InboundType {
  return typeof value === 'string' && INBOUND_SET.has(value)
}

/**
 * Parses a raw WebSocket frame. Returns null for anything that is not a
 * `{"type": "...", "data": {...}}` object, so a misbehaving backend can never
 * crash the UI - unknown message types are ignored, not fatal.
 */
export function parseInbound(raw: unknown): InboundMessage | null {
  if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) return null
  let text: string
  try {
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
  } catch {
    return null
  }
  if (!text || text.length > 1_000_000) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const obj = parsed as { type?: unknown; data?: unknown; ts?: unknown }
  if (!isInboundType(obj.type)) return null

  const data =
    obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : ({} as Record<string, unknown>)

  // Normalise: poke at the few fields the UI truly depends on.
  if (obj.type === 'notification' && typeof data.body !== 'string') {
    data.body = typeof data.title === 'string' ? data.title : ''
  }
  if (obj.type === 'reminder' && typeof data.text !== 'string') return null

  return { type: obj.type, data, ts: typeof obj.ts === 'number' ? obj.ts : undefined } as InboundMessage
}

export function encodeOutbound(msg: OutboundMessage): string {
  return JSON.stringify(msg)
}
