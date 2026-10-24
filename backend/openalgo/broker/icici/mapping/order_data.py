"""
ICICI Direct Breeze -> OpenAlgo account-data mappings.

Exposed hooks used by OpenAlgo services:

    map_order_data(order_data=...)          transform_order_data(...)
    map_trade_data(trade_data=...)          transform_tradebook_data(...)
    map_position_data(position_data=...)    transform_positions_data(...)
    map_holding_data(holding_data=...)      transform_holdings_data(...)
    calculate_order_statistics(...)         calculate_portfolio_statistics(...)

Breeze wraps every response as {"Success": ..., "Status": ..., "Error": ...};
the REST layer in breeze_client.py has already normalised empty books to an
empty Success list before the data reaches this module.
"""

from database.token_db import get_oa_symbol
from utils.logging import get_logger


logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rows(data) -> list:
    if data is None:
        return []

    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        if isinstance(data.get("data"), list):
            return data["data"]

        success = data.get("Success")

        if success is None:
            return []

        if isinstance(success, list):
            return success

        if isinstance(success, dict):
            return [success]

    return []


def _get(data: dict, *keys, default=None):
    for key in keys:
        if key in data:
            value = data[key]

            if value is not None and value != "":
                return value

    return default


def _string(value, default=""):
    if value is None:
        return default

    return str(value)


def _int(value, default=0):
    try:
        if value is None or value == "":
            return default

        return int(float(value))

    except (TypeError, ValueError):
        return default


def _float(value, default=0.0):
    try:
        if value is None or value == "":
            return default

        return float(value)

    except (TypeError, ValueError):
        return default


def _exchange(value) -> str:
    value = _string(value).upper()

    mapping = {
        "NFO": "NFO",
        "BFO": "BFO",
        "MCX": "MCX",
        "NSE": "NSE",
        "BSE": "BSE",
        "CDS": "CDS",
        "NDX": "CDS",
    }

    return mapping.get(value, value)


def _action(value) -> str:
    value = _string(value).upper()

    if value in ("B", "BUY"):
        return "BUY"

    if value in ("S", "SELL"):
        return "SELL"

    return value


def _product(value, exchange="") -> str:
    """
    Breeze product -> OpenAlgo product.

    Breeze reports the *instrument* product (Cash/Futures/Options/Margin)
    rather than the order product, so derivatives collapse to NRML and
    cash-margin to MIS.
    """

    value = _string(value).lower()

    exchange = _string(exchange).upper()

    if exchange in ("NFO", "BFO", "MCX"):
        return "NRML"

    mapping = {
        "cash": "CNC",
        "delivery": "CNC",
        "margin": "MIS",
        "mis": "MIS",
        "btst": "CNC",
        "mtf": "NRML",
    }

    return mapping.get(value, "MIS")


def _price_type(value) -> str:
    value = _string(value).upper()

    mapping = {
        "LIMIT": "LIMIT",
        "MARKET": "MARKET",
        "STOPLOSS": "SL",
        "STOP LOSS": "SL",
        "STOPLIMIT": "SL",
        "SL": "SL",
        "SL-M": "SL-M",
        "STOPLOSS_MARKET": "SL-M",
    }

    return mapping.get(value, value or "LIMIT")


def _status(value) -> str:
    """
    Breeze status -> OpenAlgo lowercase vocabulary.

    Unmapped intermediates collapse to 'open' per the common contract.
    """

    value = _string(value).strip().upper()

    mapping = {
        "REQUESTED": "open",
        "ORDERED": "open",
        "QUEUED": "open",
        "ACCEPTED": "open",
        "OPEN": "open",
        "PENDING": "open",
        "VALIDATION PENDING": "open",
        "PUT ORDER REQ RECEIVED": "open",
        "MODIFY VALIDATION PENDING": "open",
        "FREEZE": "open",

        "EXECUTED": "complete",
        "COMPLETED": "complete",
        "TRADED": "complete",
        "COMPLETE": "complete",
        "FILLED": "complete",

        "PARTIALLY EXECUTED": "partial",
        "PARTIALLY EXECUTED AND EXPIRED": "partial",
        "PARTIALLY EXECUTED AND CANCELLED": "partial",
        "PARTIALLY FILLED": "partial",

        "CANCELED": "cancelled",
        "CANCELLED": "cancelled",

        "REJECTED": "rejected",
        "REJECT": "rejected",

        "EXPIRED": "expired",
    }

    return mapping.get(value, value.lower() or "open")


def _order_status(order: dict) -> str:
    status = _status(
        _get(order, "status", "order_status", "orderStatus")
    )

    # A terminal broker status wins outright — ICICI can still report
    # cancelled_quantity on an executed order (partial cancel + partial
    # fill).
    if status in ("complete", "cancelled", "rejected", "expired"):
        return status

    pending_quantity = _int(_get(order, "pending_quantity", "open_quantity"))

    cancelled_quantity = _int(_get(order, "cancelled_quantity"))

    quantity = _int(_get(order, "quantity", "order_quantity"))

    # A pending-labelled order whose entire quantity was cancelled must
    # never surface as open.
    if (
        status == "open"
        and cancelled_quantity > 0
        and pending_quantity == 0
        and quantity <= cancelled_quantity
    ):
        return "cancelled"

    return status


