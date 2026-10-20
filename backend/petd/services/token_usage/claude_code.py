import asyncio
import json
import logging
import os
from datetime import date
from pathlib import Path
from typing import Any, Dict, Optional

from petd.services.token_usage.base import UsageProvider, UsageReport

logger = logging.getLogger("petd.services.token_usage.claude_code")


class ClaudeCodeUsageProvider(UsageProvider):
    """
    Parses Claude Code local JSONL log files (under ~/.claude/projects)
    to calculate cumulative token usage.
    """

    def __init__(
        self,
        base_path: str = "~/.claude",
        daily_limit: Optional[int] = 250000,
    ):
        self.base_path = Path(os.path.expanduser(base_path))
        self.daily_limit = daily_limit
        self._cached_usage: int = 0
        self._last_scan_date: Optional[str] = None
        # Track file size / mtime to avoid re-reading unchanged files
        self._file_offsets: Dict[str, int] = {}
        self._file_mtimes: Dict[str, float] = {}

    async def get_usage(self) -> Dict[str, Any]:
        """Runs the file scanning in an executor thread to prevent event loop blocking."""
        report = await asyncio.to_thread(self._scan_usage)
        return report.to_dict()

    def _scan_usage(self) -> UsageReport:
        today_str = date.today().isoformat()
        if self._last_scan_date != today_str:
            self._last_scan_date = today_str
            self._cached_usage = 0
            self._file_offsets.clear()
            self._file_mtimes.clear()

        projects_dir = self.base_path / "projects"
        if not projects_dir.is_dir():
            logger.debug(f"Claude Code projects directory not found at {projects_dir}")
            return UsageReport(
                provider="claude_code",
                used=self._cached_usage,
                limit=self.daily_limit,
            )

        # Find all .jsonl transcript files
        try:
            jsonl_files = list(projects_dir.rglob("*.jsonl"))
        except Exception as e:
            logger.warning(f"Error enumerating Claude Code log files: {e}")
            jsonl_files = []

        total_tokens = self._cached_usage

        for fpath in jsonl_files:
            try:
                stat = fpath.stat()
                str_path = str(fpath)

                # Skip if file was not modified today and we have already processed it
                prev_mtime = self._file_mtimes.get(str_path)
                if prev_mtime and stat.st_mtime <= prev_mtime:
                    continue

                prev_offset = self._file_offsets.get(str_path, 0)
                if stat.st_size <= prev_offset:
                    continue

                new_tokens = 0
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    if prev_offset > 0:
                        f.seek(prev_offset)

                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            record = json.loads(line)
                            usage = None

                            if isinstance(record, dict):
                                # Check message.usage first
                                msg = record.get("message")
                                if isinstance(msg, dict):
                                    usage = msg.get("usage")
                                # Fallback to top-level usage
                                if not usage:
                                    usage = record.get("usage")

                            if isinstance(usage, dict):
                                in_tokens = int(usage.get("input_tokens") or 0)
                                out_tokens = int(usage.get("output_tokens") or 0)
                                cache_read = int(usage.get("cache_read_input_tokens") or 0)
                                cache_create = int(usage.get("cache_creation_input_tokens") or 0)
                                new_tokens += in_tokens + out_tokens + cache_read + cache_create
                        except json.JSONDecodeError:
                            # Malformed line / partial write
                            continue

                    self._file_offsets[str_path] = f.tell()
                    self._file_mtimes[str_path] = stat.st_mtime

                total_tokens += new_tokens

            except Exception as e:
                logger.debug(f"Error reading Claude Code transcript {fpath}: {e}")

        self._cached_usage = total_tokens
        return UsageReport(
            provider="claude_code",
            used=total_tokens,
            limit=self.daily_limit,
        )
