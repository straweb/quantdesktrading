"""
OpenAlgo order payload -> ICICI Direct Breeze order payload.

Breeze ``place_order`` fields (breeze_connect 1.0.69):

    stock_code, exchange_code, product, action, order_type, quantity,
    price, validity, stoploss, validity_date, disclosed_quantity,
    expiry_date, right, strike_price, user_remark
"""

import re

from database.token_db import get_br_symbol, get_symbol_info
from utils.logging import get_logger


logger = get_logger(__name__)


# OpenAlgo derivative symbols look like NIFTY19OCT2623650CE /
# NIFTY19OCT26FUT. The date chunk is always ddMmmyy.
_SYMBOL_RE = re.compile(
    r"^(?P<base>.+?)(?P<date>\d{2}[A-Za-z]{3}\d{2})"
    r"(?:(?P<strike>\d+(?:\.\d+)?)(?P<right>CE|PE)|FUT)$"
)

_MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


def parse_oa_symbol(symbol: str) -> dict | None:
    """
    Parse an OpenAlgo derivative symbol into its components.

    Returns None for cash symbols (RELIANCE-EQ, indices, ...).
    """

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

    expiry_iso = f"{year:04d}-{month:02d}-{day:02d}T06:00:00.000Z"

    result = {
        "underlying": match.group("base").upper(),
        "expiry_ddmmyy": date_text,
        "expiry_iso": expiry_iso,
        "expiry_display": f"{day:02d}-{date_text[2:5].title()}-{year}",
    }

    strike = match.group("strike")

    if strike is not None:
        strike_value = float(strike)

        result["strike"] = (
            str(int(strike_value))
            if strike_value.is_integer()
            else str(strike_value)
        )
        result["right"] = (
            "call" if match.group("right") == "CE" else "put"
        )
        result["instrumenttype"] = match.group("right")

    else:
        result["strike"] = None
        result["right"] = None
        result["instrumenttype"] = "FUT"

    return result


def _symbol_info(symbol: str, exchange: str):
    try:
        return get_symbol_info(symbol, exchange)
    except Exception:
        return None


def underlying_symbol(symbol: str, exchange: str = "") -> str:
    """
    Breeze identifies F&O instruments by the UNDERLYING stock code plus
    expiry/right/strike — never by the full contract symbol.
    """

    info = _symbol_info(symbol, exchange)

    if info is not None and getattr(info, "underlying", None):
        return str(info.underlying).upper()

    parsed = parse_oa_symbol(symbol)

    if parsed:
        return parsed["underlying"]

    # Relaxed fallback: drop everything from the first date chunk on.
    text = str(symbol or "").strip()

    match = re.match(r"^(.*?)\d{2}[A-Za-z]{3}\d{2}", text)

    if match and match.group(1):
        return match.group(1).upper()

    for suffix in ("-EQ", "-BE", "-BZ", "-SM", "-ST"):
        if text.endswith(suffix):
            text = text[: -len(suffix)]

            break

    return text.upper()


def is_option(data: dict) -> bool:
    """True when the payload refers to an option instrument."""

    right = str(data.get("right") or "").upper()

    if right in ("CE", "PE", "CALL", "PUT"):
        return True

    info = _symbol_info(data.get("symbol", ""), data.get("exchange", ""))

    if info is not None and str(info.instrumenttype or "").upper() in ("CE", "PE"):
        return True

    parsed = parse_oa_symbol(data.get("symbol", ""))

    return bool(parsed and parsed.get("right"))


def map_product_type(data: dict) -> str:
    """
    OpenAlgo product/exchange -> Breeze product.

        NSE/BSE equity   CNC -> cash, MIS -> margin
        NFO/BFO/MCX      options / futures
    """

    exchange = str(data.get("exchange") or "").upper()

    product = str(data.get("product") or "").upper()

    if exchange in ("NFO", "BFO", "MCX"):
        return "options" if is_option(data) else "futures"

    if product == "CNC":
        return "cash"

    if product == "NRML":
        return "futures"

    # MIS / MARGIN / BTST / anything else
    return "margin"


