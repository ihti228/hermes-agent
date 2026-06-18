"""Desktop notification delivery for the /notify slash command.

All functions are fail-safe — notification errors are logged but never
propagate to the agent loop.

Cross-platform: Linux (notify-send), macOS (osascript),
Windows (PowerShell), and WSL (bridges to Windows via powershell.exe,
preferring notify-send via WSLg when available).
"""

import hashlib
import logging
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_SYSTEM = platform.system()


def _hermes_home() -> Path:
    from hermes_constants import get_hermes_home
    return get_hermes_home()


# ---------------------------------------------------------------------------
# WSL detection
# ---------------------------------------------------------------------------

_WSL_CACHE: Optional[bool] = None


def _is_wsl() -> bool:
    """Return True when running under Windows Subsystem for Linux."""
    global _WSL_CACHE
    if _WSL_CACHE is not None:
        return _WSL_CACHE
    try:
        with open("/proc/version", "r") as f:
            _WSL_CACHE = "microsoft" in f.read().lower()
    except Exception:
        _WSL_CACHE = False
    return _WSL_CACHE


# ---------------------------------------------------------------------------
# Sentinel file (per-session)
# ---------------------------------------------------------------------------
#
# The pending-notify flag is scoped to a *session*, not the whole process.
# The TUI gateway and dashboard serve many concurrent sessions from one
# process sharing one HERMES_HOME; a single global sentinel would let a
# ``/notify`` set in session A fire on session B's turn completion. Keying
# the sentinel by HERMES_SESSION_KEY keeps each session's pending flag
# independent. Classic single-process CLI has no session key and falls back
# to the unsuffixed default file — same behavior as before.


def _resolve_session_key(session_key: Optional[str]) -> str:
    """Resolve the session key for the current context.

    Explicit *session_key* wins (used by the TUI gateway, which serves many
    sessions from one process and must name them explicitly). Otherwise read
    ``HERMES_SESSION_KEY`` from the session context — a contextvar bound
    per-turn in the gateway, or ``os.environ`` in the classic CLI and the
    slash worker. Falls back to ``""`` (the default sentinel).
    """
    if session_key is not None:
        return session_key
    try:
        from gateway.session_context import get_session_env
        return get_session_env("HERMES_SESSION_KEY", "") or ""
    except Exception:
        return ""


def _sentinel_name(session_key: str) -> str:
    key = (session_key or "").strip()
    if not key:
        return ".notify_pending"
    digest = hashlib.sha1(key.encode("utf-8", "replace")).hexdigest()[:16]
    return f".notify_pending-{digest}"


def get_notify_sentinel_path(session_key: Optional[str] = None) -> Path:
    return _hermes_home() / _sentinel_name(_resolve_session_key(session_key))


def set_notify_flag(session_key: Optional[str] = None) -> bool:
    """Write the sentinel file to signal a pending notification."""
    try:
        p = get_notify_sentinel_path(session_key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch()
        return True
    except Exception as e:
        logger.warning("Failed to write notify sentinel: %s", e)
        return False


def clear_notify_flag(session_key: Optional[str] = None) -> bool:
    """Remove the sentinel file (cancel or consume notification)."""
    try:
        p = get_notify_sentinel_path(session_key)
        if not p.exists():
            return False
        p.unlink()
        return True
    except Exception as e:
        logger.warning("Failed to clear notify sentinel: %s", e)
        return False


def is_notify_pending(session_key: Optional[str] = None) -> bool:
    """Check if a notification is pending for this session."""
    return get_notify_sentinel_path(session_key).exists()


# ---------------------------------------------------------------------------
# Desktop notification
# ---------------------------------------------------------------------------

def _notify_send_available() -> bool:
    """Return True if notify-send is available and D-Bus is reachable."""
    if not shutil.which("notify-send"):
        return False
    # Quick smoke-test: verify D-Bus notification service exists
    try:
        result = subprocess.run(
            ["notify-send", "--version"],
            timeout=3, capture_output=True,
        )
        return result.returncode == 0
    except Exception:
        return False


def _show_notification_linux(title: str, message: str) -> None:
    """Desktop notification on native Linux via notify-send."""
    try:
        subprocess.run(
            ["notify-send", title, message],
            timeout=5, capture_output=True,
        )
        logger.debug("notify: Linux notification sent via notify-send")
    except FileNotFoundError:
        logger.debug("notify: notify-send not found on Linux")
    except subprocess.TimeoutExpired:
        logger.debug("notify: notify-send timed out on Linux")


def _ps_single_quote(value: str) -> str:
    """Quote a string for a single-quoted PowerShell literal."""
    return "'" + value.replace("'", "''") + "'"


def _show_notification_wsl(title: str, message: str) -> None:
    """Desktop notification in WSL via Windows balloon tip (PowerShell)."""
    logger.debug("notify: attempting WSL notification via PowerShell")
    try:
        ps_code = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$n = New-Object System.Windows.Forms.NotifyIcon; "
            "$n.Icon = [System.Drawing.SystemIcons]::Information; "
            f"$n.BalloonTipTitle = {_ps_single_quote(title)}; "
            f"$n.BalloonTipText = {_ps_single_quote(message)}; "
            "$n.Visible = $true; "
            "$n.ShowBalloonTip(3000); "
            "[System.Windows.Forms.Application]::DoEvents(); "
            "Start-Sleep -Seconds 4; "
            "$n.Dispose()"
        )
        result = subprocess.run(
            ["powershell.exe", "-c", ps_code],
            timeout=8, capture_output=True,
        )
        if result.returncode != 0:
            logger.debug("notify: PowerShell balloon failed (rc=%d, stderr=%s)",
                         result.returncode, result.stderr.decode(errors="replace")[:200])
        else:
            logger.debug("notify: WSL notification sent via PowerShell")
    except subprocess.TimeoutExpired:
        logger.debug("notify: PowerShell balloon timed out")
    except FileNotFoundError:
        logger.debug("notify: powershell.exe not found — is WSL properly configured?")
    except Exception as e:
        logger.warning("WSL notification failed: %s", e)


