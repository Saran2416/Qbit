# petd: Desktop-Pet Monitor Daemon Backend

`petd` is a cross-platform background monitoring service engineered for desktop-pet robot applications. It observes user activity across **Linux** (X11, GNOME Wayland, Hyprland) and **Windows**, aggregating statistics and broadcasting real-time events to frontend pet clients over a local WebSocket connection (`ws://127.0.0.1:8765`).

---

## 🔒 Privacy Guarantees

Privacy is a core architectural requirement of `petd`:
- **Strictly Duration & App Names Only**: The daemon records only process/application binary names and active durations in seconds aggregated per calendar day in SQLite.
- **Zero Input Snooping**: Although `pynput` is utilized to detect whether the user is idle, input callbacks record strictly monotonic timestamps (`time.monotonic()`). Keystrokes, character inputs, key combinations, text buffers, mouse coordinates, and click locations are **never logged, never stored, and never transmitted**.
- **No Window Content Snooping**: The daemon does not capture screenshots, window contents, DOM states, or internal text buffers.

---

## 🏗 Architecture & Tech Stack

- **Python 3.11+** with `asyncio`
- **`websockets`**: Asynchronous WebSocket server broadcasting JSON events and handling RPC commands.
- **`sqlite3`**: Embedded relational storage with WAL mode for persistent screen-time metrics, reminder schedules, and configuration settings.
- **`pynput`**: Non-invasive system idle detector.
- **`psutil`**: Lightweight process identification and categorization.
- **`dbus-next`** *(Linux)*: Asynchronous D-Bus session bus monitor capturing desktop notifications.
- **`ctypes` / `pywin32`** *(Windows)*: Win32 API adapters for foreground window tracking.
- **Decoupled Platform Adapters**: Operating system checks are strictly isolated behind unified abstract interfaces (`BaseWindowTracker`, `BaseNotificationCollector`). No OS checks are scattered through core business logic.

---

## 📦 Project Tree

```
backend/
├── config.toml                      # Daemon configuration and app-to-category mappings
├── fake_client.py                   # WebSocket test and verification client
├── petd/
│   ├── __init__.py
│   ├── __main__.py                  # CLI entry point (python -m petd)
│   ├── bus.py                       # Internal async pub-sub event bus
│   ├── config.py                    # TOML configuration parser and category mapper
│   ├── daemon.py                    # Daemon coordinator and graceful lifecycle manager
│   ├── db.py                        # SQLite storage and async repository
│   ├── logger.py                    # Structured logging setup
│   ├── server.py                    # WebSocket server and command dispatch
│   ├── platforms/
│   │   ├── __init__.py
│   │   ├── base.py                  # Abstract platform adapter interfaces
│   │   ├── factory.py               # Platform detector and adapter instantiator
│   │   ├── linux_dbus.py            # Linux D-Bus notification monitor (BecomeMonitor)
│   │   ├── linux_gnome.py           # GNOME Wayland best-effort fallback tracker
│   │   ├── linux_hyprland.py        # Hyprland activewindow tracker (`hyprctl -j`)
│   │   ├── linux_x11.py             # Linux X11 active window tracker (`Xlib` / `xdotool`)
│   │   └── windows.py               # Windows ctypes tracker & notification stub
│   └── services/
│       ├── __init__.py
│       ├── idle.py                  # Idle detector service
│       ├── notifications.py         # Notification collection service
│       ├── reminders.py             # Persistent SQLite reminder engine
│       ├── screen_time.py           # Screen-time tracking, idle pause, and warning logic
│       ├── token_usage/
│       │   ├── __init__.py
│       │   ├── base.py              # Plugin interface: UsageProvider
│       │   ├── claude_code.py       # Claude Code JSONL log parser provider
│       │   └── service.py           # Token usage service (active only during 'editor' category)
│       └── window_tracker.py        # 1s polling active window change detector
├── pyproject.toml                   # Project metadata and dependencies
└── tests/
    ├── __init__.py
    ├── test_components.py           # Unit tests for config, event bus, and token parser
    ├── test_reminders.py            # Unit tests for reminder persistence and restart survival
    └── test_screen_time.py          # Unit tests for screen time accumulation, idle pause, and limits
```

