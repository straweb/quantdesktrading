"""
OpenAlgo GTT payloads <-> ICICI Direct Breeze GTT payloads.

OpenAlgo flat payload (placegttorder.md):

    symbol, exchange, trigger_type ("SINGLE" | "OCO"), action, product,
    quantity, pricetype, price, triggerprice_sl[, triggerprice_tg,
    stoploss, target]

Breeze GTT (single leg):

    exchange_code (lowercase!), stock_code, product, quantity, gtt_type,
    index_or_stock, trade_date, order_details [{action, limit_price,
    trigger_price}] (+ expiry_date/right/strike_price for F&O)

Breeze GTT (three-leg OCO): gtt_type 'oco'/'cover_oco' with
fresh_order_* fields and multi-leg order_details.

IMPORTANT: Breeze GTT endpoints validate exchange codes in LOWERCASE
("Exchange-code should be 'nfo'.") — unlike the order endpoints.
"""

import re

from database.token_db import get_br_symbol, get_symbol_info
from utils.logging import get_logger

from broker.icici.mapping.transform_data import underlying_symbol


logger = get_logger(__name__)


_SYMBOL_RE = re.compile(
    r"^(?P<base>.+?)(?P<date>\d{2}[A-Za-z]{3}\d{2})"
    r"(?:(?P<strike>\d+(?:\.\d+)?)(?P<right>CE|PE)|FUT)$"
)

_MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

# OpenAlgo -> Breeze lowercase GTT exchange codes.
GTT_EXCHANGES = {
    "NSE": "nse",
    "BSE": "bse",
    "NFO": "nfo",
    "BFO": "bfo",
}


def normalise_gtt_exchange(exchange) -> str:
    value = str(exchange or "").upper()

    code = GTT_EXCHANGES.get(value)

    if not code:
        raise ValueError(
            f"Unsupported ICICI GTT exchange: {value}. "
            "Supported: NSE, BSE, NFO, BFO."
        )

    return code


def _parse_symbol(symbol: str) -> dict | None:
    match = _SYMBOL_RE.match(str(symbol or "").strip())

    if not match:
        return None

    date_text = match.group("date").upper()

    try:
        day = int(date_text[:2])
        month = _MONTHS[date_text[2:5]]
        year = 2000 + int(date_text[5:7])
    except (KeyError, ValueError):
        return None

    result = {
        "expiry": f"{year:04d}-{month:02d}-{day:02d}T06:00:00.000Z",
    }

    if match.group("strike"):
        strike_value = float(match.group("strike"))

        result["strike"] = (
            str(int(strike_value))
            if strike_value.is_integer()
            else str(strike_value)
        )
        result["right"] = (
            "call" if match.group("right") == "CE" else "put"
        )

    return result


def _product(data: dict) -> str:
    exchange = str(data.get("exchange") or "").upper()

    product = str(data.get("product") or "").upper()

    if exchange in ("NFO", "BFO", "MCX"):
        symbol = str(data.get("symbol") or "")

        if symbol.endswith(("CE", "PE")):
            return "options"

        return "futures"

    if product == "CNC":
        return "cash"

    if product == "NRML":
        return "futures"

    return "margin"


def _instrument_fields(data: dict) -> dict:
    exchange = str(data.get("exchange") or "").upper()

    if exchange not in ("NFO", "BFO", "MCX"):
        return {}

    result = {}

    parsed = _parse_symbol(data.get("symbol", ""))

    expiry = str(data.get("expiry_date") or "").strip()

    if not expiry and parsed:
        expiry = parsed.get("expiry", "")

    if expiry:
        result["expiry_date"] = expiry

    right = str(data.get("right") or "").strip().lower()

    strike = data.get("strike_price")

    if not right and parsed:
        right = parsed.get("right", "")

    if strike in (None, "", 0, "0") and parsed:
        strike = parsed.get("strike")

    if right in ("ce", "pe"):
        right = "call" if right == "ce" else "put"

    if right:
        result["right"] = right

    if strike not in (None, "", 0, "0"):
        result["strike_price"] = str(strike)

    return result


def _leg(data: dict, trigger_price, limit_price) -> dict:
    return {
        "action": str(data.get("action") or "").lower(),
        "limit_price": str(limit_price or "0"),
        "trigger_price": str(trigger_price or "0"),
    }


def resolve_trigger_price(data: dict) -> str:
    for key in ("trigger_price", "triggerprice_sl", "triggerprice_tg"):
        value = data.get(key)

        if value not in (None, "", 0, 0.0, "0"):
            return str(value)

    return "0"


