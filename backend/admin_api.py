"""
Admin + tool REST plane — extends the FastAPI app (mounted by api/rest.py).

Everything here is TOOL interaction (quantdesk parity): feed source mgmt,
symbols/masters, trades, funds sync, market data REST fallbacks, options
chain, FNO universe, strategies, auto rules, GTT, copy trade, diagnostics,
tick recorder, replay, portfolio, session stats, margin.
Streaming data never lives here — it flows over socket.io :8001.
"""
from __future__ import annotations

from typing import Optional
import asyncio
import json
import os
import subprocess
import sys
import time
from datetime import datetime

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from backend import charges as charges_mod
from backend import config, db
from backend.api.deps import uid
from backend.market.hub import Hub
from backend.market.funds import SVC as FUNDS
from backend.options_chain import (build_chain, ensure_chain_subscribed,
                                   ensure_strike, fno_universe,
                                   index_components)

router = APIRouter(prefix="/pyapi")


def _iso(ts: Optional[float]) -> Optional[str]:
    if not ts:
        return None
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%S")


# ================================================================== feed source
@router.get("/feed")
async def feed_get(authorization: str = Header(default="")):
    uid(authorization)
    hub = Hub.instance()
    return {"source": hub.feed_source(), "simDisabled": hub.sim_disabled(),
            "sources": hub.feed_sources()}


class FeedReq(BaseModel):
    source: Optional[str] = None
    simDisabled: Optional[bool] = None


@router.post("/feed")
async def feed_post(body: FeedReq, authorization: str = ""):
    uid(authorization)
    hub = Hub.instance()
    if body.simDisabled is not None:
        hub.set_sim_disabled(body.simDisabled)
        if body.simDisabled and hub.feed_source() == "sim":
            raise HTTPException(400, "Live-Only mode: sim feed is disabled — pick a live broker source")
    if body.source is not None:
        try:
            await hub.set_feed_source(body.source)
        except ValueError as e:
            raise HTTPException(400, str(e))
    return {"ok": True, "source": hub.feed_source(), "simDisabled": hub.sim_disabled()}


@router.get("/feed/status")
async def feed_status(authorization: str = Header(default="")):
    uid(authorization)
    return Hub.instance().feed_status()


# ================================================================== symbols / masters
@router.get("/symbols")
async def symbols(q: str = "", type: str = "", symbols: str = "", limit: int = 120,
                  authorization: str = Header(default="")):
    uid(authorization)
    out: list[dict] = []
    seen: set[str] = set()
    hub = Hub.instance()
    want = [s.strip().upper() for s in (symbols or "").split(",") if s.strip()]
    # bare watch symbols ('NIFTY') resolve to master-backed rows ('NSE:NIFTY')
    want = [hub.resolve_symbol(s) for s in want]
    for name in db.broker_dbs_keys():
        bdb = db.broker_db(name)
        try:
            if want:
                marks = ",".join("?" for _ in want)
                rows = bdb.query(f"SELECT * FROM master WHERE symbol IN ({marks}) LIMIT ?", (*want, limit))
            elif q:
                like = f"%{q.upper()}%"
                rows = bdb.query(
                    "SELECT * FROM master WHERE symbol LIKE ? OR name LIKE ? OR exchange LIKE ? LIMIT ?",
                    (like, like, like, limit))
            else:
                rows = bdb.query("SELECT * FROM master LIMIT ?", (limit,))
        except Exception:
            continue
        for r in rows:
            if r["symbol"] in seen:
                continue
            seen.add(r["symbol"])
            if type and (r.get("instrument") or "").upper() != type.upper():
                continue
            inst = (r.get("instrument") or "EQ").upper()
            out.append({
                "id": r["symbol"], "symbol": r["symbol"],
                "name": r.get("name") or r["symbol"], "exchange": r.get("exchange") or "NSE",
                "instrumentType": "CE" if inst == "OPT" and (r.get("right") or "") == "CE"
                else "PE" if inst == "OPT" and (r.get("right") or "") == "PE" else inst,
                "expiry": r.get("expiry"), "strike": r.get("strike"),
                "optionType": r.get("right") or None, "lotSize": int(r.get("lotsize") or 1),
                "basePrice": r.get("strike"),
                "mappings": [{"brokerType": name.upper(), "brokerSymbol": r["symbol"], "brokerToken": r["token"]}],
            })
            if len(out) >= limit:
                return {"symbols": out}
    return {"symbols": out}


@router.post("/symbols/sync")
async def symbols_sync(authorization: str = Header(default="")):
    """'Sync Now' — sync master contracts for EVERY active/connected broker
    account (per-account adapters keep their live sessions).  Per-account
    history rows land in master_sync_log for the broker-wise sync panel."""
    uid(authorization)
    from backend import masters
    result = await masters.sync_active_accounts(trigger="manual")
    return result


@router.post("/symbols/sync/{account_id}")
async def symbols_sync_one(account_id: int, authorization: str = Header(default="")):
    """On-demand per-broker sync button — sync ONE account's master contracts."""
    uid(authorization)
    from backend import masters
    acc = db.core().one("SELECT * FROM accounts WHERE id=?", (int(account_id),))
    if not acc:
        raise HTTPException(404, "account not found")
    result = await masters.sync_account(dict(acc), trigger="manual")
    masters._reload_token_maps(acc["broker"])
    hub = Hub.instance()
    if hub.sio and "error" not in result:
        await hub.sio.emit("master:synced", result)
    return result


@router.get("/symbols/sync")
async def symbols_sync_info(authorization: str = Header(default="")):
    uid(authorization)
    from backend import masters
    sym_count = 0
    map_count = 0
    last_sync = None
    brokers: list[dict] = []
    for name in db.broker_dbs_keys():
        bdb = db.broker_db(name)
        n = bdb.one("SELECT COUNT(*) c FROM master")["c"]
        sym_count += n
        map_count += n
        log = bdb.one("SELECT ts, symbols, mappings, source_kind FROM sync_log ORDER BY ts DESC LIMIT 1")
        if log and (last_sync is None or log["ts"] > last_sync):
            last_sync = log["ts"]
        acc = db.core().one(
            "SELECT id,label,status,mode FROM accounts WHERE broker=? ORDER BY id LIMIT 1", (name,))
        hrow = db.core().one(
            "SELECT ts,status,trigger,symbols,error FROM master_sync_log WHERE broker=? "
            "ORDER BY id DESC LIMIT 1", (name,))
        brokers.append({
            "broker": name,
            "accountId": (acc or {}).get("id"),
            "symbols": n,
            "connected": bool(acc and acc["status"] == "connected"),
            "accountLabel": (acc or {}).get("label"),
            "mode": (acc or {}).get("mode"),
            "lastSync": _iso(log["ts"]) if log else None,
            "lastSyncKind": (log or {}).get("source_kind"),
            "lastStatus": (hrow or {}).get("status"),
            "lastTrigger": (hrow or {}).get("trigger"),
            "lastError": (hrow or {}).get("error"),
        })
    return {"lastSync": _iso(last_sync),
            "counts": {"symbols": sym_count, "mappings": map_count},
            "brokers": brokers,
            "history": masters.history(40)}


