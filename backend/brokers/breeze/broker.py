"""
Breeze (ICICI Direct) REST adapter — wire shapes per the OFFICIAL breeze-connect
SDK (Idirect-Tech/Breeze-Python-SDK, api_util + generate_headers + make_request).

Auth flow (Round-25 — matches the SDK exactly):
  1. TOTP login on ICICI portal (apiuser/login?api_key=...) yields an api
     `session_token` ("apisession") the user pastes.
  2. GET {API_URL}customerdetails with a JSON REQUEST BODY
         {"SessionToken": <apisession>, "AppKey": <api_key>}
     and ONLY Content-Type in the headers (no checksum headers on this call).
     Sending them as HEADERS is what produced Breeze's
     `customerdetails failed: {'Status': 500, 'Error': 'Request Object is Null'}`
     — the server reads the request OBJECT (body), not headers.
     -> Success.session_token = base64("user_id:session_key") -> split.
  3. Every subsequent call:
       GETs CARRY A JSON BODY TOO ("{}" or the params object, compact
       separators, sent like the SDK's requests.get(url, data=body)) and
       headers X-AppKey, X-SessionToken (base64 above), X-Timestamp (utc .000Z),
       X-Checksum = "token " + sha256(timestamp + body + api_secret).
Sessions are persisted in DB and REUSED (Round-14): generate once, reuse until
it stops validating — regenerating on every connect caused the 401 storms.
"""
from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone

from backend import config, db, session_store
from backend.brokers.base import BaseBroker, BrokerError
from backend.brokers.breeze import mapping as bm

API_URL = "https://api.icicidirect.com/breezeapi/api/v1/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_5_8) AppleWebKit/534.50.2 "
      "(KHTML, like Gecko) Version/5.0.6 Safari/533.22.3")


