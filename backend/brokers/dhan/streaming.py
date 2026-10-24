"""
Dhan live feed — binary WebSocket v2 (authentic protocol, per OpenAlgo dhan_websocket):

  URL:  wss://api-feed.dhan.co?version=2&token={access_token}&clientId={client_id}&authType=2
  Sub:  {"RequestCode": 21(FULL)|17(QUOTE)|15(TICKER), "InstrumentCount": n,
         "InstrumentList": [{"ExchangeSegment": "NSE_EQ", "SecurityId": "1333", ...}]}
  Rsp:  binary frames: [code:u8][len:u16][segment:u8][securityId:u32] + payload
        code 2 ticker(ltp), 4 quote, 5 OI, 6 prev_close, 8 full, 50 disconnect, 0 heartbeat
"""
from __future__ import annotations

from typing import Optional
import asyncio
import json
import struct
import time

import websockets

from backend import config

REQ = {"SUB_TICKER": 15, "UNSUB_TICKER": 16, "SUB_QUOTE": 17, "UNSUB_QUOTE": 18,
       "SUB_FULL": 21, "UNSUB_FULL": 22, "DISCONNECT": 12}


def _f(b: bytes) -> float:
    try:
        return struct.unpack("<f", b)[0]
    except Exception:
        return 0.0


def _i(b: bytes) -> int:
    try:
        return struct.unpack("<I", b)[0]
    except Exception:
        return 0


class DhanStream:
    name = "dhan-feed"

    def __init__(self, on_tick, adapter):
        self.on_tick = on_tick
        self.adapter = adapter
        self.subscribed: dict[str, dict] = {}   # "SEG_SID" -> {"ExchangeSegment","SecurityId"}
        self._ws = None
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.connected = False

    # ------------------------------------------------------------------ control
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

    async def subscribe(self, instruments: list[dict]) -> None:
        for inst in instruments:
            self.subscribed[f"{inst['ExchangeSegment']}_{inst['SecurityId']}"] = inst
        await self._send_sub(REQ["SUB_FULL"], list(instruments))

    async def unsubscribe(self, instruments: list[dict]) -> None:
        for inst in instruments:
            self.subscribed.pop(f"{inst['ExchangeSegment']}_{inst['SecurityId']}", None)
        await self._send_sub(REQ["UNSUB_FULL"], list(instruments))

    async def _send_sub(self, code: int, batch: list[dict]) -> None:
        if not self._ws or not batch:
            return
        try:
            msg = {"RequestCode": code, "InstrumentCount": len(batch), "InstrumentList": batch}
            await self._ws.send(json.dumps(msg))
            config.log("dhan-feed", f"RequestCode={code} n={len(batch)} sent")
        except Exception as e:
            config.log("dhan-feed", f"send error: {e}", "ERROR")

    # ------------------------------------------------------------------ connection
    async def _run(self) -> None:
        s = self.adapter.session
        token = s.get("access_token", "")
        client_id = s.get("client_id", "")
        if not token or not client_id:
            config.log("dhan-feed", "missing access_token/client_id — feed not started", "ERROR")
            return
        url = (f"wss://api-feed.dhan.co?version=2&token={token}"
               f"&clientId={client_id}&authType=2")
        backoff = 2
        while self._running:
            try:
                async with websockets.connect(url, ping_interval=10, max_size=2**22) as ws:
                    self._ws = ws
                    self.connected = True
                    backoff = 2
                    config.log("dhan-feed", "connected to api-feed.dhan.co")
                    if self.subscribed:
                        await self._send_sub(REQ["SUB_FULL"], list(self.subscribed.values()))
                    async for raw in ws:
                        if not self._running:
                            break
                        if isinstance(raw, (bytes, bytearray)):
                            self._parse(bytes(raw))
            except Exception as e:
                self.connected = False
                config.log("dhan-feed", f"connection lost: {e} — retry in {backoff}s", "WARN")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)
        self.connected = False

    # ------------------------------------------------------------------ binary parse
    def _parse(self, data: bytes) -> None:
        if len(data) < 8:
            return
        code = data[0]
        if code == 0:            # heartbeat/ack
            return
        if code == 50:           # disconnect notice
            config.log("dhan-feed", "broker sent DISCONNECT packet", "WARN")
            return
        seg = data[3]
        sid = str(_i(data[4:8]))
        payload = data[8:]
        try:
            if code == 2 and len(payload) >= 8:          # TICKER: ltp f32, ltt u32
                ltp, ltt = _f(payload[0:4]), _i(payload[4:8])
                self._emit(sid, seg, {"ltp": ltp, "ts": ltt * 1000})
            elif code == 4 and len(payload) >= 30:       # QUOTE
                ltp, ltq, ltt = _f(payload[0:4]), struct.unpack("<H", payload[4:6])[0], _i(payload[6:10])
                atp, vol = _f(payload[10:14]), _i(payload[14:18])
                o, h, l = _f(payload[26:30]), 0.0, 0.0
                c = _f(payload[30:34]) if len(payload) >= 34 else ltp
                self._emit(sid, seg, {"ltp": ltp, "vol": vol, "open": o, "high": h,
                                      "low": l, "close": c, "ts": ltt * 1000})
            elif code == 8 and len(payload) >= 34:       # FULL
                ltp, ltq, ltt = _f(payload[0:4]), struct.unpack("<H", payload[4:6])[0], _i(payload[6:10])
                vol = _i(payload[14:18])
                bid_q, bid_p = _i(payload[18:22]), _f(payload[22:26])
                ask_q, ask_p = _i(payload[26:30]), _f(payload[30:34])
                o = _f(payload[34:38]) if len(payload) >= 38 else 0.0
                h = _f(payload[38:42]) if len(payload) >= 42 else 0.0
                l = _f(payload[42:46]) if len(payload) >= 46 else 0.0
                c = _f(payload[46:50]) if len(payload) >= 50 else 0.0
                self._emit(sid, seg, {"ltp": ltp, "vol": vol, "bid": bid_p or None,
                                      "ask": ask_p or None, "bid_qty": bid_q, "ask_qty": ask_q,
                                      "open": o, "high": h, "low": l, "close": c,
                                      "ts": ltt * 1000})
            elif code == 6 and len(payload) >= 4:        # PREV_CLOSE
                self._emit(sid, seg, {"prev_close": _f(payload[0:4])}, merge=True)
        except Exception as e:
            config.log("dhan-feed", f"binary parse error: {e}", "ERROR")

    def _emit(self, sid: str, seg: int, fields: dict, merge: bool = False) -> None:
        key = self._seg_code_to_name(seg)
        inst = self.subscribed.get(f"{key}_{sid}") or self.subscribed.get(f"NSE_EQ_{sid}")
        if not inst:
            return
        tick = {
            "symbol": inst.get("unified", ""), "token": sid,
            "source": "dhan",
            "ts": fields.get("ts") or int(time.time() * 1000),
        }
        tick.update({k: v for k, v in fields.items() if v is not None})
        if tick.get("symbol"):
            self.on_tick(tick)

    @staticmethod
    def _seg_code_to_name(code: int) -> str:
        return {0: "NSE_EQ", 1: "NSE_FNO", 2: "BSE_EQ", 3: "BSE_FNO",
                5: "NSE_CURRENCY", 7: "BSE_CURRENCY", 8: "MCX_COMM",
                9: "MCX_FOOD", 11: "IDX_I"}.get(code, "NSE_EQ")
