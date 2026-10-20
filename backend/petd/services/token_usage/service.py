import asyncio
import logging
from typing import List, Optional

from petd.bus import EventBus
from petd.config import TokenUsageConfig
from petd.services.token_usage.base import UsageProvider
from petd.services.window_tracker import WindowTrackerService

logger = logging.getLogger("petd.services.token_usage.service")


class TokenUsageService:
    """
    Coordinates token usage providers.
    Emits 'token_usage' events strictly when the active window category is 'editor'.
    """

    def __init__(
        self,
        bus: EventBus,
        window_tracker: WindowTrackerService,
        config: TokenUsageConfig,
        providers: Optional[List[UsageProvider]] = None,
    ):
        self._bus = bus
        self._tracker = window_tracker
        self._config = config
        self._providers = providers or []
        self._running = False
        self._task: Optional[asyncio.Task] = None

    def add_provider(self, provider: UsageProvider) -> None:
        self._providers.append(provider)

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info(
            f"Token usage monitoring started (checking every {self._config.check_interval_seconds}s; "
            "emits only when active app category is 'editor')."
        )

    async def _poll_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self._config.check_interval_seconds)

                # Requirement: Emit "token_usage" only while the active app category is "editor"
                active_state = self._tracker.current_state
                if not active_state or active_state.category != "editor":
                    continue

                for provider in self._providers:
                    usage_data = await provider.get_usage()
                    logger.debug(f"Emitting token usage for editor session: {usage_data}")
                    await self._bus.emit("token_usage", usage_data)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in token usage monitor loop: {e}", exc_info=True)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("Token usage service stopped.")
