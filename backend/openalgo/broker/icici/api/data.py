"""
ICICI Direct Breeze market-data APIs for OpenAlgo.

``BrokerData`` exposes the common OpenAlgo market-data contract:

    get_quotes(symbol, exchange)            -> dict
    get_multiquotes(symbols)                -> list[dict]
    get_depth(symbol, exchange)             -> dict (5 padded levels)
    get_history(...)                        -> pandas DataFrame (epoch s)
    get_option_chain(...)                   -> raw Breeze option-chain dict

Breeze specifics handled here:

- Quotes for F&O require the UNDERLYING stock code plus product_type /
  expiry_date / right / strike_price — derived from the OpenAlgo symbol
  (deterministic NIFTY19OCT2623650CE format) and the master contract.
- Historical data uses the v2 ``historicalcharts`` endpoint (apikey +
  X-SessionToken, query-string params). Only 1second / 1minute / 5minute /
  30minute / 1day intervals exist, which is exactly what ``timeframe_map``
  offers.
- All REST traffic flows through breeze_client.breeze_request, so the
  process-wide rate limiter and 429/503 backoff apply here too.
"""

from datetime import datetime, timedelta, timezone

import pandas as pd

from broker.icici.api.breeze_client import breeze_request, breeze_request_v2
from broker.icici.api.baseurl import HIST_V2_URL
from broker.icici.mapping.transform_data import (
    parse_oa_symbol,
    underlying_symbol,
)
from database.token_db import get_br_symbol, get_symbol_info
from utils.logging import get_logger


logger = get_logger(__name__)


HIST_ENDPOINT = "historicalcharts"

# Intraday v2 windows are chunked conservatively.
_INTRADAY_CHUNK_DAYS = 30
_DAILY_CHUNK_DAYS = 365


class ICICIBreezeAPIError(Exception):
    """Normalized ICICI Breeze market-data exception."""


# ---------------------------------------------------------------------------
# Exchange / symbol helpers
# ---------------------------------------------------------------------------

def _exchange_code(exchange) -> str:
    """
    OpenAlgo exchange -> Breeze exchange code (lowercase).
    """

    value = str(exchange or "").strip().upper()

    mapping = {
        "NSE": "nse",
        "BSE": "bse",
        "NFO": "nfo",
        "BFO": "bfo",
        "MCX": "mcx",
        "CDS": "cds",
        "NSE_INDEX": "nse",
        "BSE_INDEX": "bse",
        "MCX_INDEX": "mcx",
    }

    return mapping.get(value, value.lower())


def _is_index(exchange) -> bool:
    return str(exchange or "").upper().endswith("_INDEX")


def _is_derivative(exchange) -> bool:
    return str(exchange or "").upper() in ("NFO", "BFO", "MCX")


def _stock_code(symbol: str, exchange: str) -> str:
    """
    Broker stock code for a symbol. The master contract stores the raw
    Breeze code in brsymbol; fall back to the symbol with the common
    OpenAlgo suffixes stripped.
    """

    brsymbol = None

    try:
        brsymbol = get_br_symbol(symbol, exchange)
    except Exception:
        brsymbol = None

    if brsymbol:
        return str(brsymbol)

    text = str(symbol or "").strip()

    for suffix in ("-EQ", "-BE", "-BZ", "-SM", "-ST"):
        if text.endswith(suffix):
            return text[: -len(suffix)]

    return text


