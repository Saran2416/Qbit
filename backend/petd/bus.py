import asyncio
import logging
from typing import Any, Callable, Coroutine, Dict, List, Set

EventHandler = Callable[[str, Dict[str, Any]], Coroutine[Any, Any, None]]


class EventBus:
    """Asynchronous pub-sub event bus for petd events."""

    def __init__(self):
        self._subscribers: Set[EventHandler] = set()
        self._logger = logging.getLogger("petd.bus")

    def subscribe(self, handler: EventHandler) -> None:
        self._subscribers.add(handler)

    def unsubscribe(self, handler: EventHandler) -> None:
        self._subscribers.discard(handler)

    async def emit(self, event_type: str, data: Dict[str, Any]) -> None:
        """Publishes an event to all subscribers concurrently."""
        if not self._subscribers:
            return

        tasks = []
        for subscriber in list(self._subscribers):
            tasks.append(self._invoke_subscriber(subscriber, event_type, data))

        await asyncio.gather(*tasks, return_exceptions=True)

    async def _invoke_subscriber(
        self, subscriber: EventHandler, event_type: str, data: Dict[str, Any]
    ) -> None:
        try:
            await subscriber(event_type, data)
        except Exception as e:
            self._logger.error(
                f"Error in event handler {subscriber.__name__} for event '{event_type}': {e}",
                exc_info=True,
            )