# ================================================================== trades
@router.get("/trades")
async def trades(authorization: str = Header(default="")):
    uid(authorization)
    rows = db.core().query("SELECT * FROM trades ORDER BY id DESC LIMIT 200")
    out = []
    totals_charges = 0.0
    totals_realized = 0.0
    for t in rows:
        acc = db.core().one("SELECT label,broker FROM accounts WHERE id=?", (t["account_id"],))
        ch = json.loads(t["charges"] or "{}")
        totals_charges += ch.get("total", 0) or 0
        totals_realized += t["realized_pnl"] or 0
        out.append({
            "id": str(t["id"]), "orderId": t["order_id"], "symbol": t["symbol"],
            "exchange": t["exchange"], "side": t["side"], "qty": t["qty"], "price": t["price"],
            "value": t["value"], "chargesTotal": ch.get("total", 0), "charges": ch,
            "realizedPnl": t["realized_pnl"],
            "netPnl": round((t["realized_pnl"] or 0) - (ch.get("total", 0) or 0), 2),
            "ts": _iso(t["ts"]),
            "accountId": str(t["account_id"]),
            "accountLabel": acc["label"] if acc else "", "brokerType": (acc["broker"].upper() if acc else "SIM"),
        })
    return {"trades": out, "totals": {"charges": round(totals_charges, 2), "realized": round(totals_realized, 2)}}


# ================================================================== charges schedule (per account, editable)
class ChargesSchedReq(BaseModel):
    accountId: str
    schedule: dict


@router.get("/charges")
async def charges_get(accountId: str, authorization: str = Header(default="")):
    """The account's effective charge schedule + broker defaults + a live
    example round-trip (1 lot option @ 100) so the user SEES each charge."""
    uid(authorization)
    acc = db.core().one("SELECT * FROM accounts WHERE id=?", (int(accountId),))
    if not acc:
        raise HTTPException(404, "account not found")
    from backend import charges_config
    sched = charges_config.effective_schedule(int(accountId), acc["broker"])
    example = charges_config.round_trip(sched, "CE", "MIS", 75, 100.0)
    return {"accountId": accountId, "broker": acc["broker"], "label": acc["label"],
            "schedule": sched,
            "defaults": charges_config.default_schedule(acc["broker"]),
            "customized": charges_config.get_override(int(accountId)) is not None,
            "example": example}


@router.put("/charges")
async def charges_put(body: ChargesSchedReq, authorization: str = Header(default="")):
    """Save an edited schedule (per-segment brokerage + every tax line)."""
    uid(authorization)
    acc = db.core().one("SELECT * FROM accounts WHERE id=?", (int(body.accountId),))
    if not acc:
        raise HTTPException(404, "account not found")
    from backend import charges_config
    # keep only numeric, known keys — a bad edit can never corrupt the engine
    clean: dict[str, dict] = {}
    for seg, rows in (body.schedule or {}).items():
        if seg not in charges_config.SEGMENTS or not isinstance(rows, dict):
            continue
        keep = {}
        for k, v in rows.items():
            if k in charges_config.default_schedule()[seg]:
                try:
                    keep[k] = max(0.0, float(v))
                except (TypeError, ValueError):
                    pass
        clean[seg] = keep
    charges_config.save_override(int(body.accountId), acc["broker"], clean)
    sched = charges_config.effective_schedule(int(body.accountId), acc["broker"])
    return {"ok": True, "schedule": sched,
            "example": charges_config.round_trip(sched, "CE", "MIS", 75, 100.0)}


@router.delete("/charges")
async def charges_reset(accountId: str, authorization: str = Header(default="")):
    """Reset back to the broker defaults (today's market values)."""
    uid(authorization)
    from backend import charges_config
    charges_config.clear_override(int(accountId))
    return {"ok": True}


# ================================================================== funds (all accounts)
@router.get("/funds")
async def funds_all(authorization: str = Header(default="")):
    uid(authorization)
    hub = Hub.instance()
    open_net_map = hub._exit_net_map()
    out = []
    for acc in db.core().query("SELECT * FROM accounts ORDER BY id"):
        cash = hub._account_cash(acc["id"]) or 0
        acc_net = round((acc["realized_pnl"] or 0) - (acc["charges_paid"] or 0), 2)
        acc_open = round(open_net_map.get(acc["id"], 0.0), 2)
        out.append({
            "accountId": str(acc["id"]), "label": acc["label"],
            "brokerType": acc["broker"].upper(), "cash": round(cash, 2),
            "initialCapital": round(acc["initial_capital"] or 0, 2),
            "realizedPnl": acc["realized_pnl"] or 0,
            "netPnl": acc_net,
            "openNet": acc_open,
            "pocket": round(acc_net + acc_open, 2),
            "chargesPaid": acc["charges_paid"] or 0, "deployed": 0,
        })
    return {"funds": out}


@router.post("/funds")
async def funds_sync(body: dict, authorization: str = Header(default="")):
    uid(authorization)
    hub = Hub.instance()
    account_id = (body or {}).get("accountId")
    results = []
    if account_id:
        targets = [int(account_id)]
    else:
        targets = list(hub.adapters.keys())
    if not targets:
        raise HTTPException(400, "no connected account to pull funds from")
    for aid in targets:
        acc = db.core().one("SELECT * FROM accounts WHERE id=?", (aid,))
        if not acc:
            continue
        try:
            await FUNDS.push_funds(aid, reason="request")
            cash = hub._account_cash(aid)
            results.append({"accountId": str(aid), "label": acc["label"], "ok": True,
                            "cash": cash, "message": f"₹{(cash or 0):,.0f} available"})
        except Exception as e:
            results.append({"accountId": str(aid), "label": acc["label"], "ok": False,
                            "message": str(e)[:160]})
    ok = all(r["ok"] for r in results) if results else False
    first = results[0] if results else None
    return {"ok": ok, "cash": first.get("cash") if first else None,
            "message": first.get("message") if first else "no accounts", "results": results}