def _quote_instrument(symbol: str, exchange: str) -> dict:
    """
    Build Breeze quote parameters for any instrument class.

    - cash: stock_code + exchange_code (+ product_type cash for Breeze)
    - F&O: underlying stock_code + product futures/options + expiry +
      right + strike
    - index: the index stock code on the parent exchange
    """

    exchange_upper = str(exchange or "").upper()

    params: dict = {}

    if _is_derivative(exchange_upper):
        info = None

        try:
            info = get_symbol_info(symbol, exchange)
        except Exception:
            info = None

        parsed = parse_oa_symbol(symbol) or {}

        underlying = underlying_symbol(symbol, exchange)

        instrumenttype = ""

        if info is not None and getattr(info, "instrumenttype", None):
            instrumenttype = str(info.instrumenttype).upper()

        if not instrumenttype:
            instrumenttype = str(parsed.get("instrumenttype") or "")

        if instrumenttype in ("CE", "PE"):
            product = "options"
            right = "call" if instrumenttype == "CE" else "put"
        elif instrumenttype == "FUT":
            product = "futures"
            right = ""
        else:
            product = "futures"
            right = ""

        expiry = str(parsed.get("expiry_iso") or "")

        if not expiry and info is not None and getattr(info, "expiry", None):
            expiry = str(info.expiry or "")

        params["stock_code"] = underlying
        params["product_type"] = product

        if expiry:
            params["expiry_date"] = expiry

        if right:
            params["right"] = right

        strike = parsed.get("strike")

        if strike in (None, "") and info is not None and getattr(info, "strike", None):
            strike_value = float(info.strike)

            strike = (
                str(int(strike_value))
                if strike_value.is_integer()
                else str(strike_value)
            )

        if right and strike not in (None, ""):
            params["strike_price"] = str(strike)

        return params

    stock_code = _stock_code(symbol, exchange)

    params["stock_code"] = stock_code
    if exchange == "NSE_INDEX":
        params["exchange_code"] = "NSE"
    else:
        params["exchange_code"] = exchange


    # Breeze accepts product_type cash for equities/indices; omit for
    # robustness on indices where some scrips are not tagged Cash.
    if not _is_index(exchange):
        params["product_type"] = "cash"

    return params


def _number(value, default=0.0) -> float:
    try:
        if value is None or value == "":
            return float(default)

        return float(value)

    except (TypeError, ValueError):
        return float(default)


def _integer(value, default=0) -> int:
    try:
        if value is None or value == "":
            return int(default)

        return int(float(value))

    except (TypeError, ValueError):
        return int(default)


def _success_data(response) -> dict:
    if not isinstance(response, dict):
        return {}

    success = response.get("Success")

    if isinstance(success, dict):
        return success

    if isinstance(success, list) and success:
        return success[0]

    return {}


def _success_list(response) -> list:
    if not isinstance(response, dict):
        return []

    success = response.get("Success")

    if isinstance(success, list):
        return success

    if isinstance(success, dict):
        return [success]

    return []


def _first(data: dict, *keys, default=None):
    if not isinstance(data, dict):
        return default

    for key in keys:
        value = data.get(key)

        if value is not None and value != "":
            return value

    return default


# ---------------------------------------------------------------------------
# BrokerData
# ---------------------------------------------------------------------------