def _timestamp(*keys, row=None) -> str:
    value = _get(row or {}, *keys, default="")

    return _string(value)


def _oa_symbol(brsymbol: str, exchange: str) -> str:
    try:
        return get_oa_symbol(brsymbol=brsymbol, exchange=exchange) or brsymbol
    except Exception:
        return brsymbol


# ---------------------------------------------------------------------------
# Order book
# ---------------------------------------------------------------------------

def map_order_data(order_data) -> list[dict]:
    result = []

    for order in _rows(order_data):
        if not isinstance(order, dict):
            continue

        exchange = _exchange(
            _get(order, "exchange_code", "exchange")
        )

        brsymbol = _string(
            _get(order, "stock_code", "trading_symbol", "tradingsymbol", "symbol")
        )

        result.append(
            {
                "orderid": _string(_get(order, "order_id", "orderid")),
                "exchangeorderid": _string(
                    _get(order, "exchange_order_id", "exchangeorderid")
                ),
                "symbol": _oa_symbol(brsymbol, exchange),
                "exchange": exchange,
                "action": _action(_get(order, "action", "transaction_type", "orderFlow")),
                "quantity": _int(_get(order, "quantity", "order_quantity", "orderTotalQuantity")),
                "pending_quantity": _int(
                    _get(order, "pending_quantity", "open_quantity")
                ),
                "cancelled_quantity": _int(
                    _get(order, "cancelled_quantity", "cancelledQuantity")
                ),
                "price": _float(_get(order, "price", "limit_price", "orderLimitRate", "limitRate")),
                "average_price": _float(
                    _get(
                        order,
                        "average_price",
                        "average_executed_rate",
                        "averageExecutedRate",
                        "averagePrice",
                    )
                ),
                "trigger_price": _float(
                    _get(order, "stoploss", "trigger_price", "stopLossTrigger", "stoploss")
                ),
                "pricetype": _price_type(
                    _get(order, "order_type", "pricetype", "limitMarketFlag")
                ),
                "product": _product(
                    _get(order, "product_type", "product", "productType"),
                    exchange,
                ),
                "order_status": _order_status(order),
                "validity": _string(_get(order, "validity", "orderType"), "DAY"),
                "disclosed_quantity": _int(_get(order, "disclosed_quantity")),
                "timestamp": _timestamp(
                    "order_datetime",
                    "order_time",
                    "messageDate",
                    "orderDate",
                    row=order,
                ),
                "rejection_reason": _string(
                    _get(order, "message", "rejection_reason", "orderMessageCharacter")
                ),
            }
        )

    return result


def transform_order_data(order_data):
    return map_order_data(order_data)


def transform_orderbook_data(order_data):
    return map_order_data(order_data)


def calculate_order_statistics(order_data) -> dict:
    total_buy_orders = 0
    total_sell_orders = 0
    total_completed_orders = 0
    total_open_orders = 0
    total_rejected_orders = 0

    for order in order_data or []:
        action = str(order.get("action") or "").upper()

        if action == "BUY":
            total_buy_orders += 1
        elif action == "SELL":
            total_sell_orders += 1

        status = str(order.get("order_status") or order.get("status") or "").lower()

        if status == "complete":
            total_completed_orders += 1
        elif status in ("open", "trigger pending", "partial"):
            total_open_orders += 1
        elif status == "rejected":
            total_rejected_orders += 1

    return {
        "total_buy_orders": total_buy_orders,
        "total_sell_orders": total_sell_orders,
        "total_completed_orders": total_completed_orders,
        "total_open_orders": total_open_orders,
        "total_rejected_orders": total_rejected_orders,
    }


# ---------------------------------------------------------------------------
# Trade book
# ---------------------------------------------------------------------------

def map_trade_data(trade_data) -> list[dict]:
    result = []

    for trade in _rows(trade_data):
        if not isinstance(trade, dict):
            continue

        exchange = _exchange(_get(trade, "exchange_code", "exchange"))

        brsymbol = _string(
            _get(trade, "stock_code", "trading_symbol", "tradingsymbol", "symbol")
        )

        quantity = _int(_get(trade, "quantity", "traded_quantity", "executed_quantity"))

        price = _float(
            _get(
                trade,
                "average_cost",
                "average_price",
                "average_executed_rate",
                "trade_price",
                "price",
            )
        )

        result.append(
            {
                "tradeid": _string(_get(trade, "trade_id", "tradeid", "exchange_trade_id")),
                "orderid": _string(_get(trade, "order_id", "orderid", "orderReference")),
                "symbol": _oa_symbol(brsymbol, exchange),
                "exchange": exchange,
                "product": _product(
                    _get(trade, "product_type", "product"), exchange
                ),
                "action": _action(_get(trade, "action", "transaction_type", "orderFlow")),
                "quantity": quantity,
                "average_price": price,
                "trade_value": round(quantity * price, 2),
                "timestamp": _timestamp(
                    "trade_datetime",
                    "trade_time",
                    "trade_date",
                    "order_datetime",
                    row=trade,
                ),
            }
        )

    return result


