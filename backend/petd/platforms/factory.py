import logging
import os
import shutil
import sys
from dataclasses import dataclass
from typing import Optional

from petd.platforms.base import (
    BaseNotificationCollector,
    BaseWindowTracker,
    NotificationCallback,
    WindowInfo,
)

logger = logging.getLogger("petd.platforms.factory")


class DummyWindowTracker(BaseWindowTracker):
    """Fallback dummy window tracker when no platform-specific tracker is supported."""

    def get_active_window(self) -> Optional[WindowInfo]:
        return None


class DummyNotificationCollector(BaseNotificationCollector):
    """Fallback dummy notification collector."""

    async def start(self, callback: NotificationCallback) -> None:
        pass

    async def stop(self) -> None:
        pass


@dataclass
class PlatformAdapters:
    window_tracker: BaseWindowTracker
    notification_collector: BaseNotificationCollector


def create_platform_adapters() -> PlatformAdapters:
    """
    Detects the host OS, desktop environment, and compositor, returning the
    appropriate adapters behind unified abstract interfaces.
    """
    tracker: BaseWindowTracker
    collector: BaseNotificationCollector

    # 1. Windows platform detection
    if sys.platform == "win32":
        logger.info("Host detected: Windows. Initializing Windows Win32 ctypes adapters.")
        from petd.platforms.windows import (
            WindowsNotificationCollector,
            WindowsWindowTracker,
        )
        tracker = WindowsWindowTracker()
        collector = WindowsNotificationCollector()
        return PlatformAdapters(window_tracker=tracker, notification_collector=collector)

    # 2. Linux platform detection
    if sys.platform.startswith("linux"):
        xdg_session = os.environ.get("XDG_SESSION_TYPE", "").lower()
        desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").lower()
        hyprland_sig = os.environ.get("HYPRLAND_INSTANCE_SIGNATURE")

        logger.info(
            f"Host detected: Linux (SESSION_TYPE='{xdg_session}', CURRENT_DESKTOP='{desktop}')"
        )

        # Detect Hyprland
        if hyprland_sig or (shutil.which("hyprctl") and "hyprland" in desktop):
            logger.info("Compositor: Hyprland detected.")
            from petd.platforms.linux_hyprland import HyprlandWindowTracker
            tracker = HyprlandWindowTracker()
        # Detect GNOME Wayland
        elif "wayland" in xdg_session and "gnome" in desktop:
            logger.info("Compositor: GNOME Wayland detected.")
            from petd.platforms.linux_gnome import GnomeWaylandWindowTracker
            tracker = GnomeWaylandWindowTracker()
        # Other Wayland or standard X11
        else:
            if "wayland" in xdg_session:
                logger.warning(
                    f"Wayland session '{xdg_session}' detected without native compositor adapter. "
                    "Attempting X11/Xwayland bridge."
                )
            from petd.platforms.linux_x11 import X11WindowTracker
            tracker = X11WindowTracker()

        from petd.platforms.linux_dbus import LinuxDbusNotificationCollector
        collector = LinuxDbusNotificationCollector()
        return PlatformAdapters(window_tracker=tracker, notification_collector=collector)

    # 3. Fallback for other platforms
    logger.warning(f"Unsupported operating system: {sys.platform}. Using dummy adapters.")
    return PlatformAdapters(
        window_tracker=DummyWindowTracker(),
        notification_collector=DummyNotificationCollector(),
    )
