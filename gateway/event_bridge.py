"""Cross-process bridge: ship local ``hermes_events`` to the dashboard.

The gateway runs as its own process (``hermes gateway run``) — separate from
the dashboard's web server. Plugins like the orb live in the dashboard
process and subscribe to its local bus instance. This module forwards
locally-published events to the dashboard so its plugins see them.

Wire protocol
-------------
Frames are JSON dicts with the shape::

    {
        "_bus_relay": true,
        "topic":      "<topic, e.g. gateway.agent.start>",
        "envelope":   {<full hermes_events envelope: type, ts, src, ...>},
    }

The dashboard's ``/api/pub`` receiver recognises this shape and re-publishes
verbatim onto its local bus. ``ts`` and ``src`` are preserved (the bus only
auto-stamps missing keys), so subscribers see the original gateway-side
timestamp.

Configuration
-------------
The bridge reads two environment variables at start time:

- ``HERMES_DASHBOARD_EVENT_URL`` — ws://host:port/api/pub URL (no query string;
  this module appends ``token`` and ``channel``).
- ``HERMES_DASHBOARD_EVENT_TOKEN`` — the dashboard's session token. The
  dashboard's ``_SESSION_TOKEN`` is process-local-ephemeral, so until a
  handoff mechanism lands this must be supplied by whoever launches the
  gateway. Without it the bridge no-ops (no exception, no spam — just a
  single debug log line at startup).

Failure mode
------------
Best-effort. Connection failures, drops, and per-frame send errors are
logged at debug and the bridge silently retries with exponential backoff.
``publish()`` is sync; the bridge enqueues frames on a daemon thread so
the publisher's main path never blocks.

If both env vars are missing the bridge does not start — this is the
common case for gateways running standalone (no dashboard at all).
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
from typing import Optional
from urllib.parse import urlencode

import hermes_events
from hermes_events import _Subscription

logger = logging.getLogger(__name__)

# Module-level state. ``start()`` is idempotent; calling twice replaces the
# bridge but does not duplicate it.
_lock = threading.Lock()
_bridge: Optional["_Bridge"] = None


class _Bridge:
    """Background thread that ships local bus events to the dashboard."""

    _QUEUE_MAX = 1024

    def __init__(self, url: str, token: str, channel: str = "gateway") -> None:
        self._url = url
        self._token = token
        self._channel = channel
        self._queue: queue.Queue = queue.Queue(maxsize=self._QUEUE_MAX)
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._subscription: Optional[_Subscription] = None

    def start(self) -> None:
        # Subscribe to ``**`` first — every published event lands in the
        # outgoing queue. The worker thread drains the queue and ships via
        # WS. If the WS isn't connected yet the queue absorbs the burst.
        self._subscription = hermes_events.subscribe("**", self._enqueue)
        self._worker = threading.Thread(
            target=self._run,
            name="hermes-event-bridge",
            daemon=True,
        )
        self._worker.start()

    def stop(self) -> None:
        if self._subscription is not None:
            hermes_events.unsubscribe(self._subscription)
            self._subscription = None
        self._stop.set()
        # Nudge the queue so a blocked drain returns promptly.
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass

    def _enqueue(self, envelope: dict) -> None:
        """Subscriber callback. Skip ``_bus_relay``-tagged envelopes — those
        came IN via the dashboard's pub_ws, and re-shipping would loop them
        back. We only forward locally-originated events."""
        if envelope.get("_relayed"):
            return
        topic = envelope.get("type", "")
        if not isinstance(topic, str) or not topic:
            return
        # Skip echo: don't ship events whose ``src`` indicates they came
        # from somewhere other than this process. The dashboard ingestor
        # doesn't tag with ``_relayed``, but it does preserve the original
        # ``src``. If the gateway ever subscribes to dashboard-originated
        # events (e.g. ``tui.*``), shipping them back would create a loop.
        # For now we accept anything originating with src starting with
        # ``gateway`` or ``agent``; everything else is presumed inbound.
        src = envelope.get("src", "")
        if isinstance(src, str) and not src.startswith(("gateway", "agent")):
            return
        frame = {
            "_bus_relay": True,
            "topic": topic,
            "envelope": dict(envelope),
        }
        try:
            self._queue.put_nowait(frame)
        except queue.Full:
            # Drop oldest, enqueue newest. Bus events are best-effort; a
            # blocked subscriber must never wedge the publisher's main path.
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(frame)
            except queue.Full:
                # Pathological: queue still full after a get. Drop.
                pass

    def _run(self) -> None:
        backoff = 1.0
        max_backoff = 30.0
        while not self._stop.is_set():
            ws = self._connect()
            if ws is None:
                # Sleep with stop-aware wait. .wait returns True if stop
                # was set, in which case we exit immediately.
                if self._stop.wait(backoff):
                    return
                backoff = min(backoff * 2, max_backoff)
                continue
            backoff = 1.0  # reset on successful connect
            try:
                self._drain(ws)
            except Exception as exc:
                logger.debug("event_bridge: drain error: %s", exc)
            finally:
                try:
                    ws.close()  # type: ignore[union-attr]
                except Exception:
                    pass

    def _connect(self):
        try:
            from websockets.sync.client import connect as ws_connect
        except ImportError:  # pragma: no cover
            logger.debug("event_bridge: 'websockets' package not installed")
            return None
        qs = urlencode({"token": self._token, "channel": self._channel})
        url = f"{self._url}?{qs}" if "?" not in self._url else f"{self._url}&{qs}"
        try:
            return ws_connect(url, open_timeout=2.0, max_size=None)
        except Exception as exc:
            logger.debug("event_bridge: connect to %s failed: %s", self._url, exc)
            return None

    def _drain(self, ws) -> None:
        """Pop frames off the queue and send via WS until error or stop."""
        while not self._stop.is_set():
            try:
                item = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue
            if item is None:
                return  # explicit shutdown sentinel
            try:
                ws.send(json.dumps(item, ensure_ascii=False))
            except Exception as exc:
                logger.debug("event_bridge: send failed, will reconnect: %s", exc)
                # Re-queue the lost frame at the front so we don't drop it
                # on a transient blip. Best-effort: the queue is FIFO, so
                # this lands at the back, not the front — acceptable for v1.
                try:
                    self._queue.put_nowait(item)
                except queue.Full:
                    pass
                return


def start_if_configured() -> bool:
    """Read env vars and start the bridge if both are set.

    Returns True if the bridge was started, False otherwise. Idempotent —
    a second call replaces the previous bridge.
    """
    global _bridge

    url = os.environ.get("HERMES_DASHBOARD_EVENT_URL", "").strip()
    token = os.environ.get("HERMES_DASHBOARD_EVENT_TOKEN", "").strip()
    if not url or not token:
        logger.debug(
            "event_bridge: HERMES_DASHBOARD_EVENT_URL/TOKEN not set — "
            "gateway bus events will not reach the dashboard"
        )
        return False

    channel = os.environ.get("HERMES_DASHBOARD_EVENT_CHANNEL", "gateway").strip() or "gateway"

    with _lock:
        if _bridge is not None:
            _bridge.stop()
        _bridge = _Bridge(url=url, token=token, channel=channel)
        _bridge.start()

    logger.info(
        "event_bridge: shipping local bus events to dashboard at %s (channel=%s)",
        url,
        channel,
    )
    return True


def stop() -> None:
    """Stop the bridge if running. Idempotent."""
    global _bridge
    with _lock:
        if _bridge is not None:
            _bridge.stop()
            _bridge = None


__all__ = ["start_if_configured", "stop"]
