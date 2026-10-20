import asyncio
import itertools
import json
import logging
import time
from typing import Any, Dict, Optional, Set

import websockets
from websockets.exceptions import ConnectionClosed

try:
    from websockets.asyncio.server import ServerConnection as WebSocketConn
    from websockets.asyncio.server import serve as ws_serve
except ImportError:
    ws_serve = websockets.serve
    try:
        from websockets.server import WebSocketServerProtocol as WebSocketConn
    except ImportError:
        WebSocketConn = Any

try:
    from importlib.metadata import version as _package_version

    PETD_VERSION = _package_version("petd")
except Exception:
    PETD_VERSION = "0.1.0"

from petd.bus import EventBus
from petd.config import ServerConfig
from petd.services.reminders import ReminderService
from petd.services.screen_time import ScreenTimeService

logger = logging.getLogger("petd.server")

# Monotonic source for synthetic notification ids (the OS does not give us one).
_notification_seq = itertools.count(1)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _stats_to_wire(stats: Dict[str, Any]) -> Dict[str, Any]:
    """
    Converts the internal stats snapshot (snake_case, seconds everywhere) into
    the frontend wire schema: `screen_time_stats` in src/shared/types.ts.
    """
    wire: Dict[str, Any] = {
        "date": stats.get("date"),
        "totalSeconds": int(stats.get("total_seconds", 0)),
        "limitMinutes": max(1, round(int(stats.get("limit_seconds", 0)) / 60)),
        "apps": [
            {
                "app": row.get("app_name", "unknown"),
                "category": row.get("category", "other"),
                "seconds": int(row.get("seconds", 0)),
            }
            for row in stats.get("apps", []) or []
        ],
    }

    # Extra (ignored by the UI, handy for the fake client): reminders that are
    # still waiting, already in the shape a `reminder` event would have.
    active = stats.get("active_reminders") or []
    if active:
        wire["activeReminders"] = [_reminder_to_wire(r) for r in active]
    return wire


def _reminder_to_wire(reminder: Dict[str, Any]) -> Dict[str, Any]:
    """`{id, message, due_timestamp}` -> `{id, text, dueAt, source}` (ms!)."""
    due_ts = reminder.get("due_timestamp")
    return {
        "id": str(reminder.get("id", "")),
        "text": reminder.get("message", ""),
        "dueAt": int(float(due_ts) * 1000) if due_ts is not None else None,
        "source": "backend",
    }


