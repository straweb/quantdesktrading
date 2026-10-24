"""
Per-account EDITABLE charges schedule — brokerage + statutory taxes.

Every account gets a full charge schedule (4 segments: EQ intraday,
EQ delivery, FUT, OPT).  Defaults = TODAY'S market values, customised
per broker type (flat brokerage differs: Shoonya zero, Dhan/Breeze ₹20,
sim ₹20 so paper trading mirrors real costs).  The user can edit ANY
number later from the Broker Accounts box → "Charges" button.

The schedule feeds:
  • hub._record_fill — every fill books charges from the account's own
    schedule (so trades/realized-pnl/charges-paid are broker-accurate)
  • /margin — P&L preview incl. round-trip charges + breakeven + net
  • /charges GET/PUT — the editor UI

Schedule JSON shape (per segment):
  {brokerageFlat, brokeragePct, sttBuy, sttSell, txn, sebi, stampBuy, gstPct}
Rates are FRACTIONS (0.001 = 0.1%); brokerageFlat is ₹ per order.
"""
from __future__ import annotations

from typing import Optional
import json
import time

from backend import config, db

# ---------------------------------------------------------------- defaults
# Statutory rates = today's (2025) Indian market values, identical for all
# brokers; brokerage differs per broker platform.
STATUTORY = {   # segment -> (sttBuy, sttSell, txn, sebi, stampBuy)
    "EQ_INTRADAY": (0.0,        0.00025,   0.0000297, 0.000001, 0.00003),
    "EQ_DELIVERY": (0.001,      0.001,     0.0000297, 0.000001, 0.00015),
    "FUT":         (0.0,        0.0002,    0.0000173, 0.000001, 0.00002),
    "OPT":         (0.0,        0.001,     0.0003503, 0.000001, 0.00003),
}
GST_PCT = 0.18
SEGMENTS = ("EQ_INTRADAY", "EQ_DELIVERY", "FUT", "OPT")

# Round-25 — per-broker rate PROVENANCE.  Every default above is referenced
# from the broker's own pricing page; the date is when the schedule was last
# verified against those pages.  Statutory taxes (STT/txn/SEBI/stamp/GST) are
# set by law and identical for every broker — only brokerage differs.
CHARGES_AS_OF = "2026-10-24"
CHARGES_SOURCES = {
    "sim":          {"name": "Simulated Feed",
                     "note": "paper-trading reference schedule — ₹20 flat F&O so paper P&L ≈ typical discount-broker costs",
                     "links": []},
    "ICICI_BREEZE": {"name": "ICICI Direct (Breeze)",
                     "note": "ICICI's own rates: ₹20 per order for intraday + F&O (₹20/order across brokerage plans); equity delivery is plan-dependent (0.55% modelled); statutory taxes identical for all brokers",
                     "links": ["https://www.icicidirect.com/brokerage",
                               "https://www.icicidirect.com/calculators/brokerage-calculator"]},
    "DHAN":         {"name": "Dhan",
                     "note": "Dhan's own rates (verified from dhan.co/pricing): ₹20 per executed order for F&O + intraday equity (₹0 delivery); statutory taxes identical for all brokers",
                     "links": ["https://dhan.co/pricing/",
                               "https://dhan.co/calculators/brokerage-calculator/"]},
    "SHOONYA":      {"name": "Shoonya (Finvasia)",
                     "note": "Shoonya's own rates (verified from shoonya.com/pricing): ₹5 per executed order (or 0.03%, whichever is lower) for intraday + F&O; ₹0 delivery; NOT zero-brokerage any more (pricing revised, transaction charges from 1-Mar-2026)",
                     "links": ["https://shoonya.com/pricing",
                               "https://shoonya.com/calculators/brokerage-calculator"]},
}


def charges_source(broker: str) -> dict:
    """Provenance block for the charges dialog (name + verified-on date + links)."""
    src = CHARGES_SOURCES.get((broker or "").upper()) or CHARGES_SOURCES["sim"]
    return {"name": src["name"], "note": src["note"], "links": src["links"], "asOf": CHARGES_AS_OF}

