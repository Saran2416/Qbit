import asyncio
import logging
import signal
import sys
from typing import Optional

from petd.bus import EventBus
from petd.config import AppConfig, load_config
from petd.db import AsyncDatabase, Database
from petd.logger import setup_logging
from petd.platforms.factory import create_platform_adapters
from petd.server import WebSocketServer
from petd.services.idle import IdleDetectorService
from petd.services.notifications import NotificationService
from petd.services.reminders import ReminderService
from petd.services.screen_time import ScreenTimeService
from petd.services.token_usage import ClaudeCodeUsageProvider, TokenUsageService
from petd.services.window_tracker import WindowTrackerService


class PetDaemon:
    """
    Main background daemon for the desktop-pet robot backend.
    Coordinates all platform adapters, services, database storage,
    and WebSocket communication.
    """

    def __init__(self, config: Optional[AppConfig] = None):
        self.config = config or load_config()
        self.logger = setup_logging(
            level_name=self.config.log_level,
            log_format=self.config.log_format,
        )
        self.bus = EventBus()
        self.db = Database(self.config.storage.database_path)
        self.async_db = AsyncDatabase(self.db)

        # Detect platform adapters behind abstract interfaces
        self.platform_adapters = create_platform_adapters()

        # Instantiate background services
        self.idle_service = IdleDetectorService(
            bus=self.bus,
            idle_threshold_seconds=self.config.screen_time.idle_threshold_seconds,
        )

        self.window_service = WindowTrackerService(
            bus=self.bus,
            config=self.config,
            tracker=self.platform_adapters.window_tracker,
        )

        self.screen_time_service = ScreenTimeService(
            bus=self.bus,
            db=self.async_db,
            window_tracker=self.window_service,
            idle_detector=self.idle_service,
            config=self.config.screen_time,
        )

        self.reminder_service = ReminderService(
            bus=self.bus,
            db=self.async_db,
        )

        self.notification_service = NotificationService(
            bus=self.bus,
            collector=self.platform_adapters.notification_collector,
        )

        # Token usage providers
        claude_provider = ClaudeCodeUsageProvider(
            base_path=self.config.token_usage.claude_code_logs_path,
            daily_limit=self.config.token_usage.daily_token_limit,
        )
        self.token_usage_service = TokenUsageService(
            bus=self.bus,
            window_tracker=self.window_service,
            config=self.config.token_usage,
            providers=[claude_provider],
        )

        # WebSocket server
        self.server = WebSocketServer(
            config=self.config.server,
            bus=self.bus,
            screen_time_service=self.screen_time_service,
            reminder_service=self.reminder_service,
        )

        self._shutdown_event = asyncio.Event()

    async def run(self) -> None:
        """Starts all services and runs until a shutdown signal is received."""
        self.logger.info("Starting Pet Daemon backend...")

        # Setup graceful signal handlers
        loop = asyncio.get_running_loop()
        if sys.platform != "win32":
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    loop.add_signal_handler(sig, self._request_shutdown)
                except NotImplementedError:
                    pass
        else:
            # On Windows, add_signal_handler is not implemented for SIGINT in asyncio
            def win_signal_handler(signum, frame):
                self._request_shutdown()

            signal.signal(signal.SIGINT, win_signal_handler)
            signal.signal(signal.SIGTERM, win_signal_handler)

        try:
            # Start all components
            await self.idle_service.start()
            await self.window_service.start()
            await self.screen_time_service.start()
            await self.reminder_service.start()
            await self.notification_service.start()
            await self.token_usage_service.start()
            await self.server.start()

            self.logger.info("Pet Daemon backend is fully operational.")
            await self._shutdown_event.wait()

        except Exception as e:
            self.logger.error(f"Fatal daemon error: {e}", exc_info=True)
        finally:
            await self.shutdown()

    def _request_shutdown(self) -> None:
        self.logger.info("Shutdown signal received. Initiating graceful shutdown...")
        self._shutdown_event.set()

    async def shutdown(self) -> None:
        """Gracefully shuts down all services and closes database."""
        self.logger.info("Stopping Pet Daemon services...")

        # Stop services in reverse order of startup
        await self.server.stop()
        await self.token_usage_service.stop()
        await self.notification_service.stop()
        await self.reminder_service.stop()
        await self.screen_time_service.stop()
        await self.window_service.stop()
        await self.idle_service.stop()

        # Close database connection
        await self.async_db.close()

        self.logger.info("Pet Daemon stopped cleanly.")
