"""Round-27 — OpenAlgo per-call broker context.

Every call into vendored openalgo code happens inside `oa_ctx(...)` on a
worker thread (asyncio.to_thread). The context:

  1. maps OUR account credentials → the plugin's env vars
     (BROKER_API_KEY, BROKER_API_SECRET, …)
  2. points DATABASE_URL at that broker's own masters file
     (db/openalgo-masters/<broker>.db) so per-broker master_contract modules
     each own their symtoken table — exactly upstream's single-broker
     assumption, one instance per broker
  3. pins the token_db shim's thread-local active broker so symbol lookups
     hit the right symtoken set

Env swaps are restored on exit; thread-local means concurrent accounts of
DIFFERENT brokers never see each other's env. Calls for the SAME broker are
serialized per broker key (plugins keep module-level state).
"""
from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from backend.openalgo import bootstrap

# Serialize all calls into one broker's plugin modules (module-level state:
# engines, rate limiters, websocket adapters).
_broker_locks: dict[str, threading.Lock] = {}
_broker_locks_guard = threading.Lock()


def broker_lock(key: str) -> threading.Lock:
    with _broker_locks_guard:
        if key not in _broker_locks:
            _broker_locks[key] = threading.Lock()
        return _broker_locks[key]


# our credential key → openalgo env var(s)
_CRED_ENV: list[tuple[str, tuple[str, ...]]] = [
    ("api_key", ("BROKER_API_KEY",)),
    ("app_id", ("BROKER_API_KEY",)),
    ("api_secret", ("BROKER_API_SECRET",)),
    ("app_secret", ("BROKER_API_SECRET",)),
    ("market_api_key", ("BROKER_API_KEY_MARKET",)),
    ("market_api_secret", ("BROKER_API_SECRET_MARKET",)),
    ("client_id", ("BROKER_CLIENT_ID",)),
    ("user_id", ("BROKER_CLIENT_ID",)),
    ("vendor_code", ("BROKER_VENDOR_CODE",)),
    ("mac_address", ("BROKER_MAC_ADDRESS",)),
    ("imei", ("BROKER_MAC_ADDRESS",)),
    ("client_ip", ("BROKER_CLIENT_PUBLIC_IP",)),
    ("redirect_url", ("REDIRECT_URL", "REDIRECT_URI")),
]

_MERGED_CANDIDATES = ("api_key", "app_id", "broker_api_key")


def creds_to_env(credentials: dict) -> dict[str, str]:
    """Build the plugin env-var dict from a normalized credentials dict.
    Shoonya-style plugins accept 'client_id:::api_key' inside BROKER_API_KEY —
    we append that composite when both keys exist."""
    env: dict[str, str] = {}
    for cred_key, env_names in _CRED_ENV:
        val = credentials.get(cred_key)
        if val in (None, "", "••••"):
            continue
        for name in env_names:
            env.setdefault(name, str(val))
    # composite api key (shoonya/dhan plugins split on ':::')
    client = credentials.get("client_id") or credentials.get("user_id")
    for cand in _MERGED_CANDIDATES:
        v = credentials.get(cand)
        if v and client and ":::" not in str(v):
            env.setdefault("BROKER_API_KEY_COMPOSITE", f"{client}:::{v}")
    return env


def composite_api_key(credentials: dict) -> Optional[str]:
    client = credentials.get("client_id") or credentials.get("user_id")
    for cand in _MERGED_CANDIDATES:
        v = credentials.get(cand)
        if v and client:
            return f"{client}:::{v}"
    return None


def masters_url(broker: str) -> str:
    path = os.path.abspath(os.path.join("db", "openalgo-masters", f"{broker}.db"))
    return f"sqlite:///{path}"


def masters_file(broker: str) -> str:
    return os.path.abspath(os.path.join("db", "openalgo-masters", f"{broker}.db"))


