"""
ICICI Direct Breeze GTT (Good Till Triggered) APIs for OpenAlgo.

Service-facing functions:

    place_gtt_order(data, auth)          -> (res, response_data, trigger_id)
    modify_gtt_order(data, auth)         -> (response_message, status_code)
    cancel_gtt_order(trigger_id, auth)   -> (response_message, status_code)
    get_gtt_book(auth, include_history)  -> (response_dict, status_code)

Breeze GTT rules encoded here (each of these produced live errors in
earlier revisions):

- **Exchange codes must be LOWERCASE** on every gttorder call — the server
  validates ``Exchange-code should be 'nfo'.`` (unlike the order endpoints).
- **gtt_order_book windows may not exceed 10 days** between from_date and
  to_date; the book window is clamped (and the book is only queried for
  the recent window anyway).
- Blank optional fields are omitted; the SDK-mirrored body uses
  gtt_type 'single' / 'cover_oco' with order_details legs.
"""

import threading
import time
from datetime import datetime, timedelta

from broker.icici.api.breeze_client import (
    breeze_request,
    response_error,
    response_status,
)
from broker.icici.mapping.gtt_data import (
    normalise_gtt_exchange,
    transform_modify_gtt,
    transform_place_gtt,
)
from utils.logging import get_logger


logger = get_logger(__name__)


GTT_ENDPOINT = "gttorder"

# Breeze validated window: days between from_date & to_date must be <= 10.
GTT_WINDOW_DAYS = 9

_GTT_BOOK_TTL = 5.0

_gtt_index_lock = threading.RLock()

# trigger_id -> exchange_code (lowercase), for cancel resolution.
_gtt_index: dict[str, tuple[float, dict]] = {}


def _index_gtt_book(auth, rows) -> None:
    key = "global"

    index = {}

    for row in rows:
        trigger_id = str(
            row.get("gtt_order_id")
            or row.get("gttorderid")
            or ""
        )

        exchange = str(row.get("exchange_code") or "").lower()

        if trigger_id and exchange:
            index[trigger_id] = exchange

    with _gtt_index_lock:
        _gtt_index[auth if isinstance(auth, str) else key] = (
            time.monotonic(),
            index,
        )


def _resolve_gtt_exchange(trigger_id: str, auth) -> str | None:
    with _gtt_index_lock:
        cached = _gtt_index.get(auth if isinstance(auth, str) else "global")

        if cached and (time.monotonic() - cached[0]) < _GTT_BOOK_TTL:
            exchange = cached[1].get(str(trigger_id))

            if exchange:
                return exchange

    # Refresh the book (any exchange — try the common ones).
    for exchange in ("nse", "nfo", "bse", "bfo"):
        response = _gtt_book_response(auth, exchange)

        rows = response.get("Success") if isinstance(response, dict) else []

        if isinstance(rows, dict):
            rows = [rows]

        if rows:
            _index_gtt_book(auth, rows)

            with _gtt_index_lock:
                cached = _gtt_index.get(auth if isinstance(auth, str) else "global")

                if cached:
                    exchange = cached[1].get(str(trigger_id))

                    if exchange:
                        return exchange

    return None


def _gtt_book_response(auth, exchange_code: str) -> dict:
    """
    One GTT order-book query with a validated <=10-day window:

        from = now - 5 days, to = now + 4 days (9 days apart)
    """

    now = datetime.now()

    from_date = (now - timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    to_date = (now + timedelta(days=GTT_WINDOW_DAYS - 5)).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )

    return breeze_request(
        auth,
        "GET",
        GTT_ENDPOINT,
        {
            "exchange_code": exchange_code,
            "from_date": from_date,
            "to_date": to_date,
        },
    )


# ---------------------------------------------------------------------------
# Place
# ---------------------------------------------------------------------------

