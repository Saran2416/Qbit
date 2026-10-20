import asyncio
import logging
from typing import Optional

from petd.platforms.base import (
    BaseNotificationCollector,
    NotificationCallback,
    NotificationData,
)

logger = logging.getLogger("petd.platforms.dbus_notifications")


class LinuxDbusNotificationCollector(BaseNotificationCollector):
    """
    Collects desktop notifications on Linux systems via D-Bus session bus monitoring.
    Taps `org.freedesktop.Notifications.Notify` method calls.
    """

    def __init__(self):
        self._bus = None
        self._callback: Optional[NotificationCallback] = None
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self, callback: NotificationCallback) -> None:
        self._callback = callback
        self._running = True

        try:
            from dbus_next.aio import MessageBus
            from dbus_next.constants import BusType
            from dbus_next.message import Message, MessageType

            self._bus = await MessageBus(bus_type=BusType.SESSION).connect()

            # Attempt modern BecomeMonitor interface first
            rule = "type='method_call',interface='org.freedesktop.Notifications',member='Notify'"
            become_monitor_msg = Message(
                destination="org.freedesktop.DBus",
                path="/org/freedesktop/DBus",
                interface="org.freedesktop.DBus.Monitoring",
                member="BecomeMonitor",
                signature="asu",
                body=[[rule], 0],
            )

            reply = await self._bus.call(become_monitor_msg)
            if reply.message_type != MessageType.METHOD_RETURN:
                logger.debug("BecomeMonitor failed, attempting fallback AddMatch eavesdrop rule")
                fallback_msg = Message(
                    destination="org.freedesktop.DBus",
                    path="/org/freedesktop/DBus",
                    interface="org.freedesktop.DBus",
                    member="AddMatch",
                    signature="s",
                    body=[f"eavesdrop=true,{rule}"],
                )
                await self._bus.call(fallback_msg)

            self._bus.add_message_handler(self._on_message)
            logger.info("Linux D-Bus notification monitor attached to org.freedesktop.Notifications")
        except ImportError:
            logger.warning("dbus-next package not available; Linux notification collection disabled.")
        except Exception as e:
            logger.warning(f"Could not connect to D-Bus session bus for notifications: {e}")

    def _on_message(self, message) -> None:
        if not self._running or not self._callback:
            return

        if message.member == "Notify" and message.body and len(message.body) >= 5:
            try:
                # Signature of Notify: (susssasa{sv}i)
                # 0: app_name (s)
                # 1: replaces_id (u)
                # 2: app_icon (s)
                # 3: summary (s)
                # 4: body (s)
                # 5: actions (as)
                # 6: hints (a{sv})
                # 7: timeout (i)
                app_name = str(message.body[0]) if message.body[0] else "System"
                summary = str(message.body[3]) if len(message.body) > 3 else ""
                body = str(message.body[4]) if len(message.body) > 4 else ""

                urgency = 1
                if len(message.body) > 6 and isinstance(message.body[6], dict):
                    hints = message.body[6]
                    if "urgency" in hints:
                        val = getattr(hints["urgency"], "value", hints["urgency"])
                        if isinstance(val, int):
                            urgency = val

                data = NotificationData(
                    app_name=app_name,
                    summary=summary,
                    body=body,
                    urgency=urgency,
                )

                # Schedule callback in active event loop
                loop = asyncio.get_running_loop()
                loop.create_task(self._callback(data))
            except Exception as e:
                logger.debug(f"Error handling D-Bus notification message: {e}")

    async def stop(self) -> None:
        self._running = False
        if self._bus:
            try:
                self._bus.disconnect()
            except Exception:
                pass
            self._bus = None
        logger.info("Linux D-Bus notification collector stopped.")
