"""
SQLite store — thread-safe thin wrapper over sqlite3.

DB files:
  core.db                       users / accounts / sessions / settings / orders / positions
  sim.db | breeze.db | ...      per-broker master contracts + broker mapping tables
"""
from __future__ import annotations

import sqlite3
import threading
import time
from typing import Any, Iterable, Optional

from backend import config


class DB:
    """Thin sqlite3 wrapper.

    Round-24 CRITICAL: this sandbox's filesystem breaks sqlite's durability
    assumptions for LONG-LIVED connections — reads pin stale snapshots and
    writes silently vanish (rowcount even lies).  EVERY fresh short-lived
    connection behaved perfectly in matrix tests, so the wrapper is now
    STATELESS: one fresh connection per operation.  Cost is microseconds on
    a local file; correctness is absolute.  journal_mode=DELETE (rollback
    journal) — WAL's mmap-backed -shm coordination is unreliable here too.
    """

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()

    def _conn(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
        con.row_factory = sqlite3.Row
        try:
            con.execute("PRAGMA journal_mode=DELETE")
            con.execute("PRAGMA synchronous=NORMAL")
            con.execute("PRAGMA busy_timeout=8000")
        except Exception:
            pass
        return con

    def exec(self, sql: str, params: Iterable[Any] = ()) -> None:
        with self._lock:
            con = self._conn()
            try:
                con.execute(sql, tuple(params))
                con.commit()
            finally:
                con.close()

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            con = self._conn()
            try:
                cur = con.execute(sql, tuple(params))
                return [dict(r) for r in cur.fetchall()]
            finally:
                con.close()

    def one(self, sql: str, params: Iterable[Any] = ()) -> Optional[dict]:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def executemany(self, sql: str, rows: list[tuple]) -> None:
        with self._lock:
            con = self._conn()
            try:
                con.executemany(sql, rows)
                con.commit()
            finally:
                con.close()

    def close(self) -> None:
        pass   # stateless — nothing to close


# ---------------------------------------------------------------- singletons
_core: Optional[DB] = None
_broker_dbs: dict[str, DB] = {}


def core() -> DB:
    global _core
    if _core is None:
        _core = DB(config.CORE_DB)
    return _core


def broker_db(name: str) -> DB:
    """Per-broker database (master contracts live here, OpenAlgo-style isolation)."""
    db = _broker_dbs.get(name)
    if db is None:
        path = config.BROKER_DBS.get(name) or config.BROKER_DBS["sim"]
        db = DB(path)
        _broker_dbs[name] = db
    return db


def broker_dbs_keys() -> list[str]:
    """All configured broker DB names (registry order)."""
    return list(config.BROKER_DBS.keys())


SCHEMA_SQL = [
    # app users
    """CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at REAL NOT NULL
    )""",
    # broker accounts (credentials JSON; editable per Round-10 requirement)
    """CREATE TABLE IF NOT EXISTS accounts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker TEXT NOT NULL,
        label TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'live',             -- live | sandbox
        credentials TEXT NOT NULL DEFAULT '{}',
        initial_capital REAL,                          -- None => % of funds
        initial_capital_mode TEXT,                     -- percent | fixed | null
        status TEXT NOT NULL DEFAULT 'disconnected',   -- disconnected | connecting | connected | error
        status_message TEXT,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    )""",
    # PERSISTED BROKER SESSIONS (Round-14 #1: survive page refresh AND backend restart)
    """CREATE TABLE IF NOT EXISTS broker_sessions(
        account_id INTEGER PRIMARY KEY,
        broker TEXT NOT NULL,
        session_token TEXT,
        refresh_token TEXT,
        session_meta TEXT NOT NULL DEFAULT '{}',       -- susertoken / uid / actid / user_id etc.
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        last_validated_at REAL
    )""",
    # orders (all brokers, sim fills locally)
    """CREATE TABLE IF NOT EXISTS orders(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        broker TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        qty INTEGER NOT NULL,
        price REAL,
        trigger_price REAL,
        order_type TEXT NOT NULL DEFAULT 'MARKET',
        product TEXT NOT NULL DEFAULT 'MIS',
        status TEXT NOT NULL DEFAULT 'open',
        filled_qty REAL NOT NULL DEFAULT 0,
        avg_price REAL,
        broker_order_id TEXT,
        message TEXT,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    )""",
    # positions
    """CREATE TABLE IF NOT EXISTS positions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        broker TEXT NOT NULL,
        symbol TEXT NOT NULL,
        qty REAL NOT NULL DEFAULT 0,
        avg_price REAL NOT NULL DEFAULT 0,
        ltp REAL NOT NULL DEFAULT 0,
        pnl REAL NOT NULL DEFAULT 0,
        product TEXT DEFAULT 'MIS',
        updated_at REAL NOT NULL,
        UNIQUE(account_id, symbol, product)
    )""",
    # watchlists
    """CREATE TABLE IF NOT EXISTS watchlist(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 1,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL DEFAULT 'NSE',
        added_at REAL NOT NULL,
        UNIQUE(user_id, symbol)
    )""",
    # settings (trading mode etc.)
    """CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
    # funds snapshot cache (last known, for instant chip display)
    """CREATE TABLE IF NOT EXISTS funds_snapshot(
        account_id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at REAL NOT NULL
    )""",
    # executed fills (quantdesk trades view: qty/price/charges/realized pnl)
    """CREATE TABLE IF NOT EXISTS trades(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL DEFAULT 'NSE',
        side TEXT NOT NULL,
        qty REAL NOT NULL,
        price REAL NOT NULL,
        value REAL NOT NULL,
        charges TEXT NOT NULL DEFAULT '{}',
        realized_pnl REAL,
        ts REAL NOT NULL
    )""",
    # order audit trail (master orders + legs JSON)
    """CREATE TABLE IF NOT EXISTS audit_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'MANUAL',
        action TEXT NOT NULL,
        master_symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        qty REAL NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        legs_json TEXT
    )""",
    # per-account broker call log (admin diagnostics)
    """CREATE TABLE IF NOT EXISTS broker_logs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        ts REAL NOT NULL,
        level TEXT NOT NULL DEFAULT 'INFO',
        message TEXT NOT NULL
    )""",
    # GTT rules (good-till-trigger orders)
    """CREATE TABLE IF NOT EXISTS gtt(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL DEFAULT 'NSE',
        side TEXT NOT NULL,
        qty INTEGER NOT NULL,
        trigger TEXT NOT NULL,            -- ABOVE | BELOW
        trigger_price REAL NOT NULL,
        order_type TEXT NOT NULL DEFAULT 'LIMIT',
        product_type TEXT NOT NULL DEFAULT 'MIS',
        repeat_daily INTEGER NOT NULL DEFAULT 0,
        armed INTEGER NOT NULL DEFAULT 1,
        last_triggered_at REAL,
        last_status TEXT,
        last_message TEXT,
        created_at REAL NOT NULL
    )""",
    # auto-bot rules (index / time / compound CE-PE deploy rules)
    """CREATE TABLE IF NOT EXISTS autorules(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        underlying TEXT NOT NULL,
        expiry TEXT,
        kind TEXT NOT NULL,               -- INDEX | INDEX_RANGE | TIME | COMPOUND
        level REAL, cross TEXT, lo REAL, hi REAL, time TEXT,
        entry_op TEXT, entry_lo REAL, entry_hi REAL,
        action TEXT NOT NULL DEFAULT 'BUY',
        opt_type TEXT NOT NULL DEFAULT 'CE',
        offset INTEGER NOT NULL DEFAULT 0,
        strikes TEXT,
        alloc_pct REAL NOT NULL DEFAULT 25,
        stop_loss REAL, target REAL,
        enabled INTEGER NOT NULL DEFAULT 1,
        repeat_daily INTEGER NOT NULL DEFAULT 0,
        last_fired_date TEXT,
        last_fired_at REAL,
        last_status TEXT, last_message TEXT,
        fire_count INTEGER NOT NULL DEFAULT 0,
        created_at REAL NOT NULL
    )""",
    # time-based strategies (python-exportable)
    """CREATE TABLE IF NOT EXISTS strategies(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle',
        exchange TEXT NOT NULL DEFAULT 'NFO',
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'BUY',
        product_type TEXT NOT NULL DEFAULT 'MIS',
        order_type TEXT NOT NULL DEFAULT 'MARKET',
        qty_mode TEXT NOT NULL DEFAULT 'FIXED',
        fixed_qty INTEGER NOT NULL DEFAULT 1,
        capital_amount REAL,
        entry_time TEXT NOT NULL DEFAULT '09:20',
        entry_window_min INTEGER NOT NULL DEFAULT 10,
        exit_time TEXT NOT NULL DEFAULT '15:10',
        repeat_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
        stop_loss_pct REAL, target_pct REAL, trailing_sl_pct REAL,
        last_run_date TEXT, entry_price REAL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        created_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS strategy_logs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id INTEGER NOT NULL,
        ts REAL NOT NULL,
        level TEXT NOT NULL DEFAULT 'INFO',
        message TEXT NOT NULL
    )""",
    # copy-trade config (single row)
    """CREATE TABLE IF NOT EXISTS copytrade(
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        master_account_id TEXT,
        capital_share_pct REAL NOT NULL DEFAULT 100,
        slippage_pct REAL NOT NULL DEFAULT 0.1,
        round_to_lot INTEGER NOT NULL DEFAULT 1,
        skip_failed_legs INTEGER NOT NULL DEFAULT 1,
        kill_switch INTEGER NOT NULL DEFAULT 0
    )""",
]

MASTER_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS master(
        token TEXT NOT NULL,                -- broker-native security token / code
        symbol TEXT NOT NULL,               -- unified symbol: NSE:NIFTY / NFO:NIFTY29O2525000CE
        name TEXT,
        exchange TEXT NOT NULL,
        instrument TEXT,                    -- EQ | INDEX | OPT | FUT
        expiry TEXT,
        strike REAL,
        right TEXT,                         -- CE | PE | ''
        lotsize INTEGER DEFAULT 1,
        tick_size REAL DEFAULT 0.05,
        UNIQUE(symbol)
    )""",
    """CREATE TABLE IF NOT EXISTS sync_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker TEXT NOT NULL,
        source_url TEXT,
        source_kind TEXT,                   -- live-broker | generated
        symbols INTEGER NOT NULL,
        mappings INTEGER NOT NULL,
        replaced INTEGER NOT NULL DEFAULT 1,
        detail TEXT,
        ts REAL NOT NULL
    )""",
]