# ================================================================== market data REST fallbacks
@router.get("/market/candles")
async def market_candles(symbol: str, tf: str = "5m", limit: int = 500,
                         authorization: str = Header(default="")):
    uid(authorization)
    from backend.components_tf import TF_MIN  # noqa: F401 (ensures module exists)
    tf_min = TF_MIN.get(tf, 5)
    hub = Hub.instance()
    sym = hub.resolve_symbol(symbol.upper())
    await hub._ensure_source(sym)
    # base 1m aggregate / broker history, bucketed to tf
    base = await hub.get_history(sym, 1)
    if not base:
        return {"candles": []}
    step = tf_min * 60
    out: dict[int, dict] = {}
    for c in base:
        t = int(c["t"] - (c["t"] % step))
        b = out.get(t)
        if not b:
            out[t] = {"t": t * 1000, "o": c["o"], "h": c["h"], "l": c["l"], "c": c["c"], "v": c["v"]}
        else:
            b["h"] = max(b["h"], c["h"])
            b["l"] = min(b["l"], c["l"])
            b["c"] = c["c"]
            b["v"] += c["v"]
    candles = sorted(out.values(), key=lambda x: x["t"])[-limit:]
    return {"candles": candles}


@router.get("/market/quote")
async def market_quote(symbol: str, authorization: str = Header(default="")):
    uid(authorization)
    hub = Hub.instance()
    sym = hub.resolve_symbol(symbol.upper())
    await hub._ensure_source(sym)
    t = hub.ticks.get(sym) or {}
    ltp = float(t.get("ltp") or 0)
    mrow = hub._master_row(sym)
    lot = int((mrow or {}).get("lotsize") or 1)
    inst = (mrow or {}).get("instrument") or "EQ"
    tick_size = 0.05
    depth = {"buys": [], "sells": []}
    if ltp:
        bid = float(t.get("bid") or ltp - tick_size)
        ask = float(t.get("ask") or ltp + tick_size)
        for i in range(5):
            depth["buys"].append({"price": round(bid - i * tick_size, 2), "qty": int(75 * (i + 1))})
            depth["sells"].append({"price": round(ask + i * tick_size, 2), "qty": int(75 * (i + 1))})
    return {"symbol": sym, "ltp": ltp, "prevClose": float(t.get("prev_close") or 0),
            "bid": float(t.get("bid") or 0), "ask": float(t.get("ask") or 0),
            "lotSize": lot, "instrumentType": inst, "depth": depth}


@router.get("/market/index")
async def market_index(symbol: str, authorization: str = Header(default="")):
    uid(authorization)
    return index_components(symbol.upper())


@router.get("/market/status")
async def market_status(authorization: str = Header(default="")):
    uid(authorization)
    hub = Hub.instance()
    counts = {"symbols": 0, "lastSync": None}
    for name in db.broker_dbs_keys():
        counts["symbols"] += db.broker_db(name).one("SELECT COUNT(*) c FROM master")["c"]
        log = db.broker_db(name).one("SELECT ts FROM sync_log ORDER BY ts DESC LIMIT 1")
        if log and (counts["lastSync"] is None or log["ts"] > counts["lastSync"]):
            counts["lastSync"] = _iso(log["ts"])
    return {"services": {"rest": config.REST_PORT, "ws": config.WS_PORT,
                         "feed": "up" if hub.ticks else "idle",
                         "mode": hub.trading_mode()},
            "masterContracts": counts,
            "accounts": len(hub.adapters),
            "enabledStrategies": db.core().one("SELECT COUNT(*) c FROM strategies WHERE enabled=1")["c"]}


@router.get("/market/fno")
async def market_fno(authorization: str = Header(default="")):
    uid(authorization)
    return fno_universe()


# ================================================================== options chain
@router.get("/options/underlyings")
async def options_underlyings(authorization: str = Header(default="")):
    uid(authorization)
    from backend.options_chain import _underlyings
    return {"underlyings": _underlyings()}


@router.get("/options/chain")
async def options_chain(underlying: str, expiry: str = "", strikes: str = "",
                        authorization: str = Header(default="")):
    uid(authorization)
    await ensure_chain_subscribed(underlying.upper(), expiry or None)
    payload = build_chain(underlying.upper(), expiry or None)
    # far strikes requested explicitly (outside the ±15 band) get rows appended
    want = [int(s) for s in strikes.split(",") if s.strip().lstrip("-").isdigit()]
    if want:
        have = {r["strike"] for r in payload["rows"]}
        step = payload["meta"]["step"]
        atm = payload["meta"]["atm"]
        for s in sorted(set(want) - have):
            from backend.options_chain import _cell, _opt_symbol
            exp = payload["meta"]["expiry"]
            row = {
                "strike": s, "offset": round((s - atm) / step),
                "offsetCe": round((s - payload["meta"]["ceAtm"]) / step),
                "offsetPe": round((s - payload["meta"]["peAtm"]) / step),
                "ce": _cell(_opt_symbol(underlying.upper(), exp, s, "CE"), True),
                "pe": _cell(_opt_symbol(underlying.upper(), exp, s, "PE"), True),
            }
            payload["rows"].append(row)
        payload["rows"].sort(key=lambda r: r["strike"])
    return payload


class EnsureStrikeReq(BaseModel):
    underlying: str
    strike: float
    expiry: Optional[str] = None


@router.post("/options/ensure-strike")
async def options_ensure(body: EnsureStrikeReq, authorization: str = Header(default="")):
    uid(authorization)
    return ensure_strike(body.underlying.upper(), body.strike, body.expiry)


# ================================================================== stats / portfolio / margin
@router.get("/stats/session")
async def stats_session(authorization: str = Header(default="")):
    uid(authorization)
    return Hub.instance().session_stats()


@router.get("/portfolio")
async def portfolio(authorization: str = Header(default="")):
    uid(authorization)
    hub = Hub.instance()
    out = []
    for acc in db.core().query("SELECT * FROM accounts ORDER BY id"):
        aid = acc["id"]
        adapter = hub.adapters.get(aid)
        live = bool(adapter and getattr(adapter, "connected", False) and acc["broker"] != "sim")
        holdings = []
        message = None
        if adapter:
            try:
                raw = await adapter.get_holdings()
                for h in raw or []:
                    holdings.append({
                        "symbol": h.get("symbol", ""), "qty": float(h.get("qty", 0)),
                        "avgPrice": float(h.get("avg_price", 0) or h.get("avgPrice", 0)),
                        "ltp": float(h.get("ltp", 0) or 0),
                        "pnl": float(h.get("pnl", 0) or 0),
                        "value": float(h.get("qty", 0)) * float(h.get("ltp", 0) or 0),
                    })
            except Exception as e:
                message = str(e)[:160]
        else:
            message = "account not connected"
        out.append({"accountId": str(aid), "accountLabel": acc["label"],
                    "brokerType": acc["broker"].upper(), "live": live,
                    "holdings": holdings, "message": message})
    positions = []
    for p in db.core().query("SELECT * FROM positions WHERE qty<>0"):
        acc = db.core().one("SELECT label,broker FROM accounts WHERE id=?", (p["account_id"],))
        mrow = hub._master_row(p["symbol"])
        positions.append({
            "accountId": str(p["account_id"]),
            "accountLabel": acc["label"] if acc else "",
            "symbol": p["symbol"], "netQty": p["qty"], "avgPrice": p["avg_price"],
            "ltp": p["ltp"], "lotSize": int((mrow or {}).get("lotsize") or 1),
        })
    return {"portfolio": out, "positions": positions, "ts": _iso(time.time())}


