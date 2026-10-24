"""
Indian broking charges engine (NSE equity / futures / options).
Port of the previous terminal's charges.ts — used by every broker leg so
PnL + capital sizing reflect real costs.
"""
from __future__ import annotations

from typing import Optional
from dataclasses import dataclass


def segment_for(instrument_type: str, product_type: str) -> str:
    if instrument_type == "FUT":
        return "FUT"
    if instrument_type in ("CE", "PE"):
        return "OPT"
    return "EQ_DELIVERY" if product_type == "CNC" else "EQ_INTRADAY"


@dataclass
class Rate:
    brokerage_flat: float
    brokerage_pct: float
    stt_sell: float
    stt_buy: float
    txn: float
    sebi: float
    stamp_buy: float


RATES: dict[str, Rate] = {
    "EQ_INTRADAY": Rate(20, 0.0003, 0.00025, 0.0, 0.0000297, 0.000001, 0.00003),
    "EQ_DELIVERY": Rate(20, 0.0, 0.001, 0.001, 0.0000297, 0.000001, 0.00015),
    "FUT": Rate(20, 0.0003, 0.0002, 0.0, 0.0000173, 0.000001, 0.00002),
    "OPT": Rate(20, 0.0, 0.001, 0.0, 0.0003503, 0.000001, 0.00003),
}


def _r2(n: float) -> float:
    return round(n * 100) / 100


def calc_charges(instrument_type: str, product_type: str, side: str, value: float) -> dict:
    seg = segment_for(instrument_type, product_type)
    r = RATES[seg]
    v = max(0.0, value)
    brokerage = min(r.brokerage_flat, v * r.brokerage_pct) if r.brokerage_pct > 0 else r.brokerage_flat
    stt = (r.stt_sell if side.upper() == "SELL" else r.stt_buy) * v
    transaction = r.txn * v
    sebi = r.sebi * v
    stamp = r.stamp_buy * v if side.upper() == "BUY" else 0.0
    gst = 0.18 * (brokerage + transaction + sebi)
    total = brokerage + stt + transaction + sebi + stamp + gst
    return {
        "brokerage": _r2(brokerage), "stt": _r2(stt), "transaction": _r2(transaction),
        "gst": _r2(gst), "sebi": _r2(sebi), "stamp": _r2(stamp), "total": _r2(total),
    }


def leverage_for(instrument_type: str, product_type: str) -> float:
    if instrument_type in ("CE", "PE"):
        return 1.0
    if instrument_type == "FUT":
        return 5.0
    return 1.0 if product_type == "CNC" else 5.0


def instrument_of(master_row: Optional[dict]) -> str:
    if not master_row:
        return "EQ"
    inst = (master_row.get("instrument") or "EQ").upper()
    right = (master_row.get("right") or "").upper()
    if inst in ("OPT", "OPTION"):
        return right if right in ("CE", "PE") else "CE"
    return inst
