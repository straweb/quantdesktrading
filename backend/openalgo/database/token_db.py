# OpenAlgo-vendor shim (quantdesk Round-27) — replaces upstream
# database/token_db.py + token_db_enhanced.py with ONE broker-aware,
# raw-sqlite3 implementation.
#
# WHY: upstream binds ONE SQLAlchemy engine at import (single-broker-per-
# deployment). Our app runs 37 OpenAlgo brokers in one process, each with its
# own masters file (db/openalgo-masters/<broker>.db written by that broker's
# own master_contract_download() via DATABASE_URL set in oa_context).
#
# HOW: an in-memory {(symbol, exchange) -> row} map per broker key, loaded
# lazily from that broker's masters file. The active broker key is a
# thread-local set by backend/brokers/oa/oa_context.py — every OA call runs
# inside `with oa_context(broker, account)` on a worker thread, so lookups
# always resolve to the right broker without touching any signature.
from __future__ import annotations

import os
import sqlite3
import threading
from collections import namedtuple
from typing import Any, Optional

from utils.logging import get_logger

logger = get_logger(__name__)

SymbolData = namedtuple("SymbolData", "symbol brsymbol name exchange brexchange token expiry strike lotsize instrumenttype tick_size")

_local = threading.local()
_cache: dict[str, dict[tuple[str, str], dict]] = {}
_cache_lock = threading.Lock()

MASTERS_DIR = os.path.join("db", "openalgo-masters")

token_cache = None  # backward-compat attribute some upstream code pokes


def set_active_broker(key: Optional[str]) -> None:
    _local.broker = key


def get_active_broker() -> Optional[str]:
    return getattr(_local, "broker", None)


def masters_path(broker: Optional[str] = None) -> str:
    b = broker or get_active_broker() or "_"
    return os.path.join(MASTERS_DIR, f"{b}.db")