def transform_place_gtt(data: dict) -> dict:
    """
    Build a Breeze GTT place payload from the OpenAlgo flat payload.

    SINGLE -> gtt_single_leg_place_order
    OCO    -> gtt_three_leg_place_order (gtt_type 'cover_oco')
    """

    exchange_code = normalise_gtt_exchange(data.get("exchange"))

    exchange_upper = str(data.get("exchange") or "").upper()

    symbol = str(data.get("symbol") or "")

    if exchange_upper in ("NFO", "BFO", "MCX"):
        # Breeze GTT keys on the UNDERLYING stock code for F&O.
        stock_code = underlying_symbol(symbol, exchange_upper)
    else:
        stock_code = (
            get_br_symbol(symbol, exchange_upper) or symbol
        )

    quantity = str(int(float(data.get("quantity") or 0)))

    trigger_type = str(data.get("trigger_type") or "SINGLE").upper()

    product = _product(data)

    payload = {
        "exchange_code": exchange_code,
        "stock_code": str(stock_code),
        "product": product,
        "quantity": quantity,
        "index_or_stock": "stock",
        "trade_date": "",
    }

    payload.update(_instrument_fields(data))

    if trigger_type == "OCO":
        stoploss = data.get("stoploss")
        target = data.get("target")

        trigger_sl = data.get("triggerprice_sl")
        trigger_tg = data.get("triggerprice_tg")

        payload["gtt_type"] = "cover_oco"
        payload["fresh_order_action"] = str(
            data.get("action") or ""
        ).lower()
        payload["fresh_order_type"] = "limit"
        payload["fresh_order_price"] = str(target or "0")
        payload["order_details"] = [
            _leg(data, trigger_sl, stoploss),
            _leg(data, trigger_tg, target),
        ]
    else:
        payload["gtt_type"] = "single"
        payload["order_details"] = [
            _leg(
                data,
                resolve_trigger_price(data),
                data.get("price"),
            )
        ]

    # Strip empty scalars — Breeze rejects blank strings.
    cleaned = {}

    for key, value in payload.items():
        if value is None or value == "":
            continue

        cleaned[key] = value

    return cleaned


def transform_modify_gtt(data: dict) -> dict:
    """
    Build a Breeze GTT modify payload.

    Carries gtt_order_id from the incoming trigger_id.
    """

    payload = transform_place_gtt(data)

    trigger_id = (
        data.get("trigger_id")
        or data.get("gtt_order_id")
    )

    payload["gtt_order_id"] = str(trigger_id or "")

    return payload


def map_gtt_book(gtt_data, include_history=False) -> list[dict]:
    """
    Breeze GTT order book -> OpenAlgo common GTT book rows.

    Output fields follow docs/api/order-management/gttorderbook.md:

        trigger_id, trigger_type (single/two-leg), status, symbol, exchange,
        trigger_prices[], last_price, legs[{action, quantity, price,
        pricetype, product}], created_at, updated_at, expires_at
    """

    rows = gtt_data

    if isinstance(rows, dict):
        rows = rows.get("Success") or rows.get("data") or []

    if not isinstance(rows, list):
        return []

    result = []

    for gtt in rows:
        if not isinstance(gtt, dict):
            continue

        gtt_type = str(
            gtt.get("gtt_type")
            or gtt.get("type")
            or "single"
        ).lower()

        trigger_type = "two-leg" if gtt_type in ("oco", "cover_oco", "three_leg") else "single"

        exchange = str(gtt.get("exchange_code") or "").upper()

        brsymbol = str(gtt.get("stock_code") or "")

        try:
            from database.token_db import get_oa_symbol

            symbol = (
                get_oa_symbol(brsymbol=brsymbol, exchange=exchange)
                or brsymbol
            )
        except Exception:
            symbol = brsymbol

        status = str(gtt.get("status") or "").lower()

        order_details = gtt.get("order_details") or []

        if not isinstance(order_details, list):
            order_details = [order_details]

        trigger_prices = []
        legs = []

        for leg in order_details:
            if not isinstance(leg, dict):
                continue

            try:
                trigger_prices.append(float(leg.get("trigger_price") or 0))
            except (TypeError, ValueError):
                trigger_prices.append(0.0)

            legs.append(
                {
                    "action": str(leg.get("action") or "").upper(),
                    "quantity": int(float(gtt.get("quantity") or 0)),
                    "price": float(leg.get("limit_price") or 0),
                    "pricetype": "LIMIT",
                    "product": (
                        "CNC"
                        if str(gtt.get("product") or "").lower() == "cash"
                        else "NRML"
                    ),
                }
            )

        result.append(
            {
                "trigger_id": str(
                    gtt.get("gtt_order_id")
                    or gtt.get("gttorderid")
                    or ""
                ),
                "trigger_type": trigger_type,
                "status": status or "active",
                "symbol": symbol,
                "exchange": exchange,
                "trigger_prices": trigger_prices,
                "last_price": float(gtt.get("last_price") or 0),
                "legs": legs,
                "created_at": str(gtt.get("created_at") or gtt.get("trade_date") or ""),
                "updated_at": str(gtt.get("updated_at") or ""),
                "expires_at": str(gtt.get("validity_date") or ""),
            }
        )

    return result
