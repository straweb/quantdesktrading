"""
Shoonya (Finvasia) live feed — Noren WebSocket (authentic, per OpenAlgo):

  URL:   wss://api.shoonya.com/NorenWSAPI/
  Auth:  {"t":"c","uid":..,"actid":..,"source":"API","accesstoken":susertoken}
         -> ack {"t":"ak","s":"OK"}
  Sub:   {"t":"t","k":"NSE|22"}  touchline; ticks {"t":"tf"/"tk","lp":ltp,"pc":prev,"o","h","l","c","v":vol}
  Ping:  {"t":"h"} every ~10s -> ack "hk"
"""
from __future__ import annotations

from typing import Optional
import asyncio
import json

import websockets

from backend import config


class ShoonyaStream:
    name = "shoonya-feed"
    WS_URL = "wss://api.shoonya.com/NorenWSAPI/"

    def __init__(self, on_tick, adapter):
        self.on_tick = on_tick
        self.adapter = adapter
        self.subscribed: set[str] = set()      # "NSE|22" style keys
        self._ws = None
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.connected = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass

    async def subscribe(self, scrips: list[str]) -> None:
        new = [s for s in scrips if s not in self.subscribed]
        self.subscribed.update(new)
        if self._ws and new:
            for k in new:
                try:
                    await self._ws.send(json.dumps({"t": "t", "k": k}))
                except Exception as e:
                    config.log("shoonya-feed", f"subscribe error: {e}", "ERROR")
            config.log("shoonya-feed", f"subscribed {len(new)} touchlines (total {len(self.subscribed)})")

    async def unsubscribe(self, scrips: list[str]) -> None:
        for s in scrips:
            self.subscribed.discard(s)
        if self._ws:
            for k in scrips:
                try:
                    await self._ws.send(json.dumps({"t": "u", "k": k}))
                except Exception:
                    pass

    async def _run(self) -> None:
        s = self.adapter.session
        if not s.get("susertoken"):
            config.log("shoonya-feed", "no susertoken — feed not started", "ERROR")
            return
        backoff = 2
        while self._running:
            try:
                async with websockets.connect(self.WS_URL, ping_interval=15) as ws:
                    self._ws = ws
                    await ws.send(json.dumps({
                        "t": "c", "uid": s.get("uid", ""), "actid": s.get("actid", ""),
                        "source": "API", "accesstoken": s["susertoken"]}))
                    # wait auth ack; hedging repo uses t:"a" for the app
                    # login — retry with it when the connect-shape is refused
                    raw = await asyncio.wait_for(ws.recv(), timeout=10)
                    ack = json.loads(raw)
                    if ack.get("t") != "ak" or ack.get("s") != "OK":
                        await ws.send(json.dumps({
                            "t": "a", "uid": s.get("uid", ""), "actid": s.get("actid", ""),
                            "source": "API", "accesstoken": s["susertoken"]}))
                        raw = await asyncio.wait_for(ws.recv(), timeout=10)
                        ack = json.loads(raw)
                        if ack.get("t") != "ak" or ack.get("s") != "OK":
                            raise Exception(f"auth rejected: {raw[:120]}")
                    self.connected = True
                    backoff = 2
                    config.log("shoonya-feed", "NorenWSAPI connected + authenticated")
                    if self.subscribed:
                        for k in list(self.subscribed):
                            await ws.send(json.dumps({"t": "t", "k": k}))
                    ping_task = asyncio.create_task(self._ping(ws))
                    try:
                        async for raw in ws:
                            if not self._running:
                                break
                            self._on_msg(raw)
                    finally:
                        ping_task.cancel()
            except Exception as e:
                self.connected = False
                config.log("shoonya-feed", f"connection lost: {e} — retry {backoff}s", "WARN")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)
        self.connected = False

    async def _ping(self, ws) -> None:
        while True:
            await asyncio.sleep(10)
            try:
                await ws.send(json.dumps({"t": "h"}))
            except Exception:
                return

    def _on_msg(self, raw) -> None:
        try:
            m = json.loads(raw)
        except Exception:
            return
        t = m.get("t")
        if t in ("tk", "tf", "df", "dk"):
            lp = m.get("lp")
            if lp in (None, ""):
                return
            try:
                ltp = float(lp)
            except (TypeError, ValueError):
                return
            # Noren 'pc' is the % change vs prev close — derive the price
            try:
                pc_pct = float(m.get("pc") or 0)
            except (TypeError, ValueError):
                pc_pct = 0.0
            prev_close = round(ltp / (1 + pc_pct / 100.0), 2) if pc_pct else None
            self.on_tick({
                "symbol": f"{m.get('e', 'NSE')}:{m.get('ts', '')}" if m.get("ts") else "",
                "token": str(m.get("tk") or ""),
                "ltp": ltp,
                "prev_close": prev_close,
                "open": float(m.get("o") or 0) or None,
                "high": float(m.get("h") or 0) or None,
                "low": float(m.get("l") or 0) or None,
                "close": float(m.get("c") or 0) or None,
                "vol": float(m.get("v") or 0),
                "bid": float(m.get("bp1") or 0) or None,
                "ask": float(m.get("sp1") or 0) or None,
                "oi": float(m.get("toi") or 0) or None,
                "ts": int(float(m.get("ft") or 0) * 1000),
                "source": "shoonya",
            })
        elif t == "hk":
            pass
