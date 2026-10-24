"""
ICICI Direct Breeze order & account APIs for OpenAlgo.

Service-facing functions (OpenAlgo contract):

    place_order_api(data, auth)              -> (res, response_data, orderid)
    place_smartorder_api(data, auth)         -> (res, response_data, orderid)
    modify_order(data, auth)                 -> (response_message, status_code)
    cancel_order(orderid, auth)              -> (response_message, status_code)
    cancel_all_orders_api(data, auth)        -> (canceled_orders, failed)
    close_all_positions(api_key, auth)       -> (message, status_code)
    get_open_position(symbol, exch, prod, a) -> int net quantity
    get_order_book(auth) / get_trade_book(auth)
    get_positions(auth) / get_holdings(auth) -> raw Breeze response dicts

Breeze notes encoded here:

- ``/order`` (book) and ``/trades`` (trade book) REQUIRE exchange_code,
  from_date and to_date, and the window may not exceed 90 days. Books are
  fetched per exchange and merged; completed-day windows are cached
  in-process because they never change.
- Order quantities/prices are sent as strings; blank values are omitted.
- Order ids live in ``Success.order_id``.
"""

import os
import threading
import time
from datetime import datetime, timedelta
from types import SimpleNamespace

from broker.icici.api.breeze_client import (
    breeze_request,
    get_credentials,
    response_error,
    response_status,
)
from broker.icici.mapping.order_data import (
    map_position_data,
)
from broker.icici.mapping.transform_data import (
    map_order_type,
    map_product_type,
    reverse_map_product_type,
    transform_data,
)
from utils.logging import get_logger


logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

# Breeze caps order/trade windows at 90 days; stay safely inside.
BOOK_LOOKBACK_DAYS = int(os.getenv("ICICI_BOOK_LOOKBACK_DAYS", "7"))

# Breeze validated window: 'Number of days between from_date & to_date
# should not be more than 90' for orders/trades. Chunk well below it.
BOOK_WINDOW_DAYS = 9

# Exchanges swept for books. MCX included; CDS excluded (Breeze NDX
# segment has no OpenAlgo trading contract).
BOOK_EXCHANGES = ("NSE", "BSE", "NFO", "BFO", "MCX")

# Short-TTL caches (positions/orders change only on order events, and the
# UI / smart-order loops poll frequently).
_POSITION_CACHE_TTL = 2.0
_ORDER_INDEX_TTL = 2.5
_COMPLETED_WINDOW_TTL = 1800.0


# ---------------------------------------------------------------------------
# In-process caches (module level — services build fresh objects per call)
# ---------------------------------------------------------------------------

_CACHE_LOCK = threading.RLock()

_position_cache: dict[str, tuple[float, dict]] = {}

_order_index_cache: dict[str, tuple[float, dict]] = {}

_completed_window_cache: dict[str, tuple[float, list]] = {}


def _cache_key(auth) -> str:
    try:
        creds = get_credentials(auth)
        return f"{creds.user_id}:{creds.session_key[:12]}"
    except Exception:
        return str(hash(str(auth)))[:24]


def _invalidate_position_cache(auth) -> None:
    with _CACHE_LOCK:
        _position_cache.pop(_cache_key(auth), None)


