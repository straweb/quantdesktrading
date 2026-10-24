"""Round-27 — OpenAlgo broker catalog.

Builds the per-broker credential-field spec by AST-scanning each vendored
plugin's api/auth_api.py (env vars read via os.getenv + the parameters of
authenticate_broker(...)), plus a static LOGIN_URLS map for the well-known
OAuth-style brokers. The result drives the Admin Session dialog for every
OpenAlgo broker without hand-writing 37 forms.
"""
from __future__ import annotations

import ast
import importlib
import inspect
import os
import re
import threading
from typing import Any

from backend.openalgo import bootstrap

_LABELS: dict[str, str] = {
    "aliceblue": "AliceBlue", "angel": "Angel One", "arrow": "Arrow (Odin)",
    "compositedge": "Compositedge (XTS)", "definedge": "DefinedGe",
    "deltaexchange": "Delta Exchange", "dhan": "Dhan (OpenAlgo)",
    "firstock": "Firstock", "fivepaisa": "5Paisa",
    "fivepaisaxts": "5Paisa XT (XTS)", "flattrade": "Flattrade",
    "fyers": "Fyers", "groww": "Groww", "hdfcsecurities": "HDFC Securities",
    "hdfcsky": "HDFC Sky", "ibulls": "iBulls (XTS)", "icici": "ICICI Direct (Breeze)",
    "iifl": "IIFL (XTS)", "iiflcapital": "IIFL Capital", "indmoney": "INDmoney",
    "jainamxts": "Jainam (XTS)", "kotak": "Kotak Neo", "motilal": "Motilal Oswal",
    "mstock": "mStock", "nubra": "Nubra", "paytm": "Paytm Money",
    "pocketful": "Pocketful", "rmoney": "RMoney (XTS)", "rupeezy": "Rupeezy",
    "samco": "Samco", "shoonya": "Shoonya (OpenAlgo)", "tradejini": "Tradejini",
    "tradesmart": "TradeSmart", "upstox": "Upstox", "wisdom": "Wisdom Capital (XTS)",
    "zebu": "Zebu", "zerodha": "Zerodha (Kite)",
}

# Static login-URL templates for the well-known OAuth-style brokers.
# {api_key}/{redirect_url} are interpolated from saved credentials.
LOGIN_URLS: dict[str, str] = {
    "zerodha": "https://kite.zerodha.com/connect/login?v=3&api_key={api_key}",
    "fyers": "https://api-t1.fyers.in/api/v3/generate-authcode?client_id={api_key}&redirect_uri={redirect_url}&response_type=code&state=None",
    "upstox": "https://login.upstox.com/service/login?client_id={api_key}&redirect_uri={redirect_url}&response_type=code",
    "aliceblue": "https://ant.aliceblueapi.com/?api_key={api_key}",
    "flattrade": "https://auth.flattrade.in/?app_key={api_key}",
    "mstock": "https://login.mstock.com/accounts/login?api_key={api_key}",
    "paytm": "https://login.paytmmoney.com/?apiKey={api_key}",
    "kotak": "https://napi.kotaksecurities.com/login/1.0/login/redirectlogin?ssoToken=",
    "groww": "https://groww.in",
}

# env var → our credential key (display field spec)
_ENV_FIELDS: list[tuple[str, str, str]] = [
    # (env name, our key, label)
    ("BROKER_API_KEY", "api_key", "API Key"),
    ("BROKER_API_SECRET", "api_secret", "API Secret"),
    ("BROKER_API_KEY_MARKET", "market_api_key", "Market Data API Key"),
    ("BROKER_API_SECRET_MARKET", "market_api_secret", "Market Data API Secret"),
    ("BROKER_CLIENT_ID", "client_id", "Client ID"),
    ("BROKER_VENDOR_CODE", "vendor_code", "Vendor Code"),
    ("BROKER_MAC_ADDRESS", "mac_address", "MAC / IMEI"),
    ("BROKER_CLIENT_PUBLIC_IP", "client_ip", "Client Public IP"),
    ("REDIRECT_URL", "redirect_url", "Redirect URL"),
    ("REDIRECT_URI", "redirect_url", "Redirect URI"),
]

