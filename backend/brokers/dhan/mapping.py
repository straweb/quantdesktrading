"""
Dhan mapping — unified symbol <-> Dhan SecurityId / ExchangeSegment.

Live master source (authentic): https://images.dhan.co/api-data/api-scrip-master.csv
Compact columns (SEM_*): EXM_EXCH_ID, SEGMENT, SMST_SECURITY_ID, INSTRUMENT_NAME,
TRADING_SYMBOL, LOT_UNITS, CUSTOM_SYMBOL, EXPIRY_DATE, STRIKE_PRICE, OPTION_TYPE...

Unified symbols:  NSE:RELIANCE / NFO:NIFTY29O2525000CE / IDX:NIFTY
WS segments:      NSE_EQ, NSE_FNO, IDX_I
"""
from __future__ import annotations

import csv
import io
from datetime import datetime

MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"

EXCH_SEG = {"NSE": "NSE_EQ", "NFO": "NSE_FNO", "BSE": "BSE_EQ", "BFO": "BSE_FNO",
            "IDX": "IDX_I", "CDS": "NSE_CURRENCY", "MCX": "MCX_COMM"}

MONTHS = {1: "JAN", 2: "FEB", 3: "MAR", 4: "APR", 5: "MAY", 6: "JUN",
          7: "JUL", 8: "AUG", 9: "SEP", 10: "OCT", 11: "NOV", 12: "DEC"}
UNDERLYINGS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"}


def parse_master_csv(content: bytes) -> list[dict]:
    """Parse compact scrip master; keeps NSE equities + F&O for tracked underlyings."""
    out: list[dict] = []
    reader = csv.reader(io.TextIOWrapper(io.BytesIO(content), encoding="utf-8", errors="replace"))
    header = next(reader, [])
    idx = {c.strip().upper(): i for i, c in enumerate(header)}
    g = lambda row, key, default="": row[idx[key]].strip() if key in idx and len(row) > idx[key] else default
    for row in reader:
        if len(row) < 6:
            continue
        exch = g(row, "SEM_EXM_EXCH_ID").upper()
        seg = g(row, "SEM_SEGMENT").upper()
        sec_id = g(row, "SEM_SMST_SECURITY_ID")
        inst = g(row, "SEM_INSTRUMENT_NAME").upper()
        sym = g(row, "SM_SYMBOL_NAME").upper()
        if not sec_id:
            continue
        if exch == "NSE" and inst == "EQUITY":
            if g(row, "SEM_SERIES").upper() not in ("EQ", "BE", "", "SM"):
                continue
            out.append({"token": sec_id, "symbol": f"NSE:{sym}", "name": g(row, "SEM_CUSTOM_SYMBOL") or sym,
                        "exchange": "NSE", "instrument": "EQ", "expiry": None, "strike": None,
                        "right": "", "lotsize": int(float(g(row, "SEM_LOT_UNITS", "1") or 1))})
        elif inst in ("OPTIDX", "OPTSTK") and sym in UNDERLYINGS:
            exp_raw = g(row, "SEM_EXPIRY_DATE")          # 2025-10-29
            strike = float(g(row, "0", "0") or 0) if False else _f(g(row, "SEM_STRIKE_PRICE"))
            right = g(row, "SEM_OPTION_TYPE").upper()
            if not exp_raw or not strike or right not in ("CE", "PE"):
                continue
            short = _expiry_short(exp_raw)
            unified = f"NFO:{sym}{short}{int(strike)}{right}"
            out.append({"token": sec_id, "symbol": unified, "name": g(row, "SEM_CUSTOM_SYMBOL") or unified.split(":", 1)[1],
                        "exchange": "NFO", "instrument": "OPT", "expiry": short,
                        "strike": strike, "right": right,
                        "lotsize": int(float(g(row, "SEM_LOT_UNITS", "1") or 1))})
        elif inst == "FUTIDX" and sym in UNDERLYINGS:
            exp_raw = g(row, "SEM_EXPIRY_DATE")
            if not exp_raw:
                continue
            short = _expiry_short(exp_raw)
            unified = f"NFO:{sym}{short}FUT"
            out.append({"token": sec_id, "symbol": unified, "name": f"{sym} {short} FUT",
                        "exchange": "NFO", "instrument": "FUT", "expiry": short,
                        "strike": None, "right": "FUT",
                        "lotsize": int(float(g(row, "SEM_LOT_UNITS", "1") or 1))})
        elif exch == "NSE" and inst == "INDEX":
            out.append({"token": sec_id, "symbol": f"NSE:{sym}", "name": g(row, "SEM_CUSTOM_SYMBOL") or sym,
                        "exchange": "NSE", "instrument": "INDEX", "expiry": None, "strike": None,
                        "right": "", "lotsize": 1})
    return out


def _f(v: str) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _expiry_short(exp_raw: str) -> str:
    try:
        d = datetime.strptime(exp_raw.strip()[:10], "%Y-%m-%d")
        return f"{d.day:02d}{MONTHS[d.month]}{d.strftime('%y')}"
    except Exception:
        return exp_raw


def to_dhan_symbol(symbol: str) -> dict:
    """Unified -> {securityId, exchangeSegment, instrument, expiryCode...} using master row is
    preferred; this is the fallback textual mapping."""
    exch, sym = (symbol.split(":", 1) + [""])[:2] if ":" in symbol else ("NSE", symbol)
    seg = EXCH_SEG.get(exch.upper(), "NSE_EQ")
    instrument = "EQUITY"
    if exch.upper() == "NFO":
        instrument = "OPTIDX" if sym.endswith(("CE", "PE")) else "FUTIDX"
    return {"securityId": sym, "exchangeSegment": seg, "instrument": instrument}
