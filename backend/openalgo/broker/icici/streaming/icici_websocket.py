"""
ICICI Direct Breeze Socket.IO stream wrapper.

The official Breeze SDK owns the actual connection: python-socketio against
livestream.icicidirect.com with auth ``{"user": user_id, "token":
session_key}``. This wrapper:

- installs the ``on_ticks`` callback on the authenticated BreezeConnect,
- starts the rate-refresh stream (``ws_connect``) with bounded retries —
  bare ``Connection error`` results are retried with backoff instead of
  giving up on the first attempt,
- subscribes by STOCK TOKEN (``"4.1!<token>"`` style) exactly like the SDK
  itself does internally, because the SDK's stock_code path requires its
  own security-master naming and rejects OpenAlgo symbols,
- unsubscribes and shuts down cleanly.

Only real OS threads are used (eventlet-safe): the SDK's socketio client
runs its own engineio background thread that must never share green
primitives with the hub.
"""

from collections import defaultdict
from typing import Any, Callable, Optional

from utils.logging import get_logger
from utils.runtime import is_monkey_patched


logger = get_logger(__name__)


if is_monkey_patched("thread"):
    from utils.runtime import original as _original

    _real_threading = _original("threading")
else:
    import threading as _real_threading


# Rate-refresh stream token prefixes (breeze_connect.get_stock_token_value;
# the BFO override to '8.' applies when no OHLC interval is set, which is
# our case).
STREAM_PREFIXES = {
    "NSE": "4",
    "NFO": "4",
    "BSE": "1",
    "BFO": "8",
    "MCX": "6",
}

MODE_QUOTE = 1  # quotes token suffix
MODE_DEPTH = 2  # depth token suffix