def map_order_type(pricetype) -> str:
    """
    OpenAlgo pricetype -> Breeze order_type.

    Breeze natively supports limit / stoploss / market. SL-M has no direct
    equivalent: it is sent as a stoploss order whose stoploss trigger is the
    OpenAlgo trigger_price (protection comes from the server-side MPP).
    """

    value = str(pricetype or "").upper()

    mapping = {
        "MARKET": "market",
        "LIMIT": "limit",
        "SL": "stoploss",
        "SL-M": "stoploss",
    }

    return mapping.get(value, "limit")


def reverse_map_product_type(exchange, product):
    mapping = {
        "cash": "CNC",
        "margin": "MIS",
        "mtf": "NRML",
        "futures": "NRML",
        "options": "NRML",
        "btst": "CNC",
    }

    return mapping.get(str(product or "").lower())


def _derivative_fields(data: dict) -> dict:
    """
    Resolve expiry_date / right / strike_price for F&O payloads.

    Priority: request fields -> master contract row -> symbol parsing.
    """

    exchange = str(data.get("exchange") or "").upper()

    if exchange not in ("NFO", "BFO", "MCX"):
        return {}

    result: dict = {}

    expiry = str(data.get("expiry_date") or "").strip()

    right = str(data.get("right") or "").strip().lower()

    strike = data.get("strike_price")

    parsed = parse_oa_symbol(data.get("symbol", "")) or {}

    info = _symbol_info(data.get("symbol", ""), exchange)

    if not expiry:
        expiry = parsed.get("expiry_iso", "")

    if info is not None:
        itype = str(info.instrumenttype or "").upper()

        if itype in ("CE", "PE") and not right:
            right = "call" if itype == "CE" else "put"

        if info.strike and strike in (None, "", 0, "0"):
            strike_value = float(info.strike)

            strike = (
                str(int(strike_value))
                if strike_value.is_integer()
                else str(strike_value)
            )

    if not right:
        right = parsed.get("right") or ""

    if strike in (None, "", 0, "0"):
        strike = parsed.get("strike")

    if right in ("ce", "pe"):
        right = "call" if right == "ce" else "put"

    if expiry:
        result["expiry_date"] = expiry

    if right:
        result["right"] = right

    if strike not in (None, "", 0, "0"):
        result["strike_price"] = str(strike)

    return result


def transform_data(data: dict) -> dict:
    """
    Transform an OpenAlgo order payload into a Breeze place_order payload.

    Empty/irrelevant fields are omitted — Breeze raises server-side
    null-reference errors when empty strings reach it.
    """

    symbol = data.get("symbol", "")

    exchange = str(data.get("exchange") or "").upper()

    if exchange in ("NSE_INDEX", "BSE_INDEX", "MCX_INDEX"):
        exchange = exchange.replace("_INDEX", "")

    if exchange in ("NFO", "BFO", "MCX"):
        # Breeze keys F&O orders on the UNDERLYING code.
        stock_code = underlying_symbol(symbol, data.get("exchange", ""))
    else:
        stock_code = get_br_symbol(symbol, data.get("exchange", "")) or symbol

    price = data.get("price", "0")
    trigger = data.get("trigger_price", "0")

    payload = {
        "stock_code": str(stock_code),
        "exchange_code": exchange,
        "product": map_product_type(data),
        "action": str(data.get("action") or "").lower(),
        "order_type": map_order_type(data.get("pricetype")),
        "quantity": str(int(float(data.get("quantity") or 0))),
        "price": str(price or "0"),
        "validity": "day",
        "user_remark": str(data.get("strategy") or "OpenAlgo"),
    }

    # Trigger price is only meaningful for stop orders.
    if payload["order_type"] == "stoploss":
        try:
            if float(trigger or 0) > 0:
                payload["stoploss"] = str(trigger)
        except (TypeError, ValueError):
            pass

    disclosed = data.get("disclosed_quantity")

    if disclosed not in (None, "", 0, "0"):
        payload["disclosed_quantity"] = str(int(float(disclosed)))

    payload.update(_derivative_fields(data))

    # Drop empty values — Breeze rejects blank strings server-side.
    return {
        key: value
        for key, value in payload.items()
        if value not in (None, "")
    }
