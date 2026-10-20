import asyncio
import datetime
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from petd.bus import EventBus
from petd.config import ScreenTimeConfig
from petd.db import AsyncDatabase, Database
from petd.services.idle import IdleDetectorService
from petd.services.screen_time import ScreenTimeService
from petd.services.window_tracker import ActiveAppState, WindowTrackerService


@pytest.fixture
def temp_db(tmp_path):
    db_file = tmp_path / "test_petd.sqlite3"
    db = Database(db_file)
    async_db = AsyncDatabase(db)
    yield async_db
    db.close()


@pytest.mark.asyncio
async def test_screen_time_db_accumulation(temp_db):
    today = "2026-10-16"
    await temp_db.increment_screen_time(today, "code", "editor", 10)
    await temp_db.increment_screen_time(today, "code", "editor", 5)
    await temp_db.increment_screen_time(today, "firefox", "browser", 20)

    total = await temp_db.get_daily_total_seconds(today)
    assert total == 35

    breakdown = await temp_db.get_daily_app_breakdown(today)
    assert len(breakdown) == 2
    # Ordered descending by seconds
    assert breakdown[0]["app_name"] == "firefox"
    assert breakdown[0]["seconds"] == 20
    assert breakdown[1]["app_name"] == "code"
    assert breakdown[1]["seconds"] == 15


@pytest.mark.asyncio
async def test_screen_time_idle_pause(temp_db):
    bus = EventBus()
    config = ScreenTimeConfig(
        daily_limit_seconds=100,
        idle_threshold_seconds=120,
        warning_repeat_seconds=1800,
    )

    mock_tracker = MagicMock(spec=WindowTrackerService)
    mock_tracker.current_state = ActiveAppState(
        app_name="code", title="main.py", category="editor"
    )

    mock_idle = MagicMock(spec=IdleDetectorService)
    # Start in active (not idle)
    mock_idle.is_idle = False
    mock_idle.idle_seconds = 0.0

    service = ScreenTimeService(
        bus=bus,
        db=temp_db,
        window_tracker=mock_tracker,
        idle_detector=mock_idle,
        config=config,
    )

    today = datetime.date.today().isoformat()

    # Simulate 3 active ticks
    await service.start()
    await asyncio.sleep(1.2)
    total_active = await temp_db.get_daily_total_seconds(today)
    assert total_active >= 1

    # Now transition to idle
    mock_idle.is_idle = True
    active_before_pause = total_active
    await asyncio.sleep(1.2)
    total_after_idle = await temp_db.get_daily_total_seconds(today)

    # Accumulation must have paused during idle
    assert total_after_idle == active_before_pause

    await service.stop()


@pytest.mark.asyncio
async def test_screen_time_warning_and_repeat(temp_db):
    bus = EventBus()
    emitted_events = []

    async def event_handler(event_type, data):
        emitted_events.append((event_type, data))

    bus.subscribe(event_handler)

    config = ScreenTimeConfig(
        daily_limit_seconds=2,  # Short limit for testing
        idle_threshold_seconds=120,
        warning_repeat_seconds=2,  # Repeat every 2 seconds for test
    )

    mock_tracker = MagicMock(spec=WindowTrackerService)
    mock_tracker.current_state = ActiveAppState(
        app_name="steam", title="Dota 2", category="game"
    )

    mock_idle = MagicMock(spec=IdleDetectorService)
    mock_idle.is_idle = False
    mock_idle.idle_seconds = 0.0

    service = ScreenTimeService(
        bus=bus,
        db=temp_db,
        window_tracker=mock_tracker,
        idle_detector=mock_idle,
        config=config,
    )

    await service.start()
    # Wait for accumulation to reach and exceed 2 seconds
    await asyncio.sleep(2.5)

    warnings = [e for e in emitted_events if e[0] == "screen_time_warning"]
    assert len(warnings) >= 1
    assert warnings[0][1]["limit_seconds"] == 2
    assert warnings[0][1]["total_seconds"] >= 2

    # Dismiss the warning
    await service.dismiss_warning()

    # Changing limit dynamically
    await service.set_limit(1000)
    assert service.daily_limit_seconds == 1000

    saved_limit = await temp_db.get_setting("daily_limit_seconds")
    assert saved_limit == "1000"

    await service.stop()
