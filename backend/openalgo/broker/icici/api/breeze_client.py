"""
ICICI Direct Breeze client for OpenAlgo.

This module owns everything shared by the broker plugin:

1. Credential decoding (OpenAlgo stored auth -> api_session / user_id /
   session_key).
2. A resilient REST layer (``breeze_request``) that reproduces the official
   SDK's checksum header scheme and adds what the SDK lacks:

   - a process-wide rate limiter (Breeze throttles aggressively with
     HTTP 429 / 503 and non-JSON bodies),
   - reactive retries with Retry-After / exponential backoff,
   - empty-result normalisation ("No Data Found" -> empty Success),
   - session-expiry detection with a single transparent re-auth retry.

3. ``get_breeze_client`` — a cached official ``BreezeConnect`` instance used
   ONLY for streaming (the SDK owns the Socket.IO handshake and the security
   master tables needed to resolve websocket tokens).

REST endpoint semantics (paths, param names, HTTP verbs) are copied 1:1 from
breeze_connect 1.0.69 so behaviour matches the documented Breeze API.
"""

from __future__ import annotations

import base64
import json
import os
import random
import threading
import time
from datetime import datetime
from hashlib import sha256
from typing import Any

import requests

from broker.icici.api.baseurl import API_URL, HIST_V2_URL
from utils.logging import get_logger


logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Rate limiting (module level — services create fresh broker objects per
# request, so instance state would pace nothing).
# ---------------------------------------------------------------------------

_LIMIT_LOCK = threading.Lock()
_LAST_CALL_MONOTONIC = 0.0

# Breeze does not publish a documented REST cap, but throttles hard in
# practice (HTTP 429 / 503 bursts were observed on the default OpenAlgo UI
# polling cadence). Pace the whole plugin at ~3.5 req/s with reactive
# backoff on top.
MIN_REQUEST_INTERVAL = float(
    os.getenv("ICICI_MIN_REQUEST_INTERVAL", "0.28")
)


def _apply_rate_limit() -> None:
    """Reserve the next request slot. Sleep happens outside the lock."""

    global _LAST_CALL_MONOTONIC

    with _LIMIT_LOCK:
        now = time.monotonic()
        wait = MIN_REQUEST_INTERVAL - (now - _LAST_CALL_MONOTONIC)

        if wait > 0:
            _LAST_CALL_MONOTONIC = now + wait
        else:
            _LAST_CALL_MONOTONIC = now

    if wait > 0:
        time.sleep(wait)


# ---------------------------------------------------------------------------
# Credential handling
# ---------------------------------------------------------------------------

def decode_auth(auth: Any) -> dict:
    """
    Decode OpenAlgo's stored ICICI authentication value.

    Supported inputs:

        1. dict                      -> returned as-is
        2. JSON string               -> parsed
        3. plain api_session string  -> {"api_session": "..."}
    """

    if not auth:
        raise RuntimeError("ICICI authentication token is empty")

    if isinstance(auth, dict):
        return dict(auth)

    if isinstance(auth, bytes):
        auth = auth.decode("utf-8", errors="ignore")

    text = str(auth).strip()

    if not text:
        raise RuntimeError("ICICI authentication token is empty")

    try:
        decoded = json.loads(text)

        if isinstance(decoded, dict):
            return decoded

    except (TypeError, ValueError):
        pass

    return {"api_session": text}


def _env_credentials() -> tuple[str, str]:
    api_key = os.getenv("BROKER_API_KEY", "").strip()
    api_secret = os.getenv("BROKER_API_SECRET", "").strip()

    if not api_key:
        raise RuntimeError("BROKER_API_KEY is not configured")

    if not api_secret:
        raise RuntimeError("BROKER_API_SECRET is not configured")

    return api_key, api_secret


class BreezeCredentials:
    """Everything needed to sign a Breeze REST call or open a stream."""

    __slots__ = (
        "api_key",
        "api_secret",
        "api_session",
        "user_id",
        "session_key",
        "session_token_b64",
    )

    def __init__(self, data: dict):
        self.api_key, self.api_secret = _env_credentials()

        self.api_session = str(
            data.get("api_session")
            or data.get("apisession")
            or data.get("session_token")
            or ""
        ).strip()

        self.user_id = str(data.get("user_id") or "").strip()
        self.session_key = str(data.get("session_key") or "").strip()

        if self.user_id and self.session_key:
            self.session_token_b64 = base64.b64encode(
                f"{self.user_id}:{self.session_key}".encode("ascii")
            ).decode("ascii")
        elif self.api_session:
            # Legacy auth payload without user_id/session_key: Breeze also
            # accepts the raw login session token in X-SessionToken.
            self.session_token_b64 = base64.b64encode(
                self.api_session.encode("ascii")
            ).decode("ascii")
        else:
            raise RuntimeError(
                "ICICI authentication data does not contain api_session "
                "or user_id/session_key. Reconnect ICICI Direct."
            )


def get_credentials(auth_token) -> BreezeCredentials:
    return BreezeCredentials(decode_auth(auth_token))


# ---------------------------------------------------------------------------
# Checksum headers (exact scheme used by breeze_connect 1.0.69)
# ---------------------------------------------------------------------------

def _checksum_headers(creds: BreezeCredentials, body: str) -> dict:
    timestamp = datetime.utcnow().isoformat()[:19] + ".000Z"

    checksum = sha256(
        (timestamp + body + creds.api_secret).encode("utf-8")
    ).hexdigest()

    return {
        "Content-Type": "application/json",
        # Exact prefix used by breeze_connect 1.0.69 (space, not colon).
        "X-Checksum": "token " + checksum,
        "X-Timestamp": timestamp,
        "X-AppKey": creds.api_key,
        "X-SessionToken": creds.session_token_b64,
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_5_8) "
            "AppleWebKit/534.50.2 (KHTML, like Gecko) Version/5.0.6 Safari/533.22.3"
        ),
    }


