from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, Coroutine, Optional


@dataclass
class WindowInfo:
    app_name: str
    title: str
    process_id: Optional[int] = None


@dataclass
class NotificationData:
    app_name: str
    summary: str
    body: str
    urgency: int = 1


NotificationCallback = Callable[[NotificationData], Coroutine[Any, Any, None]]


class BaseWindowTracker(ABC):
    """Abstract interface for active window tracking across all supported platforms."""

    @abstractmethod
    def get_active_window(self) -> Optional[WindowInfo]:
        """Returns the currently active window or None if unavailable/desktop is idle."""
        pass

    def close(self) -> None:
        """Cleanup platform resources if necessary."""
        pass


class BaseNotificationCollector(ABC):
    """Abstract interface for system desktop notification collection."""

    @abstractmethod
    async def start(self, callback: NotificationCallback) -> None:
        """Starts monitoring system notifications and invokes callback on each."""
        pass

    @abstractmethod
    async def stop(self) -> None:
        """Stops monitoring notifications and cleans up resources."""
        pass
