import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8765


@dataclass
class StorageConfig:
    database_path: str = "petd.sqlite3"


@dataclass
class ScreenTimeConfig:
    daily_limit_seconds: int = 28800  # 8 hours
    idle_threshold_seconds: int = 120  # 2 minutes
    warning_repeat_seconds: int = 1800  # 30 minutes


@dataclass
class WindowTrackerConfig:
    poll_interval_seconds: float = 1.0


@dataclass
class TokenUsageConfig:
    claude_code_logs_path: str = "~/.claude"
    daily_token_limit: int = 250000
    check_interval_seconds: float = 10.0


@dataclass
class AppConfig:
    server: ServerConfig = field(default_factory=ServerConfig)
    storage: StorageConfig = field(default_factory=StorageConfig)
    screen_time: ScreenTimeConfig = field(default_factory=ScreenTimeConfig)
    window_tracker: WindowTrackerConfig = field(default_factory=WindowTrackerConfig)
    token_usage: TokenUsageConfig = field(default_factory=TokenUsageConfig)
    log_level: str = "INFO"
    log_format: str = "%(asctime)s [%(levelname)s] [%(name)s] %(message)s"
    categories: Dict[str, List[str]] = field(default_factory=dict)

    def categorize_app(self, app_name: str | None) -> str:
        """Maps a process name/window class to a category (browser, editor, game, other)."""
        if not app_name:
            return "other"

        clean_name = app_name.lower().strip()
        # Strip Windows executable extensions if present
        if clean_name.endswith(".exe"):
            clean_name = clean_name[:-4]

        for category, apps in self.categories.items():
            for target in apps:
                target_clean = target.lower().strip()
                if target_clean.endswith(".exe"):
                    target_clean = target_clean[:-4]

                if clean_name == target_clean or target_clean in clean_name:
                    return category

        return "other"


def load_config(config_path: str | Path | None = None) -> AppConfig:
    """Loads configuration from TOML file, falling back to sensible defaults."""
    path = Path(config_path) if config_path else Path("config.toml")
    
    if not path.is_file():
        # Check parent directory
        parent_path = Path(__file__).parent.parent / "config.toml"
        if parent_path.is_file():
            path = parent_path

    data: Dict[str, Any] = {}
    if path.is_file():
        try:
            with open(path, "rb") as f:
                data = tomllib.load(f)
        except Exception as e:
            import logging
            logging.getLogger("petd.config").warning(f"Failed to parse config file at {path}: {e}. Using defaults.")

    server_data = data.get("server", {})
    storage_data = data.get("storage", {})
    screen_time_data = data.get("screen_time", {})
    tracker_data = data.get("window_tracker", {})
    token_data = data.get("token_usage", {})
    log_data = data.get("logging", {})
    categories_data = data.get("categories", {})

    # Extract categories mapping
    categories: Dict[str, List[str]] = {}
    for cat_name, cat_content in categories_data.items():
        if isinstance(cat_content, dict) and "apps" in cat_content:
            categories[cat_name] = [str(x) for x in cat_content["apps"]]
        elif isinstance(cat_content, list):
            categories[cat_name] = [str(x) for x in cat_content]

    # Ensure default common categories exist if none provided
    if not categories:
        categories = {
            "browser": ["chrome", "chromium", "firefox", "brave", "msedge", "zen", "arc"],
            "editor": ["code", "codium", "cursor", "zed", "sublime_text", "nvim", "vim", "pycharm", "idea"],
            "game": ["steam", "lutris", "heroic", "minecraft", "cs2", "dota2"]
        }

    return AppConfig(
        server=ServerConfig(
            host=server_data.get("host", "127.0.0.1"),
            port=int(server_data.get("port", 8765))
        ),
        storage=StorageConfig(
            database_path=storage_data.get("database_path", "petd.sqlite3")
        ),
        screen_time=ScreenTimeConfig(
            daily_limit_seconds=int(screen_time_data.get("daily_limit_seconds", 28800)),
            idle_threshold_seconds=int(screen_time_data.get("idle_threshold_seconds", 120)),
            warning_repeat_seconds=int(screen_time_data.get("warning_repeat_seconds", 1800))
        ),
        window_tracker=WindowTrackerConfig(
            poll_interval_seconds=float(tracker_data.get("poll_interval_seconds", 1.0))
        ),
        token_usage=TokenUsageConfig(
            claude_code_logs_path=os.path.expanduser(token_data.get("claude_code_logs_path", "~/.claude")),
            daily_token_limit=int(token_data.get("daily_token_limit", 250000)),
            check_interval_seconds=float(token_data.get("check_interval_seconds", 10.0))
        ),
        log_level=log_data.get("level", "INFO"),
        log_format=log_data.get("format", "%(asctime)s [%(levelname)s] [%(name)s] %(message)s"),
        categories=categories
    )