# ---------------------------------------------------------------------------
# Response normalisation
# ---------------------------------------------------------------------------

# Breeze reports empty books as Status 500 with these messages instead of an
# empty Success list. They are normal states (a fresh account has no trades),
# so the plugin returns them as empty successes rather than errors.
_EMPTY_RESULT_MESSAGES = (
    "no data found",
    "no orders found",
    "no positions available",
    "no holdings available",
    "no trades available",
    "no gtts found",
    "no records found",
    "data not available",
)


def _is_empty_result(response: Any) -> bool:
    if not isinstance(response, dict):
        return False

    if response.get("Success") not in (None, "", [], {}):
        return False

    error = str(response.get("Error") or "").strip().lower()

    return any(message in error for message in _EMPTY_RESULT_MESSAGES)


def empty_success() -> dict:
    return {"Success": [], "Status": 200, "Error": None}


def response_status(response: Any, default: int = 500) -> int:
    if not isinstance(response, dict):
        return default

    status = response.get("Status", default)

    try:
        return int(status)
    except (TypeError, ValueError):
        return default


def response_error(response: Any) -> str:
    if not isinstance(response, dict):
        return str(response)

    return str(response.get("Error") or "").strip()


def _is_session_expired(response: Any) -> bool:
    error = response_error(response).lower()

    markers = (
        "invalid session",
        "session key is expired",
        "resource not available",
        "unauthorized",
    )

    return any(marker in error for marker in markers)


# ---------------------------------------------------------------------------
# Resilient REST request
# ---------------------------------------------------------------------------

_MAX_RETRIES = 3
_BASE_BACKOFF_SECONDS = 0.75
_REQUEST_TIMEOUT = (10, 30)


def _retry_delay(response: Any, attempt: int) -> float:
    """Retry-After when the server sends one, else exponential backoff."""

    headers = getattr(response, "headers", None) or {}

    for key in ("Retry-After", "retry-after"):
        value = headers.get(key)

        if value:
            try:
                return max(0.0, float(value))
            except (TypeError, ValueError):
                break

    return _BASE_BACKOFF_SECONDS * (2 ** (attempt - 1)) + random.uniform(0, 0.25)


def _rate_limited_status(status_code: int) -> bool:
    return status_code in (429, 502, 503, 504)


