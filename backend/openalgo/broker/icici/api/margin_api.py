"""
ICICI Direct Breeze margin API for OpenAlgo.

``calculate_margin_api(positions, auth)`` mirrors the other brokers'
margin contract: given the would-be position list, return the
normalised margin requirement dict.

Breeze publishes no what-if SPAN endpoint, so the requirement is
estimated from the position legs (premium for buy-side options, notional
contract value otherwise), and the segment margin snapshot is attached
as context.
"""

from broker.icici.api.breeze_client import breeze_request
from broker.icici.mapping.transform_data import (
    map_product_type,
    parse_oa_symbol,
)
from database.token_db import get_br_symbol
from utils.logging import get_logger


logger = get_logger(__name__)


def _leg_margin(row: dict) -> float:
    quantity = float(row.get("quantity") or 0)

    price = float(row.get("price") or 0)

    product = str(row.get("product") or "")

    action = str(row.get("action") or "")

    # Buy-side options are premium-paid: margin == premium.
    if product == "options" and action == "buy":
        return quantity * price

    # Everything else needs SPAN/exposure margin; without a what-if
    # endpoint the notional contract value is the honest lower bound.
    return quantity * price


def calculate_margin_api(positions, auth):
    """
    Estimate the margin required for a position list.

    Returns (response_message, status_code).
    """

    if not positions:
        return {"status": "error", "message": "No positions provided"}, 400

    try:
        rows = []

        exchange = ""

        for position in positions:
            exchange = (
                str(position.get("exchange") or exchange).upper()
                or exchange
            )

            symbol = position.get("symbol", "")

            stock_code = (
                get_br_symbol(symbol, position.get("exchange", ""))
                or symbol
            )

            row = {
                "exchange_code": str(exchange).lower(),
                "stock_code": stock_code,
                "product": map_product_type(position),
                "action": str(position.get("action") or "buy").lower(),
                "quantity": str(int(float(position.get("quantity") or 0))),
                "price": str(position.get("price") or "0"),
            }

            parsed = parse_oa_symbol(symbol)

            if parsed:
                if parsed.get("expiry_iso"):
                    row["expiry_date"] = parsed["expiry_iso"]

                if parsed.get("right"):
                    row["right"] = parsed["right"]

                if parsed.get("strike"):
                    row["strike_price"] = parsed["strike"]

            rows.append(row)

        margin_required = sum(_leg_margin(row) for row in rows)

        # Segment margin snapshot for context (best effort, never fatal).
        segment = {}

        if exchange:
            try:
                response = breeze_request(
                    auth,
                    "GET",
                    "margin",
                    {"exchange_code": str(exchange).lower()},
                )

                if isinstance(response, dict):
                    segment = response.get("Success") or {}
            except Exception:
                segment = {}

        return (
            {
                "status": "success",
                "margin_required": round(margin_required, 2),
                "note": (
                    "Breeze provides no what-if SPAN endpoint; buy-side "
                    "option legs use the premium, other legs use notional "
                    "contract value."
                ),
                "segment_margin": segment,
            },
            200,
        )

    except Exception as exc:
        logger.exception("Error calculating ICICI margin")

        return {"status": "error", "message": str(exc)}, 500