# Broker-flavoured brokerage defaults (flat ₹ per order / pct of turnover).
# brokerage = min(flat, value × pct) when pct > 0, else flat — so a huge flat
# models a pure-% schedule (ICICI delivery 0.55%).
# Verified 2026-10-24 from each broker's pricing page (round-27):
#   ICICI  — ₹20/order intraday + F&O (icicidirect.com/brokerage)
#   Dhan   — ₹20/order F&O + intraday, ₹0 delivery (dhan.co/pricing)
#   Shoonya— ₹5/order (or 0.03%, lower) intraday + F&O, ₹0 delivery
#            (shoonya.com/pricing — NOT zero-brokerage any more)
BROKER_BROKERAGE = {
    "sim":         {"EQ_INTRADAY": (20, 0.0003), "EQ_DELIVERY": (0, 0.0),
                    "FUT": (20, 0.0003),          "OPT": (20, 0.0)},
    "ICICI_BREEZE":{"EQ_INTRADAY": (20, 0.0003), "EQ_DELIVERY": (100000, 0.0055),
                    "FUT": (20, 0.0003),          "OPT": (20, 0.0)},
    "DHAN":        {"EQ_INTRADAY": (20, 0.0003), "EQ_DELIVERY": (0, 0.0),
                    "FUT": (20, 0.0003),          "OPT": (20, 0.0)},
    "SHOONYA":     {"EQ_INTRADAY": (5, 0.0003),  "EQ_DELIVERY": (0, 0.0),
                    "FUT": (5, 0.0003),           "OPT": (5, 0.0)},
    # openalgo plugin brokers default to the ₹20-flat reference schedule
    # (editable per account in Admin → Charges)
    "OA_DEFAULT":  {"EQ_INTRADAY": (20, 0.0003), "EQ_DELIVERY": (100000, 0.0055),
                    "FUT": (20, 0.0003),          "OPT": (20, 0.0)},
}


def default_schedule(broker: str = "") -> dict:
    """Full default schedule for a broker (today's market values)."""
    b = (broker or "").upper()
    bk = BROKER_BROKERAGE.get(b)
    if bk is None and b.startswith("OA-"):
        bk = BROKER_BROKERAGE["OA_DEFAULT"]
    if bk is None:
        bk = BROKER_BROKERAGE.get(broker, BROKER_BROKERAGE["sim"])
    out: dict[str, dict] = {}
    for seg in SEGMENTS:
        stt_b, stt_s, txn, sebi, stamp = STATUTORY[seg]
        flat, pct = bk[seg]
        out[seg] = {
            "brokerageFlat": flat, "brokeragePct": pct,
            "sttBuy": stt_b, "sttSell": stt_s,
            "txn": txn, "sebi": sebi, "stampBuy": stamp, "gstPct": GST_PCT,
        }
    return out


# ---------------------------------------------------------------- storage
def _ensure_table() -> None:
    db.core().exec("""CREATE TABLE IF NOT EXISTS charges_config(
        account_id INTEGER PRIMARY KEY,
        broker TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at REAL NOT NULL)""")


def get_override(account_id: int) -> Optional[dict]:
    _ensure_table()
    row = db.core().one("SELECT data FROM charges_config WHERE account_id=?", (int(account_id),))
    if not row:
        return None
    try:
        return json.loads(row["data"])
    except Exception:
        return None


def save_override(account_id: int, broker: str, schedule: dict) -> None:
    _ensure_table()
    db.core().exec(
        "INSERT INTO charges_config(account_id,broker,data,updated_at) VALUES(?,?,?,?) "
        "ON CONFLICT(account_id) DO UPDATE SET data=excluded.data, broker=excluded.broker, "
        "updated_at=excluded.updated_at",
        (int(account_id), broker, json.dumps(schedule), time.time()))
    config.log("charges", f"schedule saved for account#{account_id} ({broker})")


def clear_override(account_id: int) -> None:
    _ensure_table()
    db.core().exec("DELETE FROM charges_config WHERE account_id=?", (int(account_id),))


