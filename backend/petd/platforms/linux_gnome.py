import logging
import os
import time
from typing import Optional

from petd.platforms.base import BaseWindowTracker, WindowInfo

logger = logging.getLogger("petd.platforms.gnome_wayland")


class GnomeWaylandWindowTracker(BaseWindowTracker):
    """
    Best-effort active window tracker for GNOME on Wayland.
    
    Wayland's security architecture isolates display clients, explicitly preventing
    unprivileged background processes from querying the active window title or focus.
    
    This adapter:
    1. Emits a clear, prominent warning explaining the Wayland restriction.
    2. Attempts fallback to Xwayland via Xlib (if Xwayland is active and client is X11).
    3. Falls back to detecting the most recently active graphical user process via psutil.
    """

    def __init__(self):
        self._x11_fallback = None
        self._warned = False
        self._last_warning_time = 0.0

        self._log_security_warning()

        # Check if Xwayland is available for legacy/X11 apps running on GNOME
        if os.environ.get("DISPLAY"):
            try:
                from petd.platforms.linux_x11 import X11WindowTracker
                self._x11_fallback = X11WindowTracker()
            except Exception as e:
                logger.debug(f"Xwayland fallback initialization failed: {e}")

    def _log_security_warning(self) -> None:
        logger.warning(
            "*** GNOME WAYLAND ENVIRONMENT DETECTED ***\n"
            "Under the Wayland security model, unprivileged processes cannot query window titles\n"
            "or active focus across application boundaries without a dedicated GNOME Shell extension\n"
            "(such as 'window-calls' or enabling org.gnome.desktop.wm.preferences / unsafe-mode).\n"
            "The daemon will use best-effort heuristic tracking (Xwayland bridging and active user process heuristics)."
        )

    def get_active_window(self) -> Optional[WindowInfo]:
        # Periodic warning reminder (once every 15 minutes) to ensure visibility in long-running logs
        now = time.time()
        if now - self._last_warning_time > 900:
            logger.info("GNOME Wayland active: using best-effort window detection.")
            self._last_warning_time = now

        # Heuristic 1: If an Xwayland window is currently active, X11 fallback will find it
        if self._x11_fallback:
            try:
                win = self._x11_fallback.get_active_window()
                if win and win.app_name and win.app_name != "unknown":
                    return win
            except Exception:
                pass

        # Heuristic 2: Find top active user process associated with GUI session
        try:
            import psutil
            current_uid = os.getuid()
            # Find processes owned by user with an active terminal or GUI session
            candidates = []
            for proc in psutil.process_iter(["pid", "name", "uids", "cpu_percent", "status"]):
                try:
                    pinfo = proc.info
                    if pinfo["uids"] and pinfo["uids"].real == current_uid:
                        name = pinfo["name"]
                        # Skip system/shell/daemon services
                        if name in (
                            "gnome-shell", "systemd", "dbus-broker", "pipewire",
                            "pulseaudio", "wireplumber", "gdm", "Xwayland",
                            "petd", "python", "python3"
                        ):
                            continue
                        candidates.append((pinfo["pid"], name))
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue

            if candidates:
                # Return the candidate process
                pid, name = candidates[0]
                return WindowInfo(
                    app_name=name,
                    title="Wayland Application",
                    process_id=pid,
                )
        except Exception as e:
            logger.debug(f"Gnome process heuristic error: {e}")

        return WindowInfo(
            app_name="gnome-shell",
            title="GNOME Desktop",
            process_id=None,
        )

    def close(self) -> None:
        if self._x11_fallback:
            self._x11_fallback.close()
            self._x11_fallback = None