# authenticate_broker() param → our credential key
_PARAM_FIELDS: dict[str, tuple[str, str]] = {
    "request_token": ("code", "Request Token (paste after login)"),
    "code": ("code", "Auth Code / Session Token (paste)"),
    "token": ("code", "Auth Token (paste)"),
    "clientcode": ("client_id", "Client ID"),
    "broker_pin": ("pin", "Login PIN"),
    "password": ("password", "Password"),
    "totp_code": ("totp_code", "TOTP (blank = auto from TOTP secret)"),
}

_SECRET_KEYS = {"api_secret", "market_api_secret", "pin", "password", "totp_code", "totp_secret"}

_cache: dict[str, dict] = {}
_lock = threading.Lock()


def _scan_auth_api(broker: str) -> dict[str, Any]:
    """AST-parse broker/<x>/api/auth_api.py → env names + authenticate_broker params."""
    out: dict[str, Any] = {"envs": [], "params": []}
    try:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "..", "openalgo", "broker", broker, "api", "auth_api.py")
        with open(path, "r", encoding="utf-8") as f:
            tree = ast.parse(f.read())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and node.func.attr in ("getenv", "get") and node.args:
                a0 = node.args[0]
                if isinstance(a0, ast.Constant) and isinstance(a0.value, str) \
                        and re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", a0.value):
                    out["envs"].append(a0.value)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                    and node.name == "authenticate_broker":
                out["params"] = [a.arg for a in node.args.args if a.arg not in ("self",)]
    except Exception:
        pass
    return out


def broker_spec(broker: str) -> dict:
    """Public spec for one broker: label + ordered credential fields."""
    with _lock:
        if broker in _cache:
            return _cache[broker]
    scan = _scan_auth_api(broker)
    fields: list[dict] = []
    seen: set[str] = set()

    def add(key: str, label: str, secret: bool = False, hint: str = "") -> None:
        if key in seen:
            return
        seen.add(key)
        fields.append({"key": key, "label": label, "secret": secret, "hint": hint})

    for env, key, label in _ENV_FIELDS:
        if env in scan["envs"]:
            add(key, label, secret=key in _SECRET_KEYS)
    for p in scan["params"]:
        if p in _PARAM_FIELDS:
            key, label = _PARAM_FIELDS[p]
            add(key, label, secret=key in _SECRET_KEYS,
                hint="totp_code" in key and "auto-generated when a TOTP secret is saved" or "")
    # TOTP secret is never read via env by the plugins (their REST layer builds
    # it) — always offer it when a TOTP-shaped param exists
    if any(f["key"] == "totp_code" for f in fields):
        add("totp_secret", "TOTP Secret (auto-TOTP)", secret=True)
    if not fields:
        add("api_key", "API Key")
        add("api_secret", "API Secret", secret=True)
    spec = {
        "broker": broker,
        "label": _LABELS.get(broker, broker.replace("_", " ").title()),
        "fields": fields,
        "login_url_template": LOGIN_URLS.get(broker),
        "auth_params": scan["params"],
    }
    with _lock:
        _cache[broker] = spec
    return spec


def loadable(broker: str) -> bool:
    try:
        bootstrap()
        importlib.import_module(f"broker.{broker}.api.auth_api")
        return True
    except Exception:
        return False


def catalog() -> list[dict]:
    """Specs for every vendored broker (import order best-effort)."""
    out = []
    base = os.path.join(OA_BROKER_DIR())
    for name in sorted(os.listdir(base)):
        if not os.path.isdir(os.path.join(base, name)) or name.startswith("_"):
            continue
        try:
            out.append(broker_spec(name))
        except Exception:
            continue
    return out


def OA_BROKER_DIR() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        "..", "..", "openalgo", "broker"))