def init_schema() -> None:
    db = core()
    for ddl in SCHEMA_SQL:
        db.exec(ddl)
    for name in config.BROKER_DBS:
        bdb = broker_db(name)
        for ddl in MASTER_SCHEMA:
            bdb.exec(ddl)
    _migrate()


def _migrate() -> None:
    """Additive migrations for DBs created by earlier builds."""
    cols = {r["name"] for r in core().query("PRAGMA table_info(accounts)")}
    adds = {
        "is_active": "INTEGER NOT NULL DEFAULT 1",
        "is_order_enabled": "INTEGER NOT NULL DEFAULT 1",
        "capital_mode": "TEXT NOT NULL DEFAULT 'INITIAL_PLUS_PNL'",
        "capital_pct": "REAL NOT NULL DEFAULT 100",
        "realized_pnl": "REAL NOT NULL DEFAULT 0",
        "charges_paid": "REAL NOT NULL DEFAULT 0",
        "first_trade_done": "INTEGER NOT NULL DEFAULT 0",
    }
    for col, ddl in adds.items():
        if col not in cols:
            try:
                core().exec(f"ALTER TABLE accounts ADD COLUMN {col} {ddl}")
            except Exception:
                pass
    ct = core().one("SELECT id FROM copytrade WHERE id=1")
    if not ct:
        core().exec("INSERT INTO copytrade(id,enabled,master_account_id) VALUES(1,0,NULL)")


def now() -> float:
    return time.time()
