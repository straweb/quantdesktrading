"""
ICICI Direct Breeze margin response -> OpenAlgo margin format.
"""


def transform_margin_data(margin_data) -> dict:
    """
    Normalise the Breeze ``margin`` response.

    Breeze returns segment-wise rows such as:

        {"Success": [{"exchange_code": "nse", "margin_available": ...,
                      "margin_utilized": ...}], "Status": 200}

    OpenAlgo expects a single aggregate dict.
    """

    available = 0.0
    utilised = 0.0

    rows = []

    if isinstance(margin_data, dict):
        success = margin_data.get("Success")

        if isinstance(success, dict):
            rows = [success]
        elif isinstance(success, list):
            rows = success

    for row in rows:
        if not isinstance(row, dict):
            continue

        try:
            available += float(
                row.get("margin_available")
                or row.get("net")
                or 0
            )
        except (TypeError, ValueError):
            pass

        try:
            utilised += float(
                row.get("margin_utilized")
                or row.get("utilised")
                or 0
            )
        except (TypeError, ValueError):
            pass

    return {
        "availablecash": f"{available:.2f}",
        "collateral": "0.00",
        "m2munrealized": "0.00",
        "m2mrealized": "0.00",
        "utiliseddebits": f"{utilised:.2f}",
    }
