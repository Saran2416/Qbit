import json
import logging
import shutil
import subprocess
from typing import Optional

from petd.platforms.base import BaseWindowTracker, WindowInfo

logger = logging.getLogger("petd.platforms.hyprland")


class HyprlandWindowTracker(BaseWindowTracker):
    """Tracks active window on Hyprland compositors using `hyprctl activewindow -j`."""

    def __init__(self):
        self._hyprctl_path = shutil.which("hyprctl")
        if not self._hyprctl_path:
            logger.warning("hyprctl binary not found in PATH")

    def get_active_window(self) -> Optional[WindowInfo]:
        if not self._hyprctl_path:
            return None

        try:
            res = subprocess.run(
                [self._hyprctl_path, "activewindow", "-j"],
                capture_output=True,
                text=True,
                timeout=1.0,
                check=False,
            )
            if res.returncode != 0 or not res.stdout.strip():
                return None

            data = json.loads(res.stdout)
            if not isinstance(data, dict) or not data:
                return None

            # hyprctl provides initialClass, class, title, and pid
            app_name = data.get("initialClass") or data.get("class") or ""
            title = data.get("title") or ""
            pid = data.get("pid")

            if not app_name and pid:
                try:
                    import psutil
                    app_name = psutil.Process(pid).name()
                except Exception:
                    pass

            if not app_name and not title:
                return None

            return WindowInfo(
                app_name=app_name or "unknown",
                title=title,
                process_id=pid,
            )
        except subprocess.TimeoutExpired:
            logger.debug("hyprctl timed out")
            return None
        except Exception as e:
            logger.debug(f"Failed to query hyprctl activewindow: {e}")
            return None
