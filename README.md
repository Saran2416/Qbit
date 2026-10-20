# Qbit Pet

A desktop-pet robot that roams your screen and reacts to what you do, driven by a local
monitoring daemon.

```
Qbit Pet (Electron)  <--ws://127.0.0.1:8765-->  petd (Python daemon)
```

* **frontend/** — transparent, mostly click-through Electron overlay (TypeScript + Canvas +
  Vite, no UI framework). The robot walks the desktop, reacts with bubbles and a token chip,
  offers mini-games when you are idle, and shows today's screen time. It works offline:
  without the backend the pet simply keeps roaming.
* **backend/** — `petd`, a Python daemon that tracks the active window, screen time, idle
  state, desktop notifications and Claude Code token usage, then pushes events over a local
  WebSocket. It records only application names and durations — never keystrokes, window
  contents or screenshots.

Both sides speak a single wire schema, defined in [`frontend/src/shared/types.ts`](frontend/src/shared/types.ts)
and translated in [`backend/petd/server.py`](backend/petd/server.py).

## Requirements

* Node.js 20+ (22 LTS recommended), npm 10+
* Python 3.11+
* Windows 10/11 x64, or Linux on **X11/XWayland** — the overlay needs global cursor
  polling, absolute window positioning and per-pixel click-through, none of which exist in
  native Wayland sessions

## Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e .
python -m petd                     # options: --config path/to/config.toml --debug
```

Configuration lives in [`backend/config.toml`](backend/config.toml) (port, daily
screen-time limit, app → category mappings); data is stored in `backend/petd.sqlite3`.

```bash
pytest -v                          # unit tests
python fake_client.py              # inspect the socket; --interactive / --listen-only
```

## Frontend

```bash
cd frontend
npm install                        # also generates the tray/app icons
npm run dev                        # app only, connects to ws://127.0.0.1:8765
npm run dev:mock                   # app + fake backend (npm run mock for the mock alone)
```

```bash
npm run typecheck                  # tsc --noEmit
npm run build                      # typecheck + build into out/
npm start                          # run the built output
npm run test:wire                  # wire-contract test against a running petd
```

Package with `npm run dist:linux` (AppImage) or `npm run dist:win` (NSIS installer +
portable exe — cross-building Windows packages from Linux needs Wine; building on the
target OS is the painless path).

## Running both together

```bash
# terminal 1
cd backend && source .venv/bin/activate && python -m petd
# terminal 2
cd frontend && npm run dev
```

The app retries the backend with exponential backoff (1 s → 30 s), so the startup order
does not matter. To verify the connection end to end:

```bash
cd frontend && npm run test:wire
```

Click the robot for today's screen time, per-app breakdown, quick reminders and the
screen-time limit; the tray icon has Quit, Mute and Pause roaming.

## Files and settings

| What | Where |
| --- | --- |
| WebSocket URL | `~/.config/qbit-pet/settings.json` → `wsUrl` (default `ws://127.0.0.1:8765`) |
| Logs, settings, stats | `~/.config/qbit-pet/` (Linux) · `%APPDATA%\qbit-pet\` (Windows) |
| Backend config & database | `backend/config.toml` · `backend/petd.sqlite3` |
| Robot art (sprites) | see [`frontend/sprites/README.md`](frontend/sprites/README.md) |

Useful env vars for the app: `QBIT_DEBUG=1` (verbose logging), `QBIT_DISABLE_GPU=1`
(software rendering on broken GPU drivers), `QBIT_CAPTURE=/tmp/pet.png` +
`QBIT_CAPTURE_EXIT=1` (dump an overlay screenshot and quit).

## Known limitations

* Pure Wayland sessions cannot run the overlay (see Requirements).
* The always-on-top overlay can appear over fullscreen video; some games and screen-share
  tools capture or hide it.
* On GNOME Wayland the daemon cannot read window titles without a privileged Shell
  extension, so it falls back to best-effort heuristics; on Windows it cannot capture
  toast notifications, and every other feature keeps working.
* Local screen-time numbers (offline) are estimates from `active_app` ticks; while the
  backend is connected, its database figures win.
* Two instances of the app would fight over the same settings file — run one.
