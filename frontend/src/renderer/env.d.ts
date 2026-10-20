/// <reference types="vite/client" />

import type { QbitApi } from '../shared/ipc'

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts through contextBridge. */
    readonly qbit: QbitApi
  }
}

export {}
