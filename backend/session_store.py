"""
Session store — DB-backed persistence of broker API sessions/tokens.

Round-14 #1 requirement:  "created session should store into db or persistent
at backend so on page refresh it should not needed to re connect again with
api session or token."

Design:
  - authenticate() on a broker account checks broker_sessions FIRST.
  - If a stored session exists and validates, it is REUSED (no re-login).
  - Only when absent/invalid do we generate a fresh session, and the fresh
    session is immediately persisted. This also fixes the ICICI 401 storm:
    Breeze invalidates older sessions when new ones are generated, so
    regenerating per connect/refresh was the root cause.
  - Sessions survive backend restarts (loaded lazily from SQLite).
"""
from __future__ import annotations

from typing import Optional
import json
import time

from backend import config, db


def get(account_id: int) -> Optional[dict]:
    return db.core().one("SELECT * FROM broker_sessions WHERE account_id=?", (account_id,))


def save(account_id: int, broker: str, session_token: Optional[str],
         refresh_token: Optional[str] = None, meta: Optional[dict] = None) -> None:
    c = db.core()
    c.exec(
        """INSERT INTO broker_sessions(account_id,broker,session_token,refresh_token,session_meta,created_at,updated_at,last_validated_at)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(account_id) DO UPDATE SET
             broker=excluded.broker, session_token=excluded.session_token,
             refresh_token=excluded.refresh_token, session_meta=excluded.session_meta,
             updated_at=excluded.updated_at, last_validated_at=excluded.last_validated_at""",
        (account_id, broker, session_token, refresh_token,
         json.dumps(meta or {}), time.time(), time.time(), time.time()),
    )
    masked = (session_token[:6] + "...") if session_token else "-"
    config.log("session", f"persisted session for account#{account_id} broker={broker} token={masked}")


def mark_validated(account_id: int) -> None:
    c = db.core()
    c.exec("UPDATE broker_sessions SET last_validated_at=? WHERE account_id=?", (time.time(), account_id))


def clear(account_id: int) -> None:
    db.core().exec("DELETE FROM broker_sessions WHERE account_id=?", (account_id,))


def meta_of(row: Optional[dict]) -> dict:
    if not row:
        return {}
    try:
        return json.loads(row.get("session_meta") or "{}")
    except Exception:
        return {}
