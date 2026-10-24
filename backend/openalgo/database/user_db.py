# OpenAlgo-vendor shim (quantdesk Round-27) — replaces upstream user_db.py.
# Upstream demands argon2 + API_KEY_PEPPER and manages OpenAlgo's own user
# table; our app is single-admin. Vendored call sites only need
# find_user_by_username(username) to return something with a usable id.
from __future__ import annotations

from typing import Any, Optional

from utils.logging import get_logger

logger = get_logger(__name__)


class _User:
    def __init__(self, username: str):
        self.id = 1
        self.username = username or "127.0.0.1"
        self.email = ""
        self.name = self.username
        self.is_active = True


def find_user_by_username(username: str) -> Optional[_User]:
    return _User(username)


def find_user_by_email(email: str) -> Optional[_User]:
    return _User(email)


def get_user_by_id(_uid: Any) -> Optional[_User]:
    return _User("127.0.0.1")


# Legacy call sites import the model for type hints only
class User:  # noqa: D101
    pass