def effective_schedule(account_id: int, broker: str = "") -> dict:
    """Account override merged over the broker defaults (deep per-segment)."""
    base = default_schedule(broker)
    ov = get_override(account_id)
    if not ov:
        return base
    for seg in SEGMENTS:
        if seg in ov and isinstance(ov[seg], dict):
            for k, v in ov[seg].items():
                if k in base[seg]:
                    try:
                        base[seg][k] = max(0.0, float(v))
                    except (TypeError, ValueError):
                        pass
    return base


# ---------------------------------------------------------------- calc
def _r2(n: float) -> float:
    return round(n * 100) / 100


def segment_for(instrument_type: str, product_type: str) -> str:
    if instrument_type == "FUT":
        return "FUT"
    if instrument_type in ("CE", "PE"):
        return "OPT"
    return "EQ_DELIVERY" if product_type == "CNC" else "EQ_INTRADAY"


def calc_charges_sched(schedule: dict, instrument_type: str, product_type: str,
                       side: str, value: float) -> dict:
    """Charge breakdown from a GIVEN schedule (mirrors charges.calc_charges)."""
    seg = segment_for(instrument_type, product_type)
    r = schedule.get(seg) or default_schedule().get(seg)
    v = max(0.0, value)
    pct = float(r.get("brokeragePct") or 0)
    flat = float(r.get("brokerageFlat") or 0)
    brokerage = min(flat, v * pct) if pct > 0 else flat
    sell = str(side).upper() == "SELL"
    stt_rate = float(r.get("sttSell") or 0) if sell else float(r.get("sttBuy") or 0)
    stt = stt_rate * v
    transaction = float(r.get("txn") or 0) * v
    sebi = float(r.get("sebi") or 0) * v
    stamp = float(r.get("stampBuy") or 0) * v if not sell else 0.0
    gst = float(r.get("gstPct") or GST_PCT) * (brokerage + transaction + sebi)
    total = brokerage + stt + transaction + sebi + stamp + gst
    return {"segment": seg, "brokerage": _r2(brokerage), "stt": _r2(stt),
            "transaction": _r2(transaction), "gst": _r2(gst), "sebi": _r2(sebi),
            "stamp": _r2(stamp), "total": _r2(total)}


def calc_charges_for(account_id: int, broker: str, instrument_type: str,
                     product_type: str, side: str, value: float) -> dict:
    """Convenience: effective schedule for the account + breakdown."""
    return calc_charges_sched(effective_schedule(account_id, broker),
                              instrument_type, product_type, side, value)


def round_trip(schedule: dict, instrument_type: str, product_type: str,
               qty: int, entry: float, exit_: Optional[float] = None) -> dict:
    """Full round-trip P&L preview: entry + exit legs, every charge line,
    gross pnl, total charges, NET pnl and breakeven exit price."""
    exit_ = entry if exit_ is None else exit_
    mult = 1 if instrument_type not in ("CE", "PE", "FUT") else qty and 1
    buy_val = entry * qty
    sell_val = exit_ * qty
    buy = calc_charges_sched(schedule, instrument_type, product_type, "BUY", buy_val)
    sell = calc_charges_sched(schedule, instrument_type, product_type, "SELL", sell_val)
    gross = (exit_ - entry) * qty
    charges = buy["total"] + sell["total"]
    net = gross - charges
    # breakeven exit: gross == total charges (fixed-point iterate — the sell
    # %-components move slightly with the exit price, converges in ~3 passes)
    be = entry
    for _ in range(4):
        sell_c = calc_charges_sched(schedule, instrument_type, product_type, "SELL", be * qty)["total"]
        be = entry + (buy["total"] + sell_c) / max(qty, 1)
    return {
        "buy": buy, "sell": sell,
        "buyValue": _r2(buy_val), "sellValue": _r2(sell_val),
        "grossPnl": _r2(gross), "totalCharges": _r2(charges), "netPnl": _r2(net),
        "breakeven": round(be, 2), "netMovePerUnit": _r2(net / qty) if qty else 0,
    }
