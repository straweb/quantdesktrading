# OpenAlgo-vendor shim (quantdesk Round-27) — replaces upstream database/auth_db.py.
#
# Upstream stores broker session tokens in its own SQLAlchemy DB with fernet
# encryption. Our stack already has a session store (backend/session_store.py,
# SQLite-backed, per-account). Vendored broker/streaming code only needs these
# symbols: get_auth_token / get_feed_token / upsert_auth / verify_api_key /
# get_user_id / Auth / db_session / encrypt_token / decrypt_token /
# init_db + a handful of session-bookkeeping no-ops.
#
# Name convention: user_id strings look like "oa<account_id>" (or bare digits);
# they resolve against our accounts table. A plain non-numeric name returns None
# (no cross-account leakage).
from __future__ import annotations

import json
import threading
from typing import Any, Optional

from utils.logging import get_logger

logger = get_logger(__name__)


class Auth:  # upstream SQLAlchemy model — kept importable, unused
    pass


class ApiKeys:
    pass


class ActiveSession:
    pass


class LoginAttempt:
    pass


class AuthRecord:
    def __init__(self, name: str = "", auth_token: str = "", broker: str = "", feed_token: str = ""):
        self.name = name
        self.auth_token = auth_token
        self.broker = broker
        self.feed_token = feed_token


try:  # upstream exposes a scoped session for legacy call sites
    from sqlalchemy.orm import scoped_session, sessionmaker  # type: ignore

    db_session = scoped_session(sessionmaker())
except Exception:  # pragma: no cover
    db_session = None


def _account_id(name: Any) -> Optional[int]:
    s = str(name or "")
    if s.startswith("oa"):
        s = s[2:]
    if s.isdigit():
        return int(s)
    return None


_acct_local = threading.local()


def _set_active_account(aid: Optional[int]) -> None:
    """oa_ctx pins the CURRENT account so plugin calls like
    get_auth_token('127.0.0.1') resolve to the right session."""
    _acct_local.aid = aid


def _session_row(aid: Optional[int], name: Any = None) -> dict:
    if aid is None:
        aid = getattr(_acct_local, "aid", None)
    if aid is None:
        return {}
    try:
        from backend import session_store

        return session_store.get(aid) or {}
    except Exception as e:  # pragma: no cover
        logger.warning(f"auth_db shim: session store unavailable: {e}")
        return {}


def get_auth_token(name, bypass_cache: bool = False) -> Optional[str]:
    row = _session_row(_account_id(name), name)
    return row.get("token") or None


def get_auth_token_fresh(name) -> Optional[str]:
    return get_auth_token(name)


def get_auth_token_dbquery(name) -> Optional[str]:
    return get_auth_token(name)


def get_feed_token(name) -> Optional[str]:
    row = _session_row(_account_id(name), name)
    return row.get("feed_token") or row.get("token") or None


def get_feed_token_dbquery(name) -> Optional[str]:
    return get_feed_token(name)


def upsert_auth(name, auth_token, broker, feed_token=None, user_id=None, revoke=False):
    """Persist a token produced by an OpenAlgo authenticate_broker() flow into
    OUR session store so restarts reconnect without a re-login."""
    aid = _account_id(user_id or name)
    if aid is None:
        logger.info(f"auth_db shim: upsert skipped (no account id in '{name}')")
        return False
    try:
        from backend import session_store

        row = session_store.get(aid) or {}
        meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
        meta.update({"broker": broker, "source": "openalgo"})
        if feed_token:
            meta["feed_token"] = feed_token
        session_store.save(aid, broker, None if revoke else auth_token, meta)
        return True
    except Exception as e:  # pragma: no cover
        logger.warning(f"auth_db shim: upsert failed: {e}")
        return False


def verify_api_key(*_a, **_k) -> bool:
    return True


def get_broker_name(api_key=None, *_a, **_k) -> str:
    """websocket_proxy/latency_monitor resolve a broker label from an api key —
    report the active OA plugin when one is pinned."""
    try:
        from database.token_db import get_active_broker

        return get_active_broker() or "openalgo"
    except Exception:
        return "openalgo"


def get_user_id(*_a, **_k) -> str:
    return "127.0.0.1"


def encrypt_token(token):
    return token


def decrypt_token(value):
    return value


def safe_decrypt_token(value):
    return value


def init_db() -> None:
    return None


def log_login_attempt(*_a, **_k):
    return None


def get_login_attempts(*_a, **_k):
    return []


def clear_login_attempts(*_a, **_k):
    return None


def register_session(*_a, **_k):
    return None


def remove_session(*_a, **_k):
    return None


def get_active_sessions(*_a, **_k):
    return []


def update_session_last_seen(*_a, **_k):
    return None


def clear_user_sessions(*_a, **_k):
    return None


def _json_default(_o):  # pragma: no cover
    return str(_o)


def as_json(value: Any) -> str:  # tiny helper some flows use
    return json.dumps(value, default=_json_default)
