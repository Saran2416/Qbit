import json
from pathlib import Path

import pytest

from petd.bus import EventBus
from petd.config import AppConfig
from petd.services.token_usage.claude_code import ClaudeCodeUsageProvider


def test_app_categorization():
    config = AppConfig(
        categories={
            "browser": ["chrome", "firefox", "brave"],
            "editor": ["code", "nvim", "pycharm"],
            "game": ["steam", "minecraft"],
        }
    )

    assert config.categorize_app("chrome") == "browser"
    assert config.categorize_app("google-chrome") == "browser"
    assert config.categorize_app("Code.exe") == "editor"
    assert config.categorize_app("code") == "editor"
    assert config.categorize_app("nvim") == "editor"
    assert config.categorize_app("steam.exe") == "game"
    assert config.categorize_app("random_utility") == "other"
    assert config.categorize_app(None) == "other"


@pytest.mark.asyncio
async def test_event_bus():
    bus = EventBus()
    received = []

    async def handler(event_type, data):
        received.append((event_type, data))

    bus.subscribe(handler)
    await bus.emit("test_event", {"hello": "world"})
    assert len(received) == 1
    assert received[0] == ("test_event", {"hello": "world"})

    bus.unsubscribe(handler)
    await bus.emit("test_event_2", {"hello": "world 2"})
    assert len(received) == 1


@pytest.mark.asyncio
async def test_claude_code_usage_provider(tmp_path):
    claude_dir = tmp_path / ".claude"
    projects_dir = claude_dir / "projects" / "test-project"
    projects_dir.mkdir(parents=True)

    jsonl_file = projects_dir / "session.jsonl"
    lines = [
        {"type": "user", "timestamp": "2026-10-16T10:00:00Z"},
        {
            "type": "assistant",
            "timestamp": "2026-10-16T10:00:05Z",
            "message": {
                "usage": {
                    "input_tokens": 1500,
                    "output_tokens": 300,
                    "cache_creation_input_tokens": 200,
                    "cache_read_input_tokens": 500,
                }
            },
        },
        {
            "type": "assistant",
            "timestamp": "2026-10-16T10:01:00Z",
            "usage": {
                "input_tokens": 1000,
                "output_tokens": 200,
            },
        },
    ]

    with open(jsonl_file, "w") as f:
        for item in lines:
            f.write(json.dumps(item) + "\n")

    provider = ClaudeCodeUsageProvider(
        base_path=str(claude_dir),
        daily_limit=50000,
    )

    report = await provider.get_usage()
    assert report["provider"] == "claude_code"
    # 1500 + 300 + 200 + 500 = 2500; plus 1000 + 200 = 1200; total = 3700
    assert report["used"] == 3700
    assert report["limit"] == 50000
