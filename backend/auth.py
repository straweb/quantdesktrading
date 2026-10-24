"""
Auth: user login + HMAC token. Kept dependency-free (hashlib.scrypt + hmac).
"""
from __future__ import annotations

from typing import Optional
import hashlib
import hmac
import json
import os
import time

from backend import config, db


def _hash(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"{salt.hex()}${dk.hex()}"


def verify(password: str, stored: str) -> bool:
    try:
        salt_hex, _ = stored.split("$", 1)
        return hmac.compare_digest(_hash(password, bytes.fromhex(salt_hex)), stored)
    except Exception:
        return False


def ensure_default_admin() -> None:
    c = db.core()
    if not c.one("SELECT id FROM users WHERE username=?", (config.ADMIN_USERNAME,)):
        c.exec(
            "INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)",
            (config.ADMIN_USERNAME, _hash(config.ADMIN_PASSWORD), "admin", time.time()),
        )
        config.log("auth", f"default admin created (username={config.ADMIN_USERNAME})")


def login(username: str, password: str) -> Optional[dict]:
    c = db.core()
    row = c.one("SELECT * FROM users WHERE username=?", (username,))
    if not row or not verify(password, row["password_hash"]):
        return None
    token = _sign({"uid": row["id"], "u": username, "r": row["role"], "t": time.time()})
    return {"token": token, "username": username, "role": row["role"], "uid": row["id"]}


# ------------------------------------------------------------------- tokens
def _sign(payload: dict) -> str:
    import base64
    body = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = hmac.new(config.APP_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{body}.{sig}"


def check_token(token: str) -> Optional[dict]:
    """Return payload if token valid (structure + signature)."""
    import base64
    try:
        body, sig = token.rsplit(".", 1)
        calc = hmac.new(config.APP_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, calc):
            return None
        pad = "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(body + pad))
        return payload
    except Exception:
        return None
