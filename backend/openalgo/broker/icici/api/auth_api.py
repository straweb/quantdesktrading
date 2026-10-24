"""
ICICI Direct Breeze authentication for OpenAlgo.

Login flow:

    1. Browser opens ICICI's login page with the app key.
    2. ICICI redirects back with ``?apisession=<session token>``.
    3. ``authenticate_broker`` exchanges that session token at the
       customerdetails endpoint, which returns a Base64 encoded
       ``user_id:session_key`` pair.

The stored auth value keeps the original ``api_session`` because the official
SDK's ``generate_session()`` (used for streaming) requires it.
"""

import base64
import json
import os
from urllib.parse import quote_plus

import requests

from broker.icici.api.baseurl import CUSTOMER_DETAILS_URL, LOGIN_URL
from utils.logging import get_logger


logger = get_logger(__name__)


def get_login_url():
    api_key = os.getenv("BROKER_API_KEY", "").strip()

    if not api_key:
        raise RuntimeError("BROKER_API_KEY is not configured")

    return f"{LOGIN_URL}?api_key={quote_plus(api_key)}"


def authenticate_broker(api_session):
    """
    Authenticate an ICICI Direct Breeze login session.

    Returns (auth_token, error_message).
    """

    try:
        if not api_session:
            return None, "ICICI Direct API session is missing."

        api_session = str(api_session).strip()

        api_key = os.getenv("BROKER_API_KEY", "").strip()

        if not api_key:
            return None, "BROKER_API_KEY is not configured."

        body = json.dumps(
            {
                "SessionToken": api_session,
                "AppKey": api_key,
            },
            separators=(",", ":"),
        )

        response = requests.get(
            CUSTOMER_DETAILS_URL,
            data=body,
            headers={"Content-Type": "application/json"},
            timeout=20,
        )

        response.raise_for_status()

        data = response.json()

        success = data.get("Success")

        if not success:
            error = (
                data.get("Error")
                or "Invalid ICICI Direct session."
            )

            logger.error("ICICI customer-details failed: %s", error)

            return None, str(error)

        encoded = success.get("session_token")

        if not encoded:
            return None, "ICICI Direct did not return session_token."

        decoded = base64.b64decode(encoded.encode("ascii")).decode("ascii")

        if ":" not in decoded:
            return None, "Invalid ICICI session_token format."

        user_id, session_key = decoded.split(":", 1)

        user_id = user_id.strip()
        session_key = session_key.strip()

        if not user_id or not session_key:
            return None, "ICICI returned empty user/session credentials."

        auth_token = json.dumps(
            {
                # Retained because Breeze's generate_session() needs the
                # original login apisession for streaming.
                "api_session": api_session,
                "user_id": user_id,
                "session_key": session_key,
            },
            separators=(",", ":"),
        )

        logger.info("ICICI Direct Breeze authentication successful")

        return auth_token, None

    except requests.HTTPError as exc:
        logger.error("ICICI authentication HTTP error: %s", exc)

        return None, "ICICI Direct authentication failed."

    except Exception as exc:
        logger.exception("ICICI authentication exception")

        return None, str(exc)


def decode_auth_token(auth_token):
    if not auth_token:
        raise RuntimeError("ICICI auth token is empty.")

    try:
        data = json.loads(auth_token)

        if isinstance(data, dict):
            return data

    except (TypeError, ValueError):
        pass

    return {"api_session": str(auth_token).strip()}


def get_session_key(auth_token):
    return decode_auth_token(auth_token).get("session_key", "")


def get_user_id(auth_token):
    return decode_auth_token(auth_token).get("user_id", "")


def get_api_session(auth_token):
    return decode_auth_token(auth_token).get("api_session", "")