def breeze_request(
    auth_token,
    method: str,
    endpoint: str,
    params: dict | None = None,
    base_url: str | None = None,
    _allow_reauth: bool = True,
) -> dict:
    """
    Perform one checksum-signed Breeze REST call.

    - ``params`` entries that are None or "" are dropped entirely (Breeze
      throws server-side null-reference errors on empty strings).
    - Non-JSON / 429 / 5xx responses are retried with backoff.
    - Empty-result messages are normalised to an empty Success list.
    - On session expiry the cached SDK client is cleared and the call is
      retried once after a fresh generate_session().

    Returns the parsed JSON dict. Never raises for broker-level errors —
    callers inspect Status / Error.
    """

    creds = get_credentials(auth_token)

    clean_params = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value) != ""
    }

    body = json.dumps(clean_params, separators=(",", ":"))

    url = (base_url or API_URL) + endpoint

    method = method.upper()

    last_response: Any = None
    last_error = ""

    for attempt in range(1, _MAX_RETRIES + 1):
        _apply_rate_limit()

        headers = _checksum_headers(creds, body)

        try:
            response = requests.request(
                method,
                url,
                data=body if method in ("GET", "DELETE", "PUT", "POST") else None,
                headers=headers,
                timeout=_REQUEST_TIMEOUT,
            )

            status_code = response.status_code

            if _rate_limited_status(status_code):
                logger.warning(
                    "Breeze %s %s throttled (HTTP %s), attempt %d/%d",
                    method,
                    endpoint,
                    status_code,
                    attempt,
                    _MAX_RETRIES,
                )

                last_response = response
                last_error = f"HTTP {status_code}"

                if attempt < _MAX_RETRIES:
                    time.sleep(_retry_delay(response, attempt))
                    continue

                return {
                    "Success": None,
                    "Status": status_code,
                    "Error": f"ICICI Breeze returned HTTP {status_code}",
                }

            try:
                data = response.json()
            except ValueError:
                logger.warning(
                    "Breeze %s %s returned non-JSON response (HTTP %s), "
                    "attempt %d/%d",
                    method,
                    endpoint,
                    status_code,
                    attempt,
                    _MAX_RETRIES,
                )

                last_response = response
                last_error = f"non-JSON response (HTTP {status_code})"

                if attempt < _MAX_RETRIES:
                    time.sleep(_retry_delay(response, attempt))
                    continue

                return {
                    "Success": None,
                    "Status": 502,
                    "Error": (
                        "ICICI Breeze returned a non-JSON response "
                        f"(HTTP {status_code})"
                    ),
                }

            if _is_empty_result(data):
                return empty_success()

            if _is_session_expired(data) and _allow_reauth:
                logger.warning(
                    "Breeze session rejected for %s %s — regenerating "
                    "session once",
                    method,
                    endpoint,
                )

                clear_breeze_clients()

                try:
                    get_breeze_client(auth_token)
                except Exception as exc:
                    logger.error(
                        "Breeze session regeneration failed: %s", exc
                    )

                    return {
                        "Success": None,
                        "Status": 401,
                        "Error": (
                            "ICICI Direct session expired. "
                            "Please reconnect the broker."
                        ),
                    }

                return breeze_request(
                    auth_token,
                    method,
                    endpoint,
                    params,
                    base_url=base_url,
                    _allow_reauth=False,
                )

            return data

        except requests.exceptions.RequestException as exc:
            logger.warning(
                "Breeze %s %s network error: %s (attempt %d/%d)",
                method,
                endpoint,
                exc,
                attempt,
                _MAX_RETRIES,
            )

            last_error = str(exc)

            if attempt < _MAX_RETRIES:
                time.sleep(_retry_delay(None, attempt))
                continue

    return {
        "Success": None,
        "Status": 503,
        "Error": f"ICICI Breeze request failed: {last_error}",
    }


def breeze_request_v2(auth_token, endpoint: str, params: dict | None = None) -> dict:
    """
    Historical Data V2 call (query-string params, apikey + X-SessionToken
    headers, no checksum).
    """

    creds = get_credentials(auth_token)

    clean_params = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value) != ""
    }

    headers = {
        "Content-Type": "application/json",
        "X-SessionToken": creds.session_token_b64,
        "apikey": creds.api_key,
    }

    url = HIST_V2_URL + endpoint

    last_error = ""

    for attempt in range(1, _MAX_RETRIES + 1):
        _apply_rate_limit()

        try:
            response = requests.get(
                url,
                params=clean_params,
                headers=headers,
                timeout=_REQUEST_TIMEOUT,
            )

            status_code = response.status_code

            if _rate_limited_status(status_code):
                logger.warning(
                    "Breeze V2 %s throttled (HTTP %s), attempt %d/%d",
                    endpoint,
                    status_code,
                    attempt,
                    _MAX_RETRIES,
                )

                last_error = f"HTTP {status_code}"

                if attempt < _MAX_RETRIES:
                    time.sleep(_retry_delay(response, attempt))
                    continue

                return {
                    "Success": None,
                    "Status": status_code,
                    "Error": f"ICICI Breeze V2 returned HTTP {status_code}",
                }

            try:
                data = response.json()
            except ValueError:
                last_error = f"non-JSON response (HTTP {status_code})"

                logger.warning(
                    "Breeze V2 %s returned non-JSON response (HTTP %s), "
                    "attempt %d/%d",
                    endpoint,
                    status_code,
                    attempt,
                    _MAX_RETRIES,
                )

                if attempt < _MAX_RETRIES:
                    time.sleep(_retry_delay(response, attempt))
                    continue

                return {
                    "Success": None,
                    "Status": 502,
                    "Error": (
                        "ICICI Breeze V2 returned a non-JSON response "
                        f"(HTTP {status_code})"
                    ),
                }

            return data

        except requests.exceptions.RequestException as exc:
            logger.warning(
                "Breeze V2 %s network error: %s (attempt %d/%d)",
                endpoint,
                exc,
                attempt,
                _MAX_RETRIES,
            )

            last_error = str(exc)

            if attempt < _MAX_RETRIES:
                time.sleep(_retry_delay(None, attempt))
                continue

    return {
        "Success": None,
        "Status": 503,
        "Error": f"ICICI Breeze V2 request failed: {last_error}",
    }


