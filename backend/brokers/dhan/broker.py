"""
Dhan adapter — REST v2 (https://api.dhan.co/v2) + authentic consent auth.

Auth paths (both supported, matching Round-10/12 requests):
  A. Direct: user pastes access_token from web.dhan.co (My Profile -> DhanHQ APIs).
  B. apikey+apisecret (OpenAlgo-style): client_id + api_key + api_secret ->
     POST {AUTH}/app/generate-consent?client_id=...  -> consentAppId
     -> user completes browser login -> paste tokenId
     -> POST {AUTH}/app/consumeApp-consent?tokenId=... -> accessToken (persisted).

All sessions persisted in DB and reused across refreshes/restarts (Round-14).
"""
from __future__ import annotations

from typing import Optional
import time

import httpx

from backend import config, db, session_store
from backend.brokers.base import BaseBroker, BrokerError
from backend.brokers.dhan import mapping as dm

REST = "https://api.dhan.co/v2"
AUTH = "https://auth.dhan.co"


class DhanAdapter(BaseBroker):
    name = "dhan"

    def _headers(self) -> dict:
        return {
            "access-token": self.session.get("access_token", ""),
            "client-id": self.session.get("client_id", ""),
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    # ------------------------------------------------------------------ session
    async def authenticate(self) -> dict:
        stored = session_store.get(self.account_id)
        if stored and stored.get("session_token"):
            meta = session_store.meta_of(stored)
            self.session = {"access_token": stored["session_token"],
                            "client_id": meta.get("client_id", self.credentials.get("client_id", ""))}
            if await self.validate_session():
                session_store.mark_validated(self.account_id)
                self.connected = True
                self.log("reused persisted Dhan access_token")
                return self.session
            self.log("stored Dhan token invalid — will re-auth", "WARN")
        token = self.credentials.get("access_token", "").strip()
        if not token:
            raise BrokerError(
                "Dhan access_token missing. Paste it from web.dhan.co, or run the "
                "consent flow (api_key + api_secret + client_id) and paste the tokenId.")
        self.session = {"access_token": token, "client_id": self.credentials.get("client_id", "")}
        session_store.save(self.account_id, self.name, token, None,
                           {"client_id": self.credentials.get("client_id", "")})
        if not await self.validate_session():
            raise BrokerError("Dhan rejected the access_token (funds check failed)")
        self.connected = True
        self.log("Dhan session created + persisted")
        return self.session

    async def generate_consent(self) -> dict:
        """Step 1 of apikey+apisecret flow; returns consentAppId + browser login URL."""
        api_key = self.credentials.get("api_key", "")
        api_secret = self.credentials.get("api_secret", "")
        client_id = self.credentials.get("client_id", "")
        if ":::" in api_key:  # OpenAlgo combined format client_id:::api_key
            client_id, api_key = api_key.split(":::", 1)
        async with httpx.AsyncClient(timeout=30) as cx:
            r = await cx.post(f"{AUTH}/app/generate-consent?client_id={client_id}",
                              headers={"app_id": api_key, "app_secret": api_secret})
            data = r.json() if r.status_code == 200 else {}
            if data.get("status") != "success" or not data.get("consentAppId"):
                raise BrokerError(f"consent failed: HTTP {r.status_code} {str(data)[:200]}")
            consent_id = data["consentAppId"]
        config.log("dhan", f"consent generated {consent_id[:12]}... — open login URL")
        return {"consentAppId": consent_id,
                "login_url": f"{AUTH}/login/consentApp-login?consentAppId={consent_id}"}

    async def consume_consent(self, token_id: str) -> dict:
        api_key = self.credentials.get("api_key", "")
        api_secret = self.credentials.get("api_secret", "")
        client_id = self.credentials.get("client_id", "")
        async with httpx.AsyncClient(timeout=30) as cx:
            r = await cx.post(f"{AUTH}/app/consumeApp-consent?tokenId={token_id}",
                              headers={"app_id": api_key, "app_secret": api_secret,
                                       "Content-Type": "application/json"})
            data = r.json() if r.status_code == 200 else {}
            access = data.get("accessToken", "")
            if not access:
                raise BrokerError(f"consume consent failed: HTTP {r.status_code} {str(data)[:200]}")
        self.session = {"access_token": access, "client_id": client_id}
        session_store.save(self.account_id, self.name, access, None, {"client_id": client_id})
        self.connected = True
        config.log("dhan", "access_token obtained via consent flow + persisted")
        return {"status": "connected", "client_id": client_id}

    async def validate_session(self) -> bool:
        try:
            await self.get_funds()
            return True
        except Exception as e:
            self.log(f"validate failed: {e}", "WARN")
            return False

    # ------------------------------------------------------------------ data
    async def get_funds(self) -> dict:
        r = await self._request("GET", f"{REST}/fundlimit", headers=self._headers(), tag="funds")
        avail = float(r.get("availableBalance") or 0)
        used = float(r.get("utilizedAmount") or 0)
        return {"available": round(avail, 2), "used": round(used, 2),
                "total": round(avail + used, 2), "raw": r, "source": "dhan-live"}

    async def get_positions(self) -> list[dict]:
        r = await self._request("GET", f"{REST}/positions", headers=self._headers(), tag="positions")
        out = []
        for p in (r.get("data") if isinstance(r.get("data"), list) else []):
            out.append({"symbol": str(p.get("tradingSymbol", "")),
                        "qty": float(p.get("netQty") or 0),
                        "avg_price": float(p.get("averageTradedPrice") or 0),
                        "ltp": float(p.get("lastPrice") or 0),
                        "pnl": float(p.get("unrealizedProfit") or 0),
                        "product": str(p.get("productType", "MIS"))})
        return out

    async def get_orderbook(self) -> list[dict]:
        r = await self._request("GET", f"{REST}/orders", headers=self._headers(), tag="orders")
        return r.get("data") if isinstance(r.get("data"), list) else []

    # ------------------------------------------------------------------ orders
    async def place_order(self, symbol, side, qty, order_type="MARKET", price=None,
                          product="MIS", trigger_price=None) -> dict:
        m = self._resolve(symbol)
        if not m:
            raise BrokerError(f"symbol {symbol} not in Dhan master — run master sync")
        payload = {
            "dhanClientId": self.session.get("client_id", ""),
            "transactionType": side.upper(),
            "exchangeSegment": m["exchangeSegment"],
            "productType": "MIS" if product in ("MIS", "CNC") else product,
            "orderType": "MARKET" if order_type.upper() == "MARKET" else "LIMIT",
            "price": float(price or 0),
            "quantity": int(qty),
            "securityId": m["securityId"],
        }
        r = await self._request("POST", f"{REST}/orders", headers=self._headers(),
                                json_body=payload, tag="place-order")
        return {"order_id": str(r.get("orderId", "")), "status": "open", "raw": r}

    async def cancel_order(self, broker_order_id, symbol="") -> dict:
        r = await self._request("DELETE", f"{REST}/orders/{broker_order_id}",
                                headers=self._headers(), tag="cancel-order")
        return {"order_id": broker_order_id, "status": "cancelled", "raw": r}

    def _resolve(self, symbol: str) -> Optional[dict]:
        row = db.broker_db("dhan").one("SELECT * FROM master WHERE symbol=?", (symbol,))
        if not row:
            return None
        seg = dm.EXCH_SEG.get(row["exchange"], "NSE_EQ")
        return {"securityId": row["token"], "exchangeSegment": seg}

    # ------------------------------------------------------------------ history
    async def get_history(self, symbol: str, tf_minutes: int, days: int) -> list[dict]:
        m = self._resolve(symbol)
        if not m:
            return []
        iv = {1: 1, 5: 5, 15: 15, 30: 30, 60: 60}.get(tf_minutes, 1)
        end = time.strftime("%Y-%m-%d")
        start = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
        payload = {"securityId": m["securityId"], "exchangeSegment": m["exchangeSegment"],
                   "instrument": "EQUITY" if m["exchangeSegment"] == "NSE_EQ" else "INDEX",
                   "interval": iv, "fromDate": start, "toDate": end}
        r = await self._request("POST", f"{REST}/charts/intraday", headers=self._headers(),
                                json_body=payload, tag="history")
        if not isinstance(r.get("open"), list):
            return []
        # response: parallel arrays open/high/low/close/volume/timestamp
        opens, highs, lows, closes = r.get("open") or [], r.get("high") or [], r.get("low") or [], r.get("close") or []
        vols, stamps = r.get("volume") or [], r.get("timestamp") or []
        out = []
        for i in range(min(len(opens), len(stamps))):
            out.append({"t": int(stamps[i]), "o": float(opens[i]), "h": float(highs[i]),
                        "l": float(lows[i]), "c": float(closes[i]), "v": float(vols[i] or 0)})
        return out

    # ------------------------------------------------------------------ master (live CSV, REPLACE)
    async def sync_master(self) -> dict:
        import httpx
        bdb = db.broker_db("dhan")
        config.log("dhan", f"master: downloading live scrip master {dm.MASTER_URL}")
        async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as cx:
            resp = await cx.get(dm.MASTER_URL)
            resp.raise_for_status()
        rows = dm.parse_master_csv(resp.content)
        bdb.exec("DELETE FROM master")
        bdb.executemany(
            "INSERT OR REPLACE INTO master(token,symbol,name,exchange,instrument,expiry,strike,right,lotsize) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [(r["token"], r["symbol"], r.get("name"), r["exchange"], r["instrument"],
              r.get("expiry"), r.get("strike"), r.get("right", ""), r.get("lotsize", 1)) for r in rows])
        bdb.exec("INSERT INTO sync_log(broker,source_url,source_kind,symbols,mappings,replaced,detail,ts)"
                 " VALUES(?,?,?,?,?,1,'live CSV NSE equities + F&O underlyings',?)",
                 (self.name, dm.MASTER_URL, "live-broker", len(rows), len(rows), time.time()))
        config.log("dhan", f"master replaced with {len(rows)} live rows")
        return {"source_url": dm.MASTER_URL, "source_kind": "live-broker",
                "symbols": len(rows), "mappings": len(rows), "replaced": True}

    # ------------------------------------------------------------------ streaming
    def make_stream(self, on_tick):
        from backend.brokers.dhan.streaming import DhanStream
        return DhanStream(on_tick, self)