def _show_notification_macos(title: str, message: str) -> None:
    """Desktop notification on macOS.

    Prefer ``terminal-notifier`` when it's on PATH: it ships a real app
    bundle, so notifications attribute to it, show as banners, and are
    grantable in System Settings → Notifications. Plain ``osascript display
    notification`` attributes to the *launching* process — for an unsigned
    CLI that often can't register an app entry, so macOS delivers it silently
    to Notification Center with no banner (and no toggle the user can flip).
    Install with ``brew install terminal-notifier`` for reliable banners;
    otherwise fall back to osascript.
    """
    tn = shutil.which("terminal-notifier")
    if tn:
        try:
            subprocess.run(
                [tn, "-title", title, "-message", message],
                timeout=5, capture_output=True,
            )
            logger.debug("notify: macOS notification sent via terminal-notifier")
            return
        except Exception as e:
            logger.debug(
                "notify: terminal-notifier failed (%s), falling back to osascript", e
            )
    try:
        escaped_title = title.replace('\\', '\\\\').replace('"', '\\"')
        escaped_message = message.replace('\\', '\\\\').replace('"', '\\"')
        subprocess.run(
            ["osascript", "-e",
             f"display notification \"{escaped_message}\" with title \"{escaped_title}\""],
            timeout=5, capture_output=True,
        )
        logger.debug("notify: macOS notification sent via osascript")
    except Exception as e:
        logger.debug("notify: osascript notification failed: %s", e)


def _show_desktop_notification(title: str, message: str) -> None:
    """Show a desktop notification bubble.

    WSL path: prefer notify-send via WSLg (native Windows toasts),
    fall back to PowerShell balloon tip.
    """
    try:
        if _is_wsl():
            # WSLg path: notify-send bridges to native Windows notifications
            if _notify_send_available():
                logger.debug("notify: WSLg notify-send available, using D-Bus path")
                _show_notification_linux(title, message)
                return
            logger.debug("notify: notify-send not available in WSL, falling back to PowerShell")
            _show_notification_wsl(title, message)
        elif _SYSTEM == "Linux":
            _show_notification_linux(title, message)
        elif _SYSTEM == "Darwin":
            _show_notification_macos(title, message)
        elif _SYSTEM == "Windows":
            ps_code = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$n = New-Object System.Windows.Forms.NotifyIcon; "
                "$n.Icon = [System.Drawing.SystemIcons]::Information; "
                f"$n.BalloonTipTitle = {_ps_single_quote(title)}; "
                f"$n.BalloonTipText = {_ps_single_quote(message)}; "
                "$n.Visible = $true; "
                "$n.ShowBalloonTip(3000); "
                "Start-Sleep -Seconds 4"
            )
            subprocess.run(
                ["powershell", "-c", ps_code],
                timeout=8, capture_output=True,
            )
            logger.debug("notify: Windows notification sent via PowerShell")
    except Exception as e:
        logger.debug("Desktop notification failed: %s", e)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def fire_notification(
    *,
    title: str = "Hermes Agent",
    message: str = "Task complete",
) -> None:
    """Fire a desktop notification.

    All errors are caught silently — notification failure must never
    crash the idle loop.

    Args:
        title: Desktop notification title.
        message: Desktop notification body.
    """
    _show_desktop_notification(title, message)


def fire_approval_request_notification() -> None:
    """Notify that Hermes is blocked waiting for command approval.

    This intentionally does not clear the /notify sentinel; the final
    turn-complete notification should still fire after the user responds.
    """
    fire_notification(message="Input needed: approval required")


def consume_pending_notification(
    session_key: Optional[str] = None,
    *,
    title: str = "Hermes Agent",
    message: str = "Task complete",
) -> bool:
    """Fire-and-clear the pending notification for *session_key*, if any.

    Single entry point for the turn-complete sites (CLI idle loop, CLI
    process loop, TUI gateway success/error paths) so the
    check→clear→fire sequence lives in one place. Returns True when a
    notification was fired. Fully fail-safe.
    """
    try:
        if is_notify_pending(session_key):
            clear_notify_flag(session_key)
            fire_notification(title=title, message=message)
            return True
    except Exception as e:
        logger.debug("notify consume failed: %s", e)
    return False