class BrokerData:
    """ICICI Direct Breeze OpenAlgo market-data handler."""

    def __init__(self, auth_token):
        self.auth_token = auth_token

        # intervals_service intersects these keys with
        # utils.constants.SUPPORTED_INTERVALS, so only Breeze-served
        # intervals are listed.
        self.timeframe_map = {
            "1s": "1second",
            "1m": "1minute",
            "5m": "5minute",
            "30m": "30minute",
            "D": "1day",
        }

    # ------------------------------------------------------------------
    # Quotes
    # ------------------------------------------------------------------

    def get_quotes(self, symbol: str, exchange: str) -> dict:
        """
        Normalized OpenAlgo quote:

            {ask, bid, high, low, ltp, open, prev_close, volume, oi}
        """

        params = _quote_instrument(symbol, exchange)

        response = breeze_request(
            self.auth_token,
            "GET",
            "quotes",
            params,
        )

        success = _success_data(response)

        if not success:
            error = str(response.get("Error") or "") if isinstance(response, dict) else ""

            raise ICICIBreezeAPIError(
                error or f"No quote data for {symbol} on {exchange}"
            )

        return {
            "ask": _number(
                _first(success, "best_offer_price", "sPrice", "ask", "sell_price")
            ),
            "bid": _number(
                _first(success, "best_bid_price", "bPrice", "bid", "buy_price")
            ),
            "high": _number(_first(success, "high", "HighPrice")),
            "low": _number(_first(success, "low", "LowPrice")),
            "ltp": _number(_first(success, "ltp", "last", "last_price", "last_trade_price")),
            "open": _number(_first(success, "open", "OpenPrice")),
            "prev_close": _number(
                _first(success, "previous_close", "prev_close", "close", "ClosePrice")
            ),
            "volume": _integer(
                _first(success, "total_quantity_traded", "volume", "ttq")
            ),
            "oi": _integer(
                _first(success, "open_interest", "oi", "OI", "CurrOpenInterest")
            ),
        }

    def get_multiquotes(self, symbols: list) -> list:
        """
        Sequential quotes (Breeze has no batch quote endpoint). The
        module-level rate limiter inside breeze_request paces the loop;
        a failed symbol does not discard the other results.
        """

        results = []

        for item in symbols:
            symbol = item.get("symbol")
            exchange = item.get("exchange")

            try:
                data = self.get_quotes(symbol, exchange)

                results.append(
                    {
                        "symbol": symbol,
                        "exchange": exchange,
                        "data": data,
                    }
                )

            except Exception as exc:
                logger.warning(
                    "ICICI multiquote failed for %s:%s: %s",
                    exchange,
                    symbol,
                    exc,
                )

                results.append(
                    {
                        "symbol": symbol,
                        "exchange": exchange,
                        "error": str(exc),
                    }
                )

        return results

    # ------------------------------------------------------------------
    # Depth
    # ------------------------------------------------------------------

    def get_depth(self, symbol: str, exchange: str) -> dict:
        """
        Normalized five-level depth.

        The Breeze REST quote carries only the best bid/offer; levels 2-5
        are zero-padded to keep the OpenAlgo contract shape stable. Live
        multi-level depth comes from the websocket stream.
        """

        params = _quote_instrument(symbol, exchange)

        response = breeze_request(
            self.auth_token,
            "GET",
            "quotes",
            params,
        )

        success = _success_data(response)

        if not success:
            error = str(response.get("Error") or "") if isinstance(response, dict) else ""

            raise ICICIBreezeAPIError(
                error or f"No depth data for {symbol} on {exchange}"
            )

        best_bid = _number(
            _first(success, "best_bid_price", "bPrice", "bid")
        )

        bid_qty = _integer(
            _first(success, "best_bid_quantity", "bQty", "bid_quantity")
        )

        best_ask = _number(
            _first(success, "best_offer_price", "sPrice", "ask")
        )

        ask_qty = _integer(
            _first(success, "best_offer_quantity", "sQty", "ask_quantity")
        )

        bids = [{"price": best_bid, "quantity": bid_qty}]
        asks = [{"price": best_ask, "quantity": ask_qty}]

        while len(bids) < 5:
            bids.append({"price": 0.0, "quantity": 0})

        while len(asks) < 5:
            asks.append({"price": 0.0, "quantity": 0})

        ltp = _number(_first(success, "ltp", "last", "last_price"))

        return {
            "asks": asks,
            "bids": bids,
            "high": _number(_first(success, "high", "HighPrice")),
            "low": _number(_first(success, "low", "LowPrice")),
            "ltp": ltp,
            "ltq": _integer(
                _first(success, "last_traded_quantity", "ltq", "last_quantity")
            ),
            "oi": _integer(
                _first(success, "open_interest", "oi", "OI")
            ),
            "open": _number(_first(success, "open", "OpenPrice")),
            "prev_close": _number(
                _first(success, "previous_close", "prev_close", "close", "ClosePrice")
            ),
            "totalbuyqty": bid_qty,
            "totalsellqty": ask_qty,
            "volume": _integer(
                _first(success, "total_quantity_traded", "volume", "ttq")
            ),
        }

    def get_market_depth(self, symbol: str, exchange: str) -> dict:
        return self.get_depth(symbol, exchange)

    # ------------------------------------------------------------------
    # Historical data
    # ------------------------------------------------------------------

    def _history_chunk(
        self,
        stock_code: str,
        exchange_code: str,
        breeze_interval: str,
        product_type: str,
        expiry_date: str,
        right: str,
        strike_price: str,
        chunk_start: datetime,
        chunk_end: datetime,
    ) -> list:
        params = {
            "interval": breeze_interval,
            "from_date": chunk_start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "to_date": chunk_end.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "stock_code": stock_code,
            "exch_code": exchange_code,
            "product_type": product_type,
        }

        if expiry_date:
            params["expiry_date"] = expiry_date

        if right:
            params["right"] = right

        if strike_price:
            params["strike_price"] = strike_price

        response = breeze_request_v2(self.auth_token, HIST_ENDPOINT, params)

        candles = _success_list(response)

        if not candles and isinstance(response, dict):
            error = str(response.get("Error") or "")

            if error and "no data" not in error.lower():
                raise ICICIBreezeAPIError(error)

        return candles

    def get_history(
        self,
        symbol: str,
        exchange: str,
        timeframe: str,
        from_date,
        to_date,
    ) -> pd.DataFrame:
        """
        Normalized history DataFrame:

            [timestamp, open, high, low, close, volume, oi]

        ``timestamp`` is true epoch seconds; intraday candles are IST
        wall-clock instants (standard Indian-broker convention).
        """

        columns = [
            "timestamp",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "oi",
        ]

        breeze_interval = self.timeframe_map.get(timeframe)

        if not breeze_interval:
            raise ICICIBreezeAPIError(
                f"Unsupported timeframe: {timeframe}. "
                f"Supported: {', '.join(self.timeframe_map)}"
            )

        try:
            params = _quote_instrument(symbol, exchange)

            stock_code = params.get("stock_code", "")

            if not stock_code:
                raise ICICIBreezeAPIError(
                    f"Cannot resolve stock code for {symbol} on {exchange}"
                )

            exchange_code = _exchange_code(exchange)

            product_type = str(params.get("product_type") or "")

            if not product_type:
                if _is_derivative(exchange):
                    product_type = "futures"
                else:
                    product_type = "cash"

            expiry_date = str(params.get("expiry_date") or "")
            right = str(params.get("right") or "")
            strike_price = str(params.get("strike_price") or "")

            start = self._normalize_date(from_date, end_of_day=False)
            end = self._normalize_date(to_date, end_of_day=True)

            now = datetime.now()

            if end > now:
                end = now

            if end <= start:
                return pd.DataFrame(columns=columns)

            if breeze_interval == "1day":
                chunk_days = _DAILY_CHUNK_DAYS
            else:
                chunk_days = _INTRADAY_CHUNK_DAYS

            candles: list = []

            cursor = start

            while cursor < end:
                chunk_end = min(cursor + timedelta(days=chunk_days), end)

                candles.extend(
                    self._history_chunk(
                        stock_code,
                        exchange_code,
                        breeze_interval,
                        product_type,
                        expiry_date,
                        right,
                        strike_price,
                        cursor,
                        chunk_end,
                    )
                )

                cursor = chunk_end + timedelta(seconds=1)

            return self._candles_to_dataframe(candles, columns)

        except ICICIBreezeAPIError:
            raise

        except Exception as exc:
            logger.exception("Error fetching ICICI historical data")

            raise ICICIBreezeAPIError(
                f"Error fetching historical data: {exc}"
            ) from exc

    @staticmethod
    def _normalize_date(value, end_of_day: bool = False) -> datetime:
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, str):
            text = value.strip().strip("\"'")

            if text.endswith("Z"):
                text = text[:-1] + "+00:00"

            try:
                parsed = datetime.fromisoformat(text)
            except ValueError:
                parsed = datetime.strptime(text[:10], "%Y-%m-%d")
        else:
            parsed = datetime.combine(value, datetime.min.time())

        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)

        if end_of_day and parsed.time() == datetime.min.time():
            parsed = parsed.replace(hour=23, minute=59, second=59)

        return parsed

    @staticmethod
    def _timestamp_to_epoch(value) -> int | None:
        if value is None:
            return None

        if isinstance(value, (int, float)):
            return int(value)

        text = str(value).strip()

        if not text:
            return None

        if text.endswith("Z"):
            text = text[:-1] + "+00:00"

        parsed = None

        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            pass

        if parsed is None:
            for fmt in (
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M",
                "%Y-%m-%d",
            ):
                try:
                    parsed = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue

        if parsed is None:
            coerced = pd.to_datetime(value, errors="coerce")

            if pd.isna(coerced):
                return None

            parsed = coerced.to_pydatetime()

        if parsed.tzinfo is None:
            try:
                from zoneinfo import ZoneInfo

                parsed = parsed.replace(tzinfo=ZoneInfo("Asia/Kolkata"))
            except Exception:
                parsed = parsed.replace(tzinfo=timezone.utc)

        return int(parsed.timestamp())

    @classmethod
    def _candles_to_dataframe(
        cls,
        candles: list,
        columns: list,
    ) -> pd.DataFrame:
        if not candles:
            return pd.DataFrame(columns=columns)

        rows = []

        for candle in candles:
            if not isinstance(candle, dict):
                continue

            timestamp = cls._timestamp_to_epoch(
                _first(candle, "datetime", "timestamp", "time", "date")
            )

            if timestamp is None:
                continue

            rows.append(
                {
                    "timestamp": timestamp,
                    "open": _number(_first(candle, "open")),
                    "high": _number(_first(candle, "high")),
                    "low": _number(_first(candle, "low")),
                    "close": _number(_first(candle, "close")),
                    "volume": _integer(
                        _first(candle, "volume", "total_quantity_traded", "ttq")
                    ),
                    "oi": _integer(
                        _first(candle, "open_interest", "oi", "OI")
                    ),
                }
            )

        if not rows:
            return pd.DataFrame(columns=columns)

        dataframe = pd.DataFrame(rows, columns=columns)

        dataframe = (
            dataframe.sort_values("timestamp")
            .drop_duplicates(subset=["timestamp"], keep="last")
            .reset_index(drop=True)
        )

        return dataframe

    # ------------------------------------------------------------------
    # Option chain
    # ------------------------------------------------------------------

    def get_option_chain(
        self,
        symbol: str,
        exchange: str,
        expiry_date,
        right: str = "",
        strike_price: str = "",
    ):
        """
        Raw Breeze option-chain response (Success = contract rows with
        greeks/iv per strike).
        """

        params = _quote_instrument(symbol, exchange)

        if not params.get("stock_code"):
            raise ICICIBreezeAPIError(
                f"Cannot resolve stock code for {symbol} on {exchange}"
            )

        params["product_type"] = "options"

        if expiry_date:
            if isinstance(expiry_date, (datetime, pd.Timestamp)):
                params["expiry_date"] = pd.Timestamp(expiry_date).strftime(
                    "%Y-%m-%dT06:00:00.000Z"
                )
            else:
                params["expiry_date"] = str(expiry_date)

        if right:
            params["right"] = str(right).lower()

        if strike_price not in ("", None):
            params["strike_price"] = str(strike_price)

        response = breeze_request(
            self.auth_token,
            "GET",
            "optionchain",
            params,
        )

        if not isinstance(response, dict):
            raise ICICIBreezeAPIError("Invalid option-chain response")

        return response

    # ------------------------------------------------------------------
    # Misc
    # ------------------------------------------------------------------

    def get_supported_intervals(self) -> list:
        return sorted(self.timeframe_map.keys())
