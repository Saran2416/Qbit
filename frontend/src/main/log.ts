import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Tiny logger. Writes to stdout plus a rotating file in userData, which is the
 * only sane way to debug an always-on-top transparent window on Windows.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type LogLevel = keyof typeof LEVELS

const MAX_BYTES = 512 * 1024
let logFile: string | null = null
let writes = 0

export function initLogFile(userDataDir: string): void {
  try {
    mkdirSync(userDataDir, { recursive: true })
    logFile = join(userDataDir, 'qbit.log')
  } catch {
    logFile = null
  }
}

function rotateIfNeeded(): void {
  if (!logFile) return
  try {
    if (statSync(logFile).size > MAX_BYTES) {
      renameSync(logFile, `${logFile}.1`)
    }
  } catch {
    /* file does not exist yet */
  }
}

function write(level: LogLevel, args: unknown[]): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ')}`

  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(`[qbit] ${line}`)

  if (!logFile) return
  try {
    if (++writes % 200 === 0) rotateIfNeeded()
    appendFileSync(logFile, line + '\n')
  } catch {
    /* never let logging break the app */
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const log = {
  debug: (...args: unknown[]) => {
    if (process.env.QBIT_DEBUG === '1') write('debug', args)
  },
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
  filePath: (): string | null => (logFile ? dirname(logFile) : null)
}