class BreezeAdapter(BaseBroker):
    name = "breeze"

    # ------------------------------------------------------------------ session
    def _mk_headers(self, body: str = "") -> dict:
        ts = datetime.now(timezone.utc).isoformat()[:19] + ".000Z"
        secret = self.credentials.get("api_secret", "")
        checksum = hashlib.sha256((ts + body + secret).encode("utf-8")).hexdigest()
        h = {
            "Content-Type": "application/json",
            "X-Checksum": "token " + checksum,
            "X-Timestamp": ts,
            "X-AppKey": self.credentials.get("api_key", ""),
            "User-Agent": UA,
        }
        if self.session.get("b64_session"):
            h["X-SessionToken"] = self.session["b64_session"]
            h["Authorization"] = f"Bearer {self.session.get('session_token', '')}"
        return h

    async def authenticate(self) -> dict:
        stored = session_store.get(self.account_id)
        if stored and stored.get("session_token"):
            meta = session_store.meta_of(stored)
            self.session = {
                "session_token": stored["session_token"],
                "user_id": meta.get("user_id", ""),
                "b64_session": meta.get("b64_session", ""),
            }
            if await self.validate_session():
                session_store.mark_validated(self.account_id)
                self.connected = True
                self.log("reused persisted Breeze session (no re-login on refresh)")
                return self.session
            self.log("stored Breeze session invalid — regenerating once", "WARN")

        tok = self.credentials.get("session_token", "").strip()
        if not tok:
            raise BrokerError("Breeze session_token missing — complete TOTP login on ICICI portal first")
        # SDK api_util: SessionToken + AppKey travel in the JSON BODY of the GET
        # (requests.get(url, data=body)) — NOT in headers.  Headers carry only
        # Content-Type.  Anything else -> "Request Object is Null".
        body = json.dumps({"SessionToken": tok, "AppKey": self.credentials.get("api_key", "")},
                          separators=(",", ":"))
        r = await self._request(
            "GET", f"{API_URL}customerdetails",
            headers={"Content-Type": "application/json", "User-Agent": UA},
            data=body, tag="customerdetails")
        b64 = (r.get("Success") or {}).get("session_token", "")
        if not b64:
            err = str(r.get("Error") or r)[:160]
            hint = ""
            if "Public Key" in err:
                hint = " — the App Key is wrong (save the exact key from the Breeze API portal)"
            elif "Invalid session" in err:
                hint = " — the apisession is wrong or expired; log in again for a fresh one"
            elif "Resource not available" in err:
                hint = " — the apisession expired; log in again for a fresh one"
            raise BrokerError(f"Breeze rejected the apisession: {err}{hint}")
        user_id = base64.b64decode(b64.encode()).decode().split(":")[0]
        self.session = {"session_token": tok, "user_id": user_id, "b64_session": b64}
        session_store.save(self.account_id, self.name, tok, None,
                           {"user_id": user_id, "b64_session": b64})
        self.connected = True
        self.log(f"fresh Breeze session generated + persisted (user={user_id})")
        return self.session

    async def validate_session(self) -> bool:
        try:
            await self.get_funds()
            return True
        except Exception as e:
            self.log(f"session validation failed: {e}", "WARN")
            return False

    # ------------------------------------------------------------------ funds / portfolio
    async def get_funds(self) -> dict:
        r = await self._request("GET", f"{API_URL}funds", headers=self._mk_headers("{}"),
                                data="{}", tag="funds")
        # Round-26 (hedging-verified): Breeze returns Success[0] with the
        # allocated/unallocated/block split — there is no 'net' field (the old
        # parse always produced ₹0).
        suc = r.get("Success")
        rows = suc if isinstance(suc, list) else ([suc] if isinstance(suc, dict) else [])
        s = rows[0] if rows else {}

        def _n(k):
            try:
                return float(s.get(k) or 0)
            except (TypeError, ValueError):
                return 0.0

        if s:
            avail = max(0.0, _n("allocated_equity") + _n("unallocated_balance")
                        + _n("total_bank_balance") - _n("block_by_trade_balance"))
            used = abs(_n("allocated_fno") + _n("allocated_commodity")
                       + _n("block_by_trade_balance"))
        else:   # legacy shape fallback
            avail = float((s.get("net") if isinstance(s, dict) else 0) or 0)
            used = abs(float((s.get("utilised_debits") if isinstance(s, dict) else 0) or 0))
        return {"available": round(avail, 2), "used": round(used, 2),
                "total": round(avail + used, 2), "raw": s, "source": "breeze-live"}

    async def get_positions(self) -> list[dict]:
        r = await self._request("GET", f"{API_URL}portfoliopositions",
                                headers=self._mk_headers("{}"), data="{}", tag="positions")
        out = []
        for p in (r.get("Success") or []):
            try:
                out.append({"symbol": f"{(p.get('exchange_code') or 'NFO').upper()}:{p.get('stock_code', '')}",
                            "qty": float(p.get("quantity") or 0), "avg_price": float(p.get("average_price") or 0),
                            "ltp": float(p.get("ltp") or 0), "pnl": float(p.get("pnl") or 0),
                            "product": "NRML"})
            except Exception:
                continue
        return out

    async def get_orderbook(self) -> list[dict]:
        r = await self._request("GET", f"{API_URL}order", headers=self._mk_headers("{}"),
                                data="{}", tag="orderbook")
        return (r.get("Success") or [])

    # ------------------------------------------------------------------ orders
    async def place_order(self, symbol, side, qty, order_type="MARKET", price=None,
                          product="MIS", trigger_price=None) -> dict:
        exch, sym = self._split(symbol)
        body: dict = {
            "dv": "Draft", "ordertype": (order_type or "market").lower(),
            "producttype": "options" if exch == "NFO" else "cash",
            "qty": str(qty), "action": side.lower(), "exchange_code": exch.lower(),
            "stock_code": sym, "validity": "day", "remark": "terminal",
        }
        if exch == "NFO":
            c = bm.parse_contract_symbol(symbol)
            if c:
                body.update({
                    "expiry_date": bm.expiry_to_breeze(c["expiry"]),
                    "right": "call" if c["right"] == "CE" else "put",
                    "strike_price": str(int(c["strike"])) if c["strike"] == int(c["strike"]) else str(c["strike"]),
                })
                body["producttype"] = "options"
        if price is not None and order_type.lower() != "market":
            body["price"] = str(price)
        body_json = json.dumps(body, separators=(",", ":"))
        r = await self._request("POST", f"{API_URL}order", headers=self._mk_headers(body_json),
                                data=body_json, tag="place-order")
        oid = (r.get("Success") or {}).get("order_id", "")
        return {"order_id": oid, "status": "open", "raw": r}

    async def cancel_order(self, broker_order_id, symbol="") -> dict:
        exch, _ = self._split(symbol)
        body = json.dumps({"exchange_code": exch, "order_id": broker_order_id},
                          separators=(",", ":"))
        r = await self._request("DELETE", f"{API_URL}order", headers=self._mk_headers(body),
                                data=body, tag="cancel-order")
        return {"order_id": broker_order_id, "status": "cancelled", "raw": r}

    def _split(self, symbol: str) -> tuple[str, str]:
        exch, sym = symbol.split(":", 1) if ":" in symbol else ("NSE", symbol)
        return exch.upper(), sym.upper()

    # ------------------------------------------------------------------ history
    async def get_history(self, symbol: str, tf_minutes: int, days: int) -> list[dict]:
        # wire interval values per the SDK (it maps "1minute"->"minute" before sending)
        iv = {1: "minute", 5: "5minute", 15: "30minute", 30: "30minute"}.get(tf_minutes, "minute")
        exch, sym = self._split(symbol)
        params: dict = {"interval": iv,
                        "from_date": datetime.fromtimestamp(__import__("time").time() - days * 86400)
                        .strftime("%Y-%m-%dT06:00:00.000Z"),
                        "to_date": datetime.now().strftime("%Y-%m-%dT10:00:00.000Z"),
                        "stock_code": sym, "exchange_code": exch.lower()}
        if exch == "NFO":
            c = bm.parse_contract_symbol(symbol)
            if not c:
                return []
            params.update({"product_type": "options",
                           "expiry_date": bm.expiry_to_breeze(c["expiry"]),
                           "right": "call" if c["right"] == "CE" else "put",
                           "strike_price": str(int(c["strike"]))})
        body = json.dumps(params, separators=(",", ":"))
        # SDK sends the params as the GET request BODY (requests.get(url, data=body)),
        # checksum computed over that body — NOT as query params.
        r = await self._request("GET", f"{API_URL}historicalcharts",
                                headers=self._mk_headers(body), data=body, tag="history")
        candles = (r.get("Success") or {}).get("candles") or []
        out = []
        for row in candles:
            try:
                ts = datetime.fromisoformat(row[0].replace("Z", "+00:00")).timestamp()
                out.append({"t": int(ts), "o": float(row[1]), "h": float(row[2]),
                            "l": float(row[3]), "c": float(row[4]), "v": float(row[5] or 0)})
            except Exception:
                continue
        return out

    # ------------------------------------------------------------------ master (live sources, REPLACE)
    async def sync_master(self) -> dict:
        import httpx
        bdb = db.broker_db("breeze")
        source = bm.STOCK_SCRIPT_URL
        kind = "live-broker"
        rows: list[dict] = []
        detail = []
        try:
            async with httpx.AsyncClient(timeout=90.0, follow_redirects=True) as cx:
                resp = await cx.get(bm.STOCK_SCRIPT_URL)
                resp.raise_for_status()
                rows = bm.parse_stock_script_csv(resp.content)
                detail.append(f"equities CSV: {len(rows)} rows")
                config.log("breeze", f"master: fetched StockScriptNew.csv -> {len(rows)} equities")
        except Exception as e:
            detail.append(f"equities CSV failed: {e}")
            config.log("breeze", f"master equities CSV failed: {e}", "ERROR")
        # F&O tokens from live SecurityMaster.zip (large — bounded attempt)
        try:
            async with httpx.AsyncClient(timeout=240.0, follow_redirects=True) as cx:
                resp = await cx.get(bm.SECURITY_MASTER_URL)
                resp.raise_for_status()
                fo = bm.parse_security_master_zip(
                    resp.content, {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"})
                rows.extend(fo)
                detail.append(f"F&O (SecurityMaster.zip FONSE): {len(fo)} rows")
                config.log("breeze", f"master: SecurityMaster.zip -> +{len(fo)} F&O contracts")
        except Exception as e:
            detail.append(f"SecurityMaster.zip unavailable: {e}")
            config.log("breeze", f"master SecurityMaster.zip skipped: {e}", "WARN")
        # REPLACE (never append — fixes duplicated mappings growth)
        bdb.exec("DELETE FROM master")
        bdb.executemany(
            "INSERT OR REPLACE INTO master(token,symbol,name,exchange,instrument,expiry,strike,right,lotsize) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [(r["token"], r["symbol"], r.get("name"), r["exchange"], r["instrument"],
              r.get("expiry"), r.get("strike"), r.get("right", ""), r.get("lotsize", 1)) for r in rows])
        bdb.exec("INSERT INTO sync_log(broker,source_url,source_kind,symbols,mappings,replaced,detail,ts)"
                 " VALUES(?,?,?,?,?,1,?,?)",
                 (self.name, source, kind, len(rows), len(rows), "; ".join(detail),
                  config.now() if hasattr(config, "now") else __import__("time").time()))
        return {"source_url": source, "source_kind": kind, "symbols": len(rows),
                "mappings": len(rows), "replaced": True, "detail": "; ".join(detail)}

    # ------------------------------------------------------------------ streaming
    def make_stream(self, on_tick):
        from backend.brokers.breeze.streaming import BreezeStream
        return BreezeStream(on_tick, self)