def place_gtt_order(data, auth):
    """
    Place a GTT. Returns (response, response_data, trigger_id).
    """

    try:
        payload = transform_place_gtt(data)
    except ValueError as exc:
        return (
            None,
            {"status": "error", "message": str(exc)},
            None,
        )
    except Exception as exc:
        logger.exception("ICICI GTT payload transform failed")

        return (
            None,
            {"status": "error", "message": f"Invalid GTT payload: {exc}"},
            None,
        )

    logger.info("Payload for ICICI place_gtt_order: %s", payload)

    response = breeze_request(auth, "POST", GTT_ENDPOINT, payload)

    status_code = response_status(response)

    trigger_id = None

    if status_code == 200:
        success = response.get("Success") if isinstance(response, dict) else None

        if isinstance(success, dict):
            trigger_id = str(
                success.get("gtt_order_id")
                or success.get("gttorderid")
                or success.get("id")
                or ""
            ) or None

    if status_code == 200 and trigger_id:
        return (
            response,
            {"status": "success", "trigger_id": trigger_id},
            trigger_id,
        )

    message = response_error(response) or "Failed to place GTT order"

    logger.error("ICICI place_gtt_order failed: %s", message)

    return (
        response,
        {"status": "error", "message": message},
        None,
    )


# ---------------------------------------------------------------------------
# Modify
# ---------------------------------------------------------------------------

def modify_gtt_order(data, auth):
    """
    Modify a GTT. Returns (response_message, status_code).
    """

    try:
        payload = transform_modify_gtt(data)
    except ValueError as exc:
        return {"status": "error", "message": str(exc)}, 400
    except Exception as exc:
        logger.exception("ICICI GTT modify transform failed")

        return {"status": "error", "message": f"Invalid GTT payload: {exc}"}, 400

    gtt_type = payload.pop("gtt_type", "single")

    logger.info("Payload for ICICI modify_gtt_order: %s", payload)

    response = breeze_request(auth, "PUT", GTT_ENDPOINT, payload)

    status_code = response_status(response)

    if status_code == 200:
        return (
            {
                "status": "success",
                "trigger_id": payload.get("gtt_order_id", ""),
            },
            200,
        )

    message = response_error(response) or "Failed to modify GTT order"

    logger.error("ICICI modify_gtt_order failed: %s", message)

    return {"status": "error", "message": message}, status_code


# ---------------------------------------------------------------------------
# Cancel
# ---------------------------------------------------------------------------

def cancel_gtt_order(trigger_id, auth):
    """
    Cancel a GTT. Returns (response_message, status_code).

    Breeze's DELETE /gttorder requires the lowercase exchange code, which
    is resolved from a recent GTT book fetch.
    """

    trigger_id = str(trigger_id or "")

    exchange = _resolve_gtt_exchange(trigger_id, auth)

    if not exchange:
        return (
            {
                "status": "error",
                "message": f"GTT trigger {trigger_id} not found in ICICI GTT book",
            },
            404,
        )

    payload = {
        "exchange_code": exchange,
        "gtt_order_id": trigger_id,
    }

    logger.info("Payload for ICICI cancel_gtt_order: %s", payload)

    response = breeze_request(auth, "DELETE", GTT_ENDPOINT, payload)

    status_code = response_status(response)

    if status_code == 200:
        return {"status": "success", "trigger_id": trigger_id}, 200

    message = response_error(response) or "Failed to cancel GTT order"

    logger.error("ICICI cancel_gtt_order failed: %s", message)

    return {"status": "error", "message": message}, status_code


# ---------------------------------------------------------------------------
# Book
# ---------------------------------------------------------------------------

def get_gtt_book(auth, include_history=False):
    """
    GTT order book. Returns (response_dict, status_code) with OpenAlgo
    normalised rows (mapping.gtt_data.map_gtt_book).

    Active-only by default; ``include_history`` keeps every row.
    """

    collected: dict[str, dict] = {}

    for exchange in ("nse", "nfo", "bse", "bfo"):
        response = _gtt_book_response(auth, exchange)

        status_code = response_status(response)

        if status_code != 200:
            error = response_error(response)

            # Per-exchange empties are normal; only surface hard failures.
            if error and "no " not in error.lower():
                logger.warning(
                    "ICICI GTT book %s failed: %s", exchange, error
                )

            continue

        rows = response.get("Success") or []

        if isinstance(rows, dict):
            rows = [rows]

        for row in rows:
            if not isinstance(row, dict):
                continue

            trigger_id = str(
                row.get("gtt_order_id")
                or row.get("gttorderid")
                or ""
            )

            if trigger_id:
                collected[trigger_id] = row

    _index_gtt_book(auth, list(collected.values()))

    if not include_history:
        collected = {
            trigger_id: row
            for trigger_id, row in collected.items()
            if str(row.get("status") or "").lower() in ("", "active", "open")
        }

    from broker.icici.mapping.gtt_data import map_gtt_book

    return {
        "status": "success",
        "data": map_gtt_book(list(collected.values())),
    }, 200
