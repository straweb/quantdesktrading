"""Round-27 — symbol translation between OUR unified namespace and OpenAlgo.

Our terminal's unified symbols are Dhan-style:  NFO:NIFTY05NOV2626200CE,
NSE:RELIANCE, NSE:NIFTY. OpenAlgo plugins speak their own per-broker dialect
(NIFTY27OCT26C17500 for Shoonya-style, NIFTY26O2726000CE for Kite-style, …)
resolved through each broker's symtoken table.

Rather than porting 37 dialects, the vendored symtoken rows carry
expiry/strike/instrumenttype columns — enough to resolve any of our symbols
structurally:
  1. exact symbol match (equities, most indices)
  2. constructed candidates (OA-shape heuristics: root+ddMMMyy+CP+strike,
     root+yyMdd+strike+CE, root+ddMMMyy+F, …)
  3. structural search: symbol LIKE root%, expiry≈target, strike≈target,
     right via the trailing C/P/CE/PE letter

The reverse direction (OA tick → our unified) is handled by the master-table
round-trip: sync_master writes master rows keyed token='EXCH|oasym' with
symbol='our-unified'; OAStream keeps that map in memory.
"""
from __future__ import annotations

import re
import sqlite3
import threading
from datetime import datetime
from typing import Optional

MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
          "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

INDEX_ALIASES = {
    "NIFTY 50": "NIFTY", "NIFTY50": "NIFTY", "NIFTY BANK": "BANKNIFTY",
    "NIFTYBANK": "BANKNIFTY", "FIN NIFTY": "FINNIFTY", "FINNIFTY": "FINNIFTY",
    "MID SELECT": "MIDCPNIFTY", "MIDCPNIFTY": "MIDCPNIFTY",
    "NIFTY NEXT 50": "NSMIDCP", "INDIA VIX": "INDIAVIX",
    "SENSEX": "SENSEX", "BANKEX": "BANKEX",
}

_roots = ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX")


def _conn(broker: str) -> sqlite3.Connection:
    import os

    path = os.path.abspath(os.path.join("db", "openalgo-masters", f"{broker}.db"))
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _root_of(oa_symbol: str, name: str = "") -> str:
    n = (name or "").strip().upper()
    if n:
        if n in INDEX_ALIASES:
            return INDEX_ALIASES[n]
        if re.fullmatch(r"[A-Z0-9&\- ]{2,30}", n) and " " not in n[:2]:
            return n.replace(" ", "")
    s = (oa_symbol or "").upper()
    for r in sorted(_roots, key=len, reverse=True):
        if s.startswith(r):
            return r
    m = re.match(r"^([A-Z][A-Z0-9&\-]{1,18}?)[0-9]", s)
    return m.group(1) if m else s.split("2")[0][:12] if "2" in s else s[:10]


def oa_expiry_to_dt(expiry: str) -> Optional[datetime]:
    e = (expiry or "").strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%y", "%d-%b-%Y", "%d-%m-%Y", "%Y%m%d",
                "%d%b%Y", "%d-%m-%y"):
        try:
            return datetime.strptime(e, fmt)
        except ValueError:
            continue
    return None


def _eff_instrument(oa_symbol: str, itype: str, exch: str) -> str:
    """Instrument classification — plugins like zerodha leave instrumenttype
    empty, so derive from the symbol text (CE/PE tail, FUT) as fallback."""
    t = (itype or "").upper()
    if "OPT" in t or "OPT" in exch.upper():
        return "OPT"
    if "FUT" in t:
        return "FUT"
    if "INDEX" in t or exch.endswith("_INDEX"):
        return "INDEX"
    s = (oa_symbol or "").upper()
    if re.search(r"(CE|PE)\d*$", s) or re.search(r"\d+(CE|PE)$", s):
        return "OPT"
    if "FUT" in s:
        return "FUT"
    return "EQ"


def _option_strike_right(sym: str, strike_col: float) -> tuple[float, str]:
    """(strike, right) from the symbol text, falling back to the strike column.
    Handles Kite 'NIFTY26O2726000CE', Shoonya 'NIFTY27OCT26C26200',
    Dhan 'NIFTY05NOV2626200CE' and 'NIFTY27OCT26P26200' shapes."""
    s = (sym or "").upper()
    strike = float(strike_col or 0)
    right = ""
    m = re.search(r"(\d+\.?\d*)(CE|PE)$", s)
    if m:
        strike = strike or float(m.group(1))
        right = m.group(2)
        return strike, right
    m = re.search(r"(\d+\.?\d*)([CP])$", s)
    if m:
        strike = strike or float(m.group(1))
        right = m.group(2) + "E"
        return strike, right
    m = re.search(r"([CP])(\d+\.?\d*)$", s)
    if m:
        right = m.group(1) + "E"
        strike = strike or float(m.group(2))
        return strike, right
    m = re.search(r"(\d+\.?\d*)([CP])(\d+\.?\d*)$", s)
    if m:
        strike = strike or float(m.group(3))
        right = m.group(2) + "E"
        return strike, right
    return strike, ("CE" if strike else "")