class MarginReq(BaseModel):
    accountId: str
    symbol: str
    side: str
    qty: int
    price: float
    productType: str = "MIS"


@router.post("/margin")
async def margin(body: MarginReq, authorization: str = Header(default="")):
    uid(authorization)
    hub = Hub.instance()
    acc = db.core().one("SELECT * FROM accounts WHERE id=?", (int(body.accountId),))
    if not acc:
        raise HTTPException(404, "account not found")
    mrow = hub._master_row(body.symbol.upper())
    inst = charges_mod.instrument_of(mrow)
    lev = charges_mod.leverage_for(inst, body.productType)
    lot = int((mrow or {}).get("lotsize") or 1)
    mult = lot if inst in ("CE", "PE", "FUT") and lot > 1 else 1
    required = body.price * body.qty * mult / lev
    usable = hub._usable_capital(acc)
    # ---- P&L details: round-trip charges from the ACCOUNT'S OWN editable
    # schedule (defaults = today's market values per broker) ----
    from backend import charges_config
    sched = charges_config.effective_schedule(int(body.accountId), acc["broker"])
    qty_units = body.qty * mult if mult > 1 else body.qty
    rt = charges_config.round_trip(sched, inst, body.productType, qty_units, body.price)
    up, down = body.price * 1.01, body.price * 0.99
    def _net(exit_px: float, side_long: bool) -> float:
        sell_leg = charges_config.calc_charges_sched(sched, inst, body.productType, "SELL", exit_px * qty_units)["total"]
        gross = (exit_px - body.price) * qty_units * (1 if side_long else -1)
        return round(gross - rt["buy"]["total"] - sell_leg, 2)
    return {"estimate": {"required": round(required, 2), "available": usable,
                         "leverage": lev, "detail": f"{inst} leverage {lev}x"},
            "usable": usable, "live": acc["broker"] != "sim",
            "pnl": {"instrument": inst, "qtyUnits": qty_units,
                    "buyCharges": rt["buy"], "sellCharges": rt["sell"],
                    "totalCharges": rt["totalCharges"], "breakeven": rt["breakeven"],
                    "netIfUp1pct": _net(up, body.side.upper() != "SELL"),
                    "netIfDown1pct": _net(down, body.side.upper() != "SELL"),
                    "scheduleSource": "custom" if charges_config.get_override(int(body.accountId)) else "defaults"}}


# ================================================================== GTT rules
def _gtt_row(r: dict) -> dict:
    return {"id": str(r["id"]), "name": r["name"], "symbol": r["symbol"], "exchange": r["exchange"],
            "side": r["side"], "qty": r["qty"], "trigger": r["trigger"],
            "triggerPrice": r["trigger_price"], "orderType": r["order_type"],
            "productType": r["product_type"], "repeatDaily": bool(r["repeat_daily"]),
            "armed": bool(r["armed"]), "lastTriggeredAt": _iso(r["last_triggered_at"]),
            "lastStatus": r["last_status"], "lastMessage": r["last_message"],
            "createdAt": _iso(r["created_at"])}


@router.get("/gtt")
async def gtt_list(authorization: str = Header(default="")):
    uid(authorization)
    return {"rules": [_gtt_row(r) for r in db.core().query("SELECT * FROM gtt ORDER BY id DESC")]}


class GttReq(BaseModel):
    name: str
    symbol: str
    exchange: str = "NSE"
    side: str = "BUY"
    qty: int = 1
    trigger: str = "ABOVE"
    triggerPrice: float
    orderType: str = "LIMIT"
    productType: str = "MIS"
    repeatDaily: bool = False
    armed: bool = True


@router.post("/gtt")
async def gtt_create(body: GttReq, authorization: str = Header(default="")):
    uid(authorization)
    now = time.time()
    db.core().exec(
        "INSERT INTO gtt(name,symbol,exchange,side,qty,trigger,trigger_price,order_type,product_type,"
        "repeat_daily,armed,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (body.name, body.symbol.upper(), body.exchange, body.side.upper(), body.qty,
         body.trigger.upper(), body.triggerPrice, body.orderType, body.productType,
         1 if body.repeatDaily else 0, 1 if body.armed else 0, now))
    row = db.core().one("SELECT * FROM gtt ORDER BY id DESC LIMIT 1")
    return {"ok": True, "rule": _gtt_row(row)}


@router.patch("/gtt/{rule_id}")
async def gtt_patch(rule_id: int, body: dict, authorization: str = Header(default="")):
    uid(authorization)
    row = db.core().one("SELECT * FROM gtt WHERE id=?", (rule_id,))
    if not row:
        raise HTTPException(404, "rule not found")
    fields = {"name": "name", "symbol": "symbol", "side": "side", "qty": "qty",
              "trigger": "trigger", "triggerPrice": "trigger_price", "orderType": "order_type",
              "productType": "product_type", "armed": "armed", "repeatDaily": "repeat_daily"}
    sets, vals = [], []
    for k, col in fields.items():
        if k in body:
            v = body[k]
            if col in ("armed", "repeat_daily"):
                v = 1 if v else 0
            if col in ("symbol",):
                v = str(v).upper()
            sets.append(f"{col}=?")
            vals.append(v)
    if sets:
        vals.append(rule_id)
        db.core().exec(f"UPDATE gtt SET {', '.join(sets)} WHERE id=?", vals)
    return {"ok": True, "rule": _gtt_row(db.core().one("SELECT * FROM gtt WHERE id=?", (rule_id,)))}


@router.delete("/gtt/{rule_id}")
async def gtt_delete(rule_id: int, authorization: str = Header(default="")):
    uid(authorization)
    db.core().exec("DELETE FROM gtt WHERE id=?", (rule_id,))
    return {"ok": True}


# ================================================================== strategies
def _strategy_row(r: dict) -> dict:
    logs = db.core().query(
        "SELECT * FROM strategy_logs WHERE strategy_id=? ORDER BY id DESC LIMIT 30", (r["id"],))
    return {"id": str(r["id"]), "name": r["name"], "enabled": bool(r["enabled"]),
            "status": r["status"], "exchange": r["exchange"], "symbol": r["symbol"],
            "direction": r["direction"], "productType": r["product_type"],
            "orderType": r["order_type"], "qtyMode": r["qty_mode"], "fixedQty": r["fixed_qty"],
            "capitalAmount": r["capital_amount"], "entryTime": r["entry_time"],
            "entryWindowMin": r["entry_window_min"], "exitTime": r["exit_time"],
            "repeatDays": r["repeat_days"], "stopLossPct": r["stop_loss_pct"],
            "targetPct": r["target_pct"], "trailingSlPct": r["trailing_sl_pct"],
            "lastRunDate": r["last_run_date"], "entryPrice": r["entry_price"],
            "realizedPnl": r["realized_pnl"],
            "logs": [{"id": str(l["id"]), "ts": _iso(l["ts"]) or "", "level": l["level"],
                      "message": l["message"]} for l in logs]}


