import logging
import os
import shutil
import subprocess
from typing import Optional

from petd.platforms.base import BaseWindowTracker, WindowInfo

logger = logging.getLogger("petd.platforms.x11")


class X11WindowTracker(BaseWindowTracker):
    """
    Tracks active window on Linux X11 systems.
    Prioritizes python-xlib for fast in-process querying, falling back to xdotool.
    """

    def __init__(self):
        self._display = None
        self._net_active_window = None
        self._net_wm_pid = None
        self._net_wm_name = None
        self._xdotool_path = shutil.which("xdotool")
        self._use_xlib = False

        if os.environ.get("DISPLAY"):
            try:
                from Xlib import X, display
                self._display = display.Display()
                self._net_active_window = self._display.intern_atom("_NET_ACTIVE_WINDOW")
                self._net_wm_pid = self._display.intern_atom("_NET_WM_PID")
                self._net_wm_name = self._display.intern_atom("_NET_WM_NAME")
                self._use_xlib = True
                logger.info("Initialized X11 tracker using python-xlib.")
            except Exception as e:
                logger.debug(f"python-xlib initialization failed: {e}. Will attempt xdotool fallback.")

        if not self._use_xlib and self._xdotool_path:
            logger.info("Initialized X11 tracker using xdotool.")
        elif not self._use_xlib and not self._xdotool_path:
            logger.warning("Neither python-xlib nor xdotool is usable for X11 tracking.")

    def get_active_window(self) -> Optional[WindowInfo]:
        if self._use_xlib and self._display:
            try:
                return self._get_via_xlib()
            except Exception as e:
                logger.debug(f"Xlib query failed: {e}")

        if self._xdotool_path:
            return self._get_via_xdotool()

        return None

    def _get_via_xlib(self) -> Optional[WindowInfo]:
        import psutil
        from Xlib import X

        root = self._display.screen().root
        prop = root.get_full_property(self._net_active_window, X.AnyPropertyType)
        if not prop or not prop.value:
            return None

        win_id = prop.value[0]
        if win_id == 0:
            return None

        window = self._display.create_resource_object("window", win_id)

        # Get window title
        title = ""
        try:
            wm_name = window.get_full_property(self._net_wm_name, X.AnyPropertyType)
            if wm_name and wm_name.value:
                title = wm_name.value
                if isinstance(title, bytes):
                    title = title.decode("utf-8", errors="replace")
            else:
                title = window.get_wm_name() or ""
        except Exception:
            pass

        # Get PID and app name
        pid = None
        app_name = ""
        try:
            pid_prop = window.get_full_property(self._net_wm_pid, X.AnyPropertyType)
            if pid_prop and pid_prop.value:
                pid = int(pid_prop.value[0])
                app_name = psutil.Process(pid).name()
        except Exception:
            pass

        # Fallback to WM_CLASS if app_name not resolved from PID
        if not app_name:
            try:
                wm_class = window.get_wm_class()
                if wm_class:
                    app_name = wm_class[1] if len(wm_class) > 1 else wm_class[0]
            except Exception:
                pass

        if not app_name and not title:
            return None

        return WindowInfo(
            app_name=app_name or "unknown",
            title=title or "",
            process_id=pid,
        )

    def _get_via_xdotool(self) -> Optional[WindowInfo]:
        import psutil

        try:
            res = subprocess.run(
                [self._xdotool_path, "getactivewindow"],
                capture_output=True,
                text=True,
                timeout=1.0,
                check=False,
            )
            if res.returncode != 0:
                return None

            win_id = res.stdout.strip()
            if not win_id:
                return None

            # Get title
            title_res = subprocess.run(
                [self._xdotool_path, "getwindowname", win_id],
                capture_output=True,
                text=True,
                timeout=1.0,
                check=False,
            )
            title = title_res.stdout.strip() if title_res.returncode == 0 else ""

            # Get PID
            pid = None
            app_name = ""
            pid_res = subprocess.run(
                [self._xdotool_path, "getwindowpid", win_id],
                capture_output=True,
                text=True,
                timeout=1.0,
                check=False,
            )
            if pid_res.returncode == 0 and pid_res.stdout.strip().isdigit():
                pid = int(pid_res.stdout.strip())
                try:
                    app_name = psutil.Process(pid).name()
                except Exception:
                    pass

            return WindowInfo(
                app_name=app_name or "unknown",
                title=title,
                process_id=pid,
            )
        except Exception as e:
            logger.debug(f"xdotool error: {e}")
            return None

    def close(self) -> None:
        if self._display:
            try:
                self._display.close()
            except Exception:
                pass
            self._display = None
