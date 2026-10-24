"""Round-27 — OpenAlgo adapter for all 37 vendored broker plugins.

One OAAdapter(BaseBroker) class parameterized by the plugin key
("oa-<name>" accounts; the plugin name is the suffix). Every method runs the
blocking plugin call inside asyncio.to_thread wrapped in oa_ctx (env + masters
DB + token_db pin), serialized per broker.

Session contract: self.session = {"token": <auth token>, "meta": {...}}.
authenticate() reuses the persisted session; OA auth FLOWS (paste-a-code,
env-driven) run through oa_context.call_authenticate from admin_api — same
shape as our native brokers.
"""
from __future__ import annotations

import asyncio
import importlib
import time
from typing import Any, Optional

from backend.brokers.base import BaseBroker, BrokerError
from backend.brokers.oa import oa_mapping
from backend.brokers.oa.oa_context import broker_lock, oa_ctx


def oa_key(account_broker: str) -> str:
    if not account_broker.startswith("oa-"):
        raise BrokerError(f"not an openalgo broker: {account_broker}")
    return account_broker[3:]


class OAAdapter(BaseBroker):
    name = "openalgo"

    def __init__(self, account: dict, credentials: dict, plugin: str):
        super().__init__(account, credentials)
        self.plugin = plugin                      # e.g. "zerodha"
        self.name = f"oa-{plugin}"
        self._req_seq = 0

    # ------------------------------------------------------------------ helpers
    @property
    def _token(self) -> str:
        return str((self.session or {}).get("token") or "")

    def _uid(self) -> str:
        return f"oa{self.account_id}"

    async def _run(self, fn, *args, lock: bool = True, **kwargs):
        """Run a blocking plugin call on a worker thread inside oa_ctx."""
        def _job():
            if lock:
                with broker_lock(self.plugin):
                    with oa_ctx(self.plugin, self.credentials, account_id=self.account_id):
                        return fn(*args, **kwargs)
            with oa_ctx(self.plugin, self.credentials, account_id=self.account_id):
                return fn(*args, **kwargs)
        return await asyncio.to_thread(_job)

    def _plugin(self, module: str):
        try:
            return importlib.import_module(f"broker.{self.plugin}.{module}")
        except Exception as e:
            raise BrokerError(f"{self.name}: plugin module '{module}' unavailable — {e}") from e

    # ------------------------------------------------------------------ lifecycle
    async def authenticate(self) -> dict:
        stored = (self.session or {}).get("token")
        if not stored:
            raise BrokerError(
                f"{self.name}: no session — open Admin → Session for this account and "
                "complete the broker login (credentials + auth code), then Connect")
        ok = await self.validate_session()
        if not ok:
            raise BrokerError(f"{self.name}: stored session rejected by the broker — re-authenticate in Admin → Session")
        self.connected = True
        return {"ok": True, "persisted": True}

    async def validate_session(self) -> bool:
        try:
            funds = await self.get_funds()
            return bool(funds) and funds.get("available") is not None
        except Exception:
            return False

    async def disconnect(self) -> None:
        self.connected = False

    # ------------------------------------------------------------------ funds / books
    async def get_funds(self) -> dict:
        def _funds():
            mod = self._plugin("api.funds")
            data = mod.get_margin_data(self._token)
            return data or {}
        data = await self._run(_funds)
        if not isinstance(data, dict) or not data:
            raise BrokerError(f"{self.name}: funds unavailable (empty response — check session/master sync)")

        def _g(*keys, default=0.0):
            for k in keys:
                try:
                    v = data.get(k)
                    if v not in (None, ""):
                        return float(v)
                except (TypeError, ValueError):
                    continue
            return default
        avail = _g("availablecash", "available_cash", "availablemargin", "available_margin", "available_balance")
        used = _g("marginused", "margin_used", "utiliseddebits", "utilised_debits", "utilised_amount")
        m2m = _g("m2m", "m2m_realized", "day_m2m", default=0.0)
        return {"available": round(avail, 2), "used": round(used, 2),
                "total": round(avail + used, 2), "m2m": round(m2m, 2),
                "raw": data, "source": f"openalgo:{self.plugin}"}

    async def get_positions(self) -> list[dict]:
        def _pos():
            mod = self._plugin("api.order_api")
            if not hasattr(mod, "get_positions"):
                return []
            data = mod.get_positions(self._token)
            return data if isinstance(data, list) else []
        return await self._run(_pos)

    async def get_orderbook(self) -> list[dict]:
        def _book():
            mod = self._plugin("api.order_api")
            if not hasattr(mod, "get_order_book"):
                return []
            data = mod.get_order_book(self._token)
            return data if isinstance(data, list) else []
        return await self._run(_book)

    async def get_holdings(self) -> list[dict]:
        def _hold():
            mod = self._plugin("api.order_api")
            if not hasattr(mod, "get_holdings"):
                return []
            data = mod.get_holdings(self._token)
            return data if isinstance(data, list) else []
        return await self._run(_hold)

    # ------------------------------------------------------------------ orders
    async def place_order(self, symbol: str, side: str, qty: int, order_type: str = "MARKET",
                          price: Optional[float] = None, product: str = "MIS",
                          trigger_price: Optional[float] = None) -> dict:
        if not self._token:
            raise BrokerError(f"{self.name}: no session — connect the account first")

        def _place():
            exch, _, sym = symbol.partition(":")
            sym = sym or symbol
            mod = self._plugin("api.order_api")
            tdb = importlib.import_module("database.token_db")
            oa_sym = tdb.get_oa_symbol(sym.upper(), exch.upper()) or sym.upper()
            pricetype = {"MARKET": "MARKET", "LIMIT": "LIMIT", "SL": "SL",
                         "SL-M": "SL-M", "SLM": "SL-M", "STOPLOSS": "SL"}.get(
                             (order_type or "MARKET").upper(), "MARKET")
            data = {
                "apikey": "quantdesk", "symbol": oa_sym, "exchange": exch.upper(),
                "action": (side or "BUY").upper(),
                "producttype": {"MIS": "MIS", "CNC": "CNC", "NRML": "NRML",
                                "MARGIN": "MARGIN", "CO": "CO", "BO": "BO"}.get(
                                    (product or "MIS").upper(), "MIS"),
                "quantity": int(qty), "pricetype": pricetype,
                "price": float(price or 0), "trigger_price": float(trigger_price or 0),
            }
            resp, orderid = mod.place_order_api(data, self._token)
            if orderid in (None, "", "null"):
                msg = ""
                if isinstance(resp, dict):
                    statem = resp.get("emsg") or resp.get("message") or resp.get("detail") or ""
                    msg = str(statem)[:220]
                    if resp.get("status") == "error" or msg:
                        raise BrokerError(f"{self.name}: order rejected — {msg or resp}")
                raise BrokerError(f"{self.name}: order rejected — empty order id")
            return {"order_id": str(orderid), "raw": resp}
        return await self._run(_place)

    async def cancel_order(self, broker_order_id: str, symbol: str = "") -> dict:
        def _cancel():
            mod = self._plugin("api.order_api")
            resp = mod.cancel_order(broker_order_id, self._token)
            if isinstance(resp, dict) and str(resp.get("status")).lower() == "error":
                raise BrokerError(f"{self.name}: cancel rejected — {str(resp.get('message') or resp)[:200]}")
            return {"ok": True, "raw": resp}
        return await self._run(_cancel)

    # ------------------------------------------------------------------ history
    _INTERVALS = ((1, "1m"), (3, "3m"), (5, "5m"), (10, "10m"), (15, "15m"),
                  (30, "30m"), (60, "1h"), (120, "1h"), (240, "1h"))

    async def get_history(self, symbol: str, tf_minutes: int, days: int = 3) -> list[dict]:
        if not self._token:
            return []

        def _hist():
            exch, _, sym = symbol.partition(":")
            sym = sym or symbol
            tdb = importlib.import_module("database.token_db")
            oa_sym = tdb.get_oa_symbol(sym.upper(), exch.upper()) or sym.upper()
            iv = "D" if tf_minutes >= 1440 else next(
                (v for k, v in self._INTERVALS if tf_minutes <= k), "5m")
            from datetime import datetime, timedelta

            end = datetime.utcnow().date()
            start = end - timedelta(days=max(1, days) + 1)
            mod = self._plugin("api.data")
            df = mod.get_history(oa_sym, exch.upper(), iv, start.strftime("%Y-%m-%d"),
                                 end.strftime("%Y-%m-%d"))
            if df is None or len(df) == 0:
                return []
            out = []
            for _, r in df.iterrows():
                ts = r.get("timestamp") or r.get("date") or r.get("time")
                try:
                    if hasattr(ts, "timestamp"):
                        t_ms = int(ts.timestamp() * 1000)
                    else:
                        s = str(ts)
                        t_ms = int(float(s) * 1000) if s.replace(".", "").isdigit() and float(s) > 1e9 \
                            else int(datetime.strptime(s[:19].replace("T", " "), "%Y-%m-%d %H:%M:%S").timestamp() * 1000)
                except Exception:
                    continue
                try:
                    out.append({"t": t_ms, "o": float(r.get("open") or 0), "h": float(r.get("high") or 0),
                                "l": float(r.get("low") or 0), "c": float(r.get("close") or 0),
                                "v": float(r.get("volume") or 0)})
                except (TypeError, ValueError):
                    continue
            return out
        try:
            return await self._run(_hist)
        except BrokerError:
            return []
        except Exception as e:
            self.log(f"history {symbol} failed: {e}", "WARN")
            return []

    # ------------------------------------------------------------------ master contracts
    async def sync_master(self) -> dict:
        def _sync():
            mod = importlib.import_module(
                f"broker.{self.plugin}.database.master_contract_db")
            # openalgo's app boots with init_db() — plugins assume the symtoken
            # table exists before master_contract_download() deletes/copies it
            init = getattr(mod, "init_db", None)
            if callable(init):
                init()
            fn = getattr(mod, "master_contract_download")
            msg = fn()
            return str(msg)[:200] if msg else "downloaded"
        msg = await self._run(_sync)
        token_db = importlib.import_module("database.token_db")

        def _inv():
            token_db.invalidate(self.plugin)
        await asyncio.to_thread(_inv)
        res = await asyncio.to_thread(oa_mapping.sync_to_master, self.plugin)
        self.log(f"masters synced via openalgo plugin — {res['symbols']} symbols "
                 f"({res['mappings']} mappings) [{msg}]")
        return {"source_url": f"openalgo:{self.plugin}", "source_kind": "live-broker",
                "symbols": res["symbols"], "mappings": res["mappings"], "replaced": True}

    # ------------------------------------------------------------------ streaming
    def make_stream(self, on_tick) -> Any:
        from backend.brokers.oa.oa_stream import OAStream
        return OAStream(on_tick, self)