---

## 📡 WebSocket API (`ws://127.0.0.1:8765`)

All communication uses JSON objects with the format `{"type": "...", "data": {...}}`.

**Wire schema**: petd speaks the *Qbit frontend schema* — the contract defined in
[`frontend/src/shared/types.ts`](../frontend/src/shared/types.ts) and implemented by
`frontend/tools/mock-backend.mjs`. The Electron pet, the mock and this daemon are therefore
interchangeable: no translation layer is needed on either side. Every frame carries an
optional `ts` (epoch milliseconds), except `ack` and `pong`.

Internally the services still emit their own snake_case payloads on the event bus (that is
the contract the unit tests assert on); [`petd/server.py`](petd/server.py) normalises
everything that crosses the socket, in the one place where petd meets the frontend.

### Pushed Events (Backend ➔ Frontend)

| Event Type | Description | Sample Data Payload |
|---|---|---|
| `hello` | Sent on connection and as the reply to a client `hello` | `{"server": "petd", "version": "0.1.0", "serverTime": 1792515044522}` |
| `screen_time_stats` | Today's snapshot (on connection, on `hello`, on `get_stats`) | `{"date": "2026-10-16", "totalSeconds": 3600, "limitMinutes": 480, "apps": [{"app": "code", "category": "editor", "seconds": 1800}]}` |
| `active_app` | Emitted when focused window or application changes | `{"app": "code", "title": "petd - Visual Studio Code", "category": "editor", "pid": 1234}` |
| `screen_time_warning` | Emitted when daily limit is reached (repeats every 30 min) | `{"minutes": 480, "limit": 28800, "message": "Daily screen time limit (8h 0m) exceeded!"}` |
| `reminder` | Emitted when a scheduled reminder is due | `{"id": "1", "text": "Drink water 💧", "dueAt": 1792173718900, "source": "backend"}` |
| `notification` | Emitted when a system desktop notification arrives | `{"id": "notif-1", "title": "New Message", "body": "Hey, do you have a minute?", "app": "Slack", "urgent": true}` |
| `token_usage` | Emitted periodically **only while active app category is `editor`** | `{"used": 15420, "limit": 250000, "label": "Claude Code", "updatedAt": 1792515044522}` |
| `idle_state` | Emitted when user goes idle (> 120s) or returns | `{"idle": true, "idleSeconds": 120}` |
| `error` | A command could not be handled | `{"message": "Unknown command type: 'x'", "code": "UNKNOWN_COMMAND"}` |

Timestamps: `reminder.dueAt` and `notification`/`token_usage.updatedAt` are epoch
**milliseconds** (`due_timestamp` inside the daemon stays in seconds). `screen_time_stats`
may also carry `activeReminders` (same shape as a `reminder` event) for clients that want
the pending queue.

### Client Commands (Frontend ➔ Backend)

Replies are `hello`, `pong`, `ack` (`{"of": "<command>", "ok": true, ...}`) or `error`.
Both vocabularies are accepted — the frontend one the Qbit app sends, and the original
petd aliases that `fake_client.py` uses.

| Qbit (frontend) dialect | petd alias | Effect |
|---|---|---|
| `{"type": "ping", "data": {"t": 1792515044522}}` | — | replies `pong` echoing `t` (heartbeat) |
| `{"type": "hello", "data": {"client": "qbit-desktop-pet", ...}}` | — | replies `hello` + `screen_time_stats` |
| `{"type": "reminder_add", "data": {"text": "Stretch break 🧘", "dueAt": 1792175000000}}` | `set_reminder` `{"message": ..., "due_in_seconds": 300}` (or `due_timestamp`) | persists a reminder (survives restarts) |
| `{"type": "set_limit", "data": {"limitMinutes": 120}}` | `set_limit` `{"limit_seconds": 7200}` | updates the daily screen-time limit |
| `{"type": "dismiss", "data": {"id": "1", "kind": "reminder"}}` | `dismiss` `{"target": "reminder", "id": 1}` | dismisses a reminder |
| `{"type": "dismiss", "data": {"kind": "screen_time_warning"}}` | `dismiss` `{"target": "warning"}` | acknowledges a screen-time warning |
| `{"type": "dismiss", "data": {"id": "bubble-3", "kind": "notification"}}` | — | UI-only bubbles are acknowledged as no-ops |
| `{"type": "set_muted", "data": {"muted": true}}`, `game_event` | — | acknowledged (mute/games live in the UI only) |
| — | `get_stats` | replies with `screen_time_stats` |