@router.get("/strategies")
async def strategies_list(authorization: str = Header(default="")):
    uid(authorization)
    return {"strategies": [_strategy_row(r) for r in
                           db.core().query("SELECT * FROM strategies ORDER BY id DESC")]}


@router.post("/strategies")
async def strategies_create(body: dict, authorization: str = Header(default="")):
    uid(authorization)
    now = time.time()
    db.core().exec(
        "INSERT INTO strategies(name,symbol,direction,product_type,order_type,qty_mode,fixed_qty,"
        "capital_amount,entry_time,entry_window_min,exit_time,repeat_days,stop_loss_pct,target_pct,"
        "trailing_sl_pct,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (body.get("name") or "Strategy", (body.get("symbol") or "").upper(),
         body.get("direction") or "BUY", body.get("productType") or "MIS",
         body.get("orderType") or "MARKET", body.get("qtyMode") or "FIXED",
         int(body.get("fixedQty") or 1), body.get("capitalAmount"),
         body.get("entryTime") or "09:20", int(body.get("entryWindowMin") or 10),
         body.get("exitTime") or "15:10", body.get("repeatDays") or "1,2,3,4,5",
         body.get("stopLossPct"), body.get("targetPct"), body.get("trailingSlPct"),
         1 if body.get("enabled", True) else 0, now))
    return {"ok": True}


@router.patch("/strategies/{sid}")
async def strategies_patch(sid: int, body: dict, authorization: str = Header(default="")):
    uid(authorization)
    row = db.core().one("SELECT * FROM strategies WHERE id=?", (sid,))
    if not row:
        raise HTTPException(404, "strategy not found")
    fields = {"name": "name", "enabled": "enabled", "symbol": "symbol", "direction": "direction",
              "productType": "product_type", "orderType": "order_type", "qtyMode": "qty_mode",
              "fixedQty": "fixed_qty", "capitalAmount": "capital_amount", "entryTime": "entry_time",
              "entryWindowMin": "entry_window_min", "exitTime": "exit_time",
              "repeatDays": "repeat_days", "stopLossPct": "stop_loss_pct",
              "targetPct": "target_pct", "trailingSlPct": "trailing_sl_pct"}
    sets, vals = [], []
    for k, col in fields.items():
        if k in body:
            v = body[k]
            if col == "enabled":
                v = 1 if v else 0
            if col == "symbol":
                v = str(v).upper()
            sets.append(f"{col}=?")
            vals.append(v)
    if sets:
        vals.append(sid)
        db.core().exec(f"UPDATE strategies SET {', '.join(sets)} WHERE id=?", vals)
    return {"ok": True}


@router.delete("/strategies/{sid}")
async def strategies_delete(sid: int, authorization: str = Header(default="")):
    uid(authorization)
    db.core().exec("DELETE FROM strategies WHERE id=?", (sid,))
    db.core().exec("DELETE FROM strategy_logs WHERE strategy_id=?", (sid,))
    return {"ok": True}


@router.get("/strategies/{sid}/python")
async def strategies_python(sid: int, authorization: str = Header(default="")):
    uid(authorization)
    r = db.core().one("SELECT * FROM strategies WHERE id=?", (sid,))
    if not r:
        raise HTTPException(404, "strategy not found")
    code = f'''"""
{r['name']} — exported from the terminal strategy builder.
Time-driven: entry window {r['entry_time']} (+{r['entry_window_min']}m) → exit {r['exit_time']}.
Drop into strategies/ and run via the Python runner (POST /pyapi/strategy/run).
"""
from terminal_sdk import get_candles, get_quote, log, signal

SYMBOL = "{r['symbol']}"
DIRECTION = "{r['direction']}"
ENTRY_TIME = "{r['entry_time']}"
EXIT_TIME = "{r['exit_time']}"
STOP_LOSS_PCT = {r['stop_loss_pct'] or 0}
TARGET_PCT = {r['target_pct'] or 0}


def run(ctx):
    quote = get_quote(ctx, SYMBOL)
    log(ctx, f"{{SYMBOL}} ltp={{quote['ltp']}}")
    signal(ctx, DIRECTION, SYMBOL, qty=1, price=quote['ltp'],
           note=f"{{ENTRY_TIME}} entry")
'''
    os.makedirs(os.path.join(config.PROJECT_ROOT, "strategies"), exist_ok=True)
    fname = f"strategy_{sid}_{(r['name'] or 's').replace(' ', '_').lower()}.py"
    path = os.path.join(config.PROJECT_ROOT, "strategies", fname)
    with open(path, "w") as f:
        f.write(code)
    return {"code": code, "filename": fname}


class PythonRunReq(BaseModel):
    id: Optional[str] = None
    code: Optional[str] = None
    symbol: Optional[str] = None
    tf: str = "5m"
    bars: int = 50
    dryRun: bool = True


@router.post("/strategy/run")
async def strategy_run(body: PythonRunReq, authorization: str = Header(default="")):
    uid(authorization)
    run_id = f"R{time.time_ns() // 1000000}"
    t0 = time.time()
    code = body.code
    if not code and body.id:
        code = (await strategies_python(int(body.id), authorization or ""))["code"]
    if not code:
        raise HTTPException(400, "no code to run (id or code required)")
    # sandboxed-ish exec: provide the SDK namespace, collect signals
    logs: list[str] = []
    signals: list[dict] = []

    def _log(ctx, msg):
        logs.append(str(msg))

    def _signal(ctx, side, symbol, qty=1, price=None, note=""):
        signals.append({"ts": _iso(time.time()), "symbol": symbol, "side": side,
                        "qty": qty, "price": price, "message": note})

    def _get_quote(ctx, symbol):
        hub = Hub.instance()
        t = hub.ticks.get(symbol.upper()) or {}
        return {"ltp": float(t.get("ltp") or 0), "bid": float(t.get("bid") or 0),
                "ask": float(t.get("ask") or 0)}

    def _get_candles(ctx, symbol, tf="5m", bars=50):
        resp = await_none(market_candles(symbol, tf, bars, authorization or ""))
        return resp.get("candles", [])

    def await_none(coro):
        try:
            loop = asyncio.get_event_loop()
            return loop.run_until_complete(coro) if not loop.is_running() else {}
        except Exception:
            return {}

    ctx = {"symbol": body.symbol, "tf": body.tf, "dry_run": body.dryRun}
    namespace = {"get_candles": _get_candles, "get_quote": _get_quote,
                 "log": _log, "signal": _signal, "ctx": ctx, "run": None}
    error = None
    try:
        exec(compile(code, "<strategy>", "exec"), namespace)  # noqa: S102 — admin tool
        if callable(namespace.get("run")):
            namespace["run"](ctx)
    except Exception as e:
        error = str(e)[:300]
        logs.append(f"ERROR: {error}")
    placed = 0
    if not body.dryRun:
        for s in signals:
            try:
                await Hub.instance().place_master_order({
                    "symbol": s["symbol"], "side": s["side"], "qty": s.get("qty") or 1,
                    "orderType": "MARKET", "productType": "MIS", "source": "PYTHON",
                })
                placed += 1
            except Exception as e:
                logs.append(f"order failed {s['symbol']}: {e}")
    return {"ok": not error, "runId": run_id, "logs": logs[-80:], "signals": signals,
            "ordersPlaced": placed, "error": error, "ms": int((time.time() - t0) * 1000)}