def _conn(path: Optional[str] = None) -> sqlite3.Connection:
    p = path or masters_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    conn = sqlite3.connect(p, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS symtoken(
        id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, brsymbol TEXT, name TEXT,
        exchange TEXT, brexchange TEXT, token TEXT, expiry TEXT, strike REAL,
        lotsize INTEGER, instrumenttype TEXT, tick_size REAL, broker TEXT)""")
    conn.commit()


def _row_dict(r: sqlite3.Row) -> dict:
    return {k: r[k] for k in r.keys() if k != "id" and k != "broker"}


def _load(broker: Optional[str] = None) -> dict[tuple[str, str], dict]:
    b = broker or get_active_broker() or "_"
    with _cache_lock:
        snap = _cache.get(b)
        if snap is not None:
            return snap
        snap = {}
        try:
            conn = _conn(masters_path(b))
            try:
                cur = conn.execute("SELECT symbol, brsymbol, name, exchange, brexchange, token, expiry, strike, lotsize, instrumenttype, tick_size FROM symtoken")
                for r in cur:
                    row = dict(r)
                    if row["symbol"]:
                        snap[(row["symbol"].upper(), (row["exchange"] or "").upper())] = row
                        if row["brsymbol"]:
                            snap[("br:" + row["brsymbol"].upper(), (row["exchange"] or "").upper())] = row
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"token_db shim: load({b}) failed: {e}")
        _cache[b] = snap
        return snap


def invalidate(broker: Optional[str] = None) -> None:
    b = broker or get_active_broker() or "_"
    with _cache_lock:
        _cache.pop(b, None)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _lookup(symbol: str, exchange: str) -> Optional[dict]:
    snap = _load()
    row = snap.get((symbol.upper(), exchange.upper()))
    if row is None:
        row = snap.get(("br:" + symbol.upper(), exchange.upper()))
    return row


def _val(row: Optional[dict], key: str) -> Optional[str]:
    if not row:
        return None
    v = row.get(key)
    return None if v is None else str(v)


# ------------------------------------------------------------------ getters
def get_token(symbol: str, exchange: str) -> Optional[str]:
    return _val(_lookup(symbol, exchange), "token")


def get_symbol(symbol: str, exchange: str) -> Optional[str]:
    return _val(_lookup(symbol, exchange), "symbol")


def get_oa_symbol(brsymbol: str, exchange: str) -> Optional[str]:
    row = _lookup(brsymbol, exchange)
    return _val(row, "symbol") or brsymbol


def get_br_symbol(symbol: str, exchange: str) -> Optional[str]:
    return _val(_lookup(symbol, exchange), "brsymbol")


def get_brexchange(symbol: str, exchange: str) -> Optional[str]:
    return _val(_lookup(symbol, exchange), "brexchange") or exchange


def get_symbol_info(symbol: str, exchange: str) -> Optional[SymbolData]:
    row = _lookup(symbol, exchange)
    if not row:
        return None
    return SymbolData(
        symbol=row.get("symbol"), brsymbol=row.get("brsymbol"), name=row.get("name"),
        exchange=row.get("exchange"), brexchange=row.get("brexchange"), token=row.get("token"),
        expiry=row.get("expiry"), strike=row.get("strike"), lotsize=row.get("lotsize"),
        instrumenttype=row.get("instrumenttype"), tick_size=row.get("tick_size"))


def get_symbol_count(broker: Optional[str] = None) -> int:
    if broker:
        try:
            conn = _conn(masters_path(broker))
            try:
                return conn.execute("SELECT COUNT(*) c FROM symtoken").fetchone()["c"]
            finally:
                conn.close()
        except Exception:
            return 0
    return len(_load())


def search_symbols(symbol: str, exchange: Optional[str] = None) -> list[dict]:
    out = []
    pat = f"%{(symbol or '').upper()}%"
    try:
        conn = _conn()
        try:
            if exchange:
                cur = conn.execute("SELECT symbol, brsymbol, name, exchange, brexchange, token, expiry, strike, lotsize, instrumenttype, tick_size FROM symtoken WHERE symbol LIKE ? AND exchange=? LIMIT 100", (pat, exchange.upper()))
            else:
                cur = conn.execute("SELECT symbol, brsymbol, name, exchange, brexchange, token, expiry, strike, lotsize, instrumenttype, tick_size FROM symtoken WHERE symbol LIKE ? LIMIT 100", (pat,))
            out = [dict(r) for r in cur]
        finally:
            conn.close()
    except Exception as e:
        logger.debug(f"search_symbols: {e}")
    return out


def get_symbols_bulk(symbol: str, exchange: str) -> list[dict]:
    row = _lookup(symbol, exchange)
    return [row] if row else []


def get_tokens_bulk(symbol: str, exchange: str) -> list[str]:
    t = get_token(symbol, exchange)
    return [t] if t else []


def load_cache_for_broker(broker: str) -> bool:
    snap = _load(broker)
    return bool(snap)


# --------------------------------------------------------- direct db variants
def _dbquery(sql: str, args: tuple) -> Optional[dict]:
    try:
        conn = _conn()
        try:
            r = conn.execute(sql, args).fetchone()
            return dict(r) if r else None
        finally:
            conn.close()
    except Exception as e:
        logger.debug(f"token_db dbquery: {e}")
        return None


_SEL = "SELECT symbol, brsymbol, name, exchange, brexchange, token, expiry, strike, lotsize, instrumenttype, tick_size FROM symtoken WHERE "


def get_token_dbquery(symbol: str, exchange: str) -> Optional[str]:
    r = _dbquery(_SEL + "symbol=? AND exchange=?", (symbol.upper(), exchange.upper()))
    return _val(r, "token")


def get_symbol_dbquery(symbol: str, exchange: str) -> Optional[str]:
    r = _dbquery(_SEL + "symbol=? AND exchange=?", (symbol.upper(), exchange.upper()))
    return _val(r, "symbol")


def get_oa_symbol_dbquery(brsymbol: str, exchange: str) -> Optional[str]:
    r = _dbquery(_SEL + "brsymbol=? AND exchange=?", (brsymbol.upper(), exchange.upper()))
    return _val(r, "symbol")


def get_br_symbol_dbquery(symbol: str, exchange: str) -> Optional[str]:
    r = _dbquery(_SEL + "symbol=? AND exchange=?", (symbol.upper(), exchange.upper()))
    return _val(r, "brsymbol")


def get_brexchange_dbquery(symbol: str, exchange: str) -> Optional[str]:
    r = _dbquery(_SEL + "symbol=? AND exchange=?", (symbol.upper(), exchange.upper()))
    return _val(r, "brexchange")


def get_symbol_info_dbquery(symbol: str, exchange: str) -> Optional[SymbolData]:
    r = _dbquery(_SEL + "symbol=? AND exchange=?", (symbol.upper(), exchange.upper()))
    if not r:
        return None
    return get_symbol_info(r["symbol"], exchange)


def get_cache_stats() -> dict:
    return {"brokers": {b: len(s) for b, s in _cache.items()}, "active": get_active_broker()}
