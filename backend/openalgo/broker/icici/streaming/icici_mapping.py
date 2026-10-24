"""
Breeze websocket tick -> OpenAlgo normalized tick mapping.

Breeze's rate-refresh stream (livestream.icicidirect.com) delivers parsed
dictionaries from breeze_connect.parse_data():

- Quote ticks (``X.1!<token>``) carry open/last/high/low/bPrice/bQty/
  sPrice/sQty/ltq/avgPrice plus, on NSE/BSE cash, ttq/totalBuyQt/
  totalSellQ/close and, on F&O, OI/close at shifted positions.
- Depth ticks (``X.2!<token>``) carry ``time`` + ``depth`` (a list of
  per-level dicts: BestBuyRate-N / BestBuyQty-N / BuyNoOfOrders-N /
  BestSellRate-N / BestSellQty-N / SellNoOfOrders-N).
- MCX ticks (exchange '6') have their own flattened field set including
  CurrOpenInterest and 20 depth levels (Quantity-N / OrderPrice-N / ...).

The output matches the zerodha adapter's normalized key set so the proxy
and UI see one shape across brokers.
"""

from datetime import datetime
from typing import Any

from utils.logging import get_logger


logger = get_logger(__name__)


def _float(value, default=0.0) -> float:
    try:
        if value is None or value == "":
            return default

        return float(value)

    except (TypeError, ValueError):
        return default


def _int(value, default=0) -> int:
    try:
        if value is None or value == "":
            return default

        return int(float(value))

    except (TypeError, ValueError):
        return default


def _first(data: dict, *keys, default=None):
    for key in keys:
        value = data.get(key)

        if value is not None and value != "":
            return value

    return default


def _epoch_ms(value) -> int:
    """Best-effort epoch-milliseconds for tick timestamps."""

    if isinstance(value, (int, float)):
        # Breeze epoch values are seconds.
        return int(value * 1000 if value < 1e11 else value)

    text = str(value or "").strip()

    if not text:
        return int(datetime.now().timestamp() * 1000)

    parsed = None

    for fmt in (
        "%a %b %d %H:%M:%S %Y",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
    ):
        try:
            parsed = datetime.strptime(text, fmt)
            break
        except ValueError:
            continue

    if parsed is None:
        try:
            parsed = pd_timestamp(text)
        except Exception:
            return int(datetime.now().timestamp() * 1000)

    return int(parsed.timestamp() * 1000)


def pd_timestamp(text: str):
    import pandas as pd

    parsed = pd.to_datetime(text, errors="coerce")

    if pd.isna(parsed):
        raise ValueError(text)

    return parsed.to_pydatetime()


def _depth_from_list(levels: list, side: str) -> list[dict]:
    """
    Normalize the SDK's per-level dicts (BestBuyRate-N / BestSellRate-N
    families) into OpenAlgo depth entries.
    """

    result = []

    for level in levels or []:
        if not isinstance(level, dict):
            continue

        keys = list(level.keys())

        buy_price = None
        buy_qty = None
        buy_orders = 0
        sell_price = None
        sell_qty = None
        sell_orders = 0

        for key in keys:
            lower = key.lower()

            if "buyrate" in lower or "orderprice" in lower and side == "buy":
                buy_price = _float(level[key])
            elif "buyqty" in lower or ("quantity" in lower and side == "buy"):
                buy_qty = _int(level[key])
            elif "buynooforders" in lower:
                buy_orders = _int(level[key])
            elif "sellrate" in lower or ("sellorderprice" in lower):
                sell_price = _float(level[key])
            elif "sellqty" in lower:
                sell_qty = _int(level[key])
            elif "sellnooforders" in lower:
                sell_orders = _int(level[key])

        entry = (
            {
                "price": buy_price if buy_price is not None else 0.0,
                "quantity": buy_qty if buy_qty is not None else 0,
                "orders": buy_orders,
            }
            if side == "buy"
            else {
                "price": sell_price if sell_price is not None else 0.0,
                "quantity": sell_qty if sell_qty is not None else 0,
                "orders": sell_orders,
            }
        )

        result.append(entry)

    result.sort(key=lambda item: item["price"], reverse=(side == "buy"))

    return result


def _mcx_depth(data: dict) -> dict:
    """MCX depth lives in Quantity-N / OrderPrice-N / SellQuantity-N keys."""

    buy = []
    sell = []

    for index in range(20):
        qty = data.get(f"Quantity-{index}")
        price = data.get(f"OrderPrice-{index}")

        if qty is None and price is None:
            continue

        buy.append(
            {
                "price": _float(price),
                "quantity": _int(qty),
                "orders": _int(data.get(f"TotalOrders-{index}")),
            }
        )

        sell_qty = data.get(f"SellQuantity-{index}")
        sell_price = data.get(f"SellOrderPrice-{index}")

        if sell_qty is None and sell_price is None:
            continue

        sell.append(
            {
                "price": _float(sell_price),
                "quantity": _int(sell_qty),
                "orders": _int(data.get(f"SellTotalOrders-{index}")),
            }
        )

    return {"buy": buy, "sell": sell}


