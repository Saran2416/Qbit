import asyncio
import logging
import time
from typing import Optional

from petd.bus import EventBus

logger = logging.getLogger("petd.services.idle")


class IdleDetectorService:
    """
    Monitors user input activity using pynput to determine idle states.
    
    PRIVACY GUARANTEE:
    This service strictly records the timestamp of user input events.
    It never stores, logs, or transmits key characters, scan codes,
    mouse coordinates, or clicks.
    """

    def __init__(self, bus: EventBus, idle_threshold_seconds: int = 120):
        self._bus = bus
        self._threshold = idle_threshold_seconds
        self._last_activity = time.monotonic()
        self._is_idle = False
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._mouse_listener = None
        self._keyboard_listener = None

    @property
    def is_idle(self) -> bool:
        return self._is_idle

    @property
    def idle_seconds(self) -> float:
        return max(0.0, time.monotonic() - self._last_activity)

    def _on_user_input(self, *args, **kwargs) -> None:
        """Callback triggered on any user mouse or keyboard movement."""
        self._last_activity = time.monotonic()

    async def start(self) -> None:
        self._running = True
        self._last_activity = time.monotonic()

        # Start pynput listeners in background daemon threads
        try:
            from pynput import keyboard, mouse

            self._mouse_listener = mouse.Listener(
                on_move=self._on_user_input,
                on_click=self._on_user_input,
                on_scroll=self._on_user_input,
            )
            self._mouse_listener.daemon = True
            self._mouse_listener.start()

            self._keyboard_listener = keyboard.Listener(
                on_press=self._on_user_input,
                on_release=self._on_user_input,
            )
            self._keyboard_listener.daemon = True
            self._keyboard_listener.start()

            logger.info(
                f"Idle detection started (idle threshold: {self._threshold}s). "
                "Privacy enforced: input content is never inspected."
            )
        except Exception as e:
            logger.warning(
                f"Failed to initialize pynput listeners ({e}). "
                "Idle detection will remain inactive (user assumed active)."
            )

        self._task = asyncio.create_task(self._monitor_loop())

    async def _monitor_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(1.0)
                elapsed = time.monotonic() - self._last_activity

                if elapsed >= self._threshold:
                    if not self._is_idle:
                        self._is_idle = True
                        logger.info(f"User transitioned to IDLE ({int(elapsed)}s inactive)")
                        await self._bus.emit(
                            "idle_state",
                            {"is_idle": True, "idle_seconds": int(elapsed)},
                        )
                else:
                    if self._is_idle:
                        self._is_idle = False
                        logger.info("User returned from IDLE state")
                        await self._bus.emit(
                            "idle_state",
                            {"is_idle": False, "idle_seconds": 0},
                        )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in idle monitor loop: {e}", exc_info=True)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        if self._mouse_listener:
            try:
                self._mouse_listener.stop()
            except Exception:
                pass
            self._mouse_listener = None

        if self._keyboard_listener:
            try:
                self._keyboard_listener.stop()
            except Exception:
                pass
            self._keyboard_listener = None

        logger.info("Idle detector service stopped.")