# ---------------------------------------------------------------------------
# SDK client cache (streaming only)
# ---------------------------------------------------------------------------

_clients: dict[str, Any] = {}
_clients_lock = threading.RLock()


def _cache_key(data: dict) -> str:
    user_id = str(data.get("user_id") or "").strip()
    session_key = str(data.get("session_key") or "").strip()
    api_session = str(
        data.get("api_session") or data.get("apisession") or ""
    ).strip()

    if user_id and session_key:
        return f"{user_id}:{session_key}"

    if api_session:
        return f"api_session:{api_session}"

    raise RuntimeError(
        "ICICI authentication data does not contain "
        "api_session or session_key"
    )


def _create_sdk_client(data: dict) -> Any:
    """
    Build an authenticated official BreezeConnect instance.

    ``generate_session`` performs the customer-details session exchange,
    derives user_id/session_key and downloads the security master used for
    websocket token resolution.
    """

    # Imported lazily: breeze_connect downloads the security master at
    # import time, which must never happen on the Flask request path of
    # unrelated brokers.
    try:
        from breeze_connect import BreezeConnect
    except Exception as exc:
        raise RuntimeError(
            "breeze-connect package is not installed. "
            "Run: pip install breeze-connect==1.0.69"
        ) from exc

    api_key, api_secret = _env_credentials()

    api_session = str(
        data.get("api_session")
        or data.get("apisession")
        or data.get("session_token")
        or ""
    ).strip()

    if not api_session:
        raise RuntimeError(
            "ICICI api_session is missing from authentication data. "
            "Reconnect ICICI Direct."
        )

    logger.info("Creating ICICI Breeze streaming client")

    breeze = BreezeConnect(api_key=api_key)

    try:
        breeze.generate_session(
            api_secret=api_secret,
            session_token=api_session,
        )

    except Exception as exc:
        logger.error("ICICI Breeze session generation failed: %s", exc)

        raise RuntimeError(
            f"Unable to initialize ICICI Breeze session: {exc}"
        ) from exc

    if not getattr(breeze, "api_handler", None):
        raise RuntimeError("ICICI Breeze API handler was not initialized")

    if not getattr(breeze, "user_id", None):
        raise RuntimeError("ICICI Breeze user_id was not initialized")

    if not getattr(breeze, "session_key", None):
        raise RuntimeError("ICICI Breeze session_key was not initialized")

    logger.info(
        "ICICI Breeze streaming client ready (user_id_present=%s)",
        bool(breeze.user_id),
    )

    return breeze


def get_breeze_client(auth_token) -> Any:
    """
    Return a cached authenticated BreezeConnect client (streaming use).
    """

    data = decode_auth(auth_token)

    key = _cache_key(data)

    with _clients_lock:
        existing = _clients.get(key)

        if existing is not None:
            if getattr(existing, "api_handler", None) is not None:
                return existing

            _clients.pop(key, None)

        client = _create_sdk_client(data)

        _clients[key] = client

        return client


def clear_breeze_client(auth_token) -> None:
    """Drop one cached SDK client (logout / session refresh)."""

    try:
        key = _cache_key(decode_auth(auth_token))
    except Exception:
        return

    with _clients_lock:
        client = _clients.pop(key, None)

    if client is not None:
        try:
            client.ws_disconnect()
        except Exception:
            pass


def clear_breeze_clients() -> None:
    """Drop every cached SDK client."""

    with _clients_lock:
        clients = list(_clients.values())

        _clients.clear()

    for client in clients:
        try:
            client.ws_disconnect()
        except Exception:
            pass


def get_stream_credentials(auth_token) -> tuple[str, str]:
    """
    Return (user_id, session_key) for the Socket.IO auth payload.

    Prefers the values stored at login; falls back to a fresh SDK session.
    """

    data = decode_auth(auth_token)

    user_id = str(data.get("user_id") or "").strip()
    session_key = str(data.get("session_key") or "").strip()

    if user_id and session_key:
        return user_id, session_key

    breeze = get_breeze_client(auth_token)

    return str(breeze.user_id).strip(), str(breeze.session_key).strip()


# Compatibility aliases kept for older icici plugin revisions.
clear_client_cache = clear_breeze_clients
get_client = get_breeze_client
