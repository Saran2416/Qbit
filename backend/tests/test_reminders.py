import asyncio
import time

import pytest

from petd.bus import EventBus
from petd.db import AsyncDatabase, Database
from petd.services.reminders import ReminderService


@pytest.fixture
def temp_db_path(tmp_path):
    return tmp_path / "test_reminders.sqlite3"


@pytest.mark.asyncio
async def test_reminders_db_lifecycle_and_restart(temp_db_path):
    # Instance 1: Create and schedule a reminder
    db1 = Database(temp_db_path)
    async_db1 = AsyncDatabase(db1)

    now = time.time()
    r_id = await async_db1.add_reminder("Stretch break", now + 1.0)
    assert r_id > 0

    active = await async_db1.get_active_reminders()
    assert len(active) == 1
    assert active[0]["message"] == "Stretch break"
    assert active[0]["status"] == "pending"

    # Simulate daemon restart: Close db1, instantiate db2 pointing to same file
    await async_db1.close()

    db2 = Database(temp_db_path)
    async_db2 = AsyncDatabase(db2)

    # Reminders survive restart
    active_after_restart = await async_db2.get_active_reminders()
    assert len(active_after_restart) == 1
    assert active_after_restart[0]["id"] == r_id

    # Check due reminders after time passes
    due_items = await async_db2.get_pending_due_reminders(now + 2.0)
    assert len(due_items) == 1
    assert due_items[0]["id"] == r_id

    # Mark fired
    await async_db2.mark_reminder_fired(r_id)
    assert len(await async_db2.get_active_reminders()) == 0

    await async_db2.close()


@pytest.mark.asyncio
async def test_reminder_service_fires_and_dismisses(temp_db_path):
    db = Database(temp_db_path)
    async_db = AsyncDatabase(db)
    bus = EventBus()
    emitted_events = []

    async def event_handler(event_type, data):
        emitted_events.append((event_type, data))

    bus.subscribe(event_handler)

    service = ReminderService(bus=bus, db=async_db)
    await service.start()

    # Schedule reminder due in 1 second
    reminder_info = await service.set_reminder(
        message="Drink Water 💧",
        due_in_seconds=1.0,
    )
    assert reminder_info["status"] == "pending"

    # Wait 2.2 seconds for reminder to fire
    await asyncio.sleep(2.2)

    fired_events = [e for e in emitted_events if e[0] == "reminder"]
    assert len(fired_events) >= 1
    assert fired_events[0][1]["message"] == "Drink Water 💧"
    assert fired_events[0][1]["id"] == reminder_info["id"]

    # Verify dismissing a reminder
    r2 = await service.set_reminder("Walk around", due_in_seconds=10.0)
    dismiss_success = await service.dismiss(r2["id"])
    assert dismiss_success is True

    # Ensure it is not active anymore
    active = await service.get_active_reminders()
    assert not any(r["id"] == r2["id"] for r in active)

    await service.stop()
    await async_db.close()
