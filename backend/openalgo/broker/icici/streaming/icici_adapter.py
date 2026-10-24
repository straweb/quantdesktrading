"""
ICICI Direct Breeze streaming adapter -> OpenAlgo unified feed.

Subclasses ``websocket_proxy.base_adapter.BaseBrokerWebSocketAdapter`` and
publishes normalized ticks on the shared ZeroMQ bus with topics
``f"{exchange}_{symbol}_{MODE}"`` (MODE in LTP / QUOTE / DEPTH).

Subscription model
------------------
Breeze's Socket.IO stream joins per-token rooms. The adapter resolves the
OpenAlgo symbol to the ICICI token via the master contract
(``database.token_db.get_token``) and the websocket wrapper subscribes the
matching feed rooms (``"4.1!<token>"`` quotes, ``"4.2!<token>"`` depth).

Auth: the streaming client is built from the stored ICICI auth JSON
(api_session + user_id/session_key); the SDK owns the Socket.IO handshake.
"""

from typing import Any

from database.auth_db import get_auth_token
from database.token_db import get_token
from websocket_proxy.base_adapter import BaseBrokerWebSocketAdapter

from broker.icici.api.breeze_client import get_breeze_client
from broker.icici.streaming.icici_mapping import map_tick
from broker.icici.streaming.icici_websocket import IciciWebSocket
from utils.logging import get_logger
from utils.runtime import is_monkey_patched


logger = get_logger(__name__)


if is_monkey_patched("thread"):
    from utils.runtime import original as _original

    _real_threading = _original("threading")
else:
    import threading as _real_threading


# OpenAlgo numeric modes
MODE_LTP = 1
MODE_QUOTE = 2
MODE_DEPTH = 3

_MODE_TOPIC = {
    MODE_LTP: "LTP",
    MODE_QUOTE: "QUOTE",
    MODE_DEPTH: "DEPTH",
}