def map_tick(
    data: Any,
    symbol: str,
    exchange: str,
    token: str = "",
    mode: int = 2,
) -> dict | None:
    """
    Map one Breeze websocket message to the OpenAlgo normalized tick.

    Returns None for heartbeats / non-tick frames.
    """

    if not isinstance(data, dict):
        return None

    symbol_value = str(data.get("symbol") or "")

    # Depth ticks only carry depth + time; quote ticks carry prices.
    is_depth_tick = "depth" in data and "last" not in data

    mode_name = "full" if (mode == 3 and is_depth_tick) else (
        "full" if mode == 3 else ("quote" if mode == 2 else "ltp")
    )

    # --------------------------------------------------------------
    # MCX full-format ticks (exchange '6')
    # --------------------------------------------------------------
    if "TotalBuyQnt" in data and "OpenPrice" in data:
        tick = {
            "symbol": symbol,
            "exchange": exchange,
            "token": str(token),
            "last_price": _float(_first(data, "last", "HightestPriceEver")),
            "volume": _int(_first(data, "ttq", "AndiOPVolume")),
            "total_buy_quantity": _int(data.get("TotalBuyQnt")),
            "total_sell_quantity": _int(data.get("TotalSellQnt")),
            "average_price": _float(data.get("AvgTradedPrice")),
            "mode": mode_name,
            "timestamp": _epoch_ms(data.get("ltt")),
            "open": _float(data.get("OpenPrice")),
            "high": _float(data.get("HighPrice")),
            "low": _float(data.get("LowPrice")),
            "close": _float(data.get("ClosePrice")),
            "oi": _int(data.get("CurrOpenInterest")),
            "last_quantity": _int(data.get("ltq")),
        }

        if mode == 3:
            tick["depth"] = _mcx_depth(data)

        return tick

    # --------------------------------------------------------------
    # Depth ticks (X.2!<token>)
    # --------------------------------------------------------------
    if is_depth_tick:
        depth_levels = data.get("depth")

        if isinstance(depth_levels, dict):
            buy = _depth_from_list(depth_levels.get("buy") or [], "buy")
            sell = _depth_from_list(depth_levels.get("sell") or [], "sell")
        else:
            buy = _depth_from_list(depth_levels or [], "buy")
            sell = _depth_from_list(depth_levels or [], "sell")

        return {
            "symbol": symbol,
            "exchange": exchange,
            "token": str(token),
            "last_price": 0,
            "volume": 0,
            "total_buy_quantity": sum(level["quantity"] for level in buy),
            "total_sell_quantity": sum(level["quantity"] for level in sell),
            "average_price": 0,
            "mode": mode_name,
            "timestamp": _epoch_ms(data.get("time")),
            "depth": {"buy": buy, "sell": sell},
        }

    # --------------------------------------------------------------
    # Quote ticks (X.1!<token>)
    # --------------------------------------------------------------
    ltp = _float(_first(data, "last", "ltp", "last_price"))

    volume = _int(_first(data, "ttq", "volume", "total_quantity_traded"))

    tick = {
        "symbol": symbol,
        "exchange": exchange,
        "token": str(token),
        "last_price": ltp,
        "volume": volume,
        "total_buy_quantity": _int(
            _first(data, "totalBuyQt", "total_buy_quantity")
        ),
        "total_sell_quantity": _int(
            _first(data, "totalSellQ", "total_sell_quantity")
        ),
        "average_price": _float(_first(data, "avgPrice", "average_price")),
        "mode": mode_name,
        "timestamp": _epoch_ms(data.get("ltt")),
        "last_quantity": _int(_first(data, "ltq", "last_traded_quantity")),
    }

    open_value = _float(_first(data, "open", "OpenPrice"))
    high = _float(_first(data, "high", "HighPrice"))
    low = _float(_first(data, "low", "LowPrice"))
    close = _float(_first(data, "close", "ClosePrice", "previous_close"))

    if open_value or high or low or close:
        tick.update(
            {
                "open": open_value,
                "high": high,
                "low": low,
                "close": close,
            }
        )

    oi = _first(data, "OI", "open_interest", "CurrOpenInterest")

    if oi is not None:
        tick["oi"] = _int(oi)

    if mode == 3:
        # Quote tick in depth mode: best bid/offer as one-level depth.
        tick["depth"] = {
            "buy": [
                {
                    "price": _float(data.get("bPrice")),
                    "quantity": _int(data.get("bQty")),
                    "orders": 0,
                }
            ],
            "sell": [
                {
                    "price": _float(data.get("sPrice")),
                    "quantity": _int(data.get("sQty")),
                    "orders": 0,
                }
            ],
        }

    return tick


def map_feed_data(data: Any) -> Any:
    """Compatibility alias used by older icici plugin revisions."""

    return data