class IciciWebSocket:
    """
    Thin lifecycle wrapper around an authenticated BreezeConnect instance.
    """

    CONNECT_ATTEMPTS = 3

    CONNECT_BACKOFFS = (2.0, 5.0, 10.0)

    def __init__(
        self,
        breeze=None,
        on_message_callback: Optional[Callable] = None,
        on_error_callback: Optional[Callable] = None,
        on_close_callback: Optional[Callable] = None,
        on_open_callback: Optional[Callable] = None,
    ):
        self.breeze = breeze

        self.on_message_callback = on_message_callback
        self.on_error_callback = on_error_callback
        self.on_close_callback = on_close_callback
        self.on_open_callback = on_open_callback

        # Compatibility callbacks used by adapters.
        self.on_connect = None
        self.on_disconnect = None

        self.connected = False
        self.running = False

        self.logger = logger

        self.lock = _real_threading.Lock()

        self._connection_ready = _real_threading.Event()

        self._stop_event = _real_threading.Event()

        # subscription_key -> {symbol, exchange, token, mode, feed_tokens}
        self.subscriptions: dict[str, dict[str, Any]] = {}

        # feed token ("4.1!1594") -> subscription key
        self._token_index: dict[str, str] = {}

        self.logger.info("ICICI Direct WebSocket wrapper initialized")

    # ==================================================================
    # LIFECYCLE
    # ==================================================================

    def start(self) -> bool:
        if self.running:
            return True

        if self.breeze is None:
            raise RuntimeError("Authenticated Breeze client is missing")

        self.running = True

        self._stop_event.clear()
        self._connection_ready.clear()

        try:
            self.breeze.on_ticks = self._on_sdk_message

            last_error: Exception | None = None

            for attempt in range(1, self.CONNECT_ATTEMPTS + 1):
                if self._stop_event.is_set():
                    return False

                try:
                    self.logger.info(
                        "Connecting to ICICI Breeze live stream "
                        "(attempt %d/%d)",
                        attempt,
                        self.CONNECT_ATTEMPTS,
                    )

                    self.breeze.ws_connect()

                    # ws_connect returns once the socket.io handshake has
                    # been attempted; treat no-exception as success.
                    self.connected = True
                    self._connection_ready.set()

                    self.logger.info(
                        "ICICI Direct Breeze stream connected"
                    )

                    self._notify_open()

                    self._resubscribe_all()

                    return True

                except Exception as exc:
                    last_error = exc

                    self.connected = False
                    self._connection_ready.clear()

                    self.logger.warning(
                        "ICICI Breeze stream connect attempt %d/%d "
                        "failed: %s",
                        attempt,
                        self.CONNECT_ATTEMPTS,
                        exc,
                    )

                    # Drop the SDK's half-open Socket.IO handler so the
                    # next attempt builds a fresh client instead of
                    # reusing a wedged engineio session.
                    try:
                        self.breeze.sio_rate_refresh_handler = None
                    except AttributeError:
                        pass

                    if attempt < self.CONNECT_ATTEMPTS:
                        backoff = self.CONNECT_BACKOFFS[
                            min(attempt - 1, len(self.CONNECT_BACKOFFS) - 1)
                        ]

                        if self._stop_event.wait(backoff):
                            return False

            self.running = False

            self.logger.error(
                "ICICI Breeze stream connect failed after %d attempts: %s",
                self.CONNECT_ATTEMPTS,
                last_error,
            )

            self._notify_error(last_error)

            return False

        except Exception as exc:
            self.running = False
            self.connected = False

            self.logger.exception("Unable to start ICICI Breeze streaming")

            self._notify_error(exc)

            return False

    def connect(self) -> bool:
        return self.start()

    def stop(self) -> None:
        self.running = False
        self.connected = False

        self._stop_event.set()
        self._connection_ready.clear()

        try:
            if self.breeze is not None:
                self.breeze.ws_disconnect()

        except Exception:
            self.logger.exception("Error stopping ICICI Breeze streaming")

        self.logger.info("ICICI Direct WebSocket wrapper stopped")

    def disconnect(self) -> None:
        self.stop()

    def is_connected(self) -> bool:
        return bool(self.running and self.connected)

    def wait_for_connection(self, timeout: float = 15.0) -> bool:
        return self._connection_ready.wait(timeout=timeout)

    # ==================================================================
    # SDK EVENTS
    # ==================================================================

    def _on_sdk_message(self, message=None, *args, **kwargs) -> None:
        # Any message proves the socket is alive.
        if not self.connected:
            self.connected = True
            self._connection_ready.set()
            self._notify_open()

        if self.on_message_callback:
            try:
                self.on_message_callback(message)

            except Exception:
                self.logger.exception("ICICI on_message callback failed")

    def _notify_open(self) -> None:
        for callback in (self.on_open_callback, self.on_connect):
            if callback:
                try:
                    callback()
                except Exception:
                    self.logger.exception("ICICI on_open callback failed")

    def _notify_close(self) -> None:
        for callback in (self.on_close_callback, self.on_disconnect):
            if callback:
                try:
                    callback()
                except Exception:
                    self.logger.exception("ICICI on_close callback failed")

    def _notify_error(self, error) -> None:
        if not self.on_error_callback:
            return

        try:
            self.on_error_callback(error)

        except Exception:
            self.logger.exception("ICICI on_error callback failed")

    # ==================================================================
    # SUBSCRIBE / UNSUBSCRIBE
    # ==================================================================

    @staticmethod
    def _subscription_key(exchange: str, token: str, mode: int) -> str:
        return f"{str(exchange).upper()}:{token}:{int(mode)}"

    def _feed_tokens(self, exchange: str, token: str, mode: int) -> list[str]:
        prefix = STREAM_PREFIXES.get(str(exchange).upper())

        if not prefix:
            raise ValueError(
                f"Unsupported ICICI stream exchange: {exchange}"
            )

        tokens = [f"{prefix}.{MODE_QUOTE}!{token}"]

        if mode == 3:
            tokens.append(f"{prefix}.{MODE_DEPTH}!{token}")

        return tokens

    def subscribe(
        self,
        symbol: str,
        exchange: str,
        token: str,
        mode: int = 2,
    ) -> dict:
        if not self.running:
            return {
                "status": "error",
                "success": False,
                "message": "ICICI WebSocket is not running",
            }

        if self.breeze is None:
            return {
                "status": "error",
                "success": False,
                "message": "Authenticated Breeze client is missing",
            }

        if token is None or str(token) == "":
            return {
                "status": "error",
                "success": False,
                "message": "ICICI subscription token missing",
            }

        try:
            mode = int(mode)
        except (TypeError, ValueError):
            mode = 2

        try:
            feed_tokens = self._feed_tokens(exchange, str(token), mode)
        except ValueError as exc:
            return {
                "status": "error",
                "success": False,
                "message": str(exc),
            }

        key = self._subscription_key(exchange, str(token), mode)

        with self.lock:
            existing = self.subscriptions.get(key)

            if existing:
                existing["mode"] = max(existing["mode"], mode)

                for feed_token in feed_tokens:
                    self._token_index[feed_token] = key
            else:
                self.subscriptions[key] = {
                    "symbol": symbol,
                    "exchange": str(exchange).upper(),
                    "token": str(token),
                    "mode": mode,
                    "feed_tokens": feed_tokens,
                }

                for feed_token in feed_tokens:
                    self._token_index[feed_token] = key

        if not self.connected:
            return {
                "status": "error",
                "success": False,
                "message": "ICICI WebSocket is not connected yet",
            }

        failures = []

        for feed_token in feed_tokens:
            try:
                result = self.breeze.subscribe_feeds(stock_token=feed_token)

                # The SDK returns an error STRING instead of raising.
                if isinstance(result, str) and "Exception" in result:
                    failures.append(f"{feed_token}: {result}")

            except Exception as exc:
                failures.append(f"{feed_token}: {exc}")

        if failures:
            self.logger.error(
                "ICICI subscription failed for %s:%s — %s",
                exchange,
                symbol,
                "; ".join(failures),
            )

            with self.lock:
                self.subscriptions.pop(key, None)

                for feed_token in feed_tokens:
                    self._token_index.pop(feed_token, None)

            return {
                "status": "error",
                "success": False,
                "message": "; ".join(failures),
            }

        self.logger.debug(
            "Subscribed %s:%s (mode %d)", exchange, symbol, mode
        )

        return {
            "status": "success",
            "success": True,
            "message": f"Subscribed {exchange}:{symbol}",
            "symbol": symbol,
            "exchange": exchange,
            "token": str(token),
            "mode": mode,
        }

    def unsubscribe(
        self,
        symbol: str,
        exchange: str,
        token: str,
        mode: int = 2,
    ) -> dict:
        if token is None or str(token) == "":
            return {
                "status": "success",
                "success": True,
                "message": "ICICI subscription token missing",
            }

        try:
            mode = int(mode)
        except (TypeError, ValueError):
            mode = 2

        key = self._subscription_key(exchange, str(token), mode)

        with self.lock:
            subscription = self.subscriptions.get(key)

            feed_tokens = (
                list(subscription["feed_tokens"]) if subscription else []
            )

        try:
            if self.connected:
                for feed_token in feed_tokens:
                    try:
                        self.breeze.unsubscribe_feeds(
                            stock_token=feed_token
                        )

                    except Exception:
                        self.logger.exception(
                            "Error unsubscribing feed %s", feed_token
                        )

        finally:
            with self.lock:
                self.subscriptions.pop(key, None)

                for feed_token in feed_tokens:
                    self._token_index.pop(feed_token, None)

        return {
            "status": "success",
            "success": True,
            "message": f"Unsubscribed {exchange}:{symbol}",
        }

    def unsubscribe_all(self) -> dict:
        with self.lock:
            subscriptions = list(self.subscriptions.values())

        for subscription in subscriptions:
            try:
                self.unsubscribe(
                    symbol=subscription["symbol"],
                    exchange=subscription["exchange"],
                    token=subscription["token"],
                    mode=subscription["mode"],
                )

            except Exception:
                self.logger.exception(
                    "Error unsubscribing %s:%s",
                    subscription["exchange"],
                    subscription["symbol"],
                )

        with self.lock:
            self.subscriptions.clear()
            self._token_index.clear()

        return {
            "status": "success",
            "success": True,
            "message": "All ICICI subscriptions removed",
        }

    def _resubscribe_all(self) -> None:
        """Re-join every room after a reconnect."""

        with self.lock:
            subscriptions = list(self.subscriptions.values())

        if not subscriptions:
            return

        self.logger.info(
            "Resubscribing %d ICICI subscriptions", len(subscriptions)
        )

        for subscription in subscriptions:
            for feed_token in subscription["feed_tokens"]:
                try:
                    self.breeze.subscribe_feeds(stock_token=feed_token)

                except Exception:
                    self.logger.exception(
                        "Resubscribe failed for %s", feed_token
                    )

    # ==================================================================
    # TICK RESOLUTION
    # ==================================================================

    def resolve_feed_token(self, feed_token: str):
        """
        Map an incoming tick's ``symbol`` field ("4.1!1594") back to its
        subscription. Returns (subscription_dict, raw_token) or
        (None, raw_token).
        """

        raw_token = str(feed_token).split("!")[-1]

        with self.lock:
            key = self._token_index.get(str(feed_token))

            if key:
                return self.subscriptions.get(key), raw_token

            # Depth ticks echo the depth feed token ("4.2!1594"); fall
            # back to the quote subscription ("4.1!1594") of the same
            # instrument.
            parts = str(feed_token).split("!")

            if len(parts) == 2 and parts[0].endswith(".2"):
                quote_feed = f"{parts[0][:-1]}.1!{parts[1]}"

                key = self._token_index.get(quote_feed)

                if key:
                    return self.subscriptions.get(key), raw_token

        return None, raw_token