# ================================================================== auto rules
def _rule_row(r: dict) -> dict:
    return {"id": str(r["id"]), "name": r["name"], "underlying": r["underlying"],
            "expiry": r["expiry"], "kind": r["kind"], "level": r["level"], "cross": r["cross"],
            "lo": r["lo"], "hi": r["hi"], "time": r["time"], "entryOp": r["entry_op"],
            "entryLo": r["entry_lo"], "entryHi": r["entry_hi"], "action": r["action"],
            "optType": r["opt_type"], "offset": r["offset"],
            "strikes": json.loads(r["strikes"]) if r["strikes"] else None,
            "allocPct": r["alloc_pct"], "stopLoss": r["stop_loss"], "target": r["target"],
            "enabled": bool(r["enabled"]), "repeatDaily": bool(r["repeat_daily"]),
            "lastFiredDate": r["last_fired_date"], "lastFiredAt": _iso(r["last_fired_at"]),
            "lastStatus": r["last_status"], "lastMessage": r["last_message"],
            "fireCount": r["fire_count"], "createdAt": _iso(r["created_at"])}


@router.get("/autorules")
async def autorules_list(authorization: str = Header(default="")):
    uid(authorization)
    return {"rules": [_rule_row(r) for r in db.core().query("SELECT * FROM autorules ORDER BY id DESC")]}


@router.post("/autorules")
async def autorules_create(body: dict, authorization: str = Header(default="")):
    uid(authorization)
    now = time.time()
    db.core().exec(
        "INSERT INTO autorules(name,underlying,expiry,kind,level,cross,lo,hi,time,entry_op,"
        "entry_lo,entry_hi,action,opt_type,offset,strikes,alloc_pct,stop_loss,target,enabled,"
        "repeat_daily,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (body.get("name") or "Rule", (body.get("underlying") or "NIFTY").upper(),
         body.get("expiry"), body.get("kind") or "INDEX", body.get("level"),
         body.get("cross") or "ABOVE", body.get("lo"), body.get("hi"), body.get("time"),
         body.get("entryOp"), body.get("entryLo"), body.get("entryHi"),
         body.get("action") or "BUY", body.get("optType") or "CE",
         int(body.get("offset") or 0),
         json.dumps(body.get("strikes")) if body.get("strikes") else None,
         float(body.get("allocPct") or 25), body.get("stopLoss"), body.get("target"),
         1 if body.get("enabled", True) else 0, 1 if body.get("repeatDaily") else 0, now))
    row = db.core().one("SELECT * FROM autorules ORDER BY id DESC LIMIT 1")
    return {"ok": True, "rule": _rule_row(row)}


@router.patch("/autorules/{rule_id}")
async def autorules_patch(rule_id: int, body: dict, authorization: str = Header(default="")):
    uid(authorization)
    row = db.core().one("SELECT * FROM autorules WHERE id=?", (rule_id,))
    if not row:
        raise HTTPException(404, "rule not found")
    fields = {"name": "name", "underlying": "underlying", "expiry": "expiry", "kind": "kind",
              "level": "level", "cross": "cross", "lo": "lo", "hi": "hi", "time": "time",
              "entryOp": "entry_op", "entryLo": "entry_lo", "entryHi": "entry_hi",
              "action": "action", "optType": "opt_type", "offset": "offset",
              "allocPct": "alloc_pct", "stopLoss": "stop_loss", "target": "target",
              "enabled": "enabled", "repeatDaily": "repeat_daily"}
    sets, vals = [], []
    for k, col in fields.items():
        if k in body:
            v = body[k]
            if col in ("enabled", "repeat_daily"):
                v = 1 if v else 0
            sets.append(f"{col}=?")
            vals.append(v)
    if sets:
        vals.append(rule_id)
        db.core().exec(f"UPDATE autorules SET {', '.join(sets)} WHERE id=?", vals)
    return {"ok": True}


@router.delete("/autorules/{rule_id}")
async def autorules_delete(rule_id: int, authorization: str = Header(default="")):
    uid(authorization)
    db.core().exec("DELETE FROM autorules WHERE id=?", (rule_id,))
    return {"ok": True}


# ================================================================== diagnostics
@router.post("/broker-test")
async def broker_test(body: dict, authorization: str = Header(default="")):
    uid(authorization)
    aid = int(body.get("accountId") or 0)
    acc = db.core().one("SELECT * FROM accounts WHERE id=?", (aid,))
    if not acc:
        raise HTTPException(404, "account not found")
    hub = Hub.instance()
    adapter = hub.adapters.get(aid)
    steps = []
    t0 = time.perf_counter()
    # step 1 credentials
    steps.append({"step": "credentials", "ok": bool(acc["credentials"] and acc["credentials"] != "{}"),
                  "ms": int((time.perf_counter() - t0) * 1000),
                  "detail": "stored credentials present" if acc["credentials"] else "no credentials saved"})
    # step 2 connection
    t1 = time.perf_counter()
    steps.append({"step": "mode", "ok": bool(adapter), "ms": int((time.perf_counter() - t1) * 1000),
                  "detail": f"account mode {acc['mode']}" + ("" if adapter else " — NOT connected")})
    # step 3 funds
    t2 = time.perf_counter()
    funds_ok, funds_detail = False, "adapter not connected"
    if adapter:
        try:
            f = await adapter.get_funds()
            avail = float((f or {}).get("available") or 0)
            funds_ok, funds_detail = True, f"available ₹{avail:,.0f}"
        except Exception as e:
            funds_detail = str(e)[:140]
    steps.append({"step": "funds", "ok": funds_ok, "ms": int((time.perf_counter() - t2) * 1000),
                  "detail": funds_detail})
    # step 4 quote
    t3 = time.perf_counter()
    q_ok, q_detail = False, "no symbol subscribed"
    test_sym = next((s for s in list(hub.ticks)[:1]), None)
    if test_sym:
        q_ok = True
        q_detail = f"{test_sym} LTP {hub.ticks[test_sym].get('ltp')}"
    steps.append({"step": "quote", "ok": q_ok, "ms": int((time.perf_counter() - t3) * 1000),
                  "detail": q_detail})
    ok = all(s["ok"] for s in steps)
    hint = "" if ok else "check credentials + broker session in Admin → Session, then Broker Diagnostics again"
    return {"ok": ok, "accountId": str(aid), "label": acc["label"],
            "brokerType": acc["broker"].upper(), "steps": steps, "hint": hint}