def _event_to_wire(event_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Translates one internal bus event into the frontend wire schema.

    The services keep emitting their own snake_case payloads (that contract is
    what the unit tests assert on); everything that crosses the socket is
    normalised here, in the single place where petd meets the frontend.
    """
    match event_type:
        case "active_app":
            wire: Dict[str, Any] = {
                "app": data.get("app_name", ""),
                "category": data.get("category", "other"),
            }
            if isinstance(data.get("title"), str):
                wire["title"] = data["title"]
            if data.get("process_id") is not None:
                wire["pid"] = int(data["process_id"])
            return wire

        case "screen_time_warning":
            total = int(data.get("total_seconds", 0))
            return {
                "minutes": round(total / 60),
                "limit": int(data.get("limit_seconds", 0)),
                "message": data.get("message", ""),
            }

        case "reminder":
            return _reminder_to_wire(data)

        case "notification":
            urgency = data.get("urgency")
            wire = {
                "id": f"notif-{next(_notification_seq)}",
                "title": data.get("summary") or data.get("body") or "Notification",
                "body": data.get("body") or "",
            }
            if data.get("app_name"):
                wire["app"] = data["app_name"]
            if urgency is not None:
                wire["urgent"] = int(urgency) >= 1
            return wire

        case "idle_state":
            return {
                "idle": bool(data.get("is_idle")),
                "idleSeconds": int(data.get("idle_seconds", 0)),
            }

        case "token_usage":
            wire = {"used": int(data.get("used", 0)), "updatedAt": _now_ms()}
            if data.get("limit") is not None:
                wire["limit"] = int(data["limit"])
            provider = str(data.get("provider") or "").strip()
            if provider:
                # "claude_code" -> "Claude Code" (shown in the budget bubble)
                wire["label"] = provider.replace("_", " ").title()
            if data.get("model"):
                wire["model"] = str(data["model"])
            return wire

        case _:
            # Unknown event types are forwarded untouched: a new service must
            # never be silently swallowed just because the UI does not know it.
            return data


class WebSocketServer:
    """
    Local WebSocket server running at ws://127.0.0.1:8765.
    Broadcasts petd events to connected frontend clients and processes
    incoming RPC commands.

    Wire protocol: the Qbit frontend schema (frontend/src/shared/types.ts),
    the exact same dialect tools/mock-backend.mjs speaks. The historical petd
    command names (`get_stats`, `set_reminder`, `set_limit`, `dismiss` with
    `target`) are still accepted as aliases so fake_client.py keeps working.
    """

    def __init__(
        self,
        config: ServerConfig,
        bus: EventBus,
        screen_time_service: ScreenTimeService,
        reminder_service: ReminderService,
    ):
        self._config = config
        self._bus = bus
        self._screen_time = screen_time_service
        self._reminders = reminder_service
        self._clients: Set[WebSocketConn] = set()
        self._server = None
        self._running = False

    async def start(self) -> None:
        self._running = True
        self._bus.subscribe(self._on_bus_event)
        self._server = await ws_serve(
            self._handle_client,
            host=self._config.host,
            port=self._config.port,
        )
        logger.info(
            f"WebSocket server listening on ws://{self._config.host}:{self._config.port}"
        )

    async def _on_bus_event(self, event_type: str, data: Dict[str, Any]) -> None:
        """Broadcasts internal events from EventBus to all connected clients."""
        if not self._clients:
            return

        payload = json.dumps(
            {"type": event_type, "data": _event_to_wire(event_type, data), "ts": _now_ms()}
        )
        tasks = []
        for client in list(self._clients):
            tasks.append(self._safe_send(client, payload))

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _safe_send(self, client: WebSocketConn, payload: str) -> None:
        try:
            await client.send(payload)
        except Exception:
            self._clients.discard(client)

    async def _send(
        self,
        client: WebSocketConn,
        msg_type: str,
        data: Dict[str, Any],
        ts: bool = True,
    ) -> None:
        envelope: Dict[str, Any] = {"type": msg_type, "data": data}
        if ts:
            envelope["ts"] = _now_ms()
        await client.send(json.dumps(envelope))

    async def _send_ack(
        self, client: WebSocketConn, of: str, ok: bool = True, **extra: Any
    ) -> None:
        data: Dict[str, Any] = {"of": of, "ok": ok}
        data.update(extra)
        await self._send(client, "ack", data, ts=False)

    async def _send_stats(self, client: WebSocketConn) -> None:
        """Sends today's screen-time snapshot as `screen_time_stats`."""
        stats = await self._screen_time.get_stats()
        active = await self._reminders.get_active_reminders()
        stats["active_reminders"] = active
        await self._send(client, "screen_time_stats", _stats_to_wire(stats))

    async def _handle_client(self, websocket: WebSocketConn) -> None:
        client_address = websocket.remote_address
        logger.info(f"Frontend pet client connected from {client_address}")
        self._clients.add(websocket)

        # Greet the client and push the current state right away.
        try:
            await self._send(
                websocket,
                "hello",
                {"server": "petd", "version": PETD_VERSION, "serverTime": _now_ms()},
            )
            await self._send_stats(websocket)
        except Exception as e:
            logger.debug(f"Failed to send initial state to client: {e}")

        try:
            async for raw_message in websocket:
                try:
                    msg = json.loads(raw_message)
                    if not isinstance(msg, dict):
                        await self._send_error(websocket, "Message must be a JSON object", "INVALID_FORMAT")
                        continue

                    msg_type = msg.get("type", "")
                    data = msg.get("data", {})
                    await self._dispatch_command(websocket, msg_type, data)

                except json.JSONDecodeError:
                    await self._send_error(websocket, "Invalid JSON received", "JSON_DECODE_ERROR")
                except Exception as e:
                    logger.error(f"Error handling client command: {e}", exc_info=True)
                    await self._send_error(websocket, str(e), "INTERNAL_ERROR")
        except ConnectionClosed:
            pass
        finally:
            self._clients.discard(websocket)
            logger.info(f"Frontend pet client disconnected from {client_address}")

    async def _dispatch_command(
        self, websocket: WebSocketConn, cmd: str, data: Dict[str, Any]
    ) -> None:
        """
        Handles commands in either dialect:
          frontend: hello, ping, reminder_add, set_limit {limitMinutes},
                    dismiss {kind, id}, set_muted, game_event
          native:   get_stats, set_reminder, set_limit {limit_seconds},
                    dismiss {target, id}
        """
        match cmd:
            case "hello":
                await self._send(
                    websocket,
                    "hello",
                    {"server": "petd", "version": PETD_VERSION, "serverTime": _now_ms()},
                )
                await self._send_stats(websocket)

            case "ping":
                # Heartbeat: the frontend reconnects if no pong arrives in time.
                await self._send(websocket, "pong", {"t": data.get("t")}, ts=False)

            case "get_stats":
                await self._send_stats(websocket)

            case "set_reminder":
                reminder = await self._create_reminder(websocket, data, of=cmd)
                if reminder is not None:
                    await self._send_ack(websocket, of=cmd, id=str(reminder["id"]))

            case "reminder_add":
                # Frontend dialect: {text, dueAt} with an epoch in milliseconds.
                text = str(data.get("text") or "").strip()
                due_at = data.get("dueAt")
                if not text:
                    await self._send_error(websocket, "Reminder text cannot be empty", "INVALID_ARG")
                    return

                due_ts: Optional[float] = None
                if isinstance(due_at, (int, float)) and due_at > 0:
                    due_ts = float(due_at) / 1000.0

                reminder = await self._create_reminder(
                    websocket,
                    {"message": text, "due_timestamp": due_ts, "due_in_seconds": None if due_ts else 0},
                    of=cmd,
                )
                if reminder is not None:
                    await self._send_ack(websocket, of=cmd, ok=True, id=str(reminder["id"]))

            case "set_limit":
                await self._apply_limit(websocket, data, of=cmd)

            case "dismiss":
                await self._apply_dismiss(websocket, data)

            case "set_muted" | "game_event":
                # Frontend-only features (mute, mini games): acknowledged so the
                # client never sees a spurious error, but petd keeps no state.
                await self._send_ack(websocket, of=cmd)

            case _:
                await self._send_error(
                    websocket, f"Unknown command type: '{cmd}'", "UNKNOWN_COMMAND"
                )

    async def _create_reminder(
        self, websocket: WebSocketConn, data: Dict[str, Any], of: str
    ) -> Optional[Dict[str, Any]]:
        """Shared by `set_reminder` and `reminder_add`; errors are reported inline."""
        message = data.get("message", "")
        due_in_sec = data.get("due_in_seconds")
        due_ts = data.get("due_timestamp")

        try:
            return await self._reminders.set_reminder(
                message=message,
                due_in_seconds=due_in_sec,
                due_timestamp=due_ts,
            )
        except ValueError as e:
            await self._send_error(websocket, str(e), "INVALID_ARG")
            logger.debug(f"Rejected reminder ({of}): {e}")
            return None

    async def _apply_limit(
        self, websocket: WebSocketConn, data: Dict[str, Any], of: str
    ) -> None:
        """`set_limit` accepts {limit_seconds} (native) or {limitMinutes} (frontend)."""
        if "limitMinutes" in data:
            minutes = data.get("limitMinutes")
            if not isinstance(minutes, (int, float)) or minutes <= 0:
                await self._send_error(websocket, "limitMinutes must be a positive number", "INVALID_ARG")
                return
            limit_seconds = int(minutes * 60)
        else:
            limit_seconds = data.get("limit_seconds")
            if limit_seconds is None or not isinstance(limit_seconds, (int, float)):
                await self._send_error(websocket, "limit_seconds must be a number", "INVALID_ARG")
                return
            limit_seconds = int(limit_seconds)

        await self._screen_time.set_limit(limit_seconds)
        await self._send_ack(websocket, of=of, limitMinutes=max(1, round(limit_seconds / 60)))

    async def _apply_dismiss(
        self, websocket: WebSocketConn, data: Dict[str, Any]
    ) -> None:
        # Frontend dialect: {kind, id} where kind is the bubble kind.
        # Native dialect:   {target, id} where target is warning|reminder.
        if "kind" in data:
            kind = str(data.get("kind") or "")
            r_id = data.get("id")

            if kind in ("screen_time_warning", "warning"):
                await self._screen_time.dismiss_warning()
                await self._send_ack(websocket, of="dismiss", kind=kind)
            elif kind == "reminder":
                parsed = _as_int(r_id)
                if parsed is None:
                    # Locally scheduled reminder (id like "local-..."): petd has
                    # nothing to dismiss, acknowledge and move on.
                    await self._send_ack(websocket, of="dismiss", kind=kind, id=str(r_id))
                    return
                dismissed = await self._reminders.dismiss(parsed)
                await self._send_ack(
                    websocket, of="dismiss", kind=kind, ok=dismissed, id=str(parsed)
                )
            else:
                # Bubbles that only exist in the UI (notifications, games, ...):
                # petd keeps no state for them, so a plain acknowledgement.
                await self._send_ack(websocket, of="dismiss", kind=kind)
            return

        target = str(data.get("target") or "")
        r_id = data.get("id")

        if target == "warning":
            await self._screen_time.dismiss_warning()
            await self._send_ack(websocket, of="dismiss", target="warning")
        elif target == "reminder" or r_id is not None:
            parsed = _as_int(r_id)
            if parsed is None:
                if r_id is None:
                    await self._send_error(websocket, "Reminder ID is required", "MISSING_ID")
                    return
                # UI-local id ("local-..."/"bubble-3"): nothing stored here.
                await self._send_ack(websocket, of="dismiss", target=target or None, id=str(r_id))
                return
            dismissed = await self._reminders.dismiss(parsed)
            await self._send_ack(
                websocket,
                of="dismiss",
                ok=dismissed,
                target="reminder",
                id=str(parsed),
            )
        else:
            await self._send_error(
                websocket,
                "dismiss target must be 'warning' or 'reminder'",
                "INVALID_TARGET",
            )

    async def _send_error(
        self, websocket: WebSocketConn, message: str, code: str
    ) -> None:
        payload = json.dumps({"type": "error", "data": {"message": message, "code": code}})
        try:
            await websocket.send(payload)
        except Exception:
            pass

    async def stop(self) -> None:
        self._running = False
        self._bus.unsubscribe(self._on_bus_event)
        if self._clients:
            close_tasks = [client.close() for client in list(self._clients)]
            await asyncio.gather(*close_tasks, return_exceptions=True)
            self._clients.clear()

        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        logger.info("WebSocket server stopped.")


def _as_int(value: Any) -> Optional[int]:
    """Accepts ints and the string ids the frontend sends ("12"), rejects the rest."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return None
