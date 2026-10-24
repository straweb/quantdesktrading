"""
Candle aggregator — ticks -> 1m candles (ring buffer) -> higher timeframes.

Server-side aggregation keeps the frontend fully event-driven: it receives a
historical snapshot once (candles:get) and then live 'candle' events, no REST
polling (Round-15 requirement).
"""
from __future__ import annotations

from typing import Optional
import time
from collections import defaultdict, deque

BUCKET = 60


class CandleAggregator:
    def __init__(self, maxlen: int = 2500):
        # 2500 x 1m ≈ 6.5 trading days of context (session simulators seed
        # previous days so charts open with full multi-day history)
        self._candles: dict[str, dict] = {}            # symbol -> current 1m candle
        self._history: dict[str, deque] = defaultdict(lambda: deque(maxlen=maxlen))

    def on_tick(self, symbol: str, ltp: float, vol_delta: float, ts_ms: int) -> Optional[dict]:
        """Feed a tick; returns a finished 1m candle when the minute rolls."""
        if ltp <= 0:
            return None
        t = int(ts_ms // 1000) // BUCKET * BUCKET
        cur = self._candles.get(symbol)
        closed = None
        if cur is None or cur["t"] != t:
            if cur is not None:
                self._history[symbol].append(cur)
                closed = cur
            cur = {"t": t, "o": ltp, "h": ltp, "l": ltp, "c": ltp, "v": vol_delta or 0}
            self._candles[symbol] = cur
        else:
            cur["h"] = max(cur["h"], ltp)
            cur["l"] = min(cur["l"], ltp)
            cur["c"] = ltp
            cur["v"] += vol_delta or 0
        return closed

    def live_candle(self, symbol: str) -> Optional[dict]:
        return self._candles.get(symbol)

    def history(self, symbol: str, tf_minutes: int = 1, limit: int = 400) -> list[dict]:
        """Aggregated history from the ring buffer (used when broker history unavailable)."""
        if tf_minutes <= 1:
            return list(self._history[symbol])[-limit:]
        out, cur = [], None
        for c in self._history[symbol]:
            bt = c["t"] // (tf_minutes * 60) * tf_minutes * 60
            if cur is None or cur["t"] != bt:
                if cur:
                    out.append(cur)
                cur = {"t": bt, "o": c["o"], "h": c["h"], "l": c["l"], "c": c["c"], "v": c["v"]}
            else:
                cur["h"] = max(cur["h"], c["h"])
                cur["l"] = min(cur["l"], c["l"])
                cur["c"] = c["c"]
                cur["v"] += c["v"]
        if cur:
            out.append(cur)
        return out[-limit:]

    def seed_history(self, symbol: str, candles: list[dict]) -> None:
        """Seed the ring with broker-native history so live candles continue it."""
        for c in candles:
            self._history[symbol].append(c)

    def forget(self, symbol: str) -> None:
        self._candles.pop(symbol, None)
        self._history.pop(symbol, None)
