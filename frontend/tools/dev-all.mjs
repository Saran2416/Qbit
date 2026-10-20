#!/usr/bin/env node
/**
 * `npm run dev:mock` - starts the mock backend and electron-vite side by side,
 * so you get a UI with live events in one terminal and one Ctrl-C.
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const children = []

function start(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  child.on('exit', (code) => {
    console.log(`[dev] ${name} exited with code ${code}`)
    shutdown()
  })
  children.push(child)
  return child
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

start('mock backend', process.execPath, [join(ROOT, 'tools', 'mock-backend.mjs'), '--fast'])
start('electron-vite', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-vite', 'dev'])
