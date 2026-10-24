"""
ICICI Direct Breeze funds API for OpenAlgo.
"""

from broker.icici.api.breeze_client import breeze_request, response_status
from utils.logging import get_logger


logger = get_logger(__name__)


def _as_float(value, default=0.0) -> float:
    if value is None:
        return default

    if isinstance(value, bool):
        return float(value)

    try:
        if isinstance(value, str):
            value = value.strip().replace(",", "")

            if not value:
                return default

        return float(value)

    except (TypeError, ValueError):
        return default


def get_margin_data(auth_token) -> dict:
    """
    Return ICICI Direct funds in the OpenAlgo funds format:

        {availablecash, collateral, m2munrealized, m2mrealized,
         utiliseddebits}  (all 2-dp strings; {} on error)
    """

    if not auth_token:
        return {}

    try:
        response = breeze_request(auth_token, "GET", "funds", {})

        if response_status(response) != 200:
            logger.error(
                "ICICI funds request failed: %s", response.get("Error")
            )

            return {}

        success = response.get("Success")

        if isinstance(success, list):
            success = success[0] if success else {}

        if not isinstance(success, dict):
            success = {}

        total_bank = _as_float(success.get("total_bank_balance"))
        allocated_equity = _as_float(success.get("allocated_equity"))
        allocated_commodity = _as_float(
            success.get("allocated_commodity")
        )
        allocated_fno = _as_float(success.get("allocated_fno"))
        block_by_trade = _as_float(success.get("block_by_trade_balance"))
        unallocated = _as_float(success.get("unallocated_balance"))

        # Available cash = what the equity segment can deploy right now.
        availablecash = (
            allocated_equity
            + unallocated
            + total_bank
            - block_by_trade
        )

        utilised = allocated_fno + allocated_commodity + block_by_trade

        if availablecash < 0:
            availablecash = 0.0

        return {
            "availablecash": f"{availablecash:.2f}",
            "collateral": "0.00",
            "m2munrealized": "0.00",
            "m2mrealized": "0.00",
            "utiliseddebits": f"{utilised:.2f}",
        }

    except Exception:
        logger.exception("Error fetching ICICI funds")

        return {}