def _dhan_style_symbol(row: sqlite3.Row) -> Optional[str]:
    """Build OUR unified symbol part from a symtoken row (Dhan dialect)."""
    sym = (row["symbol"] or "").upper()
    exch = (row["exchange"] or row["brexchange"] or "").upper().replace("_INDEX", "")
    itype = _eff_instrument(sym, row["instrumenttype"] or "", row["exchange"] or "")
    dt = oa_expiry_to_dt(row["expiry"] or "")
    root = _root_of(sym, row["name"] or "")

    if "OPT" in itype:
        strike, right = _option_strike_right(sym, float(row["strike"] or 0))
        s_txt = str(int(strike)) if strike == int(strike) else f"{strike:g}"
        if not dt:
            return f"{exch}:{sym}"
        exp = f"{dt.day:02d}{MONTHS[dt.month - 1]}{dt.strftime('%y')}"
        return f"{exch}:{root}{exp}{s_txt}{right}"
    if "FUT" in itype:
        if not dt:
            return f"{exch}:{sym}"
        exp = f"{dt.day:02d}{MONTHS[dt.month - 1]}{dt.strftime('%y')}"
        return f"{exch}:{root}{exp}FUT"
    if "INDEX" in itype or exch.endswith("_INDEX"):
        base = INDEX_ALIASES.get((row["name"] or "").upper(), root)
        return f"NSE:{base}" if exch.startswith("NSE") else f"BSE:{base}"
    # equity
    return f"{exch}:{sym}"


def instrument_of(itype: str, exch: str) -> str:
    t = (itype or "").upper()
    if "OPT" in t:
        return "OPT"
    if "FUT" in t:
        return "FUT"
    if "INDEX" in t or exch.endswith("_INDEX"):
        return "INDEX"
    return "EQ"


def sync_to_master(broker: str) -> dict:
    """Copy the OA symtoken table into OUR per-broker master table
    (db/oa-<broker>.db) so hub._load_token_map + the option chain work as-is.
    `broker` is the plugin key; our registry/db name is 'oa-<plugin>'."""
    import backend.db as dbmod

    our_name = f"oa-{broker}"
    conn = _conn(broker)
    try:
        rows = conn.execute(
            "SELECT symbol, brsymbol, name, exchange, brexchange, token, expiry, "
            "strike, lotsize, instrumenttype, tick_size FROM symtoken").fetchall()
    finally:
        conn.close()

    bdb = dbmod.broker_db(our_name)
    out, seen = [], set()
    for r in rows:
        exch = (r["exchange"] or r["brexchange"] or "").upper().replace("_INDEX", "")
        if exch not in ("NSE", "BSE", "NFO", "BFO", "CDS", "MCX", "BCD"):
            exch = {"NSE_INDEX": "NSE", "BSE_INDEX": "BSE"}.get(
                (r["exchange"] or "").upper(), exch)
        unified = _dhan_style_symbol(r)
        if not unified or unified in seen:
            continue
        seen.add(unified)
        exch_r = r["exchange"] or ""
        itype = _eff_instrument((r["symbol"] or "").upper(), r["instrumenttype"] or "", exch_r)
        strike, right = (0.0, "")
        if itype == "OPT":
            strike, right = _option_strike_right(
                (r["symbol"] or "").upper(), float(r["strike"] or 0))
        dt = oa_expiry_to_dt(r["expiry"] or "")
        out.append((
            f"{exch}|{(r['symbol'] or '').upper()}",   # token composite for streams
            unified,                                    # OUR unified symbol
            (r["name"] or ""), exch,
            itype,
            (dt.strftime("%Y-%m-%d") if dt else ""),
            strike if itype == "OPT" else None,
            right,
            int(r["lotsize"] or 1),
            float(r["tick_size"] or 0.05),
        ))
    bdb.exec("DELETE FROM master")
    bdb.executemany(
        "INSERT OR REPLACE INTO master(token,symbol,name,exchange,instrument,expiry,strike,right,lotsize,tick_size) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)", out)
    bdb.exec("INSERT INTO sync_log(broker,source_url,source_kind,symbols,mappings,replaced,detail,ts)"
             " VALUES(?,?,?,?,?,1,?,?)",
             (our_name, f"openalgo:{broker}", "live-broker", len(out), len(out),
              "openalgo symtoken mirror", __import__("time").time()))
    return {"symbols": len(out), "mappings": len(out)}


