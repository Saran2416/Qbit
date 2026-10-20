import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from petd.bus import EventBus
from petd.config import AppConfig
from petd.platforms.base import BaseWindowTracker, WindowInfo

logger = logging.getLogger("petd.services.window_tracker")


@dataclass
class ActiveAppState:
    app_name: str
    title: str
    category: str
    process_id: Optional[int] = None


class WindowTrackerService:
    """
    Polls active window every interval (default 1s) and emits 'active_app'
    events strictly when the focused window or process changes.
    """

    def __init__(
        self,
        bus: EventBus,
        config: AppConfig,
        tracker: BaseWindowTracker,
    ):
        self._bus = bus
        self._config = config
        self._tracker = tracker
        self._current_state: Optional[ActiveAppState] = None
        self._running = False
        self._task: Optional[asyncio.Task] = None

    @property
    def current_state(self) -> Optional[ActiveAppState]:
        return self._current_state

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info(
            f"Window tracker service started (polling every "
            f"{self._config.window_tracker.poll_interval_seconds}s)"
        )

    async def _poll_loop(self) -> None:
        interval = self._config.window_tracker.poll_interval_seconds
        while self._running:
            try:
                await asyncio.sleep(interval)
                window_info = self._tracker.get_active_window()

                if window_info is None:
                    continue

                category = self._config.categorize_app(window_info.app_name)

                # Check if changed
                if (
                    self._current_state is None
                    or self._current_state.app_name != window_info.app_name
                    or self._current_state.title != window_info.title
                    or self._current_state.category != category
                ):
                    self._current_state = ActiveAppState(
                        app_name=window_info.app_name,
                        title=window_info.title,
                        category=category,
                        process_id=window_info.process_id,
                    )

                    logger.debug(
                        f"Active app changed: {window_info.app_name} "
                        f"[{category}] - '{window_info.title}'"
                    )

                    await self._bus.emit(
                        "active_app",
                        {
                            "app_name": self._current_state.app_name,
                            "title": self._current_state.title,
                            "category": self._current_state.category,
                            "process_id": self._current_state.process_id,
                        },
                    )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in window tracker loop: {e}", exc_info=True)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self._tracker.close()
        logger.info("Window tracker service stopped.")
