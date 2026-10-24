# OpenAlgo-vendor shim (quantdesk Round-27).
# The upstream file binds flask_socketio at import time; our stack uses
# python-socketio directly (hub.sio). Broker modules only ever *emit*
# events (master-contract progress, order updates) which the hub already
# fans out itself — so a silent no-op stub is exactly right here.
from __future__ import annotations

import threading
from typing import Any


class _StubSocketIO:
    """Drop-in stand-in for the Flask-SocketIO instance.

    emit() is a no-op: our hub publishes its own events to the browser.
    Anything else resolves to a no-op callable so attribute probes never
    crash vendored code paths.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.server = None

    def emit(self, event: str, data: Any = None, **kwargs) -> None:  # noqa: D401
        _ = event, data, kwargs
        return None

    def __getattr__(self, name: str):  # noqa: D105
        def _noop(*_a, **_k):
            return None
        return _noop


socketio = _StubSocketIO()


def emit_from_any_thread(event: str, data: Any = None, **kwargs) -> None:
    socketio.emit(event, data, **kwargs)
