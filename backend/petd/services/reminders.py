import asyncio
import logging
import time
from typing import Any, Dict, List, Optional

from petd.bus import EventBus
from petd.db import AsyncDatabase

logger = logging.getLogger("petd.services.reminders")


class ReminderService:
    """
    Persistent reminder engine backed by SQLite.
    Survives daemon restarts and emits 'reminder' events when due.
    """

    def __init__(self, bus: EventBus, db: AsyncDatabase):
        self._bus = bus
        self._db = db
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._check_loop())
        logger.info("Reminder service started (persisted in SQLite).")

    async def _check_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(1.0)
                now = time.time()
                due_reminders = await self._db.get_pending_due_reminders(now)

                for reminder in due_reminders:
                    r_id = reminder["id"]
                    msg = reminder["message"]
                    due_ts = reminder["due_timestamp"]

                    logger.info(f"Firing reminder #{r_id}: '{msg}'")
                    await self._db.mark_reminder_fired(r_id)

                    await self._bus.emit(
                        "reminder",
                        {
                            "id": r_id,
                            "message": msg,
                            "due_timestamp": due_ts,
                        },
                    )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in reminder check loop: {e}", exc_info=True)

    async def set_reminder(
        self,
        message: str,
        due_timestamp: Optional[float] = None,
        due_in_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Creates and persists a new reminder."""
        if not message or not message.strip():
            raise ValueError("Reminder message cannot be empty")

        now = time.time()
        if due_timestamp is not None:
            target_time = float(due_timestamp)
        elif due_in_seconds is not None:
            target_time = now + float(due_in_seconds)
        else:
            raise ValueError("Must provide either due_timestamp or due_in_seconds")

        r_id = await self._db.add_reminder(message.strip(), target_time)
        logger.info(f"Scheduled reminder #{r_id} for {target_time} (in {target_time - now:.1f}s)")

        return {
            "id": r_id,
            "message": message.strip(),
            "due_timestamp": target_time,
            "status": "pending",
        }

    async def dismiss(self, reminder_id: int) -> bool:
        """Dismisses an active or fired reminder."""
        success = await self._db.dismiss_reminder(reminder_id)
        if success:
            logger.info(f"Dismissed reminder #{reminder_id}")
        return success

    async def get_active_reminders(self) -> List[Dict[str, Any]]:
        return await self._db.get_active_reminders()

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("Reminder service stopped.")
