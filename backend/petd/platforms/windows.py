import asyncio
import logging
from typing import Optional

from petd.platforms.base import (
    BaseNotificationCollector,
    BaseWindowTracker,
    NotificationCallback,
    WindowInfo,
)

logger = logging.getLogger("petd.platforms.windows")


class WindowsWindowTracker(BaseWindowTracker):
    """Tracks the active foreground window on Windows using ctypes Win32 API and psutil."""

    def __init__(self):
        try:
            import ctypes
            import psutil
            self._ctypes = ctypes
            self._psutil = psutil
            self._user32 = ctypes.windll.user32
        except Exception as e:
            logger.warning(f"Failed to initialize Windows ctypes tracker: {e}")
            self._user32 = None

    def get_active_window(self) -> Optional[WindowInfo]:
        if not self._user32:
            return None

        try:
            hwnd = self._user32.GetForegroundWindow()
            if not hwnd:
                return None

            # Get process ID
            pid = self._ctypes.c_ulong()
            self._user32.GetWindowThreadProcessId(hwnd, self._ctypes.byref(pid))
            process_id = pid.value
            if process_id == 0:
                return None

            # Get window title
            length = self._user32.GetWindowTextLengthW(hwnd)
            buff = self._ctypes.create_unicode_buffer(length + 1)
            self._user32.GetWindowTextW(hwnd, buff, length + 1)
            title = buff.value or ""

            # Get process name via psutil
            app_name = "unknown"
            try:
                proc = self._psutil.Process(process_id)
                app_name = proc.name()
            except (self._psutil.NoSuchProcess, self._psutil.AccessDenied, Exception):
                pass

            return WindowInfo(
                app_name=app_name,
                title=title,
                process_id=process_id,
            )
        except Exception as e:
            logger.debug(f"Error querying active window on Windows: {e}")
            return None


class WindowsNotificationCollector(BaseNotificationCollector):
    """
    Windows notification listener stub.
    
    TODO: Integrate with Windows Runtime (WinRT) `Windows.UI.Notifications.Management.UserNotificationListener`.
    
    Documented Limitation:
    Listening to global Windows Action Center / Toast notifications on Windows 10/11 requires
    the WinRT `UserNotificationListener` API. This API strictly mandates that the calling process
    possesses a package identity (UWP / MSIX sparse package) with the `userNotificationListener`
    restricted capability declared in its manifest, or elevated COM authorization.
    Standard unpackaged Python scripts running in user space cannot directly tap toast events.
    """

    def __init__(self):
        self._running = False

    async def start(self, callback: NotificationCallback) -> None:
        self._running = True
        logger.info(
            "Windows notification collector initialized (Stub). "
            "Listening to global Windows toast notifications requires a packaged MSIX app identity "
            "with 'userNotificationListener' capability. Notification capture is disabled."
        )

    async def stop(self) -> None:
        self._running = False
