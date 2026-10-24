# OpenAlgo vendor bootstrap (quantdesk Round-27).
#
# `backend/openalgo/` vendors the straweb/hedging (openalgo) broker tree:
#   broker/           37 broker plugins (auth, orders, funds, quotes, history,
#                     master contracts, streaming adapters)
#   database/         shared token/auth DB layer (shimmed to our stack)
#   utils/            shared utilities (httpx client, logging, backpressure…)
#   websocket_proxy/  BaseBrokerWebSocketAdapter + SymbolMapper (ZMQ patched
#                     out — see base_adapter.py `_sink` hook)
#
# Upstream modules use TOP-LEVEL absolute imports (`from broker.dhan.api…`,
# `from database.token_db…`), so the OA_DIR must be on sys.path BEFORE any
# broker module import. Call bootstrap() exactly once.
from __future__ import annotations

import os
import sys
import threading

OA_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(OA_DIR)  # backend/
REPO_ROOT = os.path.dirname(PROJECT_ROOT)

_BOOT_LOCK = threading.Lock()
_BOOTED = False
_ERRORS: list[str] = []


def bootstrap() -> None:
    """Put the vendored tree on sys.path and prepare env. Idempotent."""
    global _BOOTED
    with _BOOT_LOCK:
        if _BOOTED:
            return
        if OA_DIR not in sys.path:
            sys.path.insert(0, OA_DIR)
        os.environ.setdefault("OPENALGO_NO_ZMQ", "1")
        os.environ.setdefault("LOG_DIR", os.path.join("logs", "openalgo"))
        try:
            os.makedirs(os.environ["LOG_DIR"], exist_ok=True)
        except Exception:
            pass
        os.makedirs(os.path.join("db", "openalgo-masters"), exist_ok=True)
        # plugins write scratch CSVs under tmp/ (upstream ships that dir)
        os.makedirs("tmp", exist_ok=True)
        _BOOTED = True


def probe_import(broker: str) -> tuple[bool, str]:
    """Import broker.<name>.api.auth_api to verify the vendor tree is usable.
    Returns (ok, error) without raising."""
    try:
        bootstrap()
        import importlib

        importlib.import_module(f"broker.{broker}.api.auth_api")
        return True, ""
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