def transform_tradebook_data(trade_data):
    return map_trade_data(trade_data)


# ---------------------------------------------------------------------------
# Positions
# ---------------------------------------------------------------------------

def map_position_data(position_data) -> list[dict]:
    result = []

    for position in _rows(position_data):
        if not isinstance(position, dict):
            continue

        exchange = _exchange(_get(position, "exchange_code", "exchange"))

        brsymbol = _string(
            _get(position, "stock_code", "trading_symbol", "tradingsymbol", "symbol")
        )

        net_quantity = _int(
            _get(
                position,
                "quantity",
                "net_quantity",
                "open_quantity",
                "cover_quantity",
            )
        )

        buy_quantity = _int(_get(position, "buy_quantity", "buy_qty", "credit_quantity"))
        sell_quantity = _int(_get(position, "sell_quantity", "sell_qty", "debit_quantity"))

        if net_quantity == 0 and (buy_quantity or sell_quantity):
            net_quantity = buy_quantity - sell_quantity

        ltp = _float(
            _get(position, "ltp", "last_price", "last_traded_price", "market_price")
        )

        average_price = _float(
            _get(
                position,
                "average_price",
                "avg_price",
                "buy_avg_rate",
                "average_cost",
            )
        )

        pnl = _float(
            _get(
                position,
                "pnl",
                "profit_n_loss",
                "unrealised",
                "mtm",
            ),
            default=round((ltp - average_price) * net_quantity, 2)
            if net_quantity and average_price
            else 0.0,
        )

        result.append(
            {
                "symbol": _oa_symbol(brsymbol, exchange),
                "exchange": exchange,
                "product": _product(
                    _get(position, "product_type", "product"), exchange
                ),
                "quantity": net_quantity,
                "pnl": pnl,
                "average_price": average_price,
                "ltp": ltp,
            }
        )

    return result


def transform_positions_data(position_data):
    return map_position_data(position_data)


# ---------------------------------------------------------------------------
# Holdings
# ---------------------------------------------------------------------------

def map_holding_data(holding_data) -> list[dict]:
    result = []

    for holding in _rows(holding_data):
        if not isinstance(holding, dict):
            continue

        exchange = _exchange(_get(holding, "exchange_code", "exchange") or "NSE")

        brsymbol = _string(
            _get(holding, "stock_code", "trading_symbol", "tradingsymbol", "symbol")
        )

        quantity = _int(
            _get(holding, "quantity", "demat_quantity", "holdings_quantity")
        )

        average_price = _float(
            _get(
                holding,
                "average_price",
                "buy_avg",
                "average_cost",
                "purchase_price",
            )
        )

        ltp = _float(
            _get(holding, "ltp", "last_price", "last_traded_price", "market_price")
        )

        pnl = _float(
            _get(holding, "pnl", "profit_n_loss", "unrealised"),
            default=round((ltp - average_price) * quantity, 2)
            if quantity and average_price
            else 0.0,
        )

        pnlpercent = (
            round((pnl / (average_price * quantity)) * 100, 2)
            if quantity and average_price
            else 0.0
        )

        result.append(
            {
                "symbol": _oa_symbol(brsymbol, exchange),
                "exchange": exchange,
                "quantity": quantity,
                "product": "CNC",
                "average_price": average_price,
                "pnl": pnl,
                "pnlpercent": pnlpercent,
            }
        )

    return result


def transform_holdings_data(holding_data):
    return map_holding_data(holding_data)


def calculate_portfolio_statistics(holdings_data) -> dict:
    totalholdingvalue = 0.0
    totalinvvalue = 0.0
    totalprofitandloss = 0.0

    for holding in holdings_data or []:
        quantity = _int(holding.get("quantity"))
        average_price = _float(holding.get("average_price"))
        ltp = _float(holding.get("ltp"))

        totalholdingvalue += ltp * quantity
        totalinvvalue += average_price * quantity
        totalprofitandloss += _float(holding.get("pnl"))

    totalpnlpercentage = (
        round((totalprofitandloss / totalinvvalue) * 100, 2)
        if totalinvvalue
        else 0.0
    )

    return {
        "totalholdingvalue": round(totalholdingvalue, 2),
        "totalinvvalue": round(totalinvvalue, 2),
        "totalprofitandloss": round(totalprofitandloss, 2),
        "totalpnlpercentage": totalpnlpercentage,
    }
