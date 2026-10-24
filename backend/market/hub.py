"""
MarketHub — the single routing point between broker feeds and UI clients
(OpenAlgo-style: adapters register here; UI never talks to brokers directly).

Responsibilities:
  - manage connected accounts (adapter + stream client per account)
  - resolve subscription: unified symbol -> source account -> broker token
  - fan out ticks/candles to socket.io clients (rooms per interest)
  - aggregate ticks -> 1m candles (aggregator) with live candle push
  - enforce global trading mode (LIVE ONLY never attaches sim/sandbox)
  - drive funds pushes on order/position events (event-driven, never polled)
  - feed SOURCE management (sim / one broker account) + purge on switch
  - master-order fanout with per-account capital sizing + trade charges
"""
from __future__ import annotations

from typing import Optional
import asyncio
import json
import threading
import time
from collections import defaultdict, deque

from backend import config, db
from backend.market.aggregator import CandleAggregator
from backend.market.funds import SVC as FUNDS


class Hub:
    _instance: "Optional[Hub]" = None
    _lock = threading.Lock()

    @classmethod
    def instance(cls) -> "Hub":
        with cls._lock:
            if cls._instance is None:
                cls._instance = Hub()
            return cls._instance

    # ------------------------------------------------------------------ init
    def __init__(self):
        self.adapters: dict[int, object] = {}          # account_id -> adapter
        self.streams: dict[int, object] = {}           # account_id -> stream client
        self.token_map: dict[int, dict] = {}           # account_id -> token -> unified symbol
        self.symbol_source: dict[str, int] = {}        # symbol -> account_id serving it
        self.symbol_refs: dict[str, set] = defaultdict(set)   # symbol -> sio sids
        self.sockets: dict[str, dict] = {}             # sio sid -> {symbols, candle, tf}
        self.ticks: dict[str, dict] = {}               # unified symbol -> last tick
        self.agg = CandleAggregator()
        self.sio = None                                 # socket.io ASGI server (set later)
        self._push_lock = asyncio.Lock()
        self._last_pos_push = 0.0
        self.sim_account_id: Optional[int] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        # ---- feed source + health (quantdesk parity) ----
        self._feed_started_at = time.time()
        self._last_tick_ts: Optional[float] = None
        self._last_error: Optional[str] = None
        self._error_ts: Optional[float] = None
        self._tick_count = 0
        self._feed_log: deque[str] = deque(maxlen=60)
        self._sync_subs: dict[str, dict] = {}          # sid -> {chains, index}
        self.epoch = 0                                  # bumped on source switch (purge)

    def feed_note(self, msg: str, level: str = "INFO") -> None:
        self._feed_log.appendleft(f"{time.strftime('%H:%M:%S')} {msg}")
        if level in ("WARN", "ERROR"):
            self._last_error = msg
            self._error_ts = time.time()

    # ------------------------------------------------------------------ settings
    def trading_mode(self) -> str:
        row = db.core().one("SELECT value FROM settings WHERE key='trading_mode'")
        return (row["value"] if row else config.DEFAULT_TRADING_MODE)

    def set_trading_mode(self, mode: str) -> None:
        db.core().exec("INSERT INTO settings(key,value) VALUES('trading_mode',?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (mode,))
        config.log("hub", f"trading mode set to {mode.upper()}")
        if self.loop:
            self.loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self.enforce_mode()))

    # ------------------------------------------------------------------ feed source
    def feed_source(self) -> str:
        row = db.core().one("SELECT value FROM settings WHERE key='feed_source'")
        src = row["value"] if row else "sim"
        # the stored source account may have been deleted — fall back to sim
        if src != "sim":
            try:
                if int(src) not in self.adapters:
                    return "sim"
            except ValueError:
                return "sim"
        return src

    def sim_disabled(self) -> bool:
        row = db.core().one("SELECT value FROM settings WHERE key='sim_disabled'")
        return (row["value"] if row else "0") == "1"

    def set_sim_disabled(self, flag: bool) -> None:
        db.core().exec("INSERT INTO settings(key,value) VALUES('sim_disabled',?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       ("1" if flag else "0",))
        config.log("hub", f"sim feed {'DISABLED (LIVE-ONLY)' if flag else 'enabled'}")
        if flag:
            self._purge_sim_data()

    def feed_sources(self) -> list[dict]:
        out = [{"id": "sim", "label": "Sim Feed (built-in)", "brokerType": "SIMFEED",
                "hasSession": not self.sim_disabled()}]
        for acc in db.core().query("SELECT id,broker,label,mode,status FROM accounts WHERE broker<>'sim' ORDER BY id"):
            sess = db.core().one("SELECT session_token FROM broker_sessions WHERE account_id=?", (acc["id"],))
            out.append({"id": str(acc["id"]), "label": acc["label"],
                        "brokerType": acc["broker"].upper(), "hasSession": bool(sess and sess["session_token"])})
        return out

    def _purge_sim_data(self) -> None:
        """Wipe ALL sim-origin market data (ticks + aggregated candles)."""
        purged = [s for s, t in self.ticks.items() if t.get("source") in ("sim", "simfeed", None)]
        for s in purged:
            self.ticks.pop(s, None)
            self.agg.forget(s)
        self.epoch += 1
        config.log("hub", f"purged {len(purged)} sim symbols from tick cache")
        if self.sio and self.loop:
            self.loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self._broadcast("feed:epoch", {"epoch": self.epoch})))

    async def set_feed_source(self, source: str) -> dict:
        """Switch the market-data source. 'sim' or an account id string."""
        if source != "sim":
            try:
                aid = int(source)
            except ValueError:
                raise ValueError("source must be 'sim' or an account id")
            acc = db.core().one("SELECT * FROM accounts WHERE id=?", (aid,))
            if not acc:
                raise ValueError(f"account {source} not found")
            if self.sim_disabled() and (acc["mode"] == "sandbox" or acc["broker"] == "sim"):
                raise ValueError("Live-Only mode: sandbox accounts cannot be the data source — create a broker session in Admin → Session")
            if aid not in self.adapters:
                raise ValueError("account is not connected — connect it first (Feed chip → link icon)")
        db.core().exec("INSERT INTO settings(key,value) VALUES('feed_source',?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (source,))
        # purge server-side market data so the new source rebuilds from scratch
        self.ticks.clear()
        self.agg = CandleAggregator()
        self.symbol_source.clear()
        self.epoch += 1
        self._last_tick_ts = None
        self.feed_note(f"feed source -> {source}")
        # re-subscribe every watched symbol under the new source
        for sid, info in list(self.sockets.items()):
            for sym in list(info.get("symbols", set())):
                await self._ensure_source(sym)
            if info.get("candle"):
                await self._ensure_source(info["candle"])
        await self._broadcast("feed:source", {"source": source, "epoch": self.epoch})
        await self._broadcast("feed:epoch", {"epoch": self.epoch})
        config.log("hub", f"feed source switched -> {source} (epoch {self.epoch})")
        return {"ok": True, "source": source}

    def feed_status(self) -> dict:
        src = self.feed_source()
        is_live = src != "sim"
        broker_type = None
        connected = False
        session_present = False
        if is_live:
            try:
                aid = int(src)
            except ValueError:
                aid = None
            acc = db.core().one("SELECT * FROM accounts WHERE id=?", (aid or 0,))
            if acc:
                broker_type = acc["broker"].upper()
                session_present = bool(db.core().one(
                    "SELECT session_token FROM broker_sessions WHERE account_id=?", (aid,)))
                adapter = self.adapters.get(aid or 0)
                connected = bool(adapter and getattr(adapter, "connected", False))
        last = self._last_tick_ts
        fresh = bool(last and (time.time() - last) < 6)
        return {
            "source": src, "brokerType": broker_type, "connected": connected if is_live else True,
            "lastTickTs": int(last * 1000) if last else None,
            "lastError": self._last_error, "errorTs": int(self._error_ts * 1000) if self._error_ts else None,
            "symbols": len(self.ticks), "polls": self._tick_count, "errors": 0,
            "startedAt": int(self._feed_started_at * 1000),
            "log": list(self._feed_log)[:25],
            "sessionPresent": session_present, "sourceIsLive": is_live, "fresh": fresh,
        }

    # ------------------------------------------------------------------ accounts
    async def connect_account(self, account: dict, credentials: Optional[dict] = None) -> dict:
        from backend.brokers.registry import get_adapter, get_stream_cls
        aid = account["id"]
        # Round-24: normalize credential keys (camelCase stored rows → snake_case)
        # so every adapter sees api_key/api_secret/client_id/... regardless of the
        # spelling the UI saved.
        try:
            from backend.api.rest import _normalize_creds, _normalize_creds_row
            credentials = _normalize_creds(dict(credentials or {}))
            _stored = account.get("credentials")
            if isinstance(_stored, str) and _stored:
                account = {**account, "credentials": _normalize_creds_row(_stored)}
        except Exception:
            pass
        if aid in self.adapters:
            await self.disconnect_account(aid, keep_session=True)
        adapter = get_adapter(account, credentials)
        try:
            await adapter.authenticate()
        except Exception as e:
            db.core().exec("UPDATE accounts SET status='error', status_message=? WHERE id=?",
                           (str(e)[:180], aid))
            self._broker_log(aid, f"connect failed: {e}", "ERROR")
            raise
        # mode enforcement: live mode cannot attach sandbox/sim envs
        if self.trading_mode() == "live" and account.get("mode") == "sandbox":
            raise Exception("LIVE ONLY mode is on — this account is configured as sandbox")
        stream = adapter.make_stream(self._on_broker_tick)
        self.adapters[aid] = adapter
        self.streams[aid] = stream
        self._load_token_map(aid)
        await stream.start()
        db.core().exec("UPDATE accounts SET status='connected', status_message='' WHERE id=?", (aid,))
        self._broker_log(aid, "account connected; feed started")
        await self._broadcast("account_status", {
            "account_id": aid, "broker": account["broker"], "status": "connected"})
        config.log("hub", f"account#{aid} ({account['broker']}) connected; feed started")
        # default master sync on CONNECT (background — new symbols list daily)
        if account.get("broker") != "sim":
            from backend import masters
            asyncio.ensure_future(masters.auto_sync_on_connect(dict(account)))
        return {"status": "connected"}

    def _load_token_map(self, aid: int) -> None:
        broker = db.core().one("SELECT broker FROM accounts WHERE id=?", (aid,))
        name = broker["broker"] if broker else "sim"
        try:
            rows = db.broker_db(name).query("SELECT token,symbol FROM master")
        except Exception as e:
            # a broker db without the master table (never synced) must never
            # blow up the connect path with a 500 — an empty map is fine
            config.log("hub", f"token map for account#{aid} ({name}): master table unavailable ({e}) — empty map", "WARN")
            rows = []
        self.token_map[aid] = {r["token"]: r["symbol"] for r in rows}
        config.log("hub", f"token map for account#{aid} ({name}): {len(self.token_map[aid])} mappings")

    def _broker_log(self, account_id: int, message: str, level: str = "INFO") -> None:
        try:
            db.core().exec("INSERT INTO broker_logs(account_id,ts,level,message) VALUES(?,?,?,?)",
                           (account_id, time.time(), level, message[:400]))
        except Exception:
            pass

    async def disconnect_account(self, account_id: int, keep_session: bool = True) -> None:
        stream = self.streams.pop(account_id, None)
        if stream:
            try:
                await stream.stop()
            except Exception:
                pass
        adapter = self.adapters.pop(account_id, None)
        if adapter:
            try:
                await adapter.disconnect()
            except Exception:
                pass
        if not keep_session:
            from backend import session_store
            session_store.clear(account_id)
        db.core().exec("UPDATE accounts SET status='disconnected', status_message='' WHERE id=?",
                       (account_id,))
        for sym, aid in list(self.symbol_source.items()):
            if aid == account_id:
                self.symbol_source.pop(sym, None)
        await self._broadcast("account_status", {
            "account_id": account_id, "status": "disconnected"})
        config.log("hub", f"account#{account_id} disconnected")

    def account_adapter(self, account_id: int):
        return self.adapters.get(account_id)

    async def enforce_mode(self) -> None:
        """Drop sim/sandbox attachments when LIVE ONLY."""
        mode = self.trading_mode()
        if mode != "live":
            return
        for aid, adapter in list(self.adapters.items()):
            acc = db.core().one("SELECT mode FROM accounts WHERE id=?", (aid,))
            if acc and acc["mode"] == "sandbox":
                config.log("hub", f"LIVE ONLY: detaching sandbox account#{aid}", "WARN")
                await self.disconnect_account(aid)
        await self._broadcast("mode", {"mode": mode})

    # ------------------------------------------------------------------ default sim account
    def ensure_sim_account(self) -> int:
        row = db.core().one("SELECT * FROM accounts WHERE broker='sim' ORDER BY id LIMIT 1")
        if row:
            self.sim_account_id = row["id"]
            return row["id"]
        now = time.time()
        db.core().exec(
            "INSERT INTO accounts(broker,label,mode,credentials,created_at,updated_at) "
            "VALUES('sim','Simulated Feed','sandbox','{}',?,?)", (now, now))
        self.sim_account_id = db.core().one(
            "SELECT id FROM accounts WHERE broker='sim' ORDER BY id LIMIT 1")["id"]
        return self.sim_account_id

    # ------------------------------------------------------------------ subscriptions
    def resolve_symbol(self, symbol: str) -> str:
        """Map a bare/UI symbol ('NIFTY') to a master-backed one ('NSE:NIFTY')."""
        symbol = (symbol or "").upper()
        if not symbol or ":" in symbol:
            return symbol
        for tm in self.token_map.values():
            for sym in tm.values():
                if sym == symbol or sym.endswith(":" + symbol):
                    return sym
        return f"NSE:{symbol}"

    async def subscribe(self, sid: str, symbols: list[str]) -> None:
        self.sockets.setdefault(sid, {"symbols": set(), "candle": None, "tf": 1})
        for sym in symbols:
            sym = self.resolve_symbol(sym)
            self.sockets[sid]["symbols"].add(sym)
            self.symbol_refs[sym].add(sid)
            await self._ensure_source(sym)
            if sym in self.ticks:      # immediate snapshot so UI is instant on refresh
                await self._emit_to(sid, "tick", self.ticks[sym])

    async def unsubscribe(self, sid: str, symbols: list[str]) -> None:
        info = self.sockets.get(sid)
        for sym in symbols:
            sym = sym.upper()
            if info:
                info["symbols"].discard(sym)
            refs = self.symbol_refs.get(sym)
            if refs:
                refs.discard(sid)
                if not refs:
                    self.symbol_refs.pop(sym, None)
                    await self._release_source(sym)

    async def watch_candles(self, sid: str, symbol: str, tf: int = 1) -> list[dict]:
        """Historical snapshot + register live candle updates for the socket."""
        symbol = self.resolve_symbol(symbol)
        info = self.sockets.setdefault(sid, {"symbols": set(), "candle": None, "tf": tf})
        info["candle"], info["tf"] = symbol, tf
        await self._ensure_source(symbol)
        candles = await self.get_history(symbol, tf)
        await self._emit_to(sid, "candles:history", {"symbol": symbol, "tf": tf, "candles": candles})
        if symbol in self.ticks:
            await self._emit_to(sid, "tick", self.ticks[symbol])
        return candles

    async def _ensure_source(self, symbol: str) -> None:
        # FNO session simulator serves its symbols itself (no broker stream)
        from backend import fnosim
        if fnosim.SVC.serves(symbol):
            return
        if symbol in self.symbol_source and self.symbol_source[symbol] in self.adapters:
            return
        mode = self.trading_mode()
        # explicit feed source first (quantdesk: exactly ONE active source)
        src = self.feed_source()
        if src != "sim":
            try:
                aid = int(src)
                if aid in self.adapters:
                    token = self._token_for(aid, symbol)
                    if token is not None:
                        stream = self.streams[aid]
                        ok = await self._stream_subscribe(stream, aid, symbol, token)
                        if ok:
                            self.symbol_source[symbol] = aid
                            return
            except ValueError:
                pass
        # fall back to any suitable account (live-only respects mode)
        candidates: list[int] = []
        for aid in self.adapters:
            acc = db.core().one("SELECT * FROM accounts WHERE id=?", (aid,))
            if not acc:
                continue
            if mode == "live" and acc["mode"] != "live":
                continue
            candidates.append(aid)
        if mode != "live" and not self.sim_disabled() and self.sim_account_id \
                and self.sim_account_id in self.adapters:
            candidates.append(self.sim_account_id)
        for aid in candidates:
            token = self._token_for(aid, symbol)
            if token is None:
                continue
            stream = self.streams[aid]
            ok = await self._stream_subscribe(stream, aid, symbol, token)
            if ok:
                self.symbol_source[symbol] = aid
                config.log("hub", f"source for {symbol}: account#{aid} (token={token})")
                return
        # no source — explicit feed:down, NEVER silent sim fallback
        if mode == "live" or self.sim_disabled():
            await self._broadcast("feed:down", {
                "symbol": symbol, "reason": "no live broker feed connected — connect an account in the FEED chip"})
        else:
            await self._broadcast("feed:down", {
                "symbol": symbol, "reason": f"no feed source for {symbol} — sync master contracts"})

    def _token_for(self, aid: int, symbol: str) -> Optional[str]:
        tm = self.token_map.get(aid, {})
        if symbol in tm.values():       # reverse lookup
            for tok, sym in tm.items():
                if sym == symbol:
                    return tok
        if symbol in self.ticks:
            return None
        return None

    async def _stream_subscribe(self, stream, aid: int, symbol: str, token: str) -> bool:
        try:
            if hasattr(stream, "universe"):                       # sim
                await stream.subscribe([token])
                return True
            broker = db.core().one("SELECT broker FROM accounts WHERE id=?", (aid,))
            name = broker["broker"] if broker else "sim"
            if name == "dhan":
                row = db.broker_db("dhan").one("SELECT * FROM master WHERE token=?", (token,))
                if not row:
                    return False
                from backend.brokers.dhan.mapping import EXCH_SEG
                await stream.subscribe([{"ExchangeSegment": EXCH_SEG.get(row["exchange"], "NSE_EQ"),
                                         "SecurityId": token, "unified": symbol}])
                return True
            if name == "shoonya":
                await stream.subscribe([f"NSE|{token}" if symbol.startswith("NSE") else f"NFO|{token}"])
                return True
            await stream.subscribe([token])                       # breeze: plain tokens
            return True
        except Exception as e:
            config.log("hub", f"subscribe {symbol} via account#{aid} failed: {e}", "WARN")
            return False

    async def _release_source(self, symbol: str) -> None:
        aid = self.symbol_source.pop(symbol, None)
        if aid is None or aid not in self.adapters:
            return
        token = self._token_for(aid, symbol)
        stream = self.streams.get(aid)
        if stream and token:
            try:
                if hasattr(stream, "unsubscribe"):
                    await stream.unsubscribe([token])
            except Exception:
                pass
        self.agg.forget(symbol)

    # ------------------------------------------------------------------ history
    async def get_history(self, symbol: str, tf_minutes: int) -> list[dict]:
        symbol = self.resolve_symbol(symbol)
        # FNO session simulator: charts read the session-seeded ring buffer
        from backend import fnosim
        if fnosim.SVC.serves(symbol):
            return self.agg.history(symbol, tf_minutes, limit=900)
        aid = self.symbol_source.get(symbol)
        if not aid:
            await self._ensure_source(symbol)
            aid = self.symbol_source.get(symbol)
        if aid and self.adapters.get(aid):
            try:
                hist = await self.adapters[aid].get_history(symbol, tf_minutes, days=3)
                if hist:
                    config.log("hub", f"history {symbol} {tf_minutes}m: {len(hist)} broker candles")
                    return hist[-1000:]
            except Exception as e:
                config.log("hub", f"broker history failed {symbol}: {e} — using session aggregate", "WARN")
        return self.agg.history(symbol, tf_minutes)

    # ------------------------------------------------------------------ tick path (hot loop)
    def _on_broker_tick(self, tick: dict) -> None:
        """Called from broker stream clients (possibly other threads)."""
        symbol = tick.get("symbol")
        if not symbol:
            aid = tick.pop("_aid", None)
            if aid is not None:
                symbol = self.token_map.get(aid, {}).get(str(tick.get("token", "")))
        if not symbol:
            return
        if self.sim_account_id is not None:
            acc = db.core().one("SELECT mode FROM accounts WHERE id=?", (self.sim_account_id,))
            if acc and acc["mode"] == "sandbox" and self.trading_mode() == "live" \
                    and tick.get("source") == "sim" and self.symbol_source.get(symbol) != self.sim_account_id:
                return   # LIVE ONLY: refuse sim ticks for non-sim sources
        tick["symbol"] = symbol
        prev = self.ticks.get(symbol)
        tick["prev_close"] = tick.get("prev_close") or (prev or {}).get("prev_close")
        self.ticks[symbol] = tick
        ltp = tick.get("ltp") or 0
        vol_delta = (tick.get("vol") or 0) - ((prev or {}).get("vol") or 0)
        if vol_delta < 0:
            vol_delta = 0
        closed = self.agg.on_tick(symbol, ltp, vol_delta, tick.get("ts") or int(time.time() * 1000))
        if self.loop is None:
            self.loop = asyncio.get_event_loop()
        self._tick_count += 1
        self._last_tick_ts = time.time()
        self.loop.call_soon_threadsafe(self._fanout, symbol, tick, closed)

    def _fanout(self, symbol: str, tick: dict, closed: Optional[dict]) -> None:
        try:
            asyncio.get_event_loop().create_task(self._fanout_async(symbol, tick, closed))
        except RuntimeError:
            pass

    async def _fanout_async(self, symbol: str, tick: dict, closed: Optional[dict]) -> None:
        if not self.sio:
            return
        sio = self.sio
        if self.symbol_refs.get(symbol):
            await sio.emit("tick", tick)
        live = self.agg.live_candle(symbol)
        if live:
            await sio.emit("candle", {"symbol": symbol, "tf": 1, "live": True, **live})
        if closed:
            await sio.emit("candle", {"symbol": symbol, "tf": 1, "live": False, **closed})
        self._update_position_pnl(symbol, tick)

    # ------------------------------------------------------------------ positions/pnl/funds events
    def _update_position_pnl(self, symbol: str, tick: dict) -> None:
        rows = db.core().query("SELECT * FROM positions WHERE symbol=? AND qty<>0", (symbol,))
        if not rows:
            return
        ltp = tick.get("ltp") or 0
        changed = False
        for r in rows:
            pnl = (ltp - r["avg_price"]) * r["qty"]
            db.core().exec("UPDATE positions SET ltp=?, pnl=? WHERE id=?", (ltp, round(pnl, 2), r["id"]))
            changed = True
        now = time.time()
        if changed and now - self._last_pos_push > 0.5:
            self._last_pos_push = now
            self.loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self._push_positions_and_funds()))

    async def _push_positions_and_funds(self) -> None:
        await self.push_positions()
        async with self._push_lock:
            # funds push on position change: every connected account
            for account_id in self.adapters:
                await FUNDS.push_funds(account_id, reason="event")

    async def push_positions(self) -> None:
        if not self.sio:
            return
        rows = db.core().query(
            "SELECT * FROM positions WHERE qty<>0 ORDER BY symbol")
        out = []
        for p in rows:
            net_x, ch_x = self._exit_net_of(p)
            out.append({**p, "netIfExit": net_x, "exitCharges": ch_x})
        await self.sio.emit("positions", out)

    def _exit_net_of(self, p: dict) -> tuple[float, float]:
        """(net in pocket if this position were closed at LTP now, est. exit
        charges) — exit leg priced by the ACCOUNT'S OWN charges schedule
        (brokerage + STT + txn + GST + SEBI + stamp).  Entry charges are
        already sunk into account netPnl, so pocket = netPnl + Σ netIfExit."""
        from backend import charges_config
        from backend.charges import instrument_of
        qty = int(p["qty"] or 0)
        ltp = float(p["ltp"] or 0)
        if not qty or ltp <= 0:
            return 0.0, 0.0
        gross = (ltp - float(p["avg_price"] or 0)) * qty
        try:
            mrow = self._master_row(p["symbol"])
            inst = instrument_of(mrow)
            acc = db.core().one("SELECT broker FROM accounts WHERE id=?", (p["account_id"],))
            side = "SELL" if qty > 0 else "BUY"      # the closing leg
            ch = charges_config.calc_charges_for(
                p["account_id"], (acc or {}).get("broker", ""), inst,
                p["product"] or "MIS", side, abs(qty) * ltp)
            return round(gross - ch["total"], 2), ch["total"]
        except Exception:
            return round(gross, 2), 0.0

    def _exit_net_map(self) -> dict[int, float]:
        """account_id -> Σ net-if-exited-at-LTP over its open positions."""
        out: dict[int, float] = {}
        for p in db.core().query("SELECT * FROM positions WHERE qty<>0"):
            net_x, _ = self._exit_net_of(p)
            out[p["account_id"]] = out.get(p["account_id"], 0.0) + net_x
        return out

    async def on_order_event(self, account_id: int, kind: str, payload: dict) -> None:
        """Called after place/cancel — pushes orders + funds (event-driven)."""
        if not self.sio:
            return
        FUNDS.invalidate(account_id)
        await self.sio.emit("order_update", {"kind": kind, **payload})
        await self.push_orders()
        await self.push_positions()
        await FUNDS.push_funds(account_id, reason="event")

    async def push_orders(self) -> None:
        if not self.sio:
            return
        rows = db.core().query(
            "SELECT * FROM orders ORDER BY id DESC LIMIT 80")
        await self.sio.emit("orders", rows)

    # ------------------------------------------------------------------ master-order fanout
    # (quantdesk parity: one request fans out to every order-enabled account
    #  with per-account capital sizing; legs recorded + audited)
    async def place_master_order(self, body: dict) -> dict:
        symbol = (body.get("symbol") or "").upper()
        exchange = (body.get("exchange") or symbol.split(":")[0] or "NSE").upper()
        side = (body.get("side") or "BUY").upper()
        order_type = (body.get("orderType") or "MARKET").upper()
        product_type = body.get("productType") or "MIS"
        limit_price = body.get("limitPrice")
        trigger_price = body.get("triggerPrice")
        source = body.get("source") or "MANUAL"
        reduce_only = bool(body.get("reduceOnly"))
        capital_pct = body.get("capitalPct")
        qty_in = body.get("qty") or 0
        master_id = f"MO{time.time_ns() // 1000}"

        accs = db.core().query("SELECT * FROM accounts WHERE is_active=1 AND is_order_enabled=1 ORDER BY id")
        if body.get("legAccounts"):
            wanted = {str(a) for a in body["legAccounts"]}
            accs = [a for a in accs if str(a["id"]) in wanted]
        if self.trading_mode() == "live" or self.sim_disabled():
            accs = [a for a in accs if a["broker"] != "sim" and a["mode"] == "live"]
        if not accs:
            raise ValueError("no order-enabled account connected (check the capital chips)")

        mrow = None
        for name in db.broker_dbs_keys():
            r = db.broker_db(name).one("SELECT * FROM master WHERE symbol=?", (symbol,))
            if r:
                mrow = r
                break
        from backend.charges import instrument_of
        instrument = instrument_of(mrow)
        lot_size = int((mrow or {}).get("lotsize") or 1)

        legs: list[dict] = []
        fills: list[tuple[float, int]] = []   # (price, qty)
        for acc in accs:
            aid = acc["id"]
            adapter = self.adapters.get(aid)
            if not adapter:
                legs.append(self._leg(aid, acc, "REJECTED", message="account not connected"))
                continue
            # ---- sizing (qty semantics: LOTS for FUT/OPT, units for EQ —
            #      positions are always stored in UNITS = lots x lotsize) ----
            is_fno = instrument in ("CE", "PE", "FUT") and lot_size > 1
            if reduce_only:
                pos = db.core().one(
                    "SELECT * FROM positions WHERE account_id=? AND symbol=? AND qty<>0", (aid, symbol))
                if not pos:
                    legs.append(self._leg(aid, acc, "SKIPPED", message="no position to close"))
                    continue
                # flatten EXACTLY what is held (units) — never over/undershoot
                leg_qty = abs(int(pos["qty"]))
            elif qty_in:
                leg_qty = int(qty_in) * lot_size if is_fno else int(qty_in)
            else:
                usable = self._usable_capital(acc)
                pct = float(capital_pct) if capital_pct else 100.0
                ref_price = (self.ticks.get(symbol) or {}).get("ltp") or limit_price or 0
                if not ref_price:
                    legs.append(self._leg(aid, acc, "REJECTED", message="no price to size against — subscribe the symbol first"))
                    continue
                budget = usable * (pct / 100.0)
                if is_fno:
                    leg_qty = max(lot_size, int(budget / (ref_price * lot_size)) * lot_size)
                else:
                    leg_qty = max(1, int(budget / ref_price))
            try:
                # position snapshot BEFORE the fill (the adapter applies it
                # synchronously — post-fill reads see the new qty/avg)
                pos_before = db.core().one(
                    "SELECT * FROM positions WHERE account_id=? AND symbol=? AND product=?",
                    (aid, symbol, product_type))
                result = await adapter.place_order(
                    symbol, side, leg_qty, order_type, limit_price, product_type, trigger_price)
                fill = result.get("filled_price")
                broker_oid = result.get("order_id", "")
                status = "FILLED" if fill else "OPEN"
                # sim adapter records its own orders row — never double-insert
                already = broker_oid and db.core().one(
                    "SELECT id FROM orders WHERE broker_order_id=?", (broker_oid,))
                if not already:
                    now = time.time()
                    db.core().exec(
                        "INSERT INTO orders(account_id,broker,symbol,side,qty,price,trigger_price,order_type,product,"
                        "status,filled_qty,avg_price,broker_order_id,message,created_at,updated_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (aid, acc["broker"], symbol, side, leg_qty, limit_price, trigger_price, order_type,
                         product_type, "complete" if fill else "open", leg_qty if fill else 0, fill,
                         broker_oid, "", now, now))
                if fill:
                    fills.append((float(fill), leg_qty))
                    self._record_fill(aid, acc, symbol, exchange, side, leg_qty,
                                      float(fill), product_type, instrument, broker_oid,
                                      master_id, pos_before)
                legs.append(self._leg(aid, acc, status, qty=leg_qty, price=fill,
                                      broker_order_id=broker_oid))
                self._broker_log(aid, f"order {side} {leg_qty} {symbol} @ {fill or limit_price} ({source})")
                FUNDS.invalidate(aid)
            except Exception as e:
                legs.append(self._leg(aid, acc, "REJECTED", qty=leg_qty, message=str(e)[:200]))
                self._broker_log(aid, f"order rejected {side} {leg_qty} {symbol}: {e}", "ERROR")

        filled = [l for l in legs if l["status"] == "FILLED"]
        avg = (sum(p * q for p, q in fills) / sum(q for _, q in fills)) if fills else None
        status = "SUCCESS" if filled and len(filled) == len([l for l in legs if l["status"] != "SKIPPED"]) \
            else ("PARTIAL" if filled else "FAILED")
        result = {
            "masterOrderId": master_id, "symbol": symbol, "exchange": exchange,
            "side": side, "lots": qty_in, "status": status, "legs": legs,
            "avgFillPrice": round(avg, 2) if avg else None,
            "message": None if filled else (next((l.get("message") for l in legs if l.get("message")), "all legs failed")),
        }
        db.core().exec(
            "INSERT INTO audit_log(ts,source,action,master_symbol,side,qty,status,message,legs_json) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (time.time(), source, "PLACE", symbol, side, qty_in, status, result["message"],
             json.dumps(legs)[:2000]))
        if self.sio:
            await self.push_orders()
            await self.push_positions()
            for l in legs:
                if l["status"] in ("FILLED", "OPEN"):
                    await FUNDS.push_funds(int(l["accountId"]), reason="event")
        return result

    async def cancel_master_order(self, account_id: str, order_id: str) -> dict:
        aid = int(account_id)
        adapter = self.adapters.get(aid)
        row = db.core().one("SELECT * FROM orders WHERE broker_order_id=? AND account_id=?", (order_id, aid))
        if not row:
            raise ValueError("order not found")
        if adapter:
            await adapter.cancel_order(order_id, row["symbol"])
        db.core().exec("UPDATE orders SET status='cancelled', updated_at=? WHERE id=?",
                       (time.time(), row["id"]))
        await self.on_order_event(aid, "cancelled", {"order_id": order_id})
        return {"ok": True}

    async def squareoff_all(self, kill: bool = False, symbols: Optional[list[str]] = None) -> dict:
        rows = db.core().query("SELECT * FROM positions WHERE qty<>0")
        if symbols:
            rows = [r for r in rows if r["symbol"] in symbols]
        placed = 0
        filled = 0
        for r in rows:
            side = "SELL" if r["qty"] > 0 else "BUY"
            lot = self._lot_of(r["symbol"])
            qty = abs(int(r["qty"]))   # positions are stored in UNITS
            try:
                res = await self.place_master_order({
                    "symbol": r["symbol"], "exchange": r["symbol"].split(":")[0],
                    "side": side, "qty": 0, "orderType": "MARKET",
                    "productType": r["product"] or "MIS", "source": "KILLSWITCH" if kill else "SQUAREOFF",
                    "reduceOnly": True, "legAccounts": [str(r["account_id"])],
                })
                placed += 1
                filled += len([l for l in res.get("legs", []) if l["status"] == "FILLED"])
            except Exception as e:
                self._broker_log(r["account_id"], f"squareoff failed {r['symbol']}: {e}", "ERROR")
        return {"ok": True, "orders": placed, "filledLegs": filled}

    async def cancel_all_orders(self, symbols: Optional[list[str]] = None) -> dict:
        rows = db.core().query("SELECT * FROM orders WHERE status='open'")
        if symbols:
            rows = [r for r in rows if r["symbol"] in symbols]
        n = 0
        for r in rows:
            try:
                await self.cancel_master_order(str(r["account_id"]), r["broker_order_id"] or "")
                n += 1
            except Exception:
                pass
        return {"ok": True, "cancelled": n}

    # ------------------------------------------------------------------ sizing / fills
    def _lot_of(self, symbol: str) -> int:
        for name in db.broker_dbs_keys():
            r = db.broker_db(name).one("SELECT lotsize FROM master WHERE symbol=?", (symbol,))
            if r and r["lotsize"]:
                return int(r["lotsize"])
        return 1

    def _leg(self, aid: int, acc: dict, status: str, qty: int = 0, price: Optional[float] = None,
             broker_order_id: Optional[str] = None, message: Optional[str] = None) -> dict:
        return {"accountId": str(aid), "accountLabel": acc["label"],
                "brokerType": acc["broker"].upper(), "brokerOrderId": broker_order_id,
                "status": status, "qty": qty, "price": price, "message": message,
                "sandbox": acc["mode"] != "live" or acc["broker"] == "sim"}

    def _usable_capital(self, acc: dict) -> float:
        """Deployable capital for sizing, per the account's house mode."""
        initial = acc["initial_capital"]
        if initial is None:
            cash = self._account_cash(acc["id"])
            initial = (cash or 1_000_000.0) * ((acc["capital_pct"] or 100) / 100.0)
        realized = acc["realized_pnl"] or 0.0
        mode = acc.get("capital_mode") or "INITIAL_PLUS_PNL"
        if mode == "PROFIT_ONLY":
            return max(0.0, initial + max(0.0, realized))
        if mode == "INITIAL_WITH_LOSS_REDUCTION":
            return max(0.0, initial + min(0.0, realized))
        if mode == "LIVE_BALANCE":
            # FULL broker balance — whatever the broker reports as available
            # right now (already net of margin used by open positions and
            # including realized + unrealized PnL).  Falls back to the
            # INITIAL_PLUS_PNL math until the first funds snapshot lands.
            live = self._account_cash(acc["id"])
            if live is not None:
                return max(0.0, live)
        return max(0.0, initial + realized)

    def _account_cash(self, account_id: int) -> Optional[float]:
        row = db.core().one("SELECT data FROM funds_snapshot WHERE account_id=?", (account_id,))
        if not row:
            return None
        try:
            return float(json.loads(row["data"]).get("available") or 0) or None
        except Exception:
            return None

    def _record_fill(self, account_id: int, acc: dict, symbol: str, exchange: str,
                     side: str, qty: int, price: float, product: str,
                     instrument: str, broker_order_id: str, master_id: str,
                     pos_before: Optional[dict] = None) -> None:
        """Record a trade with charges + realized pnl on reducing fills.
        qty is UNITS (lots x lotsize for FNO) — matches positions storage.
        pos_before = position row captured BEFORE the fill was applied.
        Charges come from the ACCOUNT'S OWN editable schedule
        (charges_config — defaults are today's market values per broker)."""
        from backend import charges_config
        c = db.core()
        value = price * qty
        charges = charges_config.calc_charges_for(
            account_id, acc.get("broker", ""), instrument, product, side, value)
        before = pos_before if pos_before is not None else c.one(
            "SELECT * FROM positions WHERE account_id=? AND symbol=? AND product=?",
            (account_id, symbol, product))
        realized = 0.0
        if before and before["qty"] != 0:
            signed = qty if side == "BUY" else -qty
            if before["qty"] * signed < 0:   # reducing / closing
                closed = min(abs(before["qty"]), qty)
                direction = 1 if before["qty"] > 0 else -1
                realized = (price - before["avg_price"]) * closed * direction
        c.exec("""INSERT INTO trades(account_id,order_id,symbol,exchange,side,qty,price,value,charges,realized_pnl,ts)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
               (account_id, broker_order_id, symbol, exchange, side, qty, price, round(value, 2),
                json.dumps(charges), round(realized, 2), time.time()))
        aggr = c.one("SELECT COALESCE(SUM(realized_pnl),0) s, COALESCE(SUM(json_extract(charges,'$.total')),0) ch "
                     "FROM trades WHERE account_id=?", (account_id,))
        c.exec("UPDATE accounts SET realized_pnl=?, charges_paid=?, first_trade_done=1 WHERE id=?",
               (round(aggr["s"], 2), round(aggr["ch"], 2), account_id))
        self._broker_log(account_id,
                         f"fill {side} {qty} {symbol} @ {price} charges ₹{charges['total']} pnl ₹{realized}")

    # ------------------------------------------------------------------ aggregates for sync pushers
    def core_payload(self) -> dict:
        accounts = []
        positions = []
        orders = []
        trades = []
        funds = []
        open_net_map = self._exit_net_map()
        for acc in db.core().query("SELECT * FROM accounts ORDER BY id"):
            aid = acc["id"]
            sess = db.core().one("SELECT session_token FROM broker_sessions WHERE account_id=?", (aid,))
            adapter = self.adapters.get(aid)
            connected = bool(adapter and getattr(adapter, "connected", False))
            open_pos = db.core().one("SELECT COUNT(*) c FROM positions WHERE account_id=? AND qty<>0", (aid,))["c"]
            open_ord = db.core().one("SELECT COUNT(*) c FROM orders WHERE account_id=? AND status='open'", (aid,))["c"]
            cash = self._account_cash(aid)
            initial = acc["initial_capital"]
            initial_fixed = initial
            if initial is None:
                initial = (cash or 1_000_000.0) * ((acc["capital_pct"] or 100) / 100.0)
            usable = self._usable_capital(acc)
            deployed = db.core().one(
                "SELECT COALESCE(SUM(qty*COALESCE(avg_price,0)),0) d FROM positions "
                "WHERE account_id=? AND qty<>0", (aid,))["d"] or 0
            src = self.feed_source()
            net_pnl = round((acc["realized_pnl"] or 0) - (acc["charges_paid"] or 0), 2)
            open_net = round(open_net_map.get(aid, 0.0), 2)
            accounts.append({
                "id": str(aid), "label": acc["label"], "brokerType": acc["broker"].upper(),
                "status": "connected" if connected else acc["status"],
                "isActive": bool(adapter), "isLiveDataSource": str(aid) == src,
                "isOrderEnabled": bool(acc["is_order_enabled"]), "isCopyMaster": False,
                "hasSession": bool(sess and sess["session_token"]) or acc["broker"] == "sim",
                "usableCapital": round(usable, 2), "initialCapital": round(initial, 2),
                "capitalBase": "AVAILABLE_CASH_PCT" if initial_fixed is None else "FIXED",
                "capitalPct": acc["capital_pct"] or 100,
                "availableCash": cash, "initialCapitalFixed": initial_fixed,
                "realizedPnl": acc["realized_pnl"] or 0, "chargesPaid": acc["charges_paid"] or 0,
                "netPnl": net_pnl,
                "openNet": open_net,
                "pocket": round(net_pnl + open_net, 2),
                "deployed": round(deployed, 2), "mode": acc["capital_mode"] or "INITIAL_PLUS_PNL",
                "modeLabel": {"PROFIT_ONLY": "Profit only",
                              "INITIAL_PLUS_PNL": "Initial + PnL",
                              "INITIAL_WITH_LOSS_REDUCTION": "Initial − losses",
                              "LIVE_BALANCE": "Broker balance"}.get(acc["capital_mode"] or "", "Initial + PnL"),
                "firstTradeDone": bool(acc["first_trade_done"]),
                "openPositions": open_pos, "openOrders": open_ord,
                "clientId": None, "modeLabel2": None,
            })
        for p in db.core().query("SELECT * FROM positions WHERE qty<>0"):
            acc = db.core().one("SELECT label,broker FROM accounts WHERE id=?", (p["account_id"],))
            mrow = self._master_row(p["symbol"])
            lot = int((mrow or {}).get("lotsize") or 1)
            net_x, ch_x = self._exit_net_of(p)
            positions.append({
                "accountId": str(p["account_id"]),
                "accountLabel": acc["label"] if acc else str(p["account_id"]),
                "brokerType": (acc["broker"].upper() if acc else "SIM"),
                "symbol": p["symbol"], "exchange": p["symbol"].split(":")[0] or "NSE",
                "productType": p["product"] or "MIS",
                "netQty": p["qty"], "buyQty": p["qty"] if p["qty"] > 0 else 0,
                "sellQty": -p["qty"] if p["qty"] < 0 else 0,
                "avgPrice": p["avg_price"], "realizedPnl": 0,
                "ltp": p["ltp"], "unrealizedPnl": p["pnl"], "lotSize": lot,
                "netIfExit": net_x, "exitCharges": ch_x,
                "updatedAt": _iso(p["updated_at"]), "instrumentType": (mrow or {}).get("instrument") or "EQ",
            })
        for o in db.core().query("SELECT * FROM orders ORDER BY id DESC LIMIT 60"):
            acc = db.core().one("SELECT label,broker FROM accounts WHERE id=?", (o["account_id"],))
            orders.append({
                "id": str(o["id"]), "symbol": o["symbol"], "exchange": o["symbol"].split(":")[0] or "NSE",
                "side": o["side"], "qty": o["qty"], "filledQty": o["filled_qty"] or 0,
                "orderType": o["order_type"], "productType": o["product"],
                "status": (o["status"] or "").upper(), "avgPrice": o["avg_price"],
                "message": o["message"], "createdAt": _iso(o["created_at"]),
                "updatedAt": _iso(o["updated_at"]),
                "accountId": str(o["account_id"]),
                "accountLabel": acc["label"] if acc else "",
                "brokerType": (acc["broker"].upper() if acc else "SIM"),
            })
        for t in db.core().query("SELECT * FROM trades ORDER BY id DESC LIMIT 60"):
            acc = db.core().one("SELECT label,broker FROM accounts WHERE id=?", (t["account_id"],))
            trades.append({
                "id": str(t["id"]), "orderId": t["order_id"], "symbol": t["symbol"],
                "exchange": t["exchange"], "side": t["side"], "qty": t["qty"],
                "price": t["price"], "value": t["value"],
                "chargesTotal": _charges_total(t["charges"]), "charges": _charges_dict(t["charges"]),
                "realizedPnl": t["realized_pnl"],
                "netPnl": round((t["realized_pnl"] or 0) - (_charges_total(t["charges"]) or 0), 2),
                "ts": _iso(t["ts"]),
                "accountId": str(t["account_id"]),
                "accountLabel": acc["label"] if acc else "",
                "brokerType": (acc["broker"].upper() if acc else "SIM"),
            })
        for acc in db.core().query("SELECT * FROM accounts ORDER BY id"):
            cash = self._account_cash(acc["id"]) or 0
            acc_net = round((acc["realized_pnl"] or 0) - (acc["charges_paid"] or 0), 2)
            acc_open = round(open_net_map.get(acc["id"], 0.0), 2)
            funds.append({
                "accountId": str(acc["id"]), "label": acc["label"],
                "brokerType": acc["broker"].upper(), "cash": round(cash, 2),
                "initialCapital": round(acc["initial_capital"] or 0, 2),
                "realizedPnl": acc["realized_pnl"] or 0,
                "netPnl": acc_net,
                "openNet": acc_open,
                "pocket": round(acc_net + acc_open, 2),
                "chargesPaid": acc["charges_paid"] or 0, "deployed": 0,
            })
        return {"accounts": accounts, "positions": positions, "orders": orders,
                "trades": trades, "funds": funds, "session": self.session_stats(),
                "sessionStart": _iso(self._feed_started_at), "ts": int(time.time() * 1000)}

    def session_stats(self) -> dict:
        rows = db.core().query("SELECT * FROM trades")
        closes = 0
        wins = 0
        pts = 0.0
        realized = 0.0
        charges = 0.0
        per: dict[str, dict] = {}
        top: dict[str, float] = {}
        for t in rows:
            ch = _charges_dict(t["charges"])
            charges += ch.get("total", 0) or 0
            rp = t["realized_pnl"] or 0
            realized += rp
            if rp != 0:
                closes += 1
                if rp > 0:
                    wins += 1
                # points captured = price move per unit (realized / qty in units)
                p = (rp / t["qty"]) if t["qty"] else 0.0
                pts += p
                top[t["symbol"]] = top.get(t["symbol"], 0) + p
            aid = str(t["account_id"])
            acc = db.core().one("SELECT label,broker FROM accounts WHERE id=?", (t["account_id"],))
            slot = per.setdefault(aid, {"accountId": aid, "label": acc["label"] if acc else "",
                                        "brokerType": (acc["broker"].upper() if acc else "SIM"),
                                        "trades": 0, "closes": 0, "wins": 0, "pts": 0.0,
                                        "realized": 0.0, "unrealized": 0.0, "charges": 0.0})
            slot["trades"] += 1
            slot["charges"] += ch.get("total", 0) or 0
            slot["realized"] += rp
            if rp != 0:
                slot["closes"] += 1
                if rp > 0:
                    slot["wins"] += 1
        unrealized = db.core().one("SELECT COALESCE(SUM(pnl),0) s FROM positions WHERE qty<>0")["s"] or 0
        unrealized_net = 0.0
        for p in db.core().query("SELECT * FROM positions WHERE qty<>0"):
            unrealized_net += self._exit_net_of(p)[0]
        for aid in per:
            u = db.core().one("SELECT COALESCE(SUM(pnl),0) s FROM positions WHERE account_id=? AND qty<>0", (int(aid),))
            per[aid]["unrealized"] = u["s"] if u else 0
            acc = db.core().one("SELECT realized_pnl,charges_paid FROM accounts WHERE id=?", (int(aid),))
            acc_net = ((acc["realized_pnl"] or 0) - (acc["charges_paid"] or 0)) if acc else 0
            a_open = 0.0
            for p in db.core().query("SELECT * FROM positions WHERE account_id=? AND qty<>0", (int(aid),)):
                a_open += self._exit_net_of(p)[0]
            per[aid]["pocket"] = round(acc_net + a_open, 2)
        return {
            "winRate": (wins / closes * 100) if closes else None,
            "pts": round(pts, 1), "realized": round(realized, 2),
            "unrealized": round(unrealized, 2),
            "unrealizedNet": round(unrealized_net, 2),
            "net": round(realized + unrealized, 2),
            "pocket": round(realized - charges + unrealized_net, 2),
            "closes": closes, "wins": wins, "trades": len(rows),
            "charges": round(charges, 2),
            "perAccount": list(per.values()),
            "topSymbols": [{"symbol": s, "pts": round(p, 1)} for s, p in
                           sorted(top.items(), key=lambda kv: -abs(kv[1]))[:8]],
        }

    def _master_row(self, symbol: str) -> Optional[dict]:
        for name in db.broker_dbs_keys():
            r = db.broker_db(name).one("SELECT * FROM master WHERE symbol=?", (symbol,))
            if r:
                return r
        return None

    # ------------------------------------------------------------------ sync subscriptions
    async def set_sync_subs(self, sid: str, chains: list[dict], index: list[str]) -> None:
        self._sync_subs[sid] = {"chains": chains or [], "index": index or []}
        # make sure chain legs + index constituents have a feed source
        from backend.options_chain import ensure_chain_subscribed, ensure_index_subscribed
        for c in (chains or []):
            u = (c.get("underlying") or "").upper()
            if u:
                await self._ensure_source(u)
                try:
                    await ensure_chain_subscribed(u, c.get("expiry"))
                except Exception as e:
                    self.feed_note(f"chain legs {u}: {e}", "WARN")
        for sym in (index or []):
            try:
                await ensure_index_subscribed(sym.upper())
            except Exception as e:
                self.feed_note(f"index {sym}: {e}", "WARN")

    def drop_sync_subs(self, sid: str) -> None:
        self._sync_subs.pop(sid, None)

    def chain_payload(self, underlying: str, expiry: Optional[str]) -> dict:
        from backend.options_chain import build_chain
        return build_chain(underlying.upper(), expiry)

    def index_payload(self, symbol: str) -> dict:
        from backend.options_chain import index_components
        return index_components(symbol.upper())

    # ------------------------------------------------------------------ broadcast helpers
    async def _broadcast(self, event: str, data: dict) -> None:
        if self.sio:
            await self.sio.emit(event, data)

    async def _emit_to(self, sid: str, event: str, data) -> None:
        if self.sio:
            await self.sio.emit(event, data, to=sid)

    async def on_connect(self, sid: str) -> None:
        self.sockets[sid] = {"symbols": set(), "candle": None, "tf": 1}
        await self._emit_to(sid, "mode", {"mode": self.trading_mode()})
        await self._emit_to(sid, "feed:source", {"source": self.feed_source(), "epoch": self.epoch})

    async def on_disconnect(self, sid: str) -> None:
        info = self.sockets.pop(sid, None)
        self.drop_sync_subs(sid)
        if not info:
            return
        syms = list(info.get("symbols", set()))
        if info.get("candle"):
            syms.append(info["candle"])
        await self.unsubscribe(sid, syms)


def _iso(ts: Optional[float]) -> str:
    if not ts:
        return ""
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts)) + "Z"
    except Exception:
        return ""


def _charges_dict(raw) -> dict:
    try:
        return json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        return {}


def _charges_total(raw) -> float:
    return (_charges_dict(raw) or {}).get("total", 0) or 0
