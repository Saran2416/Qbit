import type { AppCategory, TokenUsage } from '../../shared/types'

/** One palette for the pet chip, the panel bars and the game UI. */
export const CATEGORY_COLORS: Record<AppCategory, string> = {
  browser: '#4f9dff',
  editor: '#7ef0ff',
  media: '#ff8ac2',
  terminal: '#8ef2a8',
  chat: '#ffd166',
  game: '#c084fc',
  meeting: '#ffa07a',
  other: '#8fa3bf'
}

export function categoryColor(category: AppCategory | undefined): string {
  return CATEGORY_COLORS[category ?? 'other'] ?? CATEGORY_COLORS.other
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m`
  return `${total}s`
}

export function formatCompact(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`
  if (m > 0) return `${m}m`
  return `${total}s`
}

export function formatTokens(usage: TokenUsage): string {
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))
  const used = fmt(usage.used)
  return usage.limit ? `${used} / ${fmt(usage.limit)}` : used
}

export function formatClock(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const diff = timestamp - now
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60_000)
  if (abs < 60_000) return diff >= 0 ? 'now' : 'just now'
  const label = mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`
  return diff >= 0 ? `in ${label}` : `${label} ago`
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}
