"""
Shoonya (Finvasia) mapping — unified symbol <-> Noren tsym.

Live master sources (authentic): https://api.shoonya.com/{EXCH}_symbols.txt.gz
  NSE_symbols.txt.gz  (equities), NFO_symbols.txt.gz (F&O), BSE, CDS, MCX, BFO...
Noren fields: tsym, exch, token, instname, prcftr, lotmul/ls, strkprc, exy, optt
Unified:  NSE:RELIANCE / NFO:NIFTY29O2525000CE
"""
from __future__ import annotations

from typing import Optional
import gzip
import json
from datetime import datetime

BASE = "https://api.shoonya.com"
MASTER_URLS = {ex: f"{BASE}/{ex}_symbols.txt.gz"
               for ex in ("NSE", "NFO", "BSE", "BFO", "MCX", "CDS")}
UNDERLYINGS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"}

MONTHS = {1: "JAN", 2: "FEB", 3: "MAR", 4: "APR", 5: "MAY", 6: "JUN",
          7: "JUL", 8: "AUG", 9: "SEP", 10: "OCT", 11: "NOV", 12: "DEC"}


def parse_symbols_gz(content: bytes, exch: str) -> list[dict]:
    out: list[dict] = []
    try:
        text = gzip.decompress(content).decode("utf-8", "replace")
    except Exception:
        text = content.decode("utf-8", "replace")
    for line in text.splitlines():
        line = line.strip().rstrip(";")
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        inst = (row.get("instname") or "").upper()
        tsym = row.get("tsym") or ""
        token = row.get("token") or ""
        if not tsym or not token:
            continue
        if exch == "NSE" and inst in ("EQ", "", "INDEX"):
            series = (row.get("series") or "EQ").upper()
            if series not in ("EQ", "BE", "SM", ""):
                continue
            out.append({"token": token, "symbol": f"NSE:{tsym}", "name": row.get("cname") or tsym,
                        "exchange": "NSE", "instrument": "INDEX" if inst == "INDEX" else "EQ",
                        "expiry": None, "strike": None, "right": "",
                        "lotsize": int(row.get("ls") or 1)})
        elif exch == "NFO" and inst == "OPTIDX" and (row.get("fname") or "").upper() in UNDERLYINGS:
            try:
                strike = float(row.get("strkprc") or 0)
            except ValueError:
                continue
            right = (row.get("optt") or "").upper()   # CE / PE
            d = row.get("exy") or ""                  # expiry date yyyymmdd? Noren: 'ddMMMyy' style in tsym
            short = _short_from(row, tsym)
            if not strike or right not in ("CE", "PE"):
                continue
            unified = f"NFO:{(row.get('fname') or '').upper()}{short}{int(strike)}{right}"
            out.append({"token": token, "symbol": unified, "name": tsym,
                        "exchange": "NFO", "instrument": "OPT", "expiry": short,
                        "strike": strike, "right": right, "lotsize": int(row.get("ls") or 1)})
        elif exch == "NFO" and inst == "FUTIDX" and (row.get("fname") or "").upper() in UNDERLYINGS:
            short = _short_from(row, tsym)
            unified = f"NFO:{(row.get('fname') or '').upper()}{short}FUT"
            out.append({"token": token, "symbol": unified, "name": tsym,
                        "exchange": "NFO", "instrument": "FUT", "expiry": short,
                        "strike": None, "right": "FUT", "lotsize": int(row.get("ls") or 1)})
    return out


def _short_from(row: dict, tsym: str) -> str:
    """Extract 29O25-style expiry from Noren tsym (NIFTY29O2525000CE)."""
    try:
        body = tsym.upper()
        under = (row.get("fname") or "").upper()
        rest = body[len(under):] if under and body.startswith(under) else body
        rest = rest.rstrip("CEPF").rstrip("0123456789") if False else rest
        # find expiry part: leading digits+3 letters (29O25)
        i = 0
        while i < len(rest) and rest[i].isdigit():
            i += 1
        if i + 3 <= len(rest) and rest[i:i + 3].isalpha():
            return rest[:i + 3]
    except Exception:
        pass
    return ""


def tsym_of(symbol: str, token: Optional[str] = None) -> str:
    """Unified -> Noren tsym (identity transform on the symbol part)."""
    return symbol.split(":", 1)[1] if ":" in symbol else symbol


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
