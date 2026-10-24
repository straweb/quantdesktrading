"""
Shoonya (Finvasia) adapter — Noren REST + QuickAuth.

Auth (simplified OpenAlgo-style, Round-10/12):
  A. Direct susertoken paste (from Shoonya API dashboard TOTP flow).
  B. QuickAuth: uid + password + factor2(TOTP) + vendor_code + api_secret(app_idkey)
     POST {BASE}/QuickAuth  data={apk:api_key, imei, source:'API', uid, pwd,
     factor2, vc, app_idkey, addldivinf} -> susertoken (persisted).

REST base: https://api.shoonya.com/  endpoints: QuickAuth, PlaceOrder,
CancelOrderTask, Limits (funds), PositionBook, OrderBook, TPSeries.
All calls: POST with form jData=<json>&jKey=<susertoken>.
"""
from __future__ import annotations

import time

import httpx

from backend import config, db, session_store
from backend.brokers.base import BaseBroker, BrokerError
from backend.brokers.shoonya import mapping as sm

BASE = "https://api.shoonya.com"


class ShoonyaAdapter(BaseBroker):
    name = "shoonya"

    async def _post(self, endpoint: str, payload: dict, tag: str) -> dict:
        jdata = dict(payload)
        jkey = self.session.get("susertoken", "")
        if "jData" not in jdata:
            jdata = {"jData": jdata, "jKey": jkey}
        r = await self._request("POST", f"{BASE}/{endpoint}", data=jdata, tag=tag)
        out = r.get("data", r)
        if isinstance(out, dict) and out.get("stat") == "Not_Ok":
            raise BrokerError(f"{tag}: {out.get('emsg', 'Not_Ok')}")
        return out if isinstance(out, dict) else {"data": out}

    # ------------------------------------------------------------------ session
    async def authenticate(self) -> dict:
        stored = session_store.get(self.account_id)
        if stored and stored.get("session_token"):
            meta = session_store.meta_of(stored)
            self.session = {"susertoken": stored["session_token"], **meta}
            if await self.validate_session():
                session_store.mark_validated(self.account_id)
                self.connected = True
                self.log("reused persisted Shoonya susertoken")
                return self.session
            self.log("stored susertoken invalid — re-authenticating", "WARN")
        token = self.credentials.get("susertoken", "").strip()
        if token:
            self.session = {"susertoken": token,
                            "uid": self.credentials.get("uid", ""),
                            "actid": self.credentials.get("actid", self.credentials.get("uid", ""))}
        else:
            await self._quick_auth()
        if not await self.validate_session():
            raise BrokerError("Shoonya session validation failed (Limits call)")
        session_store.save(self.account_id, self.name, self.session["susertoken"], None,
                           {"uid": self.session.get("uid"), "actid": self.session.get("actid")})
        self.connected = True
        self.log("Shoonya session created + persisted")
        return self.session

    async def _quick_auth(self) -> None:
        c = self.credentials
        payload = {"apk": c.get("api_key", ""), "imei": c.get("imei", "abc1234"),
                   "source": "API", "uid": c.get("uid", ""), "pwd": c.get("password", ""),
                   "factor2": c.get("totp", ""), "vc": c.get("vendor_code", ""),
                   "app_idkey": c.get("api_secret", c.get("api_key", "")), "addldivinf": ""}
        r = await self._request("POST", f"{BASE}/QuickAuth", data={"jData": payload}, tag="QuickAuth")
        body = r.get("data", r)
        if not isinstance(body, dict) or not body.get("susertoken"):
            raise BrokerError(f"QuickAuth failed: {str(body)[:200]}")
        self.session = {"susertoken": body["susertoken"],
                        "uid": body.get("actid", c.get("uid", "")),
                        "actid": body.get("actid", c.get("uid", ""))}

    async def validate_session(self) -> bool:
        try:
            await self.get_funds()
            return True
        except Exception as e:
            self.log(f"validate failed: {e}", "WARN")
            return False

    # ------------------------------------------------------------------ data
    async def get_funds(self) -> dict:
        r = await self._post("Limits", {"actid": self.session.get("actid", "")}, tag="funds")
        avail = float(r.get("cash") or 0)
        used = float(r.get("marginused") or 0)
        return {"available": round(avail, 2), "used": round(used, 2),
                "total": round(avail + used, 2), "raw": r, "source": "shoonya-live"}

    async def get_positions(self) -> list[dict]:
        r = await self._post("PositionBook", {"actid": self.session.get("actid", "")}, tag="positions")
        rows = r.get("positions") if isinstance(r.get("positions"), list) else []
        out = []
        for p in rows:
            try:
                out.append({"symbol": f"{p.get('exch', 'NFO')}:{p.get('tsym', '')}",
                            "qty": float(p.get("netqty") or 0),
                            "avg_price": float(p.get("netuprice") or p.get("buyavgprice") or 0),
                            "ltp": float(p.get("lp") or 0),
                            "pnl": float(p.get("urmtom") or 0),
                            "product": "NRML"})
            except (TypeError, ValueError):
                continue
        return out

    async def get_orderbook(self) -> list[dict]:
        r = await self._post("OrderBook", {"actid": self.session.get("actid", "")}, tag="orders")
        return r.get("orders") if isinstance(r.get("orders"), list) else []

    # ------------------------------------------------------------------ orders
    async def place_order(self, symbol, side, qty, order_type="MARKET", price=None,
                          product="MIS", trigger_price=None) -> dict:
        exch, tsym = (symbol.split(":", 1) + [""])[:2] if ":" in symbol else ("NSE", symbol)
        prd = "I" if product == "MIS" else ("C" if product == "CNC" else "M")
        payload = {
            "uid": self.session.get("uid", ""), "actid": self.session.get("actid", ""),
            "exch": exch, "tsym": tsym, "trantype": "B" if side.upper() == "BUY" else "S",
            "qty": str(qty), "prd": prd,
            "prc": str(price or 0) if order_type.upper() == "LIMIT" else "0.00",
            "trgprc": str(trigger_price or 0),
            "prctyp": "LMT" if order_type.upper() == "LIMIT" else "MKT",
            "ret": "DAY", "remarks": "terminal",
        }
        r = await self._post("PlaceOrder", payload, tag="place-order")
        return {"order_id": str(r.get("norenordno", "")), "status": "open", "raw": r}

    async def cancel_order(self, broker_order_id, symbol="") -> dict:
        r = await self._post("CancelOrderTask",
                             {"uid": self.session.get("uid", ""), "norenordno": broker_order_id},
                             tag="cancel-order")
        return {"order_id": broker_order_id, "status": "cancelled", "raw": r}

    # ------------------------------------------------------------------ history (TPSeries)
    async def get_history(self, symbol: str, tf_minutes: int, days: int) -> list[dict]:
        exch, tsym = (symbol.split(":", 1) + [""])[:2] if ":" in symbol else ("NSE", symbol)
        if tf_minutes != 1:
            return []      # TPSeries is 1m; hub aggregates higher TFs
        st = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400)) + " 09:15:00"
        et = time.strftime("%Y-%m-%d %H:%M:%S")
        payload = {"uid": self.session.get("uid", ""), "actid": self.session.get("actid", ""),
                   "exch": exch, "tsym": tsym, "st": st, "et": et, "intrv": "1"}
        r = await self._post("TPSeries", payload, tag="history")
        rows = r.get("data") if isinstance(r.get("data"), list) else []
        out = []
        for row in rows:
            try:
                from datetime import datetime
                t = int(datetime.strptime(row.get("time", ""), "%d-%m-%Y %H:%M:%S").timestamp())
                out.append({"t": t, "o": float(row.get("into") or 0), "h": float(row.get("inth") or 0),
                            "l": float(row.get("intl") or 0), "c": float(row.get("intc") or 0),
                            "v": float(row.get("intv") or 0)})
            except (ValueError, TypeError):
                continue
        return out

    # ------------------------------------------------------------------ master (live gz, REPLACE)
    async def sync_master(self) -> dict:
        import httpx
        bdb = db.broker_db("shoonya")
        rows: list[dict] = []
        details = []
        async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as cx:
            for exch, url in sm.MASTER_URLS.items():
                if exch not in ("NSE", "NFO"):
                    continue        # equities + tracked F&O is enough for the terminal
                try:
                    resp = await cx.get(url)
                    resp.raise_for_status()
                    got = sm.parse_symbols_gz(resp.content, exch)
                    rows.extend(got)
                    details.append(f"{exch}:{len(got)}")
                    config.log("shoonya", f"master {url} -> {len(got)} rows")
                except Exception as e:
                    details.append(f"{exch}:FAILED({e})")
                    config.log("shoonya", f"master {url} failed: {e}", "ERROR")
        bdb.exec("DELETE FROM master")
        bdb.executemany(
            "INSERT OR REPLACE INTO master(token,symbol,name,exchange,instrument,expiry,strike,right,lotsize) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [(r["token"], r["symbol"], r.get("name"), r["exchange"], r["instrument"],
              r.get("expiry"), r.get("strike"), r.get("right", ""), r.get("lotsize", 1)) for r in rows])
        bdb.exec("INSERT INTO sync_log(broker,source_url,source_kind,symbols,mappings,replaced,detail,ts)"
                 " VALUES(?,?,?,?,?,1,?,?)",
                 (self.name, "api.shoonya.com/*_symbols.txt.gz", "live-broker",
                  len(rows), len(rows), ";".join(details), time.time()))
        return {"source_url": "api.shoonya.com/{NSE,NFO}_symbols.txt.gz",
                "source_kind": "live-broker", "symbols": len(rows),
                "mappings": len(rows), "replaced": True, "detail": ";".join(details)}

    # ------------------------------------------------------------------ streaming
    def make_stream(self, on_tick):
        from backend.brokers.shoonya.streaming import ShoonyaStream
        return ShoonyaStream(on_tick, self)
