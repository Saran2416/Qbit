#!/usr/bin/env node
/**
 * `npm run dev` - electron-vite dev launcher.
 *
 * On machines whose GPU driver segfaults Chromium, the app can only render in
 * software (SwiftShader), and the only way to select that backend is real
 * command-line flags on the Electron process itself - appendSwitch() and env
 * vars don't reach the GPU process, and app.relaunch() in dev would kill the
 * vite dev server. So we decide here, before the app starts, whether to pass
 * the SwiftShader flags through to Electron.
 *
 * The flags are appended after "--", which electron-vite copies into its
 * ELECTRON_CLI_ARGS variable right before spawning Electron. Setting
 * ELECTRON_CLI_ARGS in the environment directly does NOT work: the CLI
 * overwrites it from its own "--" option (an empty array is truthy),
 * silently dropping the flags.
 *
 * The decision mirrors src/main/index.ts:
 *   - QBIT_ENABLE_GPU=1    -> hardware, always
 *   - QBIT_DISABLE_GPU=1   -> software
 *   - <userData>/gpu-software-rendering marker -> software (written by the
 *     app after two GPU process crashes)
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const GPU_SOFTWARE_FLAGS = ['--use-gl=angle', '--use-angle=swiftshader']
// With the GPU process in software mode the window fails to map when the
// browser process started as native Wayland, so on Linux (where the app
// wants X11/XWayland anyway) ozone-platform=x11 must be on the real argv too.
if (process.platform === 'linux' && !process.argv.some((a) => a.startsWith('--ozone-platform'))) {
  if (!process.env.DISPLAY) {
    // No X11 display: ozone=x11 cannot work, so don't pretend the flags help.
    console.warn('[dev] gpu: no DISPLAY set - cannot force X11, software rendering may not map the window')
  } else {
    GPU_SOFTWARE_FLAGS.push('--ozone-platform=x11')
  }
}

/** Mirror of Electron's userData path for app name "qbit-pet" (see index.ts). */
function markerPath() {
  if (process.platform === 'linux') {
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'qbit-pet', 'gpu-software-rendering')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'qbit-pet', 'gpu-software-rendering')
  }
  return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'qbit-pet', 'gpu-software-rendering')
}

const softwareGpu =
  process.env.QBIT_ENABLE_GPU !== '1' &&
  (process.env.QBIT_DISABLE_GPU === '1' || existsSync(markerPath()))

// CLI passthrough: whatever extra flags the developer passed ("npm run dev --
// <flags>") reaches Electron too, minus duplicates of the automatic ones.
const cliArgs = process.argv.slice(2)
const baseFlags = softwareGpu ? GPU_SOFTWARE_FLAGS : []
const mergedFlags = [...baseFlags, ...cliArgs.filter((a) => !baseFlags.includes(a))]
const electronArgs = mergedFlags.length > 0 ? ['--', ...mergedFlags] : []
if (softwareGpu) {
  console.log(`[dev] gpu: hardware GPU crashed here before - starting Electron with SwiftShader (${GPU_SOFTWARE_FLAGS.join(' ')})`)
} else if (existsSync(markerPath())) {
  console.log('[dev] gpu: marker present but QBIT_ENABLE_GPU=1 - trying hardware acceleration')
}
if (electronArgs.length > 0) console.log(`[dev] electron argv extras: ${electronArgs.join(' ')}`)

const child = spawn('npx', ['electron-vite', 'dev', ...electronArgs], {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
