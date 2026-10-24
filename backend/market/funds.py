"""
FundsService — funds are ON-DEMAND + EVENT-DRIVEN, never timer-polled (Round-15).

Pushes happen when:
  1. the frontend asks (socket.io 'funds:get')            -> fetch+cache+push
  2. an order is placed/cancelled (REST hooks)            -> invalidate+push
  3. positions change (hub order fill / broker push)      -> invalidate+push
A small TTL cache (3s) dedupes bursts (order flood), while the funds chip in
the UI is updated within milliseconds of any trading activity.
"""
from __future__ import annotations

from typing import Optional
import asyncio
import json
import time

from backend import config, db


class FundsService:
    def __init__(self):
        self._cache: dict[int, tuple[float, dict]] = {}
        self._inflight: set[int] = set()
        self._push: Optional[callable] = None       # set by sio server: async fn(account_id, data)

    def set_pusher(self, push) -> None:
        self._push = push

    def _snapshot(self, account_id: int) -> Optional[dict]:
        row = db.core().one("SELECT data, updated_at FROM funds_snapshot WHERE account_id=?",
                            (account_id,))
        if not row:
            return None
        try:
            return {**json.loads(row["data"]), "ts": int(row["updated_at"] * 1000)}
        except Exception:
            return None

    def cached(self, account_id: int) -> Optional[dict]:
        entry = self._cache.get(account_id)
        if entry and time.time() - entry[0] < config.FUNDS_CACHE_TTL_S:
            return entry[1]
        return self._snapshot(account_id)

    async def push_funds(self, account_id: int, reason: str = "request") -> None:
        """Fetch from broker (or cache) and push to all connected clients."""
        cached = self.cached(account_id)
        if cached and reason in ("request", "event"):
            if self._push and reason == "request":
                await self._push(account_id, cached)
            if reason == "event" and time.time() - (cached.get("ts", 0) / 1000) < 2:
                if self._push:
                    await self._push(account_id, cached)
                return
        if account_id in self._inflight:
            return
        self._inflight.add(account_id)
        try:
            data = await self._fetch(account_id)
            if data:
                self._cache[account_id] = (time.time(), data)
                db.core().exec(
                    "INSERT INTO funds_snapshot(account_id,data,updated_at) VALUES(?,?,?) "
                    "ON CONFLICT(account_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
                    (account_id, json.dumps(data), time.time()))
                if self._push:
                    await self._push(account_id, data)
        except Exception as e:
            config.log("funds", f"push failed account#{account_id}: {e}", "WARN")
            if self._push:
                await self._push(account_id, {"error": str(e)[:120]})
        finally:
            self._inflight.discard(account_id)

    async def _fetch(self, account_id: int) -> Optional[dict]:
        from backend.market.hub import Hub
        hub = Hub.instance()
        adapter = hub.account_adapter(account_id) if hub else None
        if not adapter or not adapter.connected:
            return None
        data = await adapter.get_funds()
        data["account_id"] = account_id
        data["ts"] = int(time.time() * 1000)
        return data

    def invalidate(self, account_id: int) -> None:
        self._cache.pop(account_id, None)


SVC = FundsService()
