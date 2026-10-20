import asyncio
import sqlite3
import threading
import time
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional


class Database:
    """Thread-safe SQLite manager for screen time, persistent reminders, and settings."""

    def __init__(self, db_path: str | Path = "petd.sqlite3"):
        self.db_path = str(db_path)
        self._lock = threading.Lock()
        self._conn: Optional[sqlite3.Connection] = None
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            # Enable WAL mode for better concurrency and durability
            self._conn.execute("PRAGMA journal_mode=WAL;")
        return self._conn

    def _init_db(self) -> None:
        with self._lock:
            conn = self._get_connection()
            with conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS screen_time (
                        date TEXT NOT NULL,
                        app_name TEXT NOT NULL,
                        category TEXT NOT NULL,
                        seconds INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (date, app_name)
                    );
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS reminders (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        message TEXT NOT NULL,
                        due_timestamp REAL NOT NULL,
                        created_at REAL NOT NULL,
                        status TEXT NOT NULL DEFAULT 'pending',
                        dismissed_at REAL
                    );
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS settings (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );
                """)

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    # --- Screen Time Operations ---

    def increment_screen_time(
        self,
        date_str: str,
        app_name: str,
        category: str,
        delta_seconds: int = 1
    ) -> None:
        with self._lock:
            conn = self._get_connection()
            with conn:
                conn.execute("""
                    INSERT INTO screen_time (date, app_name, category, seconds)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(date, app_name) DO UPDATE SET
                        seconds = seconds + excluded.seconds,
                        category = excluded.category;
                """, (date_str, app_name, category, delta_seconds))

    def get_daily_total_seconds(self, date_str: str) -> int:
        with self._lock:
            conn = self._get_connection()
            cursor = conn.execute(
                "SELECT COALESCE(SUM(seconds), 0) as total FROM screen_time WHERE date = ?;",
                (date_str,)
            )
            row = cursor.fetchone()
            return int(row["total"]) if row else 0

    def get_daily_app_breakdown(self, date_str: str) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self._get_connection()
            cursor = conn.execute("""
                SELECT app_name, category, seconds
                FROM screen_time
                WHERE date = ?
                ORDER BY seconds DESC;
            """, (date_str,))
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    # --- Reminders Operations ---

    def add_reminder(self, message: str, due_timestamp: float) -> int:
        with self._lock:
            now = time.time()
            conn = self._get_connection()
            with conn:
                cursor = conn.execute("""
                    INSERT INTO reminders (message, due_timestamp, created_at, status)
                    VALUES (?, ?, ?, 'pending');
                """, (message, due_timestamp, now))
                return int(cursor.lastrowid)

    def get_pending_due_reminders(self, current_timestamp: float) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self._get_connection()
            cursor = conn.execute("""
                SELECT id, message, due_timestamp, created_at, status
                FROM reminders
                WHERE status = 'pending' AND due_timestamp <= ?
                ORDER BY due_timestamp ASC;
            """, (current_timestamp,))
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def mark_reminder_fired(self, reminder_id: int) -> None:
        with self._lock:
            conn = self._get_connection()
            with conn:
                conn.execute("""
                    UPDATE reminders
                    SET status = 'fired'
                    WHERE id = ?;
                """, (reminder_id,))

    def dismiss_reminder(self, reminder_id: int) -> bool:
        with self._lock:
            now = time.time()
            conn = self._get_connection()
            with conn:
                cursor = conn.execute("""
                    UPDATE reminders
                    SET status = 'dismissed', dismissed_at = ?
                    WHERE id = ? AND status != 'dismissed';
                """, (now, reminder_id))
                return cursor.rowcount > 0

    def get_active_reminders(self) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self._get_connection()
            cursor = conn.execute("""
                SELECT id, message, due_timestamp, created_at, status
                FROM reminders
                WHERE status = 'pending'
                ORDER BY due_timestamp ASC;
            """)
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    # --- Settings Operations ---

    def get_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        with self._lock:
            conn = self._get_connection()
            cursor = conn.execute(
                "SELECT value FROM settings WHERE key = ?;",
                (key,)
            )
            row = cursor.fetchone()
            if row:
                return str(row["value"])
            return default

    def set_setting(self, key: str, value: str) -> None:
        with self._lock:
            conn = self._get_connection()
            with conn:
                conn.execute("""
                    INSERT INTO settings (key, value)
                    VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
                """, (key, value))


class AsyncDatabase:
    """Asynchronous wrapper around Database using asyncio.to_thread."""

    def __init__(self, db: Database):
        self._db = db

    @property
    def sync_db(self) -> Database:
        return self._db

    async def increment_screen_time(
        self, date_str: str, app_name: str, category: str, delta_seconds: int = 1
    ) -> None:
        await asyncio.to_thread(
            self._db.increment_screen_time, date_str, app_name, category, delta_seconds
        )

    async def get_daily_total_seconds(self, date_str: str) -> int:
        return await asyncio.to_thread(self._db.get_daily_total_seconds, date_str)

    async def get_daily_app_breakdown(self, date_str: str) -> List[Dict[str, Any]]:
        return await asyncio.to_thread(self._db.get_daily_app_breakdown, date_str)

    async def add_reminder(self, message: str, due_timestamp: float) -> int:
        return await asyncio.to_thread(self._db.add_reminder, message, due_timestamp)

    async def get_pending_due_reminders(self, current_timestamp: float) -> List[Dict[str, Any]]:
        return await asyncio.to_thread(self._db.get_pending_due_reminders, current_timestamp)

    async def mark_reminder_fired(self, reminder_id: int) -> None:
        await asyncio.to_thread(self._db.mark_reminder_fired, reminder_id)

    async def dismiss_reminder(self, reminder_id: int) -> bool:
        return await asyncio.to_thread(self._db.dismiss_reminder, reminder_id)

    async def get_active_reminders(self) -> List[Dict[str, Any]]:
        return await asyncio.to_thread(self._db.get_active_reminders)

    async def get_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        return await asyncio.to_thread(self._db.get_setting, key, default)

    async def set_setting(self, key: str, value: str) -> None:
        await asyncio.to_thread(self._db.set_setting, key, value)

    async def close(self) -> None:
        await asyncio.to_thread(self._db.close)
