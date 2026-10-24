"""
Shoonya (Finvasia) mapping — unified symbol <-> Noren tsym.

Round-26 (verified live against api.shoonya.com 2026-10-24):
  • the OLD Noren JSON-lines masters are GONE: {EXCH}_symbols.txt.gz → 404
  • the plain {EXCH}_symbols.txt files are STALE (2023-era contracts)
  • the LIVE masters are the ZIP archives: {EXCH}_symbols.txt.zip
    (inner file = plain CSV, header below)

New CSV format:
  NSE:  Exchange,Token,LotSize,Symbol,TradingSymbol,Instrument,TickSize
        NSE,2885,1,RELIANCE,RELIANCE-EQ,EQ,0.1
        NSE,26000,1,Nifty 50,NIFTY INDEX,INDEX,0
  NFO:  Exchange,Token,LotSize,Symbol,TradingSymbol,Expiry,Instrument,OptionType,StrikePrice,TickSize
        NFO,61717,65,NIFTY,NIFTY27OCT26C17500,27-OCT-2026,OPTIDX,CE,17500,0.05
        NFO,61471,65,NIFTY,NIFTY23NOV26F,23-NOV-2026,FUTIDX,XX,-0.01,0.1

Unified symbols (aligned with the Dhan adapter so option chains dedup):
  NSE equities : NSE:RELIANCE           (wire tsym keeps the -EQ suffix)
  NSE indices  : NSE:NIFTY / NSE:BANKNIFTY (alias-normalized)
  NFO options  : NFO:NIFTY27OCT26C17500 (tsym-exact — right letter BEFORE strike)
  NFO futures  : NFO:NIFTY23NOV26F      (tsym-exact — trailing F, not FUT)
  expiry short : ddMMMyy (27OCT26) — identical to the Dhan scheme

The legacy JSON-lines parser is kept as a fallback for old dumps.
"""
from __future__ import annotations

from typing import Optional
import csv
import gzip
import io
import json
import zipfile
from datetime import datetime

BASE = "https://api.shoonya.com"
# Round-26: zip archives are the LIVE masters; .txt is stale; .gz is dead.
MASTER_CANDIDATES = ("{ex}_symbols.txt.zip", "{ex}_symbols.txt", "{ex}_symbols.txt.gz")
MASTER_URLS = {ex: [f"{BASE}/{tpl.format(ex=ex)}" for tpl in MASTER_CANDIDATES]
               for ex in ("NSE", "NFO", "BSE", "BFO", "MCX", "CDS")}
UNDERLYINGS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"}

MONTHS = {1: "JAN", 2: "FEB", 3: "MAR", 4: "APR", 5: "MAY", 6: "JUN",
          7: "JUL", 8: "AUG", 9: "SEP", 10: "OCT", 11: "NOV", 12: "DEC"}

# Shoonya index names → our canonical underlyings (keyed on the
# space-stripped upper Symbol column)
INDEX_ALIASES = {
    "NIFTY50": "NIFTY", "NIFTY": "NIFTY",
    "NIFTYBANK": "BANKNIFTY", "BANKNIFTY": "BANKNIFTY",
    "NIFTYFINSERVICE": "FINNIFTY", "FINNIFTY": "FINNIFTY",
    "NIFTYMIDSELECT": "MIDCPNIFTY", "NIFTYMIDCAP150": "MIDCPNIFTY",
    "MIDCPNIFTY": "MIDCPNIFTY",
}


def _master_rows(content: bytes) -> str:
    """Extract the master text from zip / gz / plain bytes."""
    if content[:2] == b"PK":                      # zip archive (live format)
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            name = z.namelist()[0]
            return z.read(name).decode("utf-8", "replace")
    try:
        return gzip.decompress(content).decode("utf-8", "replace")
    except Exception:
        return content.decode("utf-8", "replace")


def parse_symbols(content: bytes, exch: str) -> list[dict]:
    """Dispatch: new CSV format (header has TradingSymbol) or legacy lines."""
    text = _master_rows(content)
    first = text.split("\n", 1)[0].upper()
    if "TRADINGSYMBOL" in first:
        return parse_symbols_csv(text, exch)
    return parse_symbols_gz(text.encode("utf-8", "replace"), exch)


