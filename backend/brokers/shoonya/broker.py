"""
Shoonya (Finvasia) adapter — Noren REST via the LIVE gateway prefix.

Round-25: Shoonya DECOMMISSIONED the bare /QuickAuth, /Limits … paths AND the
whole NorenWClientTP gateway (both now nginx 502/404 — verified live).
Every REST endpoint now lives under:

    https://api.shoonya.com/NorenWClientAPI/<Endpoint>

(per shoonya.com/api-documentation — Quick Start: host="https://api.shoonya.com/NorenWClientAPI/",
 websocket="wss://api.shoonya.com/NorenWSAPI/").

Auth:
  A. OAuth (the ONLY documented consumer flow): user opens
     https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id=<api_key>,
     the redirect carries ?code=…, the server exchanges it via
     POST /NorenWClientAPI/GenAcsTok  jData={"code":…,"checksum":sha256(client_id+secret+code)}
     -> {stat:"Ok", susertoken, uid, actid}.
  B. QuickAuth (vendor-gated): POST /NorenWClientAPI/QuickAuth — works only
     for vendor-class API apps; regular consumer apps get
     "Invalid Input : Invalid Access Type" (kept as a best-effort fallback).

All calls: POST form  jData=<json>&jKey=<susertoken>.
"""
from __future__ import annotations

import time

import httpx

from backend import config, db, session_store
from backend.brokers.base import BaseBroker, BrokerError
from backend.brokers.shoonya import mapping as sm

BASE = "https://api.shoonya.com"
GW = f"{BASE}/NorenWClientAPI"          # live REST gateway (Round-25)


