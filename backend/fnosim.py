"""
FNO Session Simulator — synthetic options trading session built on REAL
broker spot data.  (Entirely different from paper-trading tick replay:
the spot path is real broker 1m OHLCV, the option premiums are generated
from it with Black-Scholes using the user's expiry + volatility settings.)

Round-18 upgrades:
  • MULTI-UNDERLYING — the user adds a LIST of F&O stocks/indices and every
    one of them runs its own session in parallel (own dataset, own contracts,
    own run loop, own persisted row).
  • CUSTOM EXPIRY DATE+TIME — the geek setting accepts an absolute expiry
    ("YYYY-MM-DD HH:MM" IST, or date-only → 15:30).  Empty → TODAY (current
    date, 15:30 IST).  The label (DDMMMYY) builds the option symbols, the
    absolute datetime drives Black-Scholes T.
  • GREEKS — Black-Scholes delta/gamma/theta/vega are computed per contract
    (chain payload carries them; strikes populate from expiry+vol).
  • MINUTE PATH = REAL OHLCV EXACTLY — the first sub-tick of every minute IS
    the candle open, the last sub-tick IS the candle close, and the path
    REACHES the candle high and low in between.  The intra-minute wiggle
    scales with the user's volatility rate AND the candle's volume vs the
    day average (high-volume minutes wobble more).

Flow per underlying:
  1. user adds F&O underlyings + a historical session date (or RANDOM)
  2. engine pulls REAL 1m OHLCV of the spot through a connected live broker
     adapter (Breeze / Dhan / Shoonya) — session day + previous days
     (default 5, up to 6 months) for prev-day/week/month/6M high-low stats
  3. contracts: CE/PE for ATM±band strikes (strike ladder per underlying)
     are inserted into every broker master so orders route normally
  4. engine seeds chart history (spot: previous days + session day so far;
     options: BS-derived 1m path of the session day)
  5. the run loop walks the session minute-by-minute (speed = session
     minutes per real second), emitting ticks through the normal hub tick
     path — charts, chain, depth, order pad all behave like a live day.

Sessions are sandbox-only: starting one in LIVE ONLY mode is refused, and
an active session self-stops if the mode is switched to live.
"""
from __future__ import annotations

import asyncio
import json
import math
import random
import time
from datetime import datetime, timedelta
from typing import Optional

from backend import config, db

# NSE session window (IST).  ts values are naive-UTC epoch; IST = UTC+5:30.
SESSION_START_HM = (9, 15)
SESSION_END_HM = (15, 29)
IST = 19800

RISK_FREE = 0.065

# strike ladder for stock underlyings (indices use options_chain.STEPS)
_LADDER = (1.0, 2.5, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0)


