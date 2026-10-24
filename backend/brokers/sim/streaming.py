"""
SIM streaming — tick-by-tick generator.

Generates realistic ticks every ~120ms per subscribed symbol (staggered so the
fan-out rate stays smooth), with micro mean-reverting random walk, volume
accumulation, bid/ask around LTP. Runs inside the backend's asyncio loop.
"""
from __future__ import annotations

from typing import Optional
import asyncio
import random
import time

from backend import config


class SimStream:
    name = "sim-feed"

    def __init__(self, on_tick, universe: dict[str, dict], lookup=None):
        # lookup (round-27): resolve tokens added to the sim master AFTER the
        # stream started — auto-ensure on first chart open works live
        self.on_tick = on_tick
        self.universe = universe
        self.lookup = lookup
        self.subscribed: dict[str, dict] = {}   # token -> state
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.ticks_sent = 0

    # ------------------------------------------------------------------ control
    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run())
        self._task.add_done_callback(self._on_loop_error)
        config.log("sim-feed", f"stream started id={id(self):x} (universe={len(self.universe)} instruments)")

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        config.log("sim-feed", "stream stopped")

    async def subscribe(self, tokens: list[str]) -> None:
        for tok in tokens:
            info = self.universe.get(tok)
            if not info and self.lookup is not None:
                info = self.lookup(tok)  # round-27: on-demand synthesized contract
                if info:
                    self.universe[tok] = info
            if not info:
                continue
            if tok not in self.subscribed:
                base = info["base"] * random.uniform(0.995, 1.005)
                self.subscribed[tok] = {
                    "ltp": base, "open": base, "high": base, "low": base,
                    "close": base, "vol": 0, "bid": base - 0.05, "ask": base + 0.05,
                    "prev_close": base,
                }
        config.log("sim-feed", f"subscribed +{len(tokens)} id={id(self):x} (active={len(self.subscribed)})")

    async def unsubscribe(self, tokens: list[str]) -> None:
        for tok in tokens:
            self.subscribed.pop(tok, None)

    # ------------------------------------------------------------------ engine
    async def _run(self) -> None:
        """Tick loop: every loop pass advances EVERY subscribed symbol a small
        random-walk step (mimics exchange packet bursts), then emits each."""
        step_i = 0
        config.log("sim-feed", "tick loop entered")
        while self._running:
            t0 = time.perf_counter()
            step_i += 1
            if step_i % 100 == 1:
                config.log("sim-feed", f"loop alive id={id(self):x} step={step_i} subscribed={len(self.subscribed)}")
            now_ms = int(time.time() * 1000)
            batch = []
            for tok, st in list(self.subscribed.items()):
                info = self.universe.get(tok)
                if not info:
                    continue
                vol = info["vol"]
                # mean-reversion pull + shock
                drift = (info["base"] - st["ltp"]) / info["base"] * 0.02
                shock = random.gauss(0, 1) * vol
                st["ltp"] = max(0.05, st["ltp"] * (1 + drift + shock))
                qty = random.randint(1, max(2, int(info.get("lotsize", 1)) // 10 or 1)) * random.choice((1, 2, 5))
                st["vol"] += qty
                st["high"] = max(st["high"], st["ltp"])
                st["low"] = min(st["low"], st["ltp"])
                spread = max(0.05, round(st["ltp"] * 0.0004, 2))
                st["bid"] = round(st["ltp"] - spread, 2)
                st["ask"] = round(st["ltp"] + spread, 2)
                batch.append({
                    "symbol": info["symbol"], "exchange": info["exchange"],
                    "ltp": round(st["ltp"], 2), "prev_close": round(st["prev_close"], 2),
                    "bid": st["bid"], "ask": st["ask"],
                    "bid_qty": random.randint(1, 50) * 10, "ask_qty": random.randint(1, 50) * 10,
                    "vol": st["vol"], "open": round(st["open"], 2), "high": round(st["high"], 2),
                    "low": round(st["low"], 2), "close": round(st["close"], 2),
                    "ts": now_ms, "source": "sim",
                })
            for tick in batch:
                try:
                    self.on_tick(tick)
                except Exception as e:
                    config.log("sim-feed", f"on_tick error: {e}", "ERROR")
            self.ticks_sent += len(batch)
            # keep ~120ms cadence regardless of batch size
            elapsed = time.perf_counter() - t0
            await asyncio.sleep(max(0.02, 0.12 - elapsed))

    def _on_loop_error(self, task: asyncio.Task) -> None:
        if task.exception():
            config.log("sim-feed", f"tick loop crashed: {task.exception()} — restarting", "ERROR")
            self._task = asyncio.create_task(self._run())