class ShoonyaAdapter(BaseBroker):
    name = "shoonya"

    async def _post(self, endpoint: str, payload: dict, tag: str) -> dict:
        jdata = dict(payload)
        jkey = self.session.get("susertoken", "")
        if "jData" not in jdata:
            jdata = {"jData": jdata, "jKey": jkey}
        r = await self._request("POST", f"{GW}/{endpoint}", data=jdata, tag=tag)
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
        r = await self._request("POST", f"{GW}/QuickAuth", data={"jData": payload}, tag="QuickAuth")
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
        # hedging-verified formula: available = cash + payin - marginused
        def _n(k):
            try:
                return float(r.get(k) or 0)
            except (TypeError, ValueError):
                return 0.0
        cash = _n("cash")
        payin = _n("payin")
        used = _n("marginused")
        avail = max(0.0, (cash + payin) - used) if (cash or payin or used) else cash
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
    def _tsym_resolve(self, symbol: str) -> tuple[str, str, dict | None]:
        """Unified symbol -> (exchange, Noren tsym, master row).
        Round-26: resolves BOTH the tsym-exact rows this master stores
        (NFO:NIFTY27OCT26C17500) AND the chain-synthesized Dhan-style symbols
        (NFO:NIFTY27OCT2617500CE / ...FUT) by translating the shape and
        looking the real contract up.  NSE equities keep their -EQ suffix."""
        exch, sym = (symbol.split(":", 1) + [""])[:2] if ":" in symbol else ("NSE", symbol)
        sym = sym.upper()
        bdb = db.broker_db("shoonya")
        row = bdb.one("SELECT * FROM master WHERE symbol=?", (f"{exch}:{sym}",)) \
            or bdb.one("SELECT * FROM master WHERE symbol=?", (symbol,))
        if row:
            tsym = row["symbol"].split(":", 1)[-1]
            if exch == "NSE" and (row.get("instrument") or "EQ") == "EQ" \
                    and "-" not in tsym and "=" not in tsym:
                tsym = f"{tsym}-EQ"
            return exch, tsym, row
        # translation fallback: Dhan-style {UNDER}{DDMMMYY}{STRIKE}{CE|PE}
        import re as _re
        m = _re.match(r"^([A-Z&-]+?)(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$", sym)
        fut = _re.match(r"^([A-Z&-]+?)(\d{2}[A-Z]{3}\d{2})FUT$", sym)
        if m:
            under, short, strike, right = m.group(1), m.group(2), m.group(3), m.group(4)
            tsym = f"{under}{short}{right[0]}{int(strike)}"   # Noren: right letter BEFORE strike
            row = bdb.one("SELECT * FROM master WHERE symbol=?", (f"NFO:{tsym}",))
            if row:
                return "NFO", tsym, row
        if fut:
            under, short = fut.group(1), fut.group(2)
            tsym = f"{under}{short}F"                            # Noren futures end with F
            row = bdb.one("SELECT * FROM master WHERE symbol=?", (f"NFO:{tsym}",))
            if row:
                return "NFO", tsym, row
        if exch == "NSE" and "-" not in sym and "=" not in sym:
            return exch, f"{sym}-EQ", None
        return exch, sym, None

    async def place_order(self, symbol, side, qty, order_type="MARKET", price=None,
                          product="MIS", trigger_price=None) -> dict:
        exch, tsym, _row = self._tsym_resolve(symbol)
        prd = "I" if product == "MIS" else ("C" if product == "CNC" else "M")
        ot = (order_type or "MARKET").upper()
        # hedging-verified: SL-MKT is rejected for API orders -> SL-LMT with a
        # MPP-protected limit (fallback: the trigger price as the limit)
        if trigger_price and ot in ("SL", "SL-M", "SL-MKT", "STOPLOSS"):
            prctyp = "SL-LMT"
            prc = str(price or trigger_price)
            trgprc = str(trigger_price)
        elif trigger_price:
            prctyp = "SL-LMT" if ot == "LIMIT" else "SL-MKT"
            prc = str(price or trigger_price)
            trgprc = str(trigger_price)
        elif ot == "LIMIT":
            prctyp, prc, trgprc = "LMT", str(price or 0), "0"
        else:
            prctyp, prc, trgprc = "MKT", "0.00", "0"
        payload = {
            "uid": self.session.get("uid", ""), "actid": self.session.get("actid", ""),
            "exch": exch, "tsym": tsym, "trantype": "B" if side.upper() == "BUY" else "S",
            "qty": str(qty), "prd": prd,
            "prc": prc, "trgprc": trgprc, "prctyp": prctyp,
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
        exch, tsym, row = self._tsym_resolve(symbol)
        if tf_minutes != 1:
            return []      # TPSeries is 1m; hub aggregates higher TFs
        # hedging-verified: TPSeries takes EPOCH strings for st/et (+ token)
        st = str(int(time.time() - days * 86400))
        et = str(int(time.time()))
        payload = {"uid": self.session.get("uid", ""), "actid": self.session.get("actid", ""),
                   "exch": exch, "tsym": tsym, "st": st, "et": et, "intrv": "1"}
        if row and row.get("token"):
            payload["token"] = str(row["token"])
        r = await self._post("TPSeries", payload, tag="history")
        rows = r.get("data") if isinstance(r.get("data"), list) else []
        if not rows and isinstance(r, list):
            rows = r
        out = []
        for row_ in rows:
            if isinstance(row_, str):
                try:
                    import json as _json
                    row_ = _json.loads(row_)
                except Exception:
                    continue
            try:
                # prefer ssboe epoch (hedging-verified); fall back to the time string
                t = int(float(row_.get("ssboe") or 0))
                if not t:
                    from datetime import datetime
                    t = int(datetime.strptime(row_.get("time", ""), "%d-%m-%Y %H:%M:%S").timestamp())
                out.append({"t": t, "o": float(row_.get("into") or 0), "h": float(row_.get("inth") or 0),
                            "l": float(row_.get("intl") or 0), "c": float(row_.get("intc") or 0),
                            "v": float(row_.get("intv") or 0)})
            except (ValueError, TypeError):
                continue
        return out

    # ------------------------------------------------------------------ master (LIVE zip/csv, REPLACE)
    async def sync_master(self) -> dict:
        import httpx
        bdb = db.broker_db("shoonya")
        rows: list[dict] = []
        details = []
        async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as cx:
            for exch, urls in sm.MASTER_URLS.items():
                if exch not in ("NSE", "NFO"):
                    continue        # equities + tracked F&O is enough for the terminal
                got: list[dict] = []
                last_err: str = ""
                for url in urls:    # .zip (live) -> .txt (stale) -> .gz (dead)
                    try:
                        resp = await cx.get(url)
                        if resp.status_code != 200:
                            last_err = f"HTTP {resp.status_code}"
                            continue
                        got = sm.parse_symbols(resp.content, exch)
                        config.log("shoonya", f"master {url} -> {len(got)} rows")
                        break
                    except Exception as e:
                        last_err = str(e)[:80]
                        config.log("shoonya", f"master {url} failed: {e}", "WARN")
                if got:
                    rows.extend(got)
                    details.append(f"{exch}:{len(got)}")
                else:
                    details.append(f"{exch}:FAILED({last_err or 'no rows'})")
                    config.log("shoonya", f"master {exch}: every candidate failed ({last_err})", "ERROR")
        bdb.exec("DELETE FROM master")
        bdb.executemany(
            "INSERT OR REPLACE INTO master(token,symbol,name,exchange,instrument,expiry,strike,right,lotsize) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [(r["token"], r["symbol"], r.get("name"), r["exchange"], r["instrument"],
              r.get("expiry"), r.get("strike"), r.get("right", ""), r.get("lotsize", 1)) for r in rows])
        bdb.exec("INSERT INTO sync_log(broker,source_url,source_kind,symbols,mappings,replaced,detail,ts)"
                 " VALUES(?,?,?,?,?,1,?,?)",
                 (self.name, "api.shoonya.com/{NSE,NFO}_symbols.txt.zip", "live-broker",
                  len(rows), len(rows), ";".join(details), time.time()))
        return {"source_url": "api.shoonya.com/{NSE,NFO}_symbols.txt.zip",
                "source_kind": "live-broker", "symbols": len(rows),
                "mappings": len(rows), "replaced": True, "detail": ";".join(details)}

    # ------------------------------------------------------------------ streaming
    def make_stream(self, on_tick):
        from backend.brokers.shoonya.streaming import ShoonyaStream
        return ShoonyaStream(on_tick, self)
