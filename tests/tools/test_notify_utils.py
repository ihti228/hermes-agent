"""Tests for the per-session /notify sentinel + consume helper.

Covers the behavior the supersede added on top of the original PR:
the sentinel is scoped per session so a /notify in one TUI/dashboard
session never fires on another session's turn completion.
"""

import pytest

from tools import notify_utils


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(notify_utils, "_hermes_home", lambda: tmp_path)
    # Never hit the OS during tests.
    monkeypatch.setattr(notify_utils, "_show_desktop_notification", lambda *a, **k: None)
    return tmp_path


def test_set_is_pending_clear_roundtrip(home):
    assert notify_utils.is_notify_pending("sess-a") is False
    assert notify_utils.set_notify_flag("sess-a") is True
    assert notify_utils.is_notify_pending("sess-a") is True
    assert notify_utils.clear_notify_flag("sess-a") is True
    assert notify_utils.is_notify_pending("sess-a") is False
    # Clearing again is a no-op (nothing to remove).
    assert notify_utils.clear_notify_flag("sess-a") is False


def test_sessions_are_independent(home):
    """A /notify set in session A must not register as pending for B."""
    notify_utils.set_notify_flag("sess-a")
    assert notify_utils.is_notify_pending("sess-a") is True
    assert notify_utils.is_notify_pending("sess-b") is False


def test_distinct_keys_get_distinct_sentinels(home):
    pa = notify_utils.get_notify_sentinel_path("sess-a")
    pb = notify_utils.get_notify_sentinel_path("sess-b")
    assert pa != pb


def test_empty_key_uses_default_sentinel(home):
    # Classic CLI (no session key) gets the unsuffixed default file.
    assert notify_utils.get_notify_sentinel_path("").name == ".notify_pending"
    assert notify_utils.get_notify_sentinel_path(None).name == ".notify_pending"


def test_consume_fires_once_and_clears(home, monkeypatch):
    fired = []
    monkeypatch.setattr(
        notify_utils, "fire_notification",
        lambda **kw: fired.append(kw),
    )
    notify_utils.set_notify_flag("sess-a")

    assert notify_utils.consume_pending_notification("sess-a") is True
    assert len(fired) == 1
    # Sentinel consumed — a second consume is a no-op.
    assert notify_utils.consume_pending_notification("sess-a") is False
    assert len(fired) == 1


def test_consume_is_scoped_to_its_session(home, monkeypatch):
    fired = []
    monkeypatch.setattr(
        notify_utils, "fire_notification",
        lambda **kw: fired.append(kw),
    )
    notify_utils.set_notify_flag("sess-a")

    # Another session completing must NOT consume A's pending notify.
    assert notify_utils.consume_pending_notification("sess-b") is False
    assert fired == []
    assert notify_utils.is_notify_pending("sess-a") is True


def test_macos_prefers_terminal_notifier_when_present(monkeypatch):
    runs = []
    monkeypatch.setattr(notify_utils.shutil, "which",
                        lambda name: "/opt/homebrew/bin/terminal-notifier")
    monkeypatch.setattr(notify_utils.subprocess, "run",
                        lambda argv, **kw: runs.append(argv))

    notify_utils._show_notification_macos("T", "M")

    assert len(runs) == 1
    assert runs[0][0].endswith("terminal-notifier")
    assert "-message" in runs[0] and "M" in runs[0]


def test_macos_falls_back_to_osascript_without_terminal_notifier(monkeypatch):
    runs = []
    monkeypatch.setattr(notify_utils.shutil, "which", lambda name: None)
    monkeypatch.setattr(notify_utils.subprocess, "run",
                        lambda argv, **kw: runs.append(argv))

    notify_utils._show_notification_macos("T", "M")

    assert len(runs) == 1
    assert runs[0][0] == "osascript"


def test_key_resolves_from_session_env(home, monkeypatch):
    """When no explicit key is passed, the current session context is used."""
    monkeypatch.setattr(
        notify_utils, "_resolve_session_key",
        lambda sk: "ctx-key" if sk is None else sk,
    )
    notify_utils.set_notify_flag()  # resolves to "ctx-key"
    assert notify_utils.is_notify_pending("ctx-key") is True
    assert notify_utils.is_notify_pending() is True
