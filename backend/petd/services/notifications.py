import logging
from typing import Optional

from petd.bus import EventBus
from petd.platforms.base import BaseNotificationCollector, NotificationData

logger = logging.getLogger("petd.services.notifications")


class NotificationService:
    """
    Coordinates desktop notification collection across platforms and emits
    'notification' events onto the bus.
    """

    def __init__(self, bus: EventBus, collector: BaseNotificationCollector):
        self._bus = bus
        self._collector = collector
        self._running = False

    async def start(self) -> None:
        self._running = True
        await self._collector.start(self._on_notification)
        logger.info("Notification service started.")

    async def _on_notification(self, data: NotificationData) -> None:
        if not self._running:
            return

        logger.debug(f"Captured notification from '{data.app_name}': {data.summary}")
        await self._bus.emit(
            "notification",
            {
                "app_name": data.app_name,
                "summary": data.summary,
                "body": data.body,
                "urgency": data.urgency,
            },
        )

    async def stop(self) -> None:
        self._running = False
        await self._collector.stop()
        logger.info("Notification service stopped.")
