import type { QbitApi } from '../../shared/ipc'

/**
 * Typed access to the preload bridge, plus a couple of renderer-side helpers.
 * Importing this once means `window.qbit` is only ever touched in one file.
 */
export function api(): QbitApi {
  return window.qbit
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!window.qbit
}

export const bridgeLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
  if (hasBridge()) window.qbit.log(level, message)
  else console.log(`[qbit:${level}]`, message)
}

/**
 * Renderer exceptions are invisible by default in a framed-less Electron app, so
 * they are forwarded to the main log file (qbit.log in the user data dir).
 */
export function installErrorReporting(scope: string): void {
  window.addEventListener('error', (event) => {
    bridgeLog('error', `${scope}: ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    bridgeLog('error', `${scope}: unhandled rejection ${String(event.reason)}`)
  })
}
