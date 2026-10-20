# Qbit Pet

A desktop-pet robot that roams your screen, stays out of your way, and reacts to
screen-time events pushed by a local backend over WebSocket
(`ws://127.0.0.1:8765`).

* Transparent, frameless, always-on-top overlay spanning **all monitors**
* The robot walks along the bottom edge, pauses, idles, sleeps, flees your
  cursor and celebrates
* Click-through **everywhere** except the robot, bubbles and chips — clicks on
  other apps are never blocked
* Reaction bubbles: browser alerts, token-usage chip for editors, screen-time
  warnings (repeat-safe), reminders with a working "dismiss"
* Click the robot: today's screen time, per-app bar chart, quick-add reminder,
  screen-time limit
* Three mini-games (reaction time, rock-paper-scissors, dodge) in a small
  window, offered when the backend reports you are idle
* Tray icon: Quit, Mute, Pause roaming
* Low CPU: rendering is dirty-rect only, the loop stops completely in deep
  sleep, 30 fps cap

Built with Electron + TypeScript + Canvas + Vite. No UI framework. The robot is
drawn procedurally in code and can be swapped for real sprites — see
[`sprites/README.md`](sprites/README.md).

---

## Requirements

* Node.js 20+ (22 LTS recommended)
* npm 10+
* **Windows 10/11** — x64
* **Linux** — X11 or Wayland via XWayland (see the note below)

## Install

```bash
npm install
```

This also runs `postinstall` → `tools/make-icons.mjs`, which generates the
tray/app icons into `build/` (nothing binary is committed).

## Run in development

```bash
npm run dev          # app only
npm run dev:mock     # app + mock backend, both watched
```

`npm run dev:mock` is the fastest way to see every feature: it starts
`tools/mock-backend.mjs`, which emits every message type from
`src/shared/types.ts` on a loop (use `--fast` for 1.2 s pacing) and answers
`ping`/`dismiss`/`set_limit`/`reminder_add`/`game_event` round trips.

To run against the real Python backend instead, just start the app — it
connects to `ws://127.0.0.1:8765` and retries with exponential backoff
(1 s → 30 s) if the backend is down. Qbit works fully offline; only live events
and stats-by-backend are unavailable. `backend/petd` speaks exactly this
schema (see [`backend/README.md`](../backend/README.md)), so the real daemon
and `tools/mock-backend.mjs` are interchangeable; `npm run test:wire` verifies
the contract against a running daemon.

Other scripts:

```bash
npm run mock         # standalone mock backend (add -- --fast for fast pacing)
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + electron-vite build into out/
npm start            # run the built output (electron-vite preview)
```

## Run the built app

```bash
npm run build
npx electron .                       # unpackaged run of out/
```

Debug helpers (all optional, all env vars):

| Variable | Effect |
| --- | --- |
| `QBIT_DEBUG=1` | verbose logging |
| `QBIT_DISABLE_GPU=1` | software rendering (broken GPU drivers) |
| `QBIT_NO_DEVTOOLS` | don't open DevTools on renderer crash |
| `QBIT_CAPTURE=/tmp/pet.png` | save an overlay screenshot after boot (also writes `pet.canvas.png`) |
| `QBIT_CAPTURE_DELAY=6000` | delay before the capture, ms |
| `QBIT_CAPTURE_EXIT=1` | quit when the capture is written |

## Package for distribution

Icons are wired for both targets (`electron-builder.yml`).

### Windows

```bash
npm run dist:win
```

Produces `release/Qbit Pet-0.1.0-x64-setup.exe` (NSIS installer, per-user,
custom install dir) and `release/Qbit Pet-0.1.0-portable.exe` in
`release/` (the version number in the file name follows `package.json`).

### Linux

```bash
npm run dist:linux
```

Produces `release/Qbit Pet-0.1.0-x86_64.AppImage`. Make it executable and run:

```bash
chmod +x "release/Qbit Pet-0.1.0-x86_64.AppImage"
./"release/Qbit Pet-0.1.0-x86_64.AppImage"
```

On first launch the AppImage shows the bundled MIT license and asks you to
agree (standard electron-builder behavior; the answer is remembered).

Cross-building Windows packages from Linux needs Wine; building on the target
OS (or CI) is the headache-free path.

### Linux / Wayland note (important)

