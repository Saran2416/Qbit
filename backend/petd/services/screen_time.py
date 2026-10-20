import asyncio
import datetime
import logging
import time
from typing import Any, Dict, Optional

from petd.bus import EventBus
from petd.config import ScreenTimeConfig
from petd.db import AsyncDatabase
from petd.services.idle import IdleDetectorService
from petd.services.window_tracker import WindowTrackerService

logger = logging.getLogger("petd.services.screen_time")


class ScreenTimeService:
    """
    Accumulates active seconds per application per calendar day in SQLite.
    Pauses accumulation whenever user is idle (> 120s by default).
    Emits 'screen_time_warning' when the daily cumulative limit is crossed,
    and repeats the warning every 30 minutes.
    """

    def __init__(
        self,
        bus: EventBus,
        db: AsyncDatabase,
        window_tracker: WindowTrackerService,
        idle_detector: IdleDetectorService,
        config: ScreenTimeConfig,
    ):
        self._bus = bus
        self._db = db
        self._tracker = window_tracker
        self._idle = idle_detector
        self._config = config
        self._daily_limit_seconds = config.daily_limit_seconds
        self._warning_repeat_seconds = config.warning_repeat_seconds
        self._last_warning_timestamp: Optional[float] = None
        self._last_warned_date: Optional[str] = None
        self._running = False
        self._task: Optional[asyncio.Task] = None

    @property
    def daily_limit_seconds(self) -> int:
        return self._daily_limit_seconds

    async def start(self) -> None:
        self._running = True

        # Restore any user-set limit from SQLite settings
        saved_limit = await self._db.get_setting("daily_limit_seconds")
        if saved_limit and saved_limit.isdigit():
            self._daily_limit_seconds = int(saved_limit)
            logger.info(f"Loaded customized daily screen-time limit: {self._daily_limit_seconds}s")
        else:
            logger.info(f"Using default daily screen-time limit: {self._daily_limit_seconds}s")

        self._task = asyncio.create_task(self._tick_loop())
        logger.info("Screen-time tracking service started.")

    async def _tick_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(1.0)
                today_str = datetime.date.today().isoformat()

                # Reset daily warning tracker if day rolled over
                if self._last_warned_date != today_str:
                    self._last_warned_date = today_str
                    self._last_warning_timestamp = None

                # Feature 2: Pause accumulation when user is idle
                if self._idle.is_idle:
                    continue

                active_app = self._tracker.current_state
                if active_app is None:
                    continue

                # Accumulate 1 active second for current application
                await self._db.increment_screen_time(
                    date_str=today_str,
                    app_name=active_app.app_name,
                    category=active_app.category,
                    delta_seconds=1,
                )

                # Check daily total against user-set limit
                total_today = await self._db.get_daily_total_seconds(today_str)
                if total_today >= self._daily_limit_seconds:
                    now = time.time()
                    should_warn = False
                    if self._last_warning_timestamp is None:
                        should_warn = True
                    elif now - self._last_warning_timestamp >= self._warning_repeat_seconds:
                        should_warn = True

                    if should_warn:
                        self._last_warning_timestamp = now
                        logger.warning(
                            f"Daily screen-time limit reached: {total_today}s >= "
                            f"{self._daily_limit_seconds}s. Emitting warning."
                        )
                        hours = self._daily_limit_seconds // 3600
                        minutes = (self._daily_limit_seconds % 3600) // 60
                        limit_desc = f"{hours}h {minutes}m" if hours else f"{minutes}m"

                        await self._bus.emit(
                            "screen_time_warning",
                            {
                                "total_seconds": total_today,
                                "limit_seconds": self._daily_limit_seconds,
                                "message": f"Daily screen time limit ({limit_desc}) exceeded!",
                            },
                        )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in screen-time tick loop: {e}", exc_info=True)

    async def set_limit(self, limit_seconds: int) -> None:
        """Sets a new daily screen-time limit and persists it to SQLite."""
        if limit_seconds <= 0:
            raise ValueError("Limit seconds must be positive")
        self._daily_limit_seconds = limit_seconds
        await self._db.set_setting("daily_limit_seconds", str(limit_seconds))
        # Reset warning timer so the new limit takes effect immediately
        self._last_warning_timestamp = None
        logger.info(f"Daily screen-time limit updated to {limit_seconds}s")

    async def dismiss_warning(self) -> None:
        """Dismisses the current warning, delaying the next warning repeat by 30 min."""
        self._last_warning_timestamp = time.time()
        logger.info("Screen time warning dismissed by user.")

    async def get_stats(self) -> Dict[str, Any]:
        """Returns comprehensive screen-time stats for the current day."""
        today_str = datetime.date.today().isoformat()
        total_seconds = await self._db.get_daily_total_seconds(today_str)
        breakdown = await self._db.get_daily_app_breakdown(today_str)
        current = self._tracker.current_state

        return {
            "date": today_str,
            "total_seconds": total_seconds,
            "limit_seconds": self._daily_limit_seconds,
            "is_idle": self._idle.is_idle,
            "idle_seconds": int(self._idle.idle_seconds),
            "current_app": {
                "app_name": current.app_name,
                "title": current.title,
                "category": current.category,
            }
            if current
            else None,
            "apps": breakdown,
        }

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("Screen-time tracking service stopped.")