@router.get("/broker-logs")
async def broker_logs(accountId: str, authorization: str = Header(default="")):
    uid(authorization)
    rows = db.core().query("SELECT * FROM broker_logs WHERE account_id=? ORDER BY id DESC LIMIT 120",
                           (int(accountId),))
    return {"logs": [{"id": r["id"], "ts": _iso(r["ts"]) or "", "level": r["level"],
                      "message": r["message"]} for r in rows]}


@router.get("/admin/audit")
async def admin_audit(authorization: str = Header(default="")):
    uid(authorization)
    rows = db.core().query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 120")
    return {"audits": [{"id": str(r["id"]), "ts": _iso(r["ts"]) or "", "source": r["source"],
                        "action": r["action"], "masterSymbol": r["master_symbol"],
                        "side": r["side"], "qty": r["qty"], "status": r["status"],
                        "message": r["message"], "legsJson": r["legs_json"]} for r in rows]}


# ================================================================== copy trade
@router.get("/copytrade")
async def copytrade_get(authorization: str = Header(default="")):
    uid(authorization)
    r = db.core().one("SELECT * FROM copytrade WHERE id=1")
    return {"config": _copytrade_cfg(r)}


def _copytrade_cfg(r: dict) -> dict:
    return {"id": str(r["id"]), "enabled": bool(r["enabled"]),
            "masterAccountId": r["master_account_id"], "capitalSharePct": r["capital_share_pct"],
            "slippagePct": r["slippage_pct"], "roundToLot": bool(r["round_to_lot"]),
            "skipFailedLegs": bool(r["skip_failed_legs"]), "killSwitch": bool(r["kill_switch"])}


@router.patch("/copytrade")
async def copytrade_patch(body: dict, authorization: str = Header(default="")):
    uid(authorization)
    fields = {"enabled": "enabled", "masterAccountId": "master_account_id",
              "capitalSharePct": "capital_share_pct", "slippagePct": "slippage_pct",
              "roundToLot": "round_to_lot", "skipFailedLegs": "skip_failed_legs",
              "killSwitch": "kill_switch"}
    sets, vals = [], []
    for k, col in fields.items():
        if k in body:
            v = body[k]
            if col in ("enabled", "round_to_lot", "skip_failed_legs", "kill_switch"):
                v = 1 if v else 0
            sets.append(f"{col}=?")
            vals.append(v)
    if sets:
        vals.append(1)
        db.core().exec(f"UPDATE copytrade SET {', '.join(sets)} WHERE id=?", vals)
    return {"config": _copytrade_cfg(db.core().one("SELECT * FROM copytrade WHERE id=1"))}


# ================================================================== tick recorder
RECORDER_CFG = os.path.join(config.DATA_DIR, "tick-recorder.json")


def _recorder_cfg() -> dict:
    try:
        with open(RECORDER_CFG) as f:
            return json.load(f)
    except Exception:
        return {"enabled": False, "symbols": []}


def _save_recorder_cfg(cfg: dict) -> None:
    with open(RECORDER_CFG, "w") as f:
        json.dump(cfg, f)


@router.get("/tickrecorder")
async def tickrecorder_get(authorization: str = Header(default="")):
    uid(authorization)
    cfg = _recorder_cfg()
    tick_dir = os.path.join(config.DATA_DIR, "ticks")
    sessions = []
    if os.path.isdir(tick_dir):
        for fn in sorted(os.listdir(tick_dir))[-12:]:
            p = os.path.join(tick_dir, fn)
            if os.path.isfile(p):
                sessions.append({"file": fn, "bytes": os.path.getsize(p),
                                 "mtime": datetime.fromtimestamp(os.path.getmtime(p)).isoformat()})
    cur = os.path.join(tick_dir, "session-live.jsonl")
    rows = 0
    if os.path.isfile(cur) and cfg.get("enabled"):
        with open(cur, "rb") as f:
            rows = sum(1 for _ in f)
    session = {"file": "session-live.jsonl", "startedAt": cfg.get("startedAt", ""),
               "rows": rows} if cfg.get("enabled") else None
    return {"enabled": cfg.get("enabled", False), "symbols": cfg.get("symbols", []),
            "session": session, "sessions": sessions}


@router.post("/tickrecorder")
async def tickrecorder_post(body: dict, authorization: str = Header(default="")):
    uid(authorization)
    cfg = _recorder_cfg()
    if "enabled" in body:
        cfg["enabled"] = bool(body["enabled"])
        cfg["startedAt"] = datetime.now().isoformat() if cfg["enabled"] else None
    if "symbols" in body:
        cfg["symbols"] = [s.upper() for s in body["symbols"]]
    _save_recorder_cfg(cfg)
    return {"ok": True, "enabled": cfg["enabled"], "symbols": cfg["symbols"]}


# ================================================================== replay
REPLAY_STATE = {"active": False, "file": None, "speed": 1.0, "startedAt": None,
                "total": 0, "played": 0, "symbols": []}


@router.get("/replay")
async def replay_get(authorization: str = Header(default="")):
    uid(authorization)
    s = REPLAY_STATE
    return {"active": s["active"], "file": s["file"], "speed": s["speed"],
            "startedAt": s["startedAt"], "total": s["total"], "played": s["played"],
            "symbols": s["symbols"], "progressPct": (s["played"] / s["total"] * 100) if s["total"] else 0}


@router.post("/replay")
async def replay_post(body: dict, authorization: str = Header(default="")):
    uid(authorization)
    from backend import engines
    if body.get("mode") == "start":
        file = body.get("file") or os.path.join(config.DATA_DIR, "ticks", "session-live.jsonl")
        if not os.path.isfile(file):
            raise HTTPException(400, f"no recorded session at {os.path.basename(file)}")
        await engines.start_replay(file, float(body.get("speed") or 1.0))
    else:
        await engines.stop_replay()
    s = REPLAY_STATE
    return {"active": s["active"], "file": s["file"], "speed": s["speed"],
            "startedAt": s["startedAt"], "total": s["total"], "played": s["played"],
            "symbols": s["symbols"], "progressPct": (s["played"] / s["total"] * 100) if s["total"] else 0}