def resolve(broker: str, unified: str) -> Optional[dict]:
    """OUR unified symbol → {symbol (OA), token, exchange} via symtoken.
    Order: master-table mirror → exact symtoken → constructed → structural."""
    import os as _os

    mirror = _os.path.join("db", f"{broker}.db")
    exch, _, sym = unified.partition(":")
    if not sym:
        exch, sym = "NSE", unified
    exch = exch.upper().replace("_INDEX", "")
    sym_u = sym.upper()

    conn = _conn(broker)
    try:
        # 1) exact OA symbol match
        r = conn.execute("SELECT symbol, token, exchange FROM symtoken WHERE UPPER(symbol)=? AND UPPER(SUBSTR(exchange,1,3))=? LIMIT 1",
                         (sym_u, exch[:3])).fetchone()
        if r:
            return {"symbol": r["symbol"], "token": str(r["token"]), "exchange": r["exchange"]}
        # 2) parse our Dhan-style: root + ddMMMyy + [strike][CE|PE] | FUT
        m = re.match(r"^([A-Z][A-Z0-9&\-]*?)(\d{2})([A-Z]{3})(\d{2})(\d*\.?\d*)(CE|PE|FUT)$", sym_u)
        if m:
            root, dd, mon, yy, strike, right = m.groups()
            month = MONTHS.index(mon) + 1 if mon in MONTHS else None
            if month:
                year = 2000 + int(yy)
                try:
                    dt = datetime(year, month, int(dd))
                except ValueError:
                    dt = None
                if dt:
                    strike_f = float(strike) if strike else None
                    # candidate rows for this root (+strike when known); expiry
                    # formats differ per broker so filter in Python
                    if right == "FUT":
                        cands = conn.execute(
                            "SELECT symbol, token, exchange, instrumenttype, expiry FROM symtoken "
                            "WHERE UPPER(symbol) LIKE ? AND (UPPER(instrumenttype) LIKE 'FUT%' OR UPPER(symbol) LIKE '%FUT') "
                            "ORDER BY LENGTH(symbol) LIMIT 80",
                            (root + "%",)).fetchall()
                        for c in cands:
                            cdt = oa_expiry_to_dt(c["expiry"] or "")
                            if cdt == dt:
                                return {"symbol": c["symbol"], "token": str(c["token"]), "exchange": c["exchange"]}
                    elif strike_f is not None:
                        cands = conn.execute(
                            "SELECT symbol, token, exchange, instrumenttype, expiry FROM symtoken "
                            "WHERE UPPER(symbol) LIKE ? AND ABS(COALESCE(strike,0)-?)<0.0001 LIMIT 120",
                            (root + "%", strike_f)).fetchall()
                        if not cands:  # plugins with empty strike columns
                            cands = conn.execute(
                                "SELECT symbol, token, exchange, instrumenttype, expiry FROM symtoken "
                                "WHERE UPPER(symbol) LIKE ? LIMIT 300",
                                (root + dt.strftime("%d%b%y").upper() + "%",)).fetchall()
                        pick = None
                        for c in cands:
                            s = (c["symbol"] or "").upper()
                            if re.search(r"OPT", (c["instrumenttype"] or "").upper()) or \
                               re.search(r"(CE|PE|\d[CP])$", s):
                                cdt = oa_expiry_to_dt(c["expiry"] or "")
                                if cdt is not None and cdt != dt:
                                    continue
                                # right letter match (either side of the strike)
                                if re.search(right[0] + re.escape(strike) + r"$", s) or \
                                   re.search(re.escape(strike) + right + r"$", s) or \
                                   s.endswith(right):
                                    pick = c
                                    break
                                if pick is None:
                                    pick = c
                        if pick is not None:
                            return {"symbol": pick["symbol"], "token": str(pick["token"]), "exchange": pick["exchange"]}
        # 3) raw-name match (equities under any exchange spelling)
        r = conn.execute("SELECT symbol, token, exchange FROM symtoken WHERE UPPER(symbol)=? LIMIT 1",
                         (sym_u,)).fetchone()
        if r:
            return {"symbol": r["symbol"], "token": str(r["token"]), "exchange": r["exchange"]}
        return None
    finally:
        conn.close()


class _Mapper:
    """module-like object returned by get_mapping('oa-<x>') — same surface as
    our native mapping modules (unused by the hub today, kept for parity)."""

    def __init__(self, broker: str):
        self.broker = broker

    def resolve(self, unified: str):
        return resolve(self.broker, unified)