def _invalidate_order_index(auth) -> None:
    with _CACHE_LOCK:
        _order_index_cache.pop(_cache_key(auth), None)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _breeze_date(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _is_success(response) -> bool:
    return response_status(response) == 200


def _rows(response) -> list:
    if not isinstance(response, dict):
        return []

    success = response.get("Success")

    if isinstance(success, list):
        return success

    if isinstance(success, dict):
        return [success]

    return []


def _response(status_code: int, body: dict) -> SimpleNamespace:
    """
    Minimal response object with the ``.status`` attribute the services
    read (``res.status == 200``).
    """

    return SimpleNamespace(status=status_code, headers={}, text=str(body))


def _error(message: str, status_code: int = 400):
    return (
        _response(status_code, {"status": "error", "message": message}),
        {"status": "error", "message": message},
        None,
    )


def _extract_order_id(response) -> str | None:
    if not isinstance(response, dict):
        return None

    success = response.get("Success")

    if isinstance(success, dict):
        order_id = (
            success.get("order_id")
            or success.get("orderid")
            or success.get("Order_Id")
        )

        if order_id:
            return str(order_id)

    return None


# ---------------------------------------------------------------------------
# Book windows
# ---------------------------------------------------------------------------

def _book_windows() -> list[tuple[datetime, datetime]]:
    """
    Most-recent-first (start, end) UTC windows covering the lookback range,
    each not wider than BOOK_WINDOW_DAYS.
    """

    now = datetime.now()

    windows = []

    start = now - timedelta(days=BOOK_LOOKBACK_DAYS)

    cursor = start

    while cursor < now:
        window_end = min(cursor + timedelta(days=BOOK_WINDOW_DAYS), now)

        windows.append((cursor, window_end))

        cursor = window_end + timedelta(seconds=1)

    windows.reverse()

    return windows


def _fetch_book_page(
    auth,
    endpoint: str,
    exchange: str,
    from_date: datetime,
    to_date: datetime,
) -> list:
    """
    One (exchange, window) book page.

    Completed windows (end before today) are cached — they never change.
    """

    is_completed = to_date < datetime.now().replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    cache_key = (
        f"{_cache_key(auth)}:{endpoint}:{exchange}:"
        f"{from_date.date()}:{to_date.date()}"
    )

    if is_completed:
        with _CACHE_LOCK:
            cached = _completed_window_cache.get(cache_key)

            if cached and (time.monotonic() - cached[0]) < _COMPLETED_WINDOW_TTL:
                return cached[1]

    response = breeze_request(
        auth,
        "GET",
        endpoint,
        {
            "exchange_code": exchange,
            "from_date": _breeze_date(from_date),
            "to_date": _breeze_date(to_date),
        },
    )

    rows = _rows(response)

    if not _is_success(response) and rows:
        logger.warning(
            "Breeze %s book page %s %s..%s reported error: %s",
            endpoint,
            exchange,
            from_date,
            to_date,
            response_error(response),
        )

    if is_completed:
        with _CACHE_LOCK:
            _completed_window_cache[cache_key] = (
                time.monotonic(),
                rows,
            )

    return rows


def _index_orders(auth, rows: list) -> None:
    """Remember orderid -> exchange (+ fields) for cancel/modify."""

    key = _cache_key(auth)

    with _CACHE_LOCK:
        cached = _order_index_cache.get(key)

        index = cached[1] if cached else {}

        for row in rows:
            order_id = str(
                row.get("order_id")
                or row.get("orderid")
                or ""
            )

            if not order_id:
                continue

            index[order_id] = {
                "exchange": str(
                    row.get("exchange_code") or ""
                ).upper(),
                "stock_code": row.get("stock_code", ""),
                "quantity": row.get("quantity", "0"),
                "price": row.get("price", "0"),
                "stoploss": row.get("stoploss", "0"),
                "order_type": row.get("order_type", "limit"),
                "validity": row.get("validity", "day"),
                "disclosed_quantity": row.get("disclosed_quantity", "0"),
                "product": row.get("product_type", ""),
            }

        _order_index_cache[key] = (time.monotonic(), index)


def _get_order_index(auth, refresh: bool = False) -> dict:
    key = _cache_key(auth)

    with _CACHE_LOCK:
        cached = _order_index_cache.get(key)

        if cached and not refresh:
            return cached[1]

    rows = []

    for exchange in BOOK_EXCHANGES:
        for from_date, to_date in _book_windows():
            rows.extend(
                _fetch_book_page(
                    auth, "order", exchange, from_date, to_date
                )
            )

    _index_orders(auth, rows)

    with _CACHE_LOCK:
        cached = _order_index_cache.get(key)

        return cached[1] if cached else {}


def _resolve_order(orderid: str, auth) -> dict | None:
    """
    Locate one order by id. Falls back to a forced index refresh when the
    cached book does not contain it (order placed milliseconds ago).
    """

    index = _get_order_index(auth)

    entry = index.get(str(orderid))

    if entry is None:
        index = _get_order_index(auth, refresh=True)

        entry = index.get(str(orderid))

    return entry


# ---------------------------------------------------------------------------
# Books & account data
# ---------------------------------------------------------------------------

def get_order_book(auth):
    """
    Merged order book across exchanges.

    Returns {"Success": [...], "Status": 200, "Error": None}.
    """

    all_rows = []

    try:
        for exchange in BOOK_EXCHANGES:
            exchange_rows = []

            for from_date, to_date in _book_windows():
                exchange_rows.extend(
                    _fetch_book_page(
                        auth, "order", exchange, from_date, to_date
                    )
                )

            if exchange_rows:
                all_rows.extend(exchange_rows)

        _index_orders(auth, all_rows)

        return {
            "Success": all_rows,
            "Status": 200,
            "Error": None,
        }

    except Exception as exc:
        logger.exception("Error fetching ICICI order book")

        return {
            "Success": all_rows,
            "Status": 500,
            "Error": str(exc),
        }


def get_trade_book(auth):
    """
    Merged trade book across exchanges (same window rules as orders).
    """

    all_rows = []

    try:
        for exchange in BOOK_EXCHANGES:
            for from_date, to_date in _book_windows():
                all_rows.extend(
                    _fetch_book_page(
                        auth, "trades", exchange, from_date, to_date
                    )
                )

        return {
            "Success": all_rows,
            "Status": 200,
            "Error": None,
        }

    except Exception as exc:
        logger.exception("Error fetching ICICI trade book")

        return {
            "Success": all_rows,
            "Status": 500,
            "Error": str(exc),
        }


def get_positions(auth):
    """
    Portfolio positions. Breeze serves them without parameters.
    """

    return breeze_request(auth, "GET", "portfoliopositions", {})


def get_holdings(auth):
    """
    Portfolio holdings (demat + T1). Breeze requires an exchange code;
    NSE is the documented default. BSE rows are merged only when the NSE
    query comes back empty, which avoids double counting dual-listed
    stocks.
    """

    response = breeze_request(
        auth,
        "GET",
        "portfolioholdings",
        {"exchange_code": "nse"},
    )

    if response_status(response) == 200 and not _rows(response):
        bse_response = breeze_request(
            auth,
            "GET",
            "portfolioholdings",
            {"exchange_code": "bse"},
        )

        if response_status(bse_response) == 200 and _rows(bse_response):
            return {
                "Success": _rows(bse_response),
                "Status": 200,
                "Error": None,
            }

    return response


# ---------------------------------------------------------------------------
# Place / smart order
# ---------------------------------------------------------------------------

def place_order_api(data, auth):
    """
    Place an order. Returns (response, response_data, orderid) where
    ``response.status`` carries the effective HTTP-ish status.
    """

    try:
        payload = transform_data(data)
    except Exception as exc:
        logger.exception("ICICI order payload transform failed")

        return _error(f"Invalid order payload: {exc}", 400)

    logger.info("Payload for ICICI place_order_api: %s", payload)

    response = breeze_request(auth, "POST", "order", payload)

    status_code = response_status(response)

    order_id = _extract_order_id(response) if status_code == 200 else None

    if status_code == 200 and order_id:
        logger.info("ICICI order placed: %s", order_id)

        _invalidate_position_cache(auth)
        _invalidate_order_index(auth)

        return (
            _response(200, response),
            {"status": "success", "orderid": order_id},
            order_id,
        )

    message = response_error(response) or "Failed to place order"

    logger.error("ICICI place_order failed: %s", message)

    return _error(message, status_code if status_code != 200 else 500)


def place_smartorder_api(data, auth):
    """
    Smart order: reconcile the live position towards ``position_size``.
    """

    res = None
    response_data = {
        "status": "error",
        "message": "No action required or invalid parameters",
    }
    orderid = None

    try:
        symbol = data.get("symbol")
        exchange = data.get("exchange")
        product = data.get("product")

        if not all([symbol, exchange, product]):
            return res, response_data, orderid

        position_size = int(data.get("position_size", "0") or 0)

        current_position = int(
            get_open_position(symbol, exchange, product, auth)
        )

        logger.debug(
            "Smart order %s: target=%s current=%s",
            symbol,
            position_size,
            current_position,
        )

        action = None
        quantity = 0

        if position_size == 0 and current_position == 0:
            action = str(data.get("action", "BUY")).upper()
            quantity = int(data.get("quantity", "0") or 0)
        elif position_size == 0 and current_position > 0:
            action = "SELL"
            quantity = abs(current_position)
        elif position_size == 0 and current_position < 0:
            action = "BUY"
            quantity = abs(current_position)
        elif current_position == 0:
            action = "BUY" if position_size > 0 else "SELL"
            quantity = abs(position_size)
        elif position_size > current_position:
            action = "BUY"
            quantity = position_size - current_position
        elif position_size < current_position:
            action = "SELL"
            quantity = current_position - position_size

        if action and quantity > 0:
            order_data = dict(data)
            order_data["action"] = action
            order_data["quantity"] = str(quantity)

            res, response, orderid = place_order_api(order_data, auth)

            _invalidate_position_cache(auth)

            return res, response, orderid

        response_data = {
            "status": "success",
            "message": "No action needed. Position already matched.",
        }

        return res, response_data, orderid

    except Exception as exc:
        logger.exception("Error in place_smartorder_api")

        return res, {"status": "error", "message": str(exc)}, orderid


# ---------------------------------------------------------------------------
# Open position (used by smart orders / close position)
# ---------------------------------------------------------------------------

def _get_positions_cached(auth) -> list[dict]:
    key = _cache_key(auth)

    with _CACHE_LOCK:
        cached = _position_cache.get(key)

        if cached and (time.monotonic() - cached[0]) < _POSITION_CACHE_TTL:
            return cached[1]

    rows = map_position_data(get_positions(auth))

    with _CACHE_LOCK:
        _position_cache[key] = (time.monotonic(), rows)

    return rows


def get_open_position(tradingsymbol, exchange, product, auth) -> int:
    """
    Net open quantity for one OpenAlgo symbol. Position rows were already
    mapped to OpenAlgo symbols, so matching is direct.
    """

    try:
        positions = _get_positions_cached(auth)
    except Exception:
        logger.exception("Error reading ICICI positions")

        return 0

    exchange = str(exchange or "").upper()
    product = str(product or "").upper()

    for position in positions:
        if (
            position.get("symbol") == tradingsymbol
            and str(position.get("exchange") or "").upper() == exchange
            and str(position.get("product") or "").upper() == product
        ):
            return int(position.get("quantity") or 0)

    return 0


# ---------------------------------------------------------------------------
# Modify / cancel
# ---------------------------------------------------------------------------

def modify_order(data, auth):
    """
    Modify an order. Returns (response_message, status_code).

    Breeze's PUT /order requires exchange_code, resolved from the indexed
    order book (the OpenAlgo payload carries only the order id).
    """

    orderid = str(data.get("orderid") or "")

    if not orderid:
        return {"status": "error", "message": "orderid is required"}, 400

    entry = _resolve_order(orderid, auth)

    if entry is None:
        return (
            {
                "status": "error",
                "message": f"Order {orderid} not found in ICICI order book",
            },
            404,
        )

    payload = {
        "order_id": orderid,
        "exchange_code": entry.get("exchange") or "NSE",
        "order_type": map_order_type(
            data.get("pricetype") or entry.get("order_type") or "LIMIT"
        ),
        "quantity": str(int(float(data.get("quantity") or entry.get("quantity") or 0))),
        "price": str(data.get("price") or entry.get("price") or "0"),
        "validity": str(data.get("validity") or entry.get("validity") or "day"),
        "disclosed_quantity": str(
            int(
                float(
                    data.get("disclosed_quantity")
                    or entry.get("disclosed_quantity")
                    or 0
                )
            )
        ),
    }

    trigger = data.get("trigger_price")

    if trigger not in (None, "", 0, "0") and payload["order_type"] == "stoploss":
        payload["stoploss"] = str(trigger)

    logger.info("Payload for ICICI modify_order: %s", payload)

    response = breeze_request(auth, "PUT", "order", payload)

    status_code = response_status(response)

    if status_code == 200:
        _invalidate_position_cache(auth)
        _invalidate_order_index(auth)

        return {"status": "success", "orderid": orderid}, 200

    message = response_error(response) or "Failed to modify order"

    logger.error("ICICI modify_order failed: %s", message)

    return {"status": "error", "message": message}, status_code


def cancel_order(orderid, auth):
    """
    Cancel one order. Returns (response_message, status_code).
    """

    orderid = str(orderid or "")

    entry = _resolve_order(orderid, auth)

    if entry is None:
        return (
            {
                "status": "error",
                "message": f"Order {orderid} not found in ICICI order book",
            },
            404,
        )

    payload = {
        "order_id": orderid,
        "exchange_code": entry.get("exchange") or "NSE",
    }

    logger.info("Payload for ICICI cancel_order: %s", payload)

    response = breeze_request(auth, "DELETE", "order", payload)

    status_code = response_status(response)

    if status_code == 200:
        _invalidate_position_cache(auth)
        _invalidate_order_index(auth)

        return {"status": "success", "orderid": orderid}, 200

    message = response_error(response) or "Failed to cancel order"

    logger.error("ICICI cancel_order failed: %s", message)

    return {"status": "error", "message": message}, status_code


def cancel_all_orders_api(data, auth):
    """
    Cancel every open order. Returns (canceled_orders, failed_cancellations).
    """

    canceled_orders: list[str] = []
    failed_cancellations: list[str] = []

    book = get_order_book(auth)

    for row in _rows(book):
        order_id = str(row.get("order_id") or "")

        if not order_id:
            continue

        status = str(row.get("status") or "").upper()

        if status in ("EXECUTED", "COMPLETED", "TRADED", "CANCELLED",
                      "CANCELED", "REJECTED", "EXPIRED"):
            continue

        pending = int(float(row.get("pending_quantity") or 0) or 0)

        if pending <= 0:
            continue

        message, status_code = cancel_order(order_id, auth)

        if status_code == 200:
            canceled_orders.append(order_id)
        else:
            failed_cancellations.append(
                {"orderid": order_id, "reason": message.get("message", "")}
            )

    return canceled_orders, failed_cancellations


# ---------------------------------------------------------------------------
# Close all positions
# ---------------------------------------------------------------------------

def close_all_positions(current_api_key, auth):
    """
    Square off every open position with opposite MARKET orders.

    Returns (message, status_code).
    """

    try:
        positions = map_position_data(get_positions(auth))
    except Exception:
        logger.exception("Error reading ICICI positions for square-off")

        return {"status": "error", "message": "Failed to read positions"}, 500

    open_positions = [p for p in positions if int(p.get("quantity") or 0) != 0]

    if not open_positions:
        return {"status": "success", "message": "No Open Positions Found"}, 200

    failures: list[str] = []

    for position in open_positions:
        quantity = abs(int(position.get("quantity") or 0))

        action = "SELL" if int(position.get("quantity") or 0) > 0 else "BUY"

        place_order_payload = {
            "apikey": current_api_key,
            "strategy": "Squareoff",
            "symbol": position.get("symbol", ""),
            "action": action,
            "exchange": position.get("exchange", ""),
            "pricetype": "MARKET",
            "product": reverse_map_product_type(
                position.get("exchange", ""),
                position.get("product", ""),
            )
            or "MIS",
            "quantity": str(quantity),
        }

        logger.info("Close position payload: %s", place_order_payload)

        res, api_response, order_id = place_order_api(
            place_order_payload, auth
        )

        if getattr(res, "status", None) != 200 or not order_id:
            reason = (
                api_response.get("message", "order was refused")
                if isinstance(api_response, dict)
                else "order was refused"
            )

            failures.append(
                f"{position.get('symbol')} ({position.get('exchange')}): {reason}"
            )

            logger.error(
                "Square-off failed for %s: %s",
                position.get("symbol"),
                reason,
            )

    if failures:
        return {
            "status": "error",
            "message": (
                f"{len(failures)} position(s) could not be squared off and "
                f"are still open: {'; '.join(failures)}"
            ),
        }, 500

    return {
        "status": "success",
        "message": "All Open Positions SquaredOff",
    }, 200