# ================================================================== broker order book
@router.get("/broker-orderbook")
async def broker_orderbook(accountId: str, authorization: str = Header(default="")):
    uid(authorization)
    hub = Hub.instance()
    adapter = hub.adapters.get(int(accountId))
    if not adapter:
        return {"orders": [], "live": False, "message": "account not connected"}
    try:
        raw = await adapter.get_orderbook()
        out = []
        for o in raw or []:
            out.append({
                "brokerOrderId": str(o.get("broker_order_id") or o.get("order_id") or ""),
                "symbol": o.get("symbol", ""), "side": o.get("side", ""),
                "qty": int(o.get("qty", 0)), "filledQty": int(o.get("filled_qty", 0) or 0),
                "status": (o.get("status") or "").upper(),
                "avgPrice": o.get("avg_price"), "orderType": o.get("order_type"),
                "ts": _iso(o.get("created_at") or time.time()),
            })
        return {"orders": out, "live": True}
    except Exception as e:
        return {"orders": [], "live": False, "message": str(e)[:160]}


# ================================================================== broker session auth descriptor
@router.get("/broker-auth")
async def broker_auth_status(accountId: str, authorization: str = Header(default="")):
    uid(authorization)
    aid = int(accountId)
    acc = db.core().one("SELECT * FROM accounts WHERE id=?", (aid,))
    if not acc:
        raise HTTPException(404, "account not found")
    import json as _json
    try:
        creds = _json.loads(acc["credentials"] or "{}")
    except Exception:
        creds = {}
    sess = db.core().one("SELECT session_token FROM broker_sessions WHERE account_id=?", (aid,))
    broker = acc["broker"].lower()
    field_specs = {
        "breeze": [("api_key", "App Key", "••••", "your-breeze-app-key"),
                   ("api_secret", "App Secret", "••••", "your-breeze-app-secret")],
        "dhan": [("client_id", "Dhan Client ID", "", "e.g. 1101234567"),
                 ("pin_totp", "PIN:TOTP", "", "123456:987654")],
        "shoonya": [("api_key", "API Key (user)", "", "e.g. 123456_U"),
                    ("api_secret", "API Secret", "••••", "your-shoonya-secret")],
    }
    spec = field_specs.get(broker, [("api_key", "API Key", "", "")])
    cred_fields = []
    for key, label, _m, sample in spec:
        masked = ("••••" + creds[key][-4:]) if creds.get(key) else None
        cred_fields.append({"key": key, "label": label, "masked": masked, "sample": sample})
    login_urls = {
        "breeze": "https://api.icicidirect.com/breezeapi/index.json",
        "shoonya": f"https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id={{client_id}}",
        "dhan": "https://auth.dhan.co/login?consoleType=web",
    }
    instructions = {
        "breeze": ["Open the Breeze apiuser login URL", "After redirect copy ?apisession= value",
                   "Paste it as the session code below"],
        "dhan": ["Save credentials first", "Press Generate consent", "Complete the Dhan login, paste the redirect tokenId"],
        "shoonya": ["Open the OAuth URL with your client_id", "Login and copy the ?code= from the redirect",
                    "Paste the FRESH code below (single-use)"],
    }
    return {
        "accountId": str(aid), "label": acc["label"], "brokerType": acc["broker"].upper(),
        "sessionKind": "daily", "hasSession": bool(sess and sess["session_token"]),
        "sessionMasked": (("••••" + sess["session_token"][-4:]) if sess and sess["session_token"] else None),
        "userId": creds.get("user_id") or creds.get("client_id"),
        "liveCapable": acc["broker"] != "sim", "mode": acc["mode"],
        "loginUrl": login_urls.get(broker), "instructions": instructions.get(broker, []),
        "fieldsNeeded": [c["key"] for c in cred_fields if not creds.get(c["key"])],
        "credFields": cred_fields,
    }


# ================================================================== FNO session simulator
@router.get("/fnosim")
async def fnosim_status(authorization: str = Header(default="")):
    uid(authorization)
    from backend import fnosim
    svc = fnosim.SVC
    sessions = db.core().query(
        "SELECT * FROM fnosim_sessions ORDER BY id DESC LIMIT 12")
    return {"status": svc.status(),
            "live": svc.status().get("live", []),
            "sessions": [{"id": s["id"], "underlying": s["underlying"],
                          "sessionDate": s["session_date"], "expiry": s["expiry"],
                          "ivPct": round((s["iv"] or 0) * 100, 1), "speed": s["speed"],
                          "status": s["status"], "source": s["source"],
                          "createdAt": _iso(s["created_at"]),
                          "finishedAt": _iso(s["finished_at"])} for s in sessions]}


class FnoSimReq(BaseModel):
    action: str                       # start | stop | patch | random
    underlying: Optional[str] = None
    underlyings: Optional[list[str]] = None   # MULTI — a list of F&O stocks/indices
    sessionDate: Optional[str] = None    # YYYY-MM-DD (historical trading day)
    expiry: Optional[str] = None
    expiryDt: Optional[str] = None       # custom expiry 'YYYY-MM-DD HH:MM' IST; empty → today
    ivPct: Optional[float] = None
    speed: Optional[float] = None
    band: Optional[int] = None
    prevDays: Optional[int] = None


@router.post("/fnosim")
async def fnosim_ctrl(req: FnoSimReq, authorization: str = Header(default="")):
    uid(authorization)
    from backend import fnosim
    svc = fnosim.SVC
    if req.action == "start":
        unds = [u for u in (req.underlyings or []) if u and u.strip()]
        if req.underlying and req.underlying.strip():
            unds.append(req.underlying.strip())
        if not unds or not req.sessionDate:
            raise HTTPException(400, "underlyings (list) + sessionDate required")
        try:
            status = await svc.start(unds, req.sessionDate, req.expiryDt or req.expiry,
                                     iv_pct=req.ivPct if req.ivPct is not None else 25.0,
                                     speed=req.speed if req.speed is not None else 5.0,
                                     band=req.band if req.band is not None else 10,
                                     prev_days=req.prevDays if req.prevDays is not None else 5)
            return {"ok": True, "status": status}
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(500, f"session start failed: {str(e)[:200]}")
    if req.action == "stop":
        return {"ok": True, "status": svc.stop(req.underlying)}
    if req.action == "play":
        return {"ok": True, "status": svc.play(req.underlying)}
    if req.action == "pause":
        return {"ok": True, "status": svc.pause(req.underlying)}
    if req.action == "patch":
        return {"ok": True, "status": svc.patch(req.ivPct, req.speed, req.underlying)}
    if req.action == "random":
        try:
            pick = svc.random_pick()
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"ok": True, "pick": pick}
    raise HTTPException(400, f"unknown action {req.action}")