def parse_symbols_csv(text: str, exch: str) -> list[dict]:
    """Round-26 parser for the live CSV masters."""
    out: list[dict] = []
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        ex = (row.get("Exchange") or exch or "").strip().upper()
        token = (row.get("Token") or "").strip()
        tsym = (row.get("TradingSymbol") or "").strip().upper()
        sym_name = (row.get("Symbol") or "").strip().upper()
        inst = (row.get("Instrument") or "").strip().upper()
        try:
            lot = int(float(row.get("LotSize") or 1))
        except (TypeError, ValueError):
            lot = 1
        if not token or not tsym:
            continue
        if ex == "NSE" and inst == "EQ":
            if not sym_name:
                continue
            out.append({"token": token, "symbol": f"NSE:{sym_name}",
                        "name": sym_name, "exchange": "NSE", "instrument": "EQ",
                        "expiry": None, "strike": None, "right": "", "lotsize": lot})
        elif ex == "NSE" and inst == "INDEX":
            norm = sym_name.replace(" ", "")
            under = INDEX_ALIASES.get(norm) or INDEX_ALIASES.get(tsym) or \
                (tsym[:-6] if tsym.endswith(" INDEX") else tsym).replace(" ", "")
            if not under:
                continue
            out.append({"token": token, "symbol": f"NSE:{under}",
                        "name": sym_name or under, "exchange": "NSE",
                        "instrument": "INDEX", "expiry": None, "strike": None,
                        "right": "", "lotsize": 1})
        elif ex == "NFO" and inst in ("OPTIDX", "OPTSTK"):
            under = sym_name
            if under not in UNDERLYINGS:
                continue
            try:
                strike = float(row.get("StrikePrice") or 0)
            except (TypeError, ValueError):
                continue
            right = (row.get("OptionType") or "").strip().upper()
            short = _expiry_short(row.get("Expiry") or "")
            if not strike or right not in ("CE", "PE") or not short:
                continue
            out.append({"token": token, "symbol": f"NFO:{tsym}", "name": tsym,
                        "exchange": "NFO", "instrument": "OPT", "expiry": short,
                        "strike": strike, "right": right, "lotsize": lot})
        elif ex == "NFO" and inst in ("FUTIDX", "FUTSTK"):
            under = sym_name
            if under not in UNDERLYINGS:
                continue
            short = _expiry_short(row.get("Expiry") or "")
            if not short:
                continue
            out.append({"token": token, "symbol": f"NFO:{tsym}", "name": tsym,
                        "exchange": "NFO", "instrument": "FUT", "expiry": short,
                        "strike": None, "right": "FUT", "lotsize": lot})
    return out


def _expiry_short(exp_raw: str) -> str:
    """'27-OCT-2026' -> '27OCT26' (identical scheme to the Dhan adapter)."""
    raw = (exp_raw or "").strip()
    for fmt in ("%d-%b-%Y", "%d-%b-%y", "%Y-%m-%d"):
        try:
            d = datetime.strptime(raw, fmt)
            return f"{d.day:02d}{MONTHS[d.month]}{d.strftime('%y')}"
        except ValueError:
            continue
    return ""


def parse_symbols_gz(content: bytes, exch: str) -> list[dict]:
    """LEGACY Noren JSON-lines parser (kept for old dumps / fallback)."""
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
    """Extract 29O25-style expiry from a legacy Noren tsym (NIFTY29O2525000CE)."""
    try:
        body = tsym.upper()
        under = (row.get("fname") or "").upper()
        rest = body[len(under):] if under and body.startswith(under) else body
        i = 0
        while i < len(rest) and rest[i].isdigit():
            i += 1
        if i + 3 <= len(rest) and rest[i:i + 3].isalpha():
            return rest[:i + 3]
    except Exception:
        pass
    return ""


def tsym_of(symbol: str, token: Optional[str] = None) -> str:
    """Unified -> Noren tsym (identity on the symbol part)."""
    return symbol.split(":", 1)[1] if ":" in symbol else symbol


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