Unknown command types still get an `error` frame with `code: "UNKNOWN_COMMAND"`, and bad
arguments get `INVALID_ARG`.

---

## 🚀 Run Instructions

### Prerequisites
- Python 3.11 or newer

### Setup Virtual Environment
```bash
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -e .
```

### Running on Linux

#### 1. Linux Dependencies
- Standard dependencies: `websockets`, `psutil`, `pynput`, `dbus-next`, `python-xlib`.
- For X11: `python-xlib` (or `xdotool`).
- For Hyprland: `hyprctl` (pre-installed with Hyprland).
- For D-Bus notifications: session bus must be active (`DBUS_SESSION_BUS_ADDRESS`).

#### 2. Start the Daemon
```bash
python -m petd
```
With custom config or debug output:
```bash
python -m petd --config /path/to/custom_config.toml --debug
```

---

### Running on Windows

#### 1. Windows Dependencies
```cmd
python -m venv .venv
.venv\Scripts\activate
pip install websockets psutil pynput pywin32 pytest pytest-asyncio
```

#### 2. Start the Daemon
```cmd
python -m petd
```

---

### Testing with Fake Client
In a separate terminal, run:
```bash
python fake_client.py
```
Options:
- `python fake_client.py`: Automated demo of stats, reminder creation, firing, and limits.
- `python fake_client.py --interactive`: Interactive REPL prompt to dispatch commands manually.
- `python fake_client.py --listen-only`: Passive live event listener.

### Running Unit Tests
```bash
pytest -v
```

### Testing the wire contract against the real frontend

With the daemon running, from `../frontend`:
```bash
npm run test:wire
```
Replays every message the Electron main process sends, validates every reply with the
frontend's own parser, and re-checks the legacy petd dialect used by `fake_client.py`.

---

## ⚠️ Known Limitations & Degradation Behavior

1. **GNOME Wayland Window Focus Restriction**:
   - *Limitation*: The Wayland protocol is deliberately engineered around client isolation. Unprivileged background services cannot inspect window titles or focus changes across arbitrary Wayland windows.
   - *Degradation Behavior*: `petd` never crashes. It logs a prominent warning on startup and uses a multi-tier fallback:
     1. Checks if an Xwayland window is currently active via Xlib.
     2. Inspects active user graphical processes via `psutil` heuristics.
     3. For full native GNOME Wayland window title tracking, users can install a privileged GNOME Shell extension (such as `window-calls`).

2. **Windows Desktop Notification Listener**:
   - *Limitation*: Capturing global Windows toast / Action Center notifications requires the Windows Runtime (WinRT) `Windows.UI.Notifications.Management.UserNotificationListener` API. This API strictly mandates that the calling process possesses a packaged MSIX identity with the `userNotificationListener` restricted capability or elevated COM authorization. Unpackaged Python scripts running in standard user space cannot directly intercept toast notifications.
   - *Degradation Behavior*: On Windows, `petd` activates `WindowsNotificationCollector`, an intentional stub adapter that logs an explanatory notice at startup and allows all other daemon features (active window tracking, screen time, reminders, token usage, idle detection) to run seamlessly without error.

3. **Claude Code Log Path**:
   - Claude Code session transcripts are read from `~/.claude/projects/**/*.jsonl`. If Claude Code has not been run or the path is located elsewhere, `ClaudeCodeUsageProvider` returns `0` tokens used without throwing. The path can be edited in `config.toml`.
