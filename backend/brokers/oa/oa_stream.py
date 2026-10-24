"""Round-27 — StreamClient wrapper around each vendored broker's WebSocket adapter.

Lifecycle per hub.connect_account:
  adapter.make_stream(on_tick) → OAStream(on_tick, oa_adapter)
  await stream.start()  — instantiate the plugin's WebSocketAdapter, patch the
                          in-process `_sink`, initialize() with our session
                          (vendored auth_db shim resolves oa<account_id>),
                          connect() — all on worker threads
  await stream.subscribe([token, …]) — token is the master-table composite
                          'EXCH|oasym'; ticks come back keyed by OUR unified
                          symbol via the master-table round-trip map
  await stream.stop()   — disconnect + cleanup
"""
from __future__ import annotations

import asyncio
import importlib
import threading
import time
from typing import Any, Optional

from backend import config
from backend.brokers.base import BrokerError


def _f(v: Any) -> Optional[float]:
    try:
        if v in (None, "", "0"):
            return None if v in (None, "") else 0.0
        return float(v)
    except (TypeError, ValueError):
        return None


class OAStream:
    name = "openalgo-stream"

    def __init__(self, on_tick, adapter):
        self.on_tick = on_tick
        self.oa = adapter                      # OAAdapter
        self.plugin = adapter.plugin
        self.ws: Any = None                    # plugin WebSocketAdapter instance
        self._map: dict[str, str] = {}         # 'EXCH|oasym' -> our unified symbol
        self._subs: set[str] = set()
        self._lock = threading.Lock()
        self._started = False

    # ------------------------------------------------------------------ map
    def _load_map(self) -> None:
        try:
            from backend import db

            rows = db.broker_db(self.oa.name).query(
                "SELECT token, symbol FROM master WHERE token LIKE '%|%'" )
            with self._lock:
                self._map = {r["token"]: r["symbol"] for r in rows}
            config.log(self.oa.name, f"stream map loaded: {len(self._map)} composites")
        except Exception as e:
            config.log(self.oa.name, f"stream map unavailable: {e}", "WARN")

    # ------------------------------------------------------------------ sink
    def _on_data(self, topic: str, data: dict) -> None:
        try:
            if not isinstance(data, dict):
                return
            exch = str(data.get("exchange") or "").upper().replace("_INDEX", "")
            oa_sym = str(data.get("symbol") or "").upper()
            unified = self._map.get(f"{exch}|{oa_sym}") or f"{exch}:{oa_sym}"
            ltp = _f(data.get("ltp") or data.get("last_price") or data.get("lp"))
            if ltp is None:
                ltp = _f(data.get("close"))
            if ltp is None:
                return
            tick = {
                "symbol": unified, "ltp": ltp,
                "open": _f(data.get("open")), "high": _f(data.get("high")),
                "low": _f(data.get("low")), "close": _f(data.get("close")),
                "prev_close": _f(data.get("prev_close") or data.get("pc")),
                "vol": _f(data.get("volume") or data.get("vol")),
                "bid": _f(data.get("bid") or data.get("buy_price")),
                "ask": _f(data.get("ask") or data.get("sell_price")),
                "bq": _f(data.get("bid_qty") or data.get("buy_qty")),
                "aq": _f(data.get("ask_qty") or data.get("sell_qty")),
                "oi": _f(data.get("oi") or data.get("open_interest")),
                "ts": data.get("timestamp"),
                "t": time.time(),
            }
            self.on_tick(tick)
        except Exception as e:
            config.log(self.oa.name, f"sink error: {e}", "WARN")

    # ------------------------------------------------------------------ control
    async def start(self) -> None:
        if self._started:
            return

        def _boot():
            from backend.brokers.oa.oa_context import oa_ctx

            with oa_ctx(self.plugin, self.oa.credentials, account_id=self.oa.account_id):
                mod = importlib.import_module(f"broker.{self.plugin}.streaming")
                cls = None
                for attr in dir(mod):
                    if attr.endswith("WebSocketAdapter") and attr not in ("BaseBrokerWebSocketAdapter",):
                        cls = getattr(mod, attr)
                        break
                if cls is None:
                    raise BrokerError(f"{self.oa.name}: no WebSocketAdapter in plugin streaming module")
                ws = cls()
                ws._sink = self._on_data
                ws.initialize(self.plugin, f"oa{self.oa.account_id}")
                ws.connect()
            return ws
        try:
            self.ws = await asyncio.to_thread(_boot)
            self._started = True
            await asyncio.to_thread(self._load_map)
            config.log(self.oa.name, "stream started (openalgo plugin adapter)")
        except Exception as e:
            self.ws = None
            raise BrokerError(f"{self.oa.name}: stream start failed — {e}") from e

    async def stop(self) -> None:
        ws, self.ws = self.ws, None
        self._started = False
        if ws is None:
            return

        def _down():
            try:
                ws.disconnect()
            except Exception:
                pass
            try:
                ws.cleanup_zmq()
            except Exception:
                pass
        try:
            await asyncio.to_thread(_down)
        except Exception:
            pass
        config.log(self.oa.name, "stream stopped")

    # ------------------------------------------------------------------ subs
    @staticmethod
    def _split(token: str) -> Optional[tuple[str, str]]:
        if "|" not in str(token):
            return None
        exch, _, sym = str(token).partition("|")
        if not exch or not sym:
            return None
        return exch.upper().replace("_INDEX", ""), sym

    async def subscribe(self, tokens: list) -> None:
        if self.ws is None:
            return
        for tok in tokens:
            pair = self._split(tok)
            if not pair:
                continue
            exch, sym = pair

            def _sub(exch=exch, sym=sym):
                try:
                    resp = self.ws.subscribe(sym, exch, mode=2, depth_level=5)
                    if isinstance(resp, dict) and resp.get("status") == "error":
                        config.log(self.oa.name, f"subscribe {sym}@{exch}: {resp.get('message')}", "WARN")
                        return False
                    return True
                except Exception as e:
                    config.log(self.oa.name, f"subscribe {sym}@{exch} failed: {e}", "WARN")
                    return False
            ok = await asyncio.to_thread(_sub)
            if ok:
                self._subs.add(tok)

    async def unsubscribe(self, tokens: list) -> None:
        if self.ws is None:
            return
        for tok in tokens:
            pair = self._split(tok)
            if not pair:
                continue
            exch, sym = pair

            def _unsub(exch=exch, sym=sym):
                try:
                    self.ws.unsubscribe(sym, exch, mode=2)
                except Exception:
                    pass
            await asyncio.to_thread(_unsub)
            self._subs.discard(tok)