@contextmanager
def oa_ctx(broker: str, credentials: Optional[dict] = None,
           env_extra: Optional[dict[str, str]] = None,
           account_id: Optional[int] = None) -> Iterator[None]:
    """Enter the vendored world for ONE broker. Use around every plugin call."""
    bootstrap()
    env = creds_to_env(credentials or {})
    env.update(env_extra or {})
    env["DATABASE_URL"] = masters_url(broker)
    composite = composite_api_key(credentials or {})
    if composite and broker in ("shoonya", "dhan", "firstock", "fivepaisa"):
        env.setdefault("BROKER_API_KEY", composite)
    # fivepaisa's plugins split the key into api_key:::user_id:::client_id at
    # import time — provide the full composite or the import crashes
    if broker == "fivepaisa":
        creds = credentials or {}
        ak = creds.get("api_key") or ""
        uid = creds.get("user_id") or creds.get("client_id") or ""
        cid = creds.get("client_id") or uid
        if ak:
            env["BROKER_API_KEY"] = f"{ak}:::{uid}:::{cid}"

    # Some plugins split/parse BROKER_API_KEY at IMPORT time (fivepaisa unpacks
    # THREE ':::'-separated parts). Real calls still need real tokens — the
    # placeholder only lets the import succeed and the API fail cleanly with an
    # auth error instead of an import crash.
    env.setdefault("BROKER_API_KEY", "quantdesk:::import:::placeholder")
    env.setdefault("BROKER_API_SECRET", "quantdesk-import-placeholder")

    old: dict[str, Optional[str]] = {}
    try:
        for k, v in env.items():
            old[k] = os.environ.get(k)
            os.environ[k] = v
        import database.token_db as token_db  # vendored shim (OA path)

        token_db.set_active_broker(broker)
        try:  # auth_db shim: unresolved user names resolve to THIS account
            import database.auth_db as _auth_db

            _auth_db._set_active_account(account_id)
        except Exception:
            pass
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        try:
            import database.token_db as token_db  # vendored shim

            token_db.set_active_broker(None)
            import database.auth_db as _auth_db

            _auth_db._set_active_account(None)
        except Exception:
            pass


def totp_now(secret: str) -> Optional[str]:
    """6-digit TOTP from a base32 secret (plugins' REST layer did this)."""
    if not secret:
        return None
    try:
        import base64
        import hmac
        import hashlib
        import struct
        import time

        key = secret.strip().replace(" ", "").upper()
        pad = "=" * ((8 - len(key) % 8) % 8)
        raw = base64.b32decode(key + pad)
        counter = int(time.time()) // 30
        msg = struct.pack(">Q", counter)
        digest = hmac.new(raw, msg, hashlib.sha1).digest()
        o = digest[19] & 0x0F
        code = (struct.unpack(">I", digest[o:o + 4])[0] & 0x7FFFFFFF) % 1000000
        return f"{code:06d}"
    except Exception:
        return None


def call_authenticate(broker: str, credentials: dict, code: str = "",
                      account_id: Any = None) -> dict:
    """Run the plugin's authenticate_broker(...) inside the right context.

    Returns {ok, token, message} — token is persisted by the caller via our
    session store (the vendored auth_db shim routes upsert_auth there too).
    """
    import importlib
    import inspect
    import json as _json

    bootstrap()
    with broker_lock(broker):
        mod = importlib.import_module(f"broker.{broker}.api.auth_api")
        fn = getattr(mod, "authenticate_broker")
        params = list(inspect.signature(fn).parameters)
        args: dict[str, Any] = {}
        creds = dict(credentials or {})
        for p in params:
            pl = p.lower()
            if pl in ("request_token", "code", "token") and code:
                args[p] = code
            elif pl == "clientcode":
                args[p] = creds.get("client_id") or creds.get("user_id") or ""
            elif pl == "broker_pin":
                args[p] = creds.get("pin") or creds.get("password") or ""
            elif pl == "password":
                args[p] = creds.get("password") or ""
            elif pl in ("totp_code", "totp"):
                args[p] = code if code and len(code) == 6 and code.isdigit() \
                    else (totp_now(creds.get("totp_secret") or "") or "")
        with oa_ctx(broker, creds):
            result = fn(**args)
        # normalize: plugins return (success, value, resp) tuples / (ok, value)
        ok, token, message = False, "", ""
        if isinstance(result, tuple):
            head = result[0] if result else None
            ok = head is True or head == 1 or (isinstance(head, str) and head.lower() in ("true", "success"))
            for item in result[1:]:
                if isinstance(item, str) and len(item) > 8 and not item.startswith("{"):
                    token = item
                    break
                if isinstance(item, dict):
                    token = (item.get("auth_token") or item.get("token")
                             or item.get("access_token") or item.get("susertoken")
                             or item.get("session_token") or "")
                    if not message:
                        message = _json.dumps(item)[:220]
                    if token:
                        break
            if not token and isinstance(head, str) and len(head) > 8:
                token = head
            if not message and len(result) > 2 and isinstance(result[-1], (dict, str)):
                message = _json.dumps(result[-1])[:220] if isinstance(result[-1], dict) else str(result[-1])[:220]
        elif isinstance(result, dict):
            ok = bool(result.get("success") or result.get("status") in (True, "success"))
            token = (result.get("auth_token") or result.get("token")
                     or result.get("access_token") or result.get("susertoken") or "")
            message = _json.dumps(result)[:220]
        elif isinstance(result, str):
            ok, token = len(result) > 8, result
        return {"ok": bool(ok), "token": token, "message": message or ("authenticated" if ok else "authentication failed")}
