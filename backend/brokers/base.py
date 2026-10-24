"""
BaseBroker — OpenAlgo-style broker adapter contract.

Every broker lives in `backend/brokers/<name>/` and provides:
    broker.py     BrokerAdapter(BaseBroker)  — auth, orders, funds, positions, master sync
    streaming.py  StreamClient               — broker WS feed -> unified ticks
    mapping.py    pure functions: unified symbol <-> broker native token/code

Adding a NEW broker (the whole point of the mapping/registry design):
  1. mkdir backend/brokers/<name>/ with the 3 modules above
  2. add one line to REGISTRY in registry.py
  3. add its DB path to config.BROKER_DBS and a .env.sample credential block
Nothing else changes — routing, hub, UI, and DB isolation are generic.
"""
from __future__ import annotations

import time
from typing import Any, Callable, Optional

import httpx

from backend import config


class BrokerError(Exception):
    pass


class BaseBroker:
    """Abstract adapter. All methods return plain JSON-safe dicts."""

    name: str = "base"

    def __init__(self, account: dict, credentials: dict):
        self.account = account
        self.account_id = account["id"]
        self.credentials = credentials
        self.session: dict = {}          # live session info (token, meta) — persisted in DB
        self.connected = False
        self._http = httpx.AsyncClient(timeout=15.0)
        # 401/503 backoff state (Round-13 fix: never hammer the broker)
        self._fail_streak = 0
        self._backoff_until = 0.0

    # ------------------------------------------------------------------ utils
    def log(self, msg: str, level: str = "INFO") -> None:
        config.log(self.name, msg, level)

    async def _request(self, method: str, url: str, *, headers: Optional[dict] = None,
                       params: Optional[dict] = None, json_body: Optional[dict] = None,
                       data: Any = None, tag: str = "req") -> dict:
        """
        Shared HTTP with structured logging + exponential backoff.
        Breeze wraps auth errors as HTTP 401 body {"Status":500,"Error":"Unauthorized User"};
        a failure streak trips a backoff so the feed loop stops spamming (Round-13).
        """
        if time.time() < self._backoff_until:
            raise BrokerError(f"{tag}: backing off {self._backoff_until - time.time():.1f}s after repeated errors")
        t0 = time.perf_counter()
        status = 0
        body: Any = None
        try:
            resp = await self._http.request(method, url, headers=headers, params=params,
                                            json=json_body, data=data)
            status = resp.status_code
            try:
                body = resp.json()
            except Exception:
                body = {"_raw": resp.text[:400], "_non_json": True}
            dur = int((time.perf_counter() - t0) * 1000)
            config.log(self.name, f"{tag} {method} {url} -> {status} ({dur}ms)")
            if status == 401 or (isinstance(body, dict) and str(body.get("Error", "")).lower().find("unauthorized") >= 0):
                self._fail_streak += 1
                self._trip_backoff()
                raise BrokerError(f"{tag}: unauthorized (streak={self._fail_streak})")
            if status >= 400:
                self._fail_streak += 1
                self._trip_backoff()
                raise BrokerError(f"{tag}: HTTP {status} {str(body)[:180]}")
            self._fail_streak = 0
            return body if isinstance(body, dict) else {"data": body}
        except httpx.HTTPError as e:
            self._fail_streak += 1
            self._trip_backoff()
            config.log(self.name, f"{tag} {url} transport error: {e}", "ERROR")
            raise BrokerError(f"{tag}: {e}")

    def _trip_backoff(self) -> None:
        delay = min(2 ** min(self._fail_streak, 6), 60)  # 2s .. 60s
        self._backoff_until = time.time() + delay
        config.log(self.name, f"error streak={self._fail_streak} -> backoff {delay}s", "WARN")

    # ------------------------------------------------------------------ lifecycle
    async def authenticate(self) -> dict:
        """Ensure self.session holds a valid session; persist via session_store.
        MUST reuse a stored valid session (session_store.get) before generating new."""
        raise NotImplementedError

    async def validate_session(self) -> bool:
        """Cheap call verifying current self.session still works (funds/limits)."""
        raise NotImplementedError

    async def disconnect(self) -> None:
        self.connected = False

    # ------------------------------------------------------------------ data (REST, tool interactions)
    async def get_funds(self) -> dict:
        raise NotImplementedError

    async def get_positions(self) -> list[dict]:
        return []

    async def get_holdings(self) -> list[dict]:
        return []

    async def get_orderbook(self) -> list[dict]:
        return []

    async def place_order(self, symbol: str, side: str, qty: int, order_type: str = "MARKET",
                          price: Optional[float] = None, product: str = "MIS",
                          trigger_price: Optional[float] = None) -> dict:
        raise NotImplementedError

    async def cancel_order(self, broker_order_id: str, symbol: str = "") -> dict:
        raise NotImplementedError

    async def get_history(self, symbol: str, tf_minutes: int, days: int) -> list[dict]:
        """Broker-native historical candles; [] when unsupported (hub falls back)."""
        return []

    # ------------------------------------------------------------------ master contracts
    async def sync_master(self) -> dict:
        """Pull LIVE broker master contracts; REPLACE rows (never append).
        Returns {source_url, source_kind, symbols, mappings}."""
        raise NotImplementedError

    # ------------------------------------------------------------------ streaming
    def make_stream(self, on_tick: Callable[[dict], None]) -> Any:
        """Return a StreamClient instance bound to on_tick (see streaming.py per broker)."""
        raise NotImplementedError


def normalize_symbol(exchange: str, symbol: str) -> str:
    return f"{exchange.upper()}:{symbol.upper()}"


def split_symbol(symbol: str) -> tuple[str, str]:
    if ":" in symbol:
        exch, sym = symbol.split(":", 1)
        return exch.upper(), sym.upper()
    return "NSE", symbol.upper()