# ------------------------------------------------------------------ helpers
def _n(x: float) -> float:
    """Standard normal CDF."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _bs_premium(right: str, S: float, K: float, T_years: float, iv: float) -> float:
    """Black-Scholes option premium (r=RISK_FREE), floored at 0.05."""
    if S <= 0 or K <= 0:
        return 0.05
    intrinsic = max(0.0, S - K) if right == "CE" else max(0.0, K - S)
    if T_years <= 0 or iv <= 0:
        return max(0.05, intrinsic)
    try:
        sqT = math.sqrt(T_years)
        d1 = (math.log(S / K) + (RISK_FREE + iv * iv / 2.0) * T_years) / (iv * sqT)
        d2 = d1 - iv * sqT
        disc = math.exp(-RISK_FREE * T_years)
        if right == "CE":
            px = S * _n(d1) - K * disc * _n(d2)
        else:
            px = K * disc * _n(-d2) - S * _n(-d1)
        return max(0.05, px)
    except (ValueError, ZeroDivisionError, OverflowError):
        return max(0.05, intrinsic)


def _bs_greeks(right: str, S: float, K: float, T_years: float, iv: float) -> dict:
    """Black-Scholes greeks: delta / gamma / theta(day) / vega(1% IV)."""
    out = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    if S <= 0 or K <= 0 or iv <= 0 or T_years <= 0:
        if S > 0 and K > 0:
            itm = S > K if right == "CE" else K > S
            out["delta"] = (1.0 if itm else 0.0) if T_years <= 0 else 0.0
        return out
    try:
        sqT = math.sqrt(T_years)
        d1 = (math.log(S / K) + (RISK_FREE + iv * iv / 2.0) * T_years) / (iv * sqT)
        d2 = d1 - iv * sqT
        pdf = math.exp(-d1 * d1 / 2.0) / math.sqrt(2.0 * math.pi)
        disc = math.exp(-RISK_FREE * T_years)
        if right == "CE":
            delta = _n(d1)
            theta = (-(S * pdf * iv) / (2 * sqT) - RISK_FREE * K * disc * _n(d2)) / 365.0
        else:
            delta = _n(d1) - 1.0
            theta = (-(S * pdf * iv) / (2 * sqT) + RISK_FREE * K * disc * _n(-d2)) / 365.0
        gamma = pdf / (S * iv * sqT)
        vega = S * pdf * sqT / 100.0
        return {"delta": round(delta, 4), "gamma": round(gamma, 6),
                "theta": round(theta, 3), "vega": round(vega, 3)}
    except (ValueError, ZeroDivisionError, OverflowError):
        return out


def _ist_hm(ts: int) -> int:
    g = time.gmtime(ts + IST)
    return g.tm_hour * 100 + g.tm_min


def _ist_date(ts: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts + IST))


def _ist_now() -> datetime:
    return datetime.utcnow() + timedelta(seconds=IST)


def _step_for(underlying: str, spot: float) -> float:
    from backend.options_chain import STEPS
    if underlying in STEPS:
        return float(STEPS[underlying])
    for st in _LADDER:
        if 20 <= spot / st <= 160:
            return st
    return 100.0


def _expiry_label(dt: datetime) -> str:
    """datetime -> '05NOV26' style symbol label."""
    return f"{dt.day:02d}{dt.strftime('%b').upper()}{dt.strftime('%y')}"


def _parse_expiry_input(raw: Optional[str]) -> datetime:
    """User expiry input -> absolute IST-naive datetime.

    accepted: 'YYYY-MM-DD HH:MM' · 'YYYY-MM-DD' (→15:30) · '05NOV26' (→15:30)
    empty/None → TODAY (current IST date) at 15:30.
    """
    s = (raw or "").strip()
    if not s:
        d = _ist_now().replace(hour=15, minute=30, second=0, microsecond=0)
        return d
    s = s.upper().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, fmt)
            if fmt == "%Y-%m-%d":
                dt = dt.replace(hour=15, minute=30)
            return dt
        except ValueError:
            continue
    try:
        return datetime.strptime(s, "%d%b%y") + timedelta(hours=15, minutes=30)
    except ValueError:
        pass
    raise ValueError(f"expiry must be 'YYYY-MM-DD HH:MM' or a date — got {raw!r}")


def _parse_label(label: str) -> Optional[datetime]:
    """'05NOV26' -> datetime (15:30 IST expiry close)."""
    try:
        return datetime.strptime(label.strip().upper(), "%d%b%y") + timedelta(hours=15, minutes=30)
    except Exception:
        return None


def _resolve_spot(underlying: str) -> tuple[str, str]:
    """Resolve the spot master row for an underlying across broker masters.
    Returns (spot_symbol, option_exchange) — SENSEX resolves to BSE:SENSEX
    with BFO options, everything else defaults to NSE + NFO."""
    for cand in (f"NSE:{underlying}", f"BSE:{underlying}"):
        for name in db.broker_dbs_keys():
            row = db.broker_db(name).one("SELECT symbol FROM master WHERE symbol=?", (cand,))
            if row:
                return cand, ("BFO" if cand.startswith("BSE:") else "NFO")
    return f"NSE:{underlying}", "NFO"


class FnoSimSession:
    """One underlying's session — full state + run loop (was the old SVC)."""

    def __init__(self) -> None:
        self.active = False
        self.completed = False
        self.playing = False            # manual start: prepare -> user presses Play
        self.underlying: Optional[str] = None
        self.spot_symbol: Optional[str] = None
        self.opt_exch = "NFO"           # option exchange (BFO for BSE underlyings)
        self.session_date: Optional[str] = None
        self.expiry: Optional[str] = None            # label used in symbols (05NOV26)
        self.expiry_dt: Optional[datetime] = None    # absolute expiry datetime (user geek setting)
        self.expiry_custom = False                # user-provided vs defaulted
        self.iv = 0.25              # annualised, user "volatility rate"
        self.speed = 5.0            # session minutes per real second
        self.band = 10
        self.prev_days = 5
        self.step = 50.0
        self.lot_size = 75
        self.strikes: list[int] = []
        self.stats: dict = {}
        self.source_label: Optional[str] = None
        self.symbols: set[str] = set()
        self.option_symbols: set[str] = set()
        self.error: Optional[str] = None
        self.started_at: Optional[float] = None
        self.ticks_sent = 0
        self.cursor_iso: Optional[str] = None
        self.progress = 0.0
        self._dataset: dict = {}
        self._minutes: list[int] = []
        self._candles: dict[int, dict] = {}
        self._cursor = 0
        self._task: Optional[asyncio.Task] = None
        self._prev_close: float = 0.0
        self._opt_prev: dict[str, float] = {}
        self._cumvol: dict[str, int] = {}
        self._opt_hi: dict[str, float] = {}
        self._opt_lo: dict[str, float] = {}
        self._avg_vol: float = 0.0
        self._last_minute_ts: Optional[int] = None
        self._running = False

    # ------------------------------------------------------------- sim-data fallback
    def _synthetic_dataset(self) -> dict:
        """Sim-feed fallback: DETERMINISTIC synthetic 1m OHLCV for the session
        day + previous days — so the Session Simulator works for any synced
        stock or index even with no live broker connected (sim-only users).
        Seeded per (underlying, session date) so re-runs replay the same day."""
        import zlib
        from backend.brokers.sim import mapping as sim_mapping
        base = None
        for row in list(sim_mapping.INDEXES) + list(sim_mapping.EQUITIES):
            if row["symbol"].split(":")[1] == self.underlying:
                base = float(row["base"])
                break
        if base is None:
            tick = Hub_instance().ticks.get(self.spot_symbol or "") or {}
            base = float(tick.get("ltp") or 1000.0)
        rnd = random.Random(zlib.crc32(f"{self.underlying}|{self.session_date}".encode()) & 0xFFFFFFFF)
        sig = max(0.0004, self.iv / math.sqrt(252.0 * 375.0))   # per-minute sigma

        def epoch(d: datetime, hm: tuple[int, int]) -> int:
            utc_naive = datetime(d.year, d.month, d.day, hm[0], hm[1])
            return int((utc_naive - datetime(1970, 1, 1)).total_seconds()) - IST

        def gen_day(d: datetime, start_px: float) -> tuple[list[dict], float]:
            rows: list[dict] = []
            px = start_px
            for mnum in range(9 * 60 + 15, 15 * 60 + 29 + 1):
                o = px
                hi = lo = px
                for _ in range(4):
                    px = max(0.05, px * (1.0 + rnd.gauss(0, sig)))
                    hi = max(hi, px)
                    lo = min(lo, px)
                if rnd.random() < 0.06:      # occasional impulse candle
                    px = max(0.05, px * (1.0 + rnd.gauss(0, sig * 3.0)))
                    hi = max(hi, px)
                    lo = min(lo, px)
                rows.append({"t": epoch(d, divmod(mnum, 60)), "o": round(o, 2),
                             "h": round(hi, 2), "l": round(lo, 2), "c": round(px, 2),
                             "v": int(rnd.uniform(0.3, 1.7) * 100000)})
            return rows, px

        sd = datetime.strptime(self.session_date or _ist_now().strftime("%Y-%m-%d"), "%Y-%m-%d")
        days: list[datetime] = []
        d = sd
        while len(days) < max(2, self.prev_days + 1):
            if d.weekday() < 5:
                days.append(d)
            d -= timedelta(days=1)
        days.reverse()
        px = base
        dailies: list[dict] = []
        prev_rows: list[dict] = []
        session_rows: list[dict] = []
        for d in days:
            rows, px = gen_day(d, px)
            dailies.append({"date": d.strftime("%Y-%m-%d"), "o": rows[0]["o"],
                            "h": max(r["h"] for r in rows), "l": min(r["l"] for r in rows),
                            "c": rows[-1]["c"]})
            if d.strftime("%Y-%m-%d") == self.session_date:
                session_rows = rows
            else:
                prev_rows.extend(rows)
        prev_rows = prev_rows[-self.prev_days * 375:]
        return {"session": session_rows, "prev_days": prev_rows, "dailies": dailies,
                "fetched_at": time.time(), "source": "Sim feed (synthetic 1m)",
                "synthetic": True}

    def now_dt(self) -> datetime:
        """'Current time' for pricing: the replay clock while the session
        walks (greeks/premiums evolve with the session), else wall clock."""
        if self._last_minute_ts is not None:
            return datetime.utcfromtimestamp(self._last_minute_ts + IST)
        return _ist_now()

    # ------------------------------------------------------------------ state
    def serves(self, symbol: str) -> bool:
        return self.active and symbol in self.symbols

    # ------------------------------------------------------------------ data load
    def _cache_get(self, underlying: str, date: str) -> Optional[dict]:
        row = db.core().one("SELECT data FROM fnosim_cache WHERE underlying=? AND date=?",
                            (underlying, date))
        if row:
            try:
                return json.loads(row["data"])
            except Exception:
                return None
        return None

    def _cache_put(self, underlying: str, date: str, data: dict) -> None:
        db.core().exec(
            "INSERT OR REPLACE INTO fnosim_cache(underlying,date,data,fetched_at) VALUES(?,?,?,?)",
            (underlying, date, json.dumps(data)[:4_000_000], time.time()))

    async def _load_spot(self) -> dict:
        """REAL 1m OHLCV through a connected live broker adapter.

        Returns {session: [...], prev_days: [...], dailies: [...], source: label}.
        Cached per (underlying, date) so re-runs never re-hit the broker API.
        """
        cached = self._cache_get(self.underlying, self.session_date)
        if cached:
            return cached
        hub = Hub_instance()
        # prefer the active feed source account, else any connected live broker
        order: list[int] = []
        src = hub.feed_source()
        if src not in ("sim", ""):
            try:
                order.append(int(src))
            except ValueError:
                pass
        for aid in hub.adapters:
            if aid not in order:
                order.append(aid)
        errors: list[str] = []
        for aid in order:
            adapter = hub.adapters.get(aid)
            if not adapter:
                continue
            acc = db.core().one("SELECT broker,label,mode FROM accounts WHERE id=?", (aid,))
            if not acc or acc["broker"] == "sim":
                continue
            label = f"{acc['label']} ({acc['broker']})"
            try:
                hist = await adapter.get_history(self.spot_symbol, 1, days=185)
                if not hist or len(hist) < 30:
                    errors.append(f"{label}: no history returned")
                    continue
                data = self._build_dataset(hist)
                if not data["session"]:
                    errors.append(f"{label}: no 1m data for {self.session_date}")
                    continue
                data["source"] = label
                self._cache_put(self.underlying, self.session_date, data)
                return data
            except Exception as e:
                errors.append(f"{label}: {str(e)[:120]}")
        # sim-feed fallback: DETERMINISTIC synthetic 1m data so the Session
        # Simulator works for any synced stock/index with no live broker
        # (not cached — a live broker must always win once connected)
        if errors:
            config.log("fnosim", f"live history unavailable ({'; '.join(errors[:2])}) — using sim synthetic data", "WARN")
        data = self._synthetic_dataset()
        if data["session"]:
            return data
        raise ValueError(
            "no 1m data available — connect a live broker account "
            "(Admin → Accounts) with history access. Attempts: " + " | ".join(errors[:3]))

    def _build_dataset(self, hist: list[dict]) -> dict:
        """Split raw 1m candles into session day / previous days / daily bars."""
        sess: list[dict] = []
        prev: list[dict] = []
        by_day: dict[str, list[dict]] = {}
        for c in hist:
            ts = int(c["t"])
            if _ist_hm(ts) < 900 or _ist_hm(ts) > 1530:
                continue
            d = _ist_date(ts)
            by_day.setdefault(d, []).append({"t": ts, "o": c["o"], "h": c["h"],
                                             "l": c["l"], "c": c["c"], "v": c.get("v") or 0})
        dates = sorted(by_day)
        for d in dates:
            if d == self.session_date:
                sess = sorted(by_day[d], key=lambda x: x["t"])
            elif d < self.session_date:
                prev.extend(sorted(by_day[d], key=lambda x: x["t"]))
        prev = prev[-self.prev_days * 375:]
        dailies = []
        for d in dates:
            rows = by_day[d]
            dailies.append({"date": d, "o": rows[0]["o"], "h": max(r["h"] for r in rows),
                            "l": min(r["l"] for r in rows), "c": rows[-1]["c"]})
        dailies = [d for d in dailies if d["date"] <= (self.session_date or "9999")]
        return {"session": sess, "prev_days": prev, "dailies": dailies,
                "fetched_at": time.time()}

    def _compute_stats(self, data: dict) -> dict:
        dailies = data.get("dailies") or []
        if not dailies:
            return {}
        def rng(n):
            rows = dailies[-n:] if n else dailies
            return {"high": max(d["h"] for d in rows), "low": min(d["l"] for d in rows)}
        # prev trading day strictly BEFORE the session date
        prev_rows = [d for d in dailies if d["date"] < (self.session_date or "")]
        prev_day = prev_rows[-1] if prev_rows else dailies[-1]
        return {
            "prevDayHigh": prev_day["h"], "prevDayLow": prev_day["l"],
            "weekHigh": rng(5)["high"], "weekLow": rng(5)["low"],
            "monthHigh": rng(21)["high"], "monthLow": rng(21)["low"],
            "sixMonthHigh": rng(0)["high"], "sixMonthLow": rng(0)["low"],
            "sessionDaysLoaded": len(dailies),
        }

    # ------------------------------------------------------------------ contracts
    def _ensure_contracts(self) -> None:
        """Insert CE/PE master rows for every band strike into every broker
        master (idempotent) so orders + quotes resolve like real contracts."""
        hub = Hub_instance()
        exp = self.expiry
        atm = round(self._session_open() / self.step) * self.step
        strikes = [int(atm + k * self.step) for k in range(-self.band, self.band + 1)]
        self.strikes = strikes
        rows = []
        for s in strikes:
            for right in ("CE", "PE"):
                sym = f"{self.opt_exch}:{self.underlying}{exp}{s}{right}"
                self.option_symbols.add(sym)
                rows.append((sym.split(":")[1], sym,
                             f"{self.underlying} {exp} {s} {right}",
                             self.opt_exch, "OPT", exp, s, right, self.lot_size))
        self.symbols = {self.spot_symbol, *self.option_symbols}
        touched: set[str] = set()
        for name in db.broker_dbs_keys():
            bdb = db.broker_db(name)
            if bdb.one("SELECT COUNT(*) c FROM master")["c"] == 0:
                continue
            bdb.executemany(
                "INSERT OR REPLACE INTO master(token,symbol,name,exchange,instrument,expiry,strike,right,lotsize) "
                "VALUES(?,?,?,?,?,?,?,?,?)", rows)
            touched.add(name)
        for aid in list(hub.adapters):
            acc = db.core().one("SELECT broker FROM accounts WHERE id=?", (aid,))
            if acc and acc["broker"] in touched:
                hub._load_token_map(aid)
        config.log("fnosim", f"contracts ensured: {len(rows)} option rows across {len(touched)} broker masters")

    def _session_open(self) -> float:
        rows = self._candles or {}
        if self._minutes:
            return float(rows[self._minutes[0]]["o"])
        return 100.0

    # ------------------------------------------------------------------ seeding
    def _seed_history(self) -> None:
        """Seed the aggregator so every chart opens with full context."""
        hub = Hub_instance()
        agg = hub.agg
        spot_prev = self._dataset.get("prev_days") or []
        up_to = self._minutes[self._cursor] if self._minutes else 0
        spot_hist = [c for c in spot_prev if c["t"] < up_to]
        spot_hist += [c for c in self._minutes if c < up_to and self._candles.get(c)]
        agg.seed_history(self.spot_symbol, spot_hist)
        # options: BS path of the session day so far (greeks-consistent)
        exp_dt = self.expiry_dt
        for sym in self.option_symbols:
            right = "CE" if sym.endswith("CE") else "PE"
            mrow = self._row_of(sym)
            strike = float((mrow or {}).get("strike") or 0)
            if not strike:
                continue
            path = []
            t0 = None
            for ts in self._minutes:
                if ts >= up_to:
                    break
                cnd = self._candles[ts]
                mid = (cnd["h"] + cnd["l"]) / 2.0
                T = max(0.0, (exp_dt - datetime.utcfromtimestamp(ts + IST)).total_seconds()) / (365 * 86400) if exp_dt else 5 / 365
                px = _bs_premium(right, mid, strike, T, self.iv)
                if t0 is None:
                    t0 = px
                path.append({"t": ts, "o": px, "h": px * 1.004, "l": px * 0.996,
                             "c": px, "v": int(cnd.get("v") or 0) // 40})
            if path:
                agg.seed_history(sym, path)
                self._opt_prev[sym] = round(t0, 2)
        # spot prev_close = last close BEFORE the session day
        if spot_prev:
            self._prev_close = float(spot_prev[-1]["c"])
        elif self._minutes:
            self._prev_close = float(self._candles[self._minutes[0]]["o"])

    def _row_of(self, symbol: str) -> Optional[dict]:
        for name in db.broker_dbs_keys():
            row = db.broker_db(name).one("SELECT * FROM master WHERE symbol=?", (symbol,))
            if row:
                return row
        return None

    # ------------------------------------------------------------------ lifecycle
    async def start(self, underlying: str, session_date: str, expiry_input: Optional[str],
                    iv_pct: float = 25.0, speed: float = 5.0, band: int = 10,
                    prev_days: int = 5) -> dict:
        if self.active:
            self.stop()
            await asyncio.sleep(0.1)
        hub = Hub_instance()
        if hub.trading_mode() == "live":
            raise ValueError("Session simulator is sandbox-only — switch trading mode to SANDBOX first")
        underlying = underlying.upper().strip()
        session_date = session_date.strip()
        try:
            datetime.strptime(session_date, "%Y-%m-%d")
        except ValueError:
            raise ValueError("session_date must be YYYY-MM-DD")
        if datetime.strptime(session_date, "%Y-%m-%d").weekday() >= 5:
            raise ValueError(f"{session_date} is a weekend — pick a trading day")
        self.underlying = underlying
        self.session_date = session_date
        # resolve the spot row (SENSEX -> BSE:SENSEX + BFO options)
        self.spot_symbol, self.opt_exch = _resolve_spot(underlying)
        self.iv = max(0.05, min(2.0, float(iv_pct) / 100.0))
        self.speed = max(0.5, min(60.0, float(speed)))
        self.band = max(3, min(20, int(band)))
        self.prev_days = max(1, min(185, int(prev_days)))
        self.error = None
        self.completed = False
        self.playing = False
        self.ticks_sent = 0
        self.progress = 0.0
        self.cursor_iso = None

        # custom expiry: absolute datetime (empty → current date 15:30 IST)
        self.expiry_dt = _parse_expiry_input(expiry_input)
        self.expiry_custom = bool((expiry_input or "").strip())
        self.expiry = _expiry_label(self.expiry_dt)

        # 1. REAL spot data (raises with a clear message when unavailable)
        data = await self._load_spot()
        self._dataset = data
        self._candles = {c["t"]: c for c in data["session"]}
        self._minutes = sorted(self._candles)
        if not self._minutes:
            raise ValueError(f"no 1m candles for {underlying} on {session_date} — pick another date")
        vols = [c.get("v") or 0 for c in data["session"]]
        self._avg_vol = (sum(vols) / len(vols)) if vols else 0.0
        self.stats = self._compute_stats(data)
        self.source_label = data.get("source") or "live broker"
        self._cursor = 0
        self._cumvol = {}
        self._opt_hi = {}
        self._opt_lo = {}

        # 2. step + lot
        spot0 = float(self._candles[self._minutes[0]]["o"])
        self.step = _step_for(underlying, spot0)
        urow = (self._row_of(self.spot_symbol) or self._row_of(f"NFO:{underlying}")
                or self._row_of(f"BFO:{underlying}"))
        self.lot_size = int((urow or {}).get("lotsize") or (75 if underlying in
                            ("NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX") else 250))

        # 3. contracts + history seeding (past data shows immediately —
        #    the session day itself only streams once the user presses Play)
        self._ensure_contracts()
        self._seed_history()

        # 4. persist + arm (PREPARE ONLY — the day starts on play())
        self.active = True
        self.started_at = time.time()
        self.playing = False
        db.core().exec(
            "INSERT INTO fnosim_sessions(underlying,session_date,expiry,iv,speed,status,source,stats,created_at) "
            "VALUES(?,?,?,?,?, 'ready', ?, ?, ?)",
            (underlying, session_date, self.expiry, self.iv, self.speed,
             self.source_label, json.dumps(self.stats), time.time()))
        self._running = True
        config.log("fnosim", f"session prepared: {underlying} {session_date} "
                             f"expiry={self.expiry} ({self.expiry_dt:%Y-%m-%d %H:%M} IST"
                             f"{', custom' if self.expiry_custom else ', defaulted to today'}) "
                             f"iv={self.iv:.2f} speed={self.speed} band=±{self.band} "
                             f"minutes={len(self._minutes)} source={self.source_label} "
                             "— waiting for PLAY")
        self._emit_event("ready")
        return self.status()

    # ------------------------------------------------------------------ play/pause
    def _emit_event(self, kind: str) -> None:
        """Best-effort WS push so every open terminal updates instantly."""
        hub = Hub_instance()
        if not hub.sio:
            return

        async def _push() -> None:
            try:
                await hub.sio.emit("fnosim", {"event": kind, **self.status()})
            except Exception:
                pass

        try:
            asyncio.ensure_future(_push())
        except RuntimeError:
            pass

    def play(self) -> dict:
        """Manually start (or resume) the session day — the user's prepare
        break ends here.  Resumes from the exact paused minute."""
        if not self.active or self.completed:
            return self.status()
        self.playing = True
        if self._task is None or self._task.done():
            self._running = True
            self._task = asyncio.ensure_future(self._run())
            self._task.add_done_callback(self._on_done)
        db.core().exec("UPDATE fnosim_sessions SET status='running' WHERE id="
                       "(SELECT MAX(id) FROM fnosim_sessions WHERE underlying=?)",
                       (self.underlying,))
        config.log("fnosim", f"session PLAYED: {self.underlying} "
                             f"(from {self.cursor_iso or '09:15 open'})")
        self._emit_event("playing")
        return self.status()

    def pause(self) -> dict:
        """Freeze the replay clock — resume later exactly where it stopped."""
        if not self.active:
            return self.status()
        self.playing = False
        db.core().exec("UPDATE fnosim_sessions SET status='paused' WHERE status='running' AND id="
                       "(SELECT MAX(id) FROM fnosim_sessions WHERE underlying=?)",
                       (self.underlying,))
        config.log("fnosim", f"session PAUSED: {self.underlying} @ {self.cursor_iso or 'start'}")
        self._emit_event("paused")
        return self.status()

    def _on_done(self, task: asyncio.Task) -> None:
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            exc = None
        if exc:
            self.error = str(exc)[:200]
            config.log("fnosim", f"session crashed: {exc}", "ERROR")
        self.active = False
        self._running = False
        if not self.error and not self.completed:
            self.completed = True

    def stop(self) -> dict:
        if self._task and not self._task.done():
            self._task.cancel()
        was = self.active
        self.active = False
        self._running = False
        if was:
            db.core().exec("UPDATE fnosim_sessions SET status='stopped', finished_at=? "
                           "WHERE status IN ('running','ready','paused') AND underlying=?",
                           (time.time(), self.underlying))
            config.log("fnosim", f"session stopped by user: {self.underlying}")
        return self.status()

    def patch(self, iv_pct: Optional[float] = None, speed: Optional[float] = None) -> dict:
        if iv_pct is not None:
            self.iv = max(0.05, min(2.0, float(iv_pct) / 100.0))
        if speed is not None:
            self.speed = max(0.5, min(60.0, float(speed)))
        return self.status()

    # ------------------------------------------------------------------ run loop
    def _make_tick(self, symbol: str, ltp: float, prev_close: float, vol_delta: int,
                   ts_ms: int, hi: float, lo: float, open_px: float) -> dict:
        return {"symbol": symbol, "exchange": symbol.split(":")[0],
                "ltp": round(max(0.05, ltp), 2), "prev_close": round(prev_close, 2),
                "bid": round(max(0.05, ltp - 0.05), 2), "ask": round(ltp + 0.05, 2),
                "bid_qty": random.randint(1, 40) * 10, "ask_qty": random.randint(1, 40) * 10,
                "vol": vol_delta, "open": round(open_px, 2), "high": round(hi, 2),
                "low": round(lo, 2), "close": round(ltp, 2),
                "ts": ts_ms, "source": "fnosim"}

    def _minute_path(self, cnd: dict, subs: int) -> list[float]:
        """Intra-minute spot path that matches the REAL 1m OHLCV exactly:
        pts[0] = open, pts[-1] = close, the path REACHES the candle high and
        low in between.  The wiggle between anchors scales with the user
        volatility AND the candle's volume vs the session-day average
        (high-volume minutes wobble more)."""
        o, h, l, c = cnd["o"], cnd["h"], cnd["l"], cnd["c"]
        v = cnd.get("v") or 0
        rng = max(0.05, h - l)
        vol_f = 1.0
        if self._avg_vol > 0 and v > 0:
            vol_f = max(0.6, min(1.7, 0.75 + 0.5 * (v / self._avg_vol)))
        wig = rng * 0.15 * (self.iv / 0.25) * vol_f
        mid1, mid2 = (h, l) if c >= o else (l, h)   # 1st extreme, 2nd extreme
        subs = max(4, subs)
        fr = [i / (subs - 1) for i in range(subs)]
        anchors = ((0.0, o), (0.4, mid1), (0.7, mid2), (1.0, c))
        pts = []
        for f in fr:
            for (f0, v0), (f1, v1) in zip(anchors, anchors[1:]):
                if f0 <= f <= f1:
                    v_ = v0 if f1 == f0 else v0 + (v1 - v0) * (f - f0) / (f1 - f0)
                    pts.append(v_)
                    break
        i1 = min(range(subs), key=lambda i: abs(fr[i] - 0.4))
        i2 = min(range(subs), key=lambda i: abs(fr[i] - 0.7))
        for i, p in enumerate(pts):
            # keep the OPEN (first), the two extremes and the CLOSE (last) exact
            if i in (0, i1, i2, subs - 1):
                continue
            # clamp INSIDE [l, h] so the aggregator's 1m candle high/low are
            # EXACTLY the real candle's high/low (nothing pokes beyond)
            pts[i] = min(h, max(l, p + random.gauss(0, wig * 0.5)))
        pts[i1], pts[i2], pts[-1], pts[0] = mid1, mid2, c, o
        return pts[:subs]

    async def _run(self) -> None:
        hub = Hub_instance()
        subs = 6                                   # sub-ticks per session minute
        exp_dt = self.expiry_dt
        run_hi, run_lo = -1e18, 1e18
        # resume: rebuild the running high/low from already-played minutes
        for ts in self._minutes[:self._cursor]:
            c0 = self._candles[ts]
            run_hi = max(run_hi, c0["h"])
            run_lo = min(run_lo, c0["l"])
        i = self._cursor
        while i < len(self._minutes):
            if not self._running:
                return
            if hub.trading_mode() == "live":       # sandbox-only guarantee
                config.log("fnosim", "LIVE ONLY mode — session auto-stopped", "WARN")
                self.stop()
                return
            if not self.playing:                   # paused / waiting for Play
                await asyncio.sleep(0.15)
                continue
            ts = self._minutes[i]
            cnd = self._candles[ts]
            self._last_minute_ts = ts
            run_hi = max(run_hi, cnd["h"])
            run_lo = min(run_lo, cnd["l"])
            path = self._minute_path(cnd, subs)
            sleep_s = max(0.02, (60.0 / self.speed) / subs)
            j = 0
            while j < len(path):
                if not self._running:
                    return
                if not self.playing:               # mid-minute pause freezes here
                    await asyncio.sleep(0.15)
                    continue
                px = path[j]
                ts_ms = (ts + int(j * 60 / subs)) * 1000
                self._emit_minute(ts, ts_ms, px, cnd, run_hi, run_lo,
                                  exp_dt, full=(j == subs - 1))
                await asyncio.sleep(sleep_s)
                j += 1
            self._cursor = i + 1
            self.progress = round(100.0 * (i + 1) / len(self._minutes), 1)
            dt = datetime.utcfromtimestamp(ts + IST)
            self.cursor_iso = dt.strftime("%Y-%m-%d %H:%M")
            i += 1
        self.completed = True
        self.active = False
        self._running = False
        db.core().exec("UPDATE fnosim_sessions SET status='completed', finished_at=? "
                       "WHERE status='running' AND underlying=?",
                       (time.time(), self.underlying))
        config.log("fnosim", f"session completed: {self.underlying} {self.session_date} "
                             f"({self.ticks_sent} ticks)")
        if hub.sio:
            try:
                await hub.sio.emit("fnosim", {"event": "completed", **self.status()})
            except Exception:
                pass

    def _emit_minute(self, minute_ts: int, ts_ms: int, spot_px: float, cnd: dict,
                     run_hi: float, run_lo: float,
                     exp_dt: Optional[datetime], full: bool) -> None:
        hub = Hub_instance()
        self._cumvol[self.spot_symbol] = self._cumvol.get(self.spot_symbol, 0) \
            + max(1, int((cnd.get("v") or 0) / 6))
        spot_tick = self._make_tick(self.spot_symbol, spot_px, self._prev_close,
                                    self._cumvol[self.spot_symbol], ts_ms,
                                    run_hi, run_lo, self._candles[self._minutes[0]]["o"])
        self._push(hub, spot_tick)
        T = max(0.0, (exp_dt - datetime.utcfromtimestamp(minute_ts + IST)).total_seconds()) \
            / (365 * 86400) if exp_dt else 5 / 365
        atm = round(cnd["o"] / self.step) * self.step
        emit = self.strikes if full else [s for s in self.strikes if abs(s - atm) <= 3 * self.step]
        for s in emit:
            for right in ("CE", "PE"):
                sym = f"{self.opt_exch}:{self.underlying}{self.expiry}{s}{right}"
                px = _bs_premium(right, spot_px, float(s), T, self.iv)
                px = round(px / 0.05) * 0.05
                prev = self._opt_prev.get(sym)
                if prev is None:
                    T0 = max(T, 1 / 365)
                    prev = round(_bs_premium(right, self._session_open(), float(s), T0, self.iv) / 0.05) * 0.05
                    self._opt_prev[sym] = prev
                self._cumvol[sym] = self._cumvol.get(sym, 0) + random.randint(1, max(2, self.lot_size // 10))
                hi = max(px, prev, self._opt_hi.get(sym, 0))
                lo = min(px, prev, self._opt_lo.get(sym, 1e18)) or px
                self._opt_hi[sym] = hi
                self._opt_lo[sym] = lo
                self._push(hub, self._make_tick(sym, px, prev, self._cumvol[sym], ts_ms,
                                                hi, lo, prev))

    def _push(self, hub, tick: dict) -> None:
        try:
            hub._on_broker_tick(tick)
            self.ticks_sent += 1
        except Exception as e:
            config.log("fnosim", f"tick push failed {tick.get('symbol')}: {e}", "WARN")

    # ------------------------------------------------------------------ status
    def status(self) -> dict:
        phase = None
        if self.completed:
            phase = "completed"
        elif self.active and self.playing:
            phase = "running"
        elif self.active and self._cursor > 0:
            phase = "paused"
        elif self.active:
            phase = "ready"          # prepared — history loaded, waiting for Play
        return {
            "active": self.active,
            "playing": self.playing,
            "phase": phase,
            "completed": self.completed,
            "error": self.error,
            "underlying": self.underlying,
            "spotSymbol": self.spot_symbol,
            "sessionDate": self.session_date,
            "expiry": self.expiry,
            "expiryDt": self.expiry_dt.strftime("%Y-%m-%d %H:%M") if self.expiry_dt else None,
            "expiryCustom": self.expiry_custom,
            "ivPct": round(self.iv * 100, 1),
            "speed": self.speed,
            "band": self.band,
            "step": self.step,
            "lotSize": self.lot_size,
            "strikeCount": len(self.strikes),
            "source": self.source_label,
            "progressPct": self.progress,
            "cursor": self.cursor_iso,
            "ticksSent": self.ticks_sent,
            "startedAt": self.started_at,
            "stats": self.stats,
            "symbols": len(self.symbols),
            "minutesLoaded": len(self._minutes),
            "historyDays": len((self._dataset or {}).get("dailies") or []),
            "sessionOpen": (round(float(self._candles[self._minutes[0]]["o"]), 2)
                            if self._minutes else None),
            "synthetic": bool((self._dataset or {}).get("synthetic")),
        }


class FnoSimManager:
    """Runs SEVERAL FnoSimSessions in parallel — the user adds a list of
    F&O stocks/indices and every underlying gets its own live session."""

    def __init__(self) -> None:
        self.engines: dict[str, FnoSimSession] = {}
        self._ensure_tables()

    def _ensure_tables(self) -> None:
        c = db.core()
        c.exec("""CREATE TABLE IF NOT EXISTS fnosim_cache(
                   underlying TEXT, date TEXT, data TEXT, fetched_at REAL,
                   PRIMARY KEY(underlying, date))""")
        c.exec("""CREATE TABLE IF NOT EXISTS fnosim_sessions(
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   underlying TEXT, session_date TEXT, expiry TEXT,
                   iv REAL, speed REAL, status TEXT, source TEXT,
                   stats TEXT, created_at REAL, finished_at REAL)""")

    # ------------------------------------------------------------------ state
    def serves(self, symbol: str) -> bool:
        return any(e.serves(symbol) for e in self.engines.values())

    def session_of(self, underlying: str) -> Optional[FnoSimSession]:
        e = self.engines.get((underlying or "").upper().strip())
        return e if (e and e.active) else None

    def expiry_of(self, underlying: str) -> Optional[str]:
        e = self.session_of(underlying)
        return e.expiry if e else None

    def iv_of(self, underlying: str) -> Optional[float]:
        e = self.session_of(underlying)
        return e.iv if e else None

    def expiry_dt_of(self, underlying: str) -> Optional[datetime]:
        e = self.session_of(underlying)
        return e.expiry_dt if e else None

    def active_underlyings(self) -> list[str]:
        return [u for u, e in self.engines.items() if e.active]

    @property
    def active(self) -> bool:
        return any(e.active for e in self.engines.values())

    # legacy single-session attribute shims (options_chain / hub compat)
    @property
    def underlying(self) -> Optional[str]:
        act = self.active_underlyings()
        return act[0] if act else None

    @property
    def expiry(self) -> Optional[str]:
        e = self.session_of(self.underlying or "")
        return e.expiry if e else None

    # ------------------------------------------------------------------ control
    async def start(self, underlyings: list[str], session_date: str,
                    expiry_input: Optional[str], iv_pct: float = 25.0,
                    speed: float = 5.0, band: int = 10, prev_days: int = 5) -> dict:
        """Start (or restart) a session for EVERY underlying in the list.
        Data loads run in parallel; a failure on one underlying does not
        cancel the others — the error lands on that session's status."""
        clean = []
        for u in underlyings:
            u = (u or "").upper().strip()
            if u and u not in clean:
                clean.append(u)
        if not clean:
            raise ValueError("add at least one F&O stock or index")
        # pre-flight: sandbox-only
        if Hub_instance().trading_mode() == "live":
            raise ValueError("Session simulator is sandbox-only — switch trading mode to SANDBOX first")

        async def one(u: str) -> None:
            eng = self.engines.get(u) or FnoSimSession()
            self.engines[u] = eng
            try:
                await eng.start(u, session_date, expiry_input,
                                iv_pct=iv_pct, speed=speed, band=band, prev_days=prev_days)
            except Exception as e:
                eng.error = str(e)[:220]
                eng.active = False
                config.log("fnosim", f"session start failed for {u}: {e}", "ERROR")

        await asyncio.gather(*(one(u) for u in clean))
        started = [u for u in clean if self.engines[u].active]
        if not started:
            errs = "; ".join(f"{u}: {self.engines[u].error}" for u in clean if self.engines[u].error)
            raise ValueError(errs[:400] or "no session could start")
        return self.status()

    def stop(self, underlying: Optional[str] = None) -> dict:
        if underlying:
            e = self.engines.get(underlying.upper().strip())
            if e:
                e.stop()
        else:
            for e in self.engines.values():
                e.stop()
        return self.status()

    def play(self, underlying: Optional[str] = None) -> dict:
        """Manually start / resume the session day (per underlying or all)."""
        if underlying:
            e = self.engines.get(underlying.upper().strip())
            if e:
                e.play()
        else:
            for e in self.engines.values():
                if e.active:
                    e.play()
        return self.status()

    def pause(self, underlying: Optional[str] = None) -> dict:
        """Freeze the replay clock (per underlying or all)."""
        if underlying:
            e = self.engines.get(underlying.upper().strip())
            if e:
                e.pause()
        else:
            for e in self.engines.values():
                if e.active:
                    e.pause()
        return self.status()

    def patch(self, iv_pct: Optional[float] = None, speed: Optional[float] = None,
              underlying: Optional[str] = None) -> dict:
        if underlying:
            e = self.engines.get(underlying.upper().strip())
            if e:
                e.patch(iv_pct, speed)
        else:
            for e in self.engines.values():
                if e.active:
                    e.patch(iv_pct, speed)
        return self.status()

    # ------------------------------------------------------------------ random
    def random_pick(self) -> dict:
        """Random F&O underlying + a random recent trading day."""
        unds = []
        try:
            from backend.options_chain import fno_universe
            for g in fno_universe().get("groups", []):
                for u in g.get("underlyings", []):
                    if u.get("latestExpiry") and (u.get("contracts") or 0) > 0:
                        unds.append(u)
        except Exception:
            pass
        if not unds:
            raise ValueError("F&O universe is empty — sync master contracts first")
        u = random.choice(unds)
        # random weekday within the last ~30 days
        today = _ist_now()
        d = today
        for _ in range(30):
            d = today - timedelta(days=random.randint(1, 30))
            if d.weekday() < 5:
                break
        return {"underlying": u["underlying"],
                "session_date": d.strftime("%Y-%m-%d"),
                "expiry": u.get("latestExpiry"),
                "name": u.get("name")}

    # ------------------------------------------------------------------ status
    def status(self) -> dict:
        live = [e.status() for e in self.engines.values()]
        act = [s for s in live if s["active"]]
        prim = act[0] if act else (live[0] if live else {
            "active": False, "completed": False, "error": None, "underlying": None,
            "spotSymbol": None, "sessionDate": None, "expiry": None, "expiryDt": None,
            "expiryCustom": False, "ivPct": 25.0, "speed": 5.0, "band": 10,
            "step": 50.0, "lotSize": 75, "strikeCount": 0, "source": None,
            "progressPct": 0.0, "cursor": None, "ticksSent": 0, "startedAt": None,
            "stats": {}, "symbols": 0})
        errors = [f"{s['underlying']}: {s['error']}" for s in live if s.get("error")]
        return {
            **prim,
            "count": len(live),
            "underlyings": [s["underlying"] for s in live],
            "live": live,
            "errors": errors,
        }


def Hub_instance():
    from backend.market.hub import Hub
    return Hub.instance()


SVC = FnoSimManager()
