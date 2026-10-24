"""
SIM adapter — paper trading broker with virtual funds.

Auth is instant (sim never needs network), funds/positions/orders are stored
in core.db and marked source=sim. Respects the global trading mode: when the
terminal is LIVE ONLY, the hub will not route sim data to live accounts
(enforced centrally; the adapter simply declares itself sandboxable).
"""
from __future__ import annotations

from typing import Optional
import json
import random
import time

from backend import config, db, session_store
from backend.brokers.base import BaseBroker
from backend.brokers.sim import mapping as sim_mapping


def _spot_of_underlying(under_name: str) -> float:
    """Sim spot for an underlying (mapping base — deterministic)."""
    for idx in sim_mapping.INDEXES:
        if idx["symbol"].split(":")[1] == under_name:
            return float(idx["base"])
    for eq in sim_mapping.EQUITIES:
        if eq["symbol"].split(":")[1] == under_name or under_name.startswith(eq["symbol"].split(":")[1]):
            return float(eq["base"])
    return 0.0


def option_premium(row: dict, spot: Optional[float] = None) -> float:
    """Realistic option premium: intrinsic + time value (shared by the tick
    stream base AND synthesized history so charts and LTP never disagree)."""
    import math as _m
    under = (row.get("symbol") or "").split(":")[-1]
    under_name = None
    for u in ("BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "NIFTY"):
        if under.startswith(u):
            under_name = u
            break
    if spot is None:
        spot = _spot_of_underlying(under_name or under)
        if not spot:
            spot = next((e["base"] for e in sim_mapping.EQUITIES
                         if under.startswith(e["symbol"].split(":")[1])), 0)
    strike = float(row.get("strike") or 0)
    right = row.get("right") or "CE"
    if not spot or not strike:
        return round(random.Random(row.get("symbol", "x")).uniform(50, 800), 2)
    intrinsic = max(0.0, spot - strike) if right == "CE" else max(0.0, strike - spot)
    # time value decays with expiry distance (expiries like 29OCT26)
    days = 7.0
    try:
        from datetime import datetime
        exp = row.get("expiry") or ""
        exp_dt = datetime.strptime(exp, "%d%b%y")
        days = max(0.5, (exp_dt - datetime.now()).total_seconds() / 86400)
    except Exception:
        pass
    tv = spot * 0.0075 * _m.sqrt(days / 7.0)
    return max(0.05, intrinsic * 0.85 + tv)


class SimAdapter(BaseBroker):
    name = "sim"

    # ------------------------------------------------------------------ lifecycle
    async def authenticate(self) -> dict:
        stored = session_store.get(self.account_id)
        if stored and stored.get("session_token"):
            self.session = {"token": stored["session_token"],
                            "user_id": session_store.meta_of(stored).get("user_id", "simuser")}
            session_store.mark_validated(self.account_id)
            self.connected = True
            self.log("reused persisted sim session (no re-connect needed on refresh)")
            return self.session
        token = f"SIM-{random.randint(100000, 999999)}"
        self.session = {"token": token, "user_id": "simuser"}
        session_store.save(self.account_id, self.name, token, None, {"user_id": "simuser"})
        self.connected = True
        self.log("fresh sim session generated + persisted")
        return self.session

    async def validate_session(self) -> bool:
        return bool(self.session.get("token"))

    async def disconnect(self) -> None:
        self.connected = False

    # ------------------------------------------------------------------ helpers
    def _funds_row(self) -> dict:
        row = db.core().one(
            "SELECT data FROM funds_snapshot WHERE account_id=?", (self.account_id,))
        if row:
            try:
                return json.loads(row["data"])
            except Exception:
                pass
        return {"available": 1_000_000.0, "used": 0.0, "total": 1_000_000.0}

    def _save_funds(self, data: dict) -> None:
        db.core().exec(
            "INSERT INTO funds_snapshot(account_id,data,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(account_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
            (self.account_id, json.dumps(data), time.time()))

    # ------------------------------------------------------------------ funds / positions
    async def get_funds(self) -> dict:
        return self._funds_row()

    async def get_positions(self) -> list[dict]:
        rows = db.core().query(
            "SELECT * FROM positions WHERE account_id=? AND qty<>0", (self.account_id,))
        return [{
            "symbol": r["symbol"], "qty": r["qty"], "avg_price": r["avg_price"],
            "ltp": r["ltp"], "pnl": r["pnl"], "product": r["product"],
        } for r in rows]

    async def get_orderbook(self) -> list[dict]:
        rows = db.core().query(
            "SELECT * FROM orders WHERE account_id=? ORDER BY id DESC LIMIT 100", (self.account_id,))
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------ orders (instant fill)
    async def place_order(self, symbol, side, qty, order_type="MARKET", price=None,
                          product="MIS", trigger_price=None) -> dict:
        ltp = self._last_ltp(symbol)
        if not ltp:
            raise Exception(f"no sim feed price yet for {symbol} — subscribe first")
        fill = ltp if order_type == "MARKET" else (price or ltp)
        fill = round(fill * (1.0002 if side.upper() == "BUY" else 0.9998), 2)
        funds = self._funds_row()
        margin = fill * qty
        if side.upper() == "BUY" and margin > funds["available"] + 1e-9:
            raise Exception(f"insufficient sim funds: need {margin:.0f}, available {funds['available']:.0f}")
        now = time.time()
        broker_order_id = f"S{random.randint(10**9, 10**10 - 1)}"
        c = db.core()
        c.exec("""INSERT INTO orders(account_id,broker,symbol,side,qty,price,order_type,product,
                   status,filled_qty,avg_price,broker_order_id,created_at,updated_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
               (self.account_id, self.name, symbol, side.upper(), qty, price, order_type,
                product, "complete", qty, fill, broker_order_id, now, now))
        self._apply_fill(symbol, side.upper(), qty, fill, product)
        if side.upper() == "BUY":
            avail = funds["available"] - margin
            used = funds["used"] + margin
        else:
            avail = funds["available"] + margin * 0.98
            used = max(0.0, funds["used"] - margin)
        self._save_funds({"available": round(avail, 2), "used": round(used, 2),
                          "total": round(avail + used, 2)})
        self.log(f"order filled {side} {qty} {symbol} @ {fill} id={broker_order_id}")
        return {"order_id": broker_order_id, "status": "complete", "filled_price": fill}

    async def cancel_order(self, broker_order_id, symbol="") -> dict:
        return {"order_id": broker_order_id, "status": "cancelled"}

    def _last_ltp(self, symbol: str) -> Optional[float]:
        # live stream state first, then hub's last-tick cache (any key form),
        # then master base
        from backend.market.hub import Hub
        hub = Hub.instance()
        stream = hub.streams.get(hub.sim_account_id) if hub else None
        st = stream.subscribed.get(sim_mapping.token_of(symbol)) if stream else None
        if st:
            return round(st["ltp"], 2)
        tick = (hub.ticks.get(symbol) if hub else None) or {}
        if not tick.get("ltp"):
            for sym, t in (hub.ticks if hub else {}).items():
                if sym == f"NSE:{symbol}" or sym.split(":")[-1] == symbol:
                    tick = t
                    break
        if tick.get("ltp"):
            return round(tick["ltp"], 2)
        row = db.broker_db("sim").one(
            "SELECT strike,symbol FROM master WHERE symbol=? OR symbol=?",
            (symbol, f"NSE:{symbol}"))
        if row:
            import random as _r
            return round(row["strike"] or _r.Random(symbol).uniform(300, 4000), 2)
        return None

    def _apply_fill(self, symbol: str, side: str, qty: float, price: float, product: str) -> None:
        c = db.core()
        row = c.one("SELECT * FROM positions WHERE account_id=? AND symbol=? AND product=?",
                    (self.account_id, symbol, product))
        signed = qty if side == "BUY" else -qty
        if not row:
            c.exec("""INSERT INTO positions(account_id,broker,symbol,qty,avg_price,ltp,pnl,product,updated_at)
                      VALUES(?,?,?,?,?,?,0,?,?)""",
                   (self.account_id, self.name, symbol, signed, price, price, product, time.time()))
            return
        new_qty = row["qty"] + signed
        if abs(new_qty) < 1e-9:
            c.exec("DELETE FROM positions WHERE id=?", (row["id"],))
            return
        if row["qty"] * signed < 0 or abs(row["qty"] + signed) > abs(row["qty"]):
            # increasing or flipping: weighted average on the increasing side
            new_avg = ((row["avg_price"] * abs(row["qty"]) + price * qty)
                       / (abs(row["qty"]) + qty)) if row["qty"] * signed > 0 else price
        else:
            new_avg = row["avg_price"]
        c.exec("UPDATE positions SET qty=?, avg_price=?, updated_at=? WHERE id=?",
               (new_qty, round(new_avg, 2), time.time(), row["id"]))

    # ------------------------------------------------------------------ history / master
    def _universe_rows(self) -> list[dict]:
        """Round-27: the sim universe is the sim MASTER table (so symbols added
        at runtime — e.g. via option-chain ensure-strike — are served), with
        build_universe() as the empty-DB fallback."""
        try:
            rows = db.broker_db("sim").query(
                "SELECT token,symbol,name,exchange,instrument,expiry,strike,right,lotsize FROM master")
            if rows:
                return [dict(r) for r in rows]
        except Exception:
            pass
        return sim_mapping.build_universe()

    async def get_history(self, symbol: str, tf_minutes: int, days: int) -> list[dict]:
        """Synthesized history priced like the LIVE stream (options at premium
        level, spot at mapping base) and ANCHORED so the last candle closes at
        the exact base the tick stream starts from — no chart/LTP jump."""
        info = next((u for u in self._universe_rows()
                     if u["symbol"] == symbol or u["symbol"] == f"NSE:{symbol}"
                     or u["symbol"].split(":")[-1] == symbol), None)
        if not info:
            return []
        inst = (info.get("instrument") or "EQ").upper()
        if inst == "OPT":
            base = option_premium(info)
        elif inst == "FUT":
            base = _spot_of_underlying(symbol.split(":")[-1]) * 1.002 \
                or random.Random(symbol).uniform(300, 4000)
        else:
            base = _spot_of_underlying(symbol.split(":")[-1]) \
                or info.get("strike") or random.Random(symbol).uniform(300, 4000)
        out = []
        t = int(time.time()) - days * 86400
        t -= t % 60
        rnd = random.Random(f"{symbol}{tf_minutes}")
        px = base * rnd.uniform(0.97, 1.03)
        step = tf_minutes * 60
        end = int(time.time()) - 60
        while t < end:
            # NSE market hours 09:15-15:30 IST
            ist = time.gmtime(t + 19800)
            hm = ist.tm_hour * 100 + ist.tm_min
            if 915 <= hm <= 1530:
                o = px
                px = max(0.5, px * (1 + rnd.gauss(0, 0.0012)))
                h = max(o, px) * (1 + rnd.uniform(0, 0.0006))
                l = min(o, px) * (1 - rnd.uniform(0, 0.0006))
                out.append({"t": t, "o": o, "h": h, "l": l, "c": px,
                            "v": int(rnd.uniform(1e3, 9e4))})
            t += step
        if not out:
            return out
        # anchor: rescale the whole walk so the LAST close == base (the price
        # the live tick stream starts at) -> seamless history->live handoff
        scale = base / out[-1]["c"] if out[-1]["c"] else 1.0
        for c in out:
            c["o"] = round(c["o"] * scale, 2)
            c["h"] = round(c["h"] * scale, 2)
            c["l"] = round(c["l"] * scale, 2)
            c["c"] = round(c["c"] * scale, 2)
        return out

    async def sync_master(self) -> dict:
        rows = sim_mapping.build_universe()
        bdb = db.broker_db("sim")
        bdb.exec("DELETE FROM master")
        bdb.executemany(
            "INSERT OR REPLACE INTO master(token,symbol,name,exchange,instrument,expiry,strike,right,lotsize) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [(r["token"], r["symbol"], r["name"], r["exchange"], r["instrument"],
              r["expiry"], r["strike"], r["right"], r["lotsize"]) for r in rows])
        bdb.exec("INSERT INTO sync_log(broker,source_url,source_kind,symbols,mappings,replaced,detail,ts)"
                 " VALUES(?,?,?,?,?,1,?,?)",
                 ("sim", "generated://sim-universe", "generated", len(rows), len(rows),
                  f"expiries={sorted({r['expiry'] for r in rows if r['expiry']})}", time.time()))
        return {"source_url": "generated://sim-universe", "source_kind": "generated",
                "symbols": len(rows), "mappings": len(rows), "replaced": True}

    # ------------------------------------------------------------------ streaming
    def make_stream(self, on_tick):
        from backend.brokers.sim.streaming import SimStream

        universe: dict[str, dict] = {}
        for r in self._universe_rows():
            inst = (r.get("instrument") or "EQ").upper()
            if inst == "OPT":
                base = option_premium(r)          # same model as get_history
            elif inst == "FUT":
                base = _spot_of_underlying(r["symbol"].split(":")[-1]) * 1.002
            else:
                base = _spot_of_underlying(r["symbol"].split(":")[-1]) \
                    or r.get("strike") or random.Random(r["symbol"]).uniform(300, 4000)
            universe[r["token"]] = {**r, "base": round(base, 2),
                                    "vol": 0.0008 if inst == "OPT" else 0.0007}
        # Round-27: tokens added to the sim master AFTER the stream started
        # (auto-ensure on first chart open) resolve on demand
        def _lookup(tok: str) -> Optional[dict]:
            for r in self._universe_rows():
                if r.get("token") == tok:
                    inst = (r.get("instrument") or "EQ").upper()
                    if inst == "OPT":
                        base = option_premium(r)
                    elif inst == "FUT":
                        base = _spot_of_underlying(r["symbol"].split(":")[-1]) * 1.002
                    else:
                        base = _spot_of_underlying(r["symbol"].split(":")[-1]) \
                            or r.get("strike") or random.Random(r["symbol"]).uniform(300, 4000)
                    return {**r, "base": round(base, 2),
                            "vol": 0.0008 if inst == "OPT" else 0.0007}
            return None
        return SimStream(on_tick, universe, lookup=_lookup)