class IciciWebSocketAdapter(BaseBrokerWebSocketAdapter):
    """ICICI Direct Breeze market-data adapter for OpenAlgo."""

    def __init__(self):
        super().__init__()

        self.broker_name = "icici"

        self.user_id: str | None = None

        self.auth_token: str | None = None

        self.breeze = None

        self.ws_client: IciciWebSocket | None = None

        self.running = False
        self.connected = False

        # (exchange, token) -> {"symbol": ..., "mode": highest}
        self.token_info: dict[tuple[str, str], dict] = {}

        self.lock = _real_threading.RLock()

        self.logger = logger

    # ==================================================================
    # INITIALIZATION
    # ==================================================================

    def initialize(
        self,
        broker_name=None,
        user_id=None,
        auth_data=None,
        *args,
        **kwargs,
    ) -> dict[str, Any]:
        """
        Initialize the adapter with the stored ICICI session.

        ``auth_data`` accepts {"token": <auth json>} (the websocket proxy
        contract) or {"auth_token": ...} / {"access_token": ...}.
        """

        try:
            if broker_name:
                self.broker_name = broker_name

            self.user_id = user_id

            auth_token = ""

            if isinstance(auth_data, dict):
                auth_token = (
                    auth_data.get("token")
                    or auth_data.get("auth_token")
                    or auth_data.get("access_token")
                    or ""
                )

            if not auth_token:
                auth_token = get_auth_token(user_id) or ""

            if not auth_token:
                return {
                    "status": "error",
                    "message": (
                        "No ICICI authentication token available for "
                        f"user {user_id}"
                    ),
                }

            self.auth_token = auth_token

            # Authenticated SDK client (session exchange + security
            # master for token rooms). Cached process-wide.
            self.breeze = get_breeze_client(auth_token)

            self.ws_client = IciciWebSocket(
                breeze=self.breeze,
                on_message_callback=self._on_message,
                on_error_callback=self._on_error,
                on_close_callback=self._on_close,
                on_open_callback=self._on_open,
            )

            self.logger.info(
                "ICICI adapter initialized for user %s", user_id
            )

            return {
                "status": "success",
                "message": "Adapter initialized successfully",
            }

        except Exception as exc:
            self.logger.error("Error initializing ICICI adapter: %s", exc)

            return {"status": "error", "message": str(exc)}

    # ==================================================================
    # LIFECYCLE
    # ==================================================================

    def connect(self) -> dict[str, Any]:
        if not self.ws_client:
            return {
                "status": "error",
                "message": "WebSocket client not initialized",
            }

        try:
            with self.lock:
                if self.running and self.connected:
                    return {
                        "status": "success",
                        "message": "Already connected",
                    }

                if self.ws_client.start():
                    self.running = True

                    if self.ws_client.wait_for_connection(timeout=15.0):
                        self.connected = True

                        self.logger.info("ICICI stream connected")

                        return {
                            "status": "success",
                            "message": "Connected successfully",
                        }

                    if self.ws_client.running:
                        self.logger.warning(
                            "ICICI stream client started but connection "
                            "not confirmed yet"
                        )

                        return {
                            "status": "success",
                            "message": "Client started, connection in progress",
                        }

                    return {
                        "status": "error",
                        "message": "Connection timeout",
                    }

                return {
                    "status": "error",
                    "message": "Failed to start ICICI stream client",
                }

        except Exception as exc:
            self.logger.exception("ICICI adapter connect failed")

            return {"status": "error", "message": str(exc)}

    def disconnect(self) -> dict[str, Any]:
        try:
            with self.lock:
                if self.ws_client:
                    self.ws_client.stop()
                    self.ws_client = None

                self.running = False
                self.connected = False

                self.token_info.clear()

                self.logger.info("ICICI stream disconnected")

                self.cleanup_zmq()

            return {
                "status": "success",
                "message": "Disconnected successfully and resources cleaned up",
            }

        except Exception as exc:
            self.logger.exception("Error disconnecting ICICI adapter")

            try:
                self.cleanup_zmq()
            except Exception:
                pass

            return {"status": "error", "message": str(exc)}

    # ==================================================================
    # SUBSCRIPTIONS
    # ==================================================================

    def subscribe(
        self,
        symbol: str,
        exchange: str,
        mode: int = MODE_QUOTE,
        depth_level: int = 5,
    ) -> dict[str, Any]:
        if not self.ws_client:
            return {
                "status": "error",
                "message": "WebSocket client not initialized",
            }

        try:
            token = get_token(symbol, exchange)

            if not token:
                return {
                    "status": "error",
                    "error_code": 404,
                    "message": (
                        f"Token not found for {symbol} on {exchange}. "
                        "Load the ICICI master contract and retry."
                    ),
                }

            result = self.ws_client.subscribe(
                symbol=symbol,
                exchange=exchange,
                token=str(token),
                mode=int(mode),
            )

            if result.get("status") != "success":
                return result

            with self.lock:
                entry = self.token_info.get((exchange, str(token)))

                if entry:
                    entry["mode"] = max(entry["mode"], int(mode))
                else:
                    self.token_info[(exchange, str(token))] = {
                        "symbol": symbol,
                        "mode": int(mode),
                    }

            return self._create_success_response(
                f"Subscribed {symbol} ({exchange})",
                symbol=symbol,
                exchange=exchange,
                mode=int(mode),
                depth_level=5,
                actual_depth=5,
            )

        except Exception as exc:
            self.logger.exception("ICICI subscribe failed for %s", symbol)

            return {"status": "error", "message": str(exc)}

    def unsubscribe(
        self,
        symbol: str,
        exchange: str,
        mode: int = MODE_QUOTE,
    ) -> dict[str, Any]:
        if not self.ws_client:
            return {
                "status": "error",
                "message": "WebSocket client not initialized",
            }

        try:
            token = get_token(symbol, exchange)

            if not token:
                return self._create_error_response(
                    "TOKEN_NOT_FOUND",
                    f"Token not found for {symbol} on {exchange}",
                )

            result = self.ws_client.unsubscribe(
                symbol=symbol,
                exchange=exchange,
                token=str(token),
                mode=int(mode),
            )

            with self.lock:
                self.token_info.pop((exchange, str(token)), None)

            return result

        except Exception as exc:
            self.logger.exception(
                "ICICI unsubscribe failed for %s", symbol
            )

            return {"status": "error", "message": str(exc)}

    # ==================================================================
    # STREAM EVENTS
    # ==================================================================

    def _on_open(self) -> None:
        self.connected = True

        self.logger.info("ICICI stream opened")

    def _on_close(self) -> None:
        self.connected = False

        self.logger.info("ICICI stream closed")

    def _on_error(self, error) -> None:
        self.connected = False

        self.logger.error("ICICI stream error: %s", error)

    def _on_message(self, message) -> None:
        """
        One parsed Breeze tick. Resolves the room token back to the
        OpenAlgo subscription and publishes on the ZeroMQ bus.
        """

        if not isinstance(message, dict):
            return

        feed_token = str(message.get("symbol") or "")

        if not feed_token or "!" not in feed_token:
            # Order notifications / heartbeats carry no feed token.
            return

        if not self.ws_client:
            return

        subscription, raw_token = self.ws_client.resolve_feed_token(
            feed_token
        )

        if not subscription:
            return

        symbol = subscription["symbol"]
        exchange = subscription["exchange"]
        mode = int(subscription.get("mode") or MODE_QUOTE)

        try:
            tick = map_tick(
                message,
                symbol=symbol,
                exchange=exchange,
                token=raw_token,
                mode=mode,
            )

        except Exception:
            self.logger.exception("Tick mapping failed for %s", feed_token)

            return

        if not tick:
            return

        # ----------------------------------------------------------
        # Publish per mode (topic: exchange_symbol_MODE)
        # ----------------------------------------------------------
        if mode == MODE_LTP:
            self._publish(symbol, exchange, MODE_LTP, tick)
            return

        if mode == MODE_DEPTH:
            self._publish(symbol, exchange, MODE_DEPTH, tick)

            if "last_price" in tick and tick.get("last_price"):
                self._publish(symbol, exchange, MODE_QUOTE, tick)

            return

        self._publish(symbol, exchange, MODE_QUOTE, tick)

    def _publish(self, symbol: str, exchange: str, mode: int, tick: dict) -> None:
        try:
            topic = f"{exchange}_{symbol}_{_MODE_TOPIC[mode]}"

            self.publish_market_data(topic, tick)

        except Exception:
            self.logger.exception(
                "Failed to publish tick for %s:%s", exchange, symbol
            )

    # ==================================================================
    # COMPATIBILITY
    # ==================================================================

    def get_supported_depth_levels(self) -> list[int]:
        return [5]
