"""Shared FastAPI dependencies (auth helper for every router)."""
from __future__ import annotations

from fastapi import Header, HTTPException

from backend import auth as auth_mod


def uid(authorization: str = Header(default="")) -> dict:
    token = (authorization or "").replace("Bearer ", "").strip()
    payload = auth_mod.check_token(token)
    if not payload:
        raise HTTPException(401, "Invalid or missing token")
    return payload
