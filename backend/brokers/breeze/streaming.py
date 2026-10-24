"""
Breeze live feed — socket.io client on livestream.icicidirect.com (authentic
breeze-connect transport: auth={"user": user_id, "token": session_token},
emit('join', tokens), ticks arrive on the 'stock' event).

Runs the blocking socket.io client in a worker thread; parsed ticks are
forwarded to on_tick (hub) via loop.call_soon_threadsafe.
"""
from __future__ import annotations

from typing import Optional
import asyncio
import threading

from backend import config


class BreezeStream:
    name = "breeze-feed"

    def __init__(self, on_tick, adapter):
        self.on_tick = on_tick
        self.adapter = adapter
        self.subscribed: set[str] = set()      # broker-native tokens
        self._sio = None
        self._thread: Optional[threading.Thread] = None
        self._loop = asyncio.get_event_loop()
        self._running = False
        self.connected = False

    # ------------------------------------------------------------------ control
    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_blocking, daemon=True,
                                        name="breeze-feed")
        self._thread.start()

    async def stop(self) -> None:
        self._running = False
        sio = self._sio
        if sio is not None:
            try:
                sio.disconnect()
            except Exception:
                pass
        self.connected = False

    async def subscribe(self, tokens: list[str]) -> None:
        new = [t for t in tokens if t and t not in self.subscribed]
        if not new:
            return
        self.subscribed.update(new)
        sio = self._sio
        if sio is not None and sio.connected:
            for t in new:
                sio.emit("join", t)
            config.log("breeze-feed", f"join emitted for {len(new)} tokens (total {len(self.subscribed)})")

    async def unsubscribe(self, tokens: list[str]) -> None:
        for t in tokens:
            self.subscribed.discard(t)

    # ------------------------------------------------------------------ thread
    def _run_blocking(self) -> None:
        try:
            import socketio as sio_client
        except ImportError:
            config.log("breeze-feed", "python-socketio client missing", "ERROR")
            return
        s = self.adapter.session
        if not s.get("user_id") or not s.get("session_token"):
            config.log("breeze-feed", "no persisted session — feed not started", "ERROR")
            return
        sio = sio_client.Client(reconnection=True, logger=False, engineio_logger=False)
        self._sio = sio

        @sio.event
        def connect():  # noqa: ANN202
            self.connected = True
            config.log("breeze-feed", "connected to livestream.icicidirect.com")
            for t in list(self.subscribed):
                sio.emit("join", t)
            if self.subscribed:
                sio.on("stock", self._on_stock)
            else:
                sio.on("stock", self._on_stock)

        @sio.event
        def disconnect(*a):  # noqa: ANN202
            self.connected = False
            config.log("breeze-feed", "disconnected", "WARN")

        @sio.on("connect_error")
        def _cerr(info):  # noqa: ANN202
            self.connected = False
            config.log("breeze-feed", f"connect_error: {info}", "ERROR")

        try:
            sio.connect(
                "https://livestream.icicidirect.com",
                headers={"User-Agent": "python-socketio[client]/socket"},
                auth={"user": s["user_id"], "token": s["session_token"]},
                transports="websocket", wait_timeout=10)
            sio.on("stock", self._on_stock)
            sio.wait()
        except Exception as e:
            self.connected = False
            config.log("breeze-feed", f"feed ended: {e}", "ERROR")

    def _on_stock(self, data) -> None:
        """Broker 'stock' event -> unified tick -> hub (thread-safe)."""
        try:
            if not isinstance(data, dict):
                return
            ltp = data.get("ltp") or data.get("last_price") or data.get("lp")
            if ltp is None:
                return
            tick = {
                "token": str(data.get("symbol") or data.get("stock_code") or ""),
                "ltp": float(ltp),
                "bid": _f(data.get("best_bid")), "ask": _f(data.get("best_ask")),
                "vol": _f(data.get("volume_traded_today") or data.get("vol")),
                "prev_close": _f(data.get("close")),
                "ts": int(config.now() if hasattr(config, "now") else 0) * 1000,
                "source": "breeze",
            }
            self._loop.call_soon_threadsafe(self.on_tick, tick)
        except Exception as e:
            config.log("breeze-feed", f"parse error: {e}", "ERROR")


def _f(v) -> Optional[float]:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None
