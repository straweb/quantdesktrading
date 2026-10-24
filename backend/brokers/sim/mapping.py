"""
SIM broker mapping — unified symbol <-> sim token (identity).

The sim master is a generated-but-realistic universe:
  - NSE indices: NIFTY, BANKNIFTY  ·  BSE index: SENSEX
  - NSE equities: 10 liquid names
  - NFO options: NIFTY + BANKNIFTY chains (Thursday weekly expiry)
  - BFO options: SENSEX chain (Tuesday weekly expiry)
Everything is deterministic given the day, so the UI, DB, and mapping behave
exactly like a real broker's contract file.
"""
from __future__ import annotations

from typing import Optional
from datetime import datetime, timedelta
import math

INDEXES = [
    {"symbol": "NSE:NIFTY",      "name": "NIFTY 50",          "base": 25450.0, "vol": 0.0006, "lot": 75},
    {"symbol": "NSE:BANKNIFTY",  "name": "NIFTY BANK",        "base": 56750.0, "vol": 0.0008, "lot": 35},
    {"symbol": "BSE:SENSEX",     "name": "BSE SENSEX",        "base": 81450.0, "vol": 0.0007, "lot": 20},
]
EQUITIES = [
    {"symbol": "NSE:RELIANCE",   "name": "Reliance Industries", "base": 2895.0, "vol": 0.0009, "lot": 250},
    {"symbol": "NSE:TCS",        "name": "Tata Consultancy",    "base": 4120.0, "vol": 0.0007, "lot": 175},
    {"symbol": "NSE:HDFCBANK",   "name": "HDFC Bank",           "base": 1712.0, "vol": 0.0008, "lot": 550},
    {"symbol": "NSE:INFY",       "name": "Infosys",             "base": 1876.0, "vol": 0.0008, "lot": 400},
    {"symbol": "NSE:SBIN",       "name": "State Bank of India", "base": 842.0,  "vol": 0.0010, "lot": 750},
    {"symbol": "NSE:ICICIBANK",  "name": "ICICI Bank",          "base": 1268.0, "vol": 0.0008, "lot": 700},
    {"symbol": "NSE:ITC",        "name": "ITC",                 "base": 471.0,  "vol": 0.0006, "lot": 1600},
    {"symbol": "NSE:TATAMOTORS", "name": "Tata Motors",         "base": 942.0,  "vol": 0.0012, "lot": 800},
    {"symbol": "NSE:AXISBANK",   "name": "Axis Bank",           "base": 1156.0, "vol": 0.0009, "lot": 625},
    {"symbol": "NSE:LT",         "name": "Larsen & Toubro",     "base": 3610.0, "vol": 0.0009, "lot": 150},
]

strikes: list[dict] = []


def _expiry_fmt(e: datetime) -> str:
    return f"{e.day:02d}{e.strftime('%b').upper()}{e.strftime('%y')}"


def _expiries(today: datetime, weekday: int = 3) -> list[str]:
    """Nearest 2 weekly expiries + 1 monthly, formatted 29OCT26 style.
    weekday: NSE weeks expire Thursday (3), BSE SENSEX Tuesday (1)."""
    days_ahead = (weekday - today.weekday()) % 7
    e1 = today + timedelta(days=days_ahead or 7)
    exps = [e1, e1 + timedelta(days=7), e1 + timedelta(days=30)]
    return [_expiry_fmt(e) for e in exps]


def build_universe(today: Optional[datetime] = None) -> list[dict]:
    """Full sim instrument list. Rebuilt when day changes."""
    global strikes
    today = today or datetime.now()
    rows: list[dict] = []
    for idx in INDEXES:
        rows.append({"token": idx["symbol"].split(":")[1], "symbol": idx["symbol"],
                     "name": idx["name"], "exchange": "NSE", "instrument": "INDEX",
                     "expiry": None, "strike": None, "right": "", "lotsize": idx["lot"]})
    for eq in EQUITIES:
        rows.append({"token": eq["symbol"].split(":")[1], "symbol": eq["symbol"],
                     "name": eq["name"], "exchange": "NSE", "instrument": "EQ",
                     "expiry": None, "strike": None, "right": "", "lotsize": eq["lot"]})
    exps = _expiries(today)
    exps_sensex = _expiries(today, weekday=1)   # BSE weekly = Tuesday
    chain_defs = [
        ("NIFTY", 25450.0, 50, 6, "NFO", exps, 75),      # 6 strikes each side
        ("BANKNIFTY", 56750.0, 100, 4, "NFO", exps, 35),
        ("SENSEX", 81450.0, 100, 4, "BFO", exps_sensex, 20),
    ]
    for under, spot, step, sides, exch, uexps, lot in chain_defs:
        for exp in uexps[:2]:
            for k in range(-sides, sides + 1):
                # half-up rounding (round() banker-rounds .5 midpoints, which
                # COLLAPSED the ladder for BANKNIFTY 567.5 / SENSEX 814.5)
                strike = math.floor(spot / step + 0.5 + k) * step
                for right in ("CE", "PE"):
                    sym = f"{exch}:{under}{exp}{int(strike)}{right}"
                    rows.append({"token": sym.split(":")[1], "symbol": sym,
                                 "name": f"{under} {exp} {int(strike)} {right}",
                                 "exchange": exch, "instrument": "OPT",
                                 "expiry": exp, "strike": strike, "right": right,
                                 "lotsize": lot})
    strikes = rows
    return rows


def token_of(symbol: str) -> str:
    """Unified -> broker token (identity for sim)."""
    return symbol.split(":", 1)[1] if ":" in symbol else symbol


def symbol_of(token: str, exchange: str = "NSE") -> str:
    return f"{exchange.upper()}:{token.upper()}"
