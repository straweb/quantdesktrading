"""
Breeze (ICICI Direct) mapping — unified symbol <-> Breeze stock_code/token.

Live master sources (authentic, per breeze-connect SDK):
  - Equities CSV : https://traderweb.icicidirect.com/Content/File/txtFile/ScripFile/StockScriptNew.csv
                   columns: token=col0, stock_code=col1, company=col3
  - SecurityMaster.zip (FONSE/NSE F&O tokens): https://directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip
                   NFO rows: token=col0, contract = OPT-{under}-{expiry}-{strike}-{CE|PE}

Unified symbols:
  NSE:RELIANCE            equities
  NSE:NIFTY / BANKNIFTY   indices (stock_code = NIFTY / CNXBAN)
  NFO:NIFTY29O2525000CE   options  (underlying + expiry + strike + right)
"""
from __future__ import annotations

from typing import Optional
import io
import csv
import zipfile
from datetime import datetime

INDEX_CODE = {"NIFTY": "NIFTY", "BANKNIFTY": "CNXBAN", "FINNIFTY": "NIFSEL", "MIDCPNIFTY": "NIFMDC"}
SECURITY_MASTER_URL = "https://directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip"
STOCK_SCRIPT_URL = "https://traderweb.icicidirect.com/Content/File/txtFile/ScripFile/StockScriptNew.csv"

MONTHS = {1: "JAN", 2: "FEB", 3: "MAR", 4: "APR", 5: "MAY", 6: "JUN",
          7: "JUL", 8: "AUG", 9: "SEP", 10: "OCT", 11: "NOV", 12: "DEC"}


def contract_symbol(underlying: str, expiry: str, strike: float, right: str) -> str:
    """expiry '29O25' style + strike + right -> NFO:NIFTY29O2525000CE"""
    return f"NFO:{underlying.upper()}{expiry.upper()}{int(strike)}{right.upper()}"


def parse_contract_symbol(symbol: str) -> Optional[dict]:
    """NFO:NIFTY29O2525000CE -> {underlying, expiry, strike, right}"""
    try:
        body = symbol.split(":", 1)[1]
        right = body[-2:]
        if right not in ("CE", "PE"):
            return None
        i = len(body) - 2
        while i > 0 and body[i - 1].isdigit():
            i -= 1
        strike = float(body[i:len(body) - 2])
        head = body[:i]                       # NIFTY29O25
        under = head.rstrip("0123456789")
        expiry = head[len(under):]            # 29O25
        return {"underlying": under, "expiry": expiry, "strike": strike, "right": right}
    except Exception:
        return None


def expiry_to_breeze(expiry: str) -> str:
    """29O25 -> 2025-10-29T14:30:00.000Z (Breeze param format)."""
    try:
        day, mon, yr = int(expiry[:2]), expiry[2:5], expiry[5:]
        month = {v: k for k, v in MONTHS.items()}[mon.upper()]
        year = 2000 + int(yr)
        return f"{year:04d}-{month:02d}-{day:02d}T14:30:00.000Z"
    except Exception:
        return expiry


def parse_stock_script_csv(content: bytes) -> list[dict]:
    """Equities from official ICICI scrip file (live source)."""
    out = []
    text = content.decode("utf-8", "replace")
    for line in text.splitlines():
        parts = next(csv.reader([line]))
        if len(parts) < 4:
            continue
        token, stock_code = parts[0].strip('"'), parts[1].strip('"')
        company = parts[3].strip('"')
        if not token.isdigit() or not stock_code:
            continue
        out.append({"token": token, "symbol": f"NSE:{stock_code}", "name": company,
                    "exchange": "NSE", "instrument": "EQ", "expiry": None,
                    "strike": None, "right": "", "lotsize": 1})
    return out


def parse_security_master_zip(content: bytes, underlyings: set[str]) -> list[dict]:
    """F&O rows from live SecurityMaster.zip (FONSE txt) restricted to underlyings."""
    out: list[dict] = []
    zf = zipfile.ZipFile(io.BytesIO(content))
    for fn in zf.namelist():
        if "FONSE" not in fn.upper() or not fn.lower().endswith(".txt"):
            continue
        with zf.open(fn) as file:
            reader = csv.reader(io.TextIOWrapper(file, encoding="utf-8"))
            for cols in reader:
                if len(cols) < 7:
                    continue
                token = cols[0].strip('"')
                ptype = cols[3].strip('"').upper()
                under = cols[2].strip('"').upper()
                if under not in underlyings:
                    continue
                if "FUT" in ptype:
                    expiry_raw = cols[4].strip('"')
                    sym = f"NFO:{under}{_expiry_short(expiry_raw)}"
                    out.append({"token": token, "symbol": sym, "name": f"{under} FUT",
                                "exchange": "NFO", "instrument": "FUT",
                                "expiry": _expiry_short(expiry_raw), "strike": None,
                                "right": "", "lotsize": 1})
                elif ptype == "OPT":
                    expiry_raw, strike_raw, ot = cols[4].strip('"'), cols[5].strip('"'), cols[6].strip('"')
                    right = "CE" if "C" in ot.upper() else "PE"
                    strike = float(strike_raw or 0)
                    sym = contract_symbol(under, _expiry_short(expiry_raw), strike, right)
                    out.append({"token": token, "symbol": sym, "name": sym.split(":", 1)[1],
                                "exchange": "NFO", "instrument": "OPT",
                                "expiry": _expiry_short(expiry_raw), "strike": strike,
                                "right": right, "lotsize": 1})
    return out


def _expiry_short(expiry_raw: str) -> str:
    """'29-Oct-2025' / '2025-10-29' variants -> 29O25"""
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%B-%Y"):
        try:
            d = datetime.strptime(expiry_raw.strip('"'), fmt)
            return f"{d.day:02d}{MONTHS[d.month]}{d.strftime('%y')}"
        except Exception:
            continue
    return expiry_raw.strip('"')