The app forces X11 (`--ozone-platform=x11`), which also works on Wayland
desktops through XWayland. This is deliberate: native Wayland has **no global
cursor polling**, **no absolute window positioning** and **no click-through** —
all three are core to the pet. If you pass your own `--ozone-platform` flag, it
is respected.

```bash
./"release/Qbit Pet-0.1.0-x86_64.AppImage" --ozone-platform=x11
```

## How it behaves

* **Roaming** — the pet walks along the bottom/edges of the *virtual desktop*
  (union of all monitors), pauses randomly, sleeps when you idle.
* **Cursor avoidance** — the cursor position is polled at 30 Hz; the pet walks
  away smoothly when you get within `cursorAvoidRadius` (default 150 px).
* **Click-through** — the overlay reports its interactive rectangles
  (robot + bubbles) to the main process, which toggles
  `setIgnoreMouseEvents(..., {forward: true})` from the polled cursor. Every
  pixel outside those rectangles belongs to the app underneath.
* **Events** (see `src/shared/types.ts` for the full schema):
  * `active_app` with `category: browser` → notification-style bubble
  * `active_app` with `category: editor` → token-usage chip with progress bar
  * `screen_time_warning` → alert bounce + bubble; deduped per day/limit, the
    bubble is updated instead of re-shown
  * `notification` / `reminder` → bubble with **dismiss**, sends
    `{"type":"dismiss","data":{"id":..., "kind":...}}` back
  * `idle_state` `idle=true` → after a short delay Qbit offers "Play a game?"
  * `token_usage`, `error`, `hello`, `pong` → chip / reactions
* **Stats** — accumulated locally from `active_app` ticks (pauses while idle,
  180 s staleness); `screen_time_stats` from the backend overrides them.
  Persisted to `screen-time.json`.

## Data files

Written to the app's data dir (kept tidy as `qbit-pet`):

* Linux: `~/.config/qbit-pet/`
* Windows: `%APPDATA%\qbit-pet\`

| File | Contents |
| --- | --- |
| `qbit.log` | rotating log (also contains renderer errors) |
| `settings.json` | all settings incl. `wsUrl`, mute, pause roaming, limit, bubble duration |
| `screen-time.json` | today's accumulated stats |
| `sprites/` | optional drop-in sprite overrides (hot-reloaded) |

`settings.json` is the source of truth for the WebSocket URL — edit it there to
point Qbit at a non-default port.

## Replacing the robot art

See [`sprites/README.md`](sprites/README.md). Short version: drop
`robot.json` + `robot.png` (a row-per-clip sprite sheet) into `sprites/` in the
repo, or into `<userData>/sprites/` for a hot-reloaded override without
rebuild. Broken sheets fall back to the built-in procedural robot, so the pet
can never end up invisible.

## Project layout

```
src/
  shared/     types.ts (wire schema), ipc.ts (channel names), settings, geometry
  main/       Electron main: overlay/panel/game windows, ws client, tray,
              stats, reminders, click-through authority, settings/log stores
  preload/    typed window.qbit bridge (renderer never touches fs/network)
  renderer/
    overlay/  roaming canvas pet: painter (dirty rects), motion (AI), brain
              (event → animation/bubble), bubbles, chip, sprite atlas
    panel/    popup panel: screen time, bar chart, reminder, limit
    game/     reaction, rock-paper-scissors, dodge
    lib/      tiny helpers (loop, dom, format, bridge)
tools/        mock backend, icon generator, dev runner
```

## Known limitations

* **Linux needs X11/XWayland** (see above). Pure Wayland sessions can't run
  this design.
* **Screen recording / fullscreen apps on top** — since the overlay is
  always-on-top, it will appear over fullscreen videos on some window
  managers; some games and screen-share tools capture or hide it. Not
  solvable for an overlay pet in general.
* **Cursor polling is root-coordinate based** — on fractional-scaling
  multi-monitor setups with *mixed* scales, coordinates are logical, so the pet
  can be off by a few pixels near monitor borders.
* **Mute mutes bubbles, not the pet** — muting suppresses bubbles and
  alert/happy animations; the token chip still appears (it is passive
  information). Tray "Pause roaming" freezes movement.
* **Local stats are estimates** — while the backend is connected,
  `screen_time_stats` wins; offline localStorage-based numbers are derived from
  `active_app` ticks and should be treated as approximate.
* **No code signing** — Windows builds are unsigned, so SmartScreen will warn.
* **Single instance per user** — two copies would fight over the settings file.
