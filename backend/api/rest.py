"""
FastAPI REST plane (port 8000, /pyapi/*) — TOOL INTERACTIONS ONLY.

Everything streaming (ticks/candles/funds/orders/positions) flows over the
socket.io WS on 8001. REST is reserved for: login, account CRUD + connect,
place/cancel orders, master sync, settings, diagnostics, workspace archive.
The extended admin/tool surface lives in backend/admin_api.py (same router).
"""
from __future__ import annotations

from typing import Optional
import json
import os
import time
import zipfile

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict

from backend import auth as auth_mod
from backend import config, db, session_store
from backend.admin_api import router as admin_router
from backend.api.deps import uid
from backend.brokers.registry import REGISTRY, broker_names
from backend.market.hub import Hub
from backend.market.funds import SVC as FUNDS

app = FastAPI(title="Trading Terminal Backend", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(admin_router)


def _uid(authorization: str = "") -> dict:
    return uid(authorization)


# ================================================================== health
@app.get("/pyapi/health")
async def health():
    hub = Hub.instance()
    return {"ok": True, "v": 24, "rest_port": config.REST_PORT, "ws_port": config.WS_PORT,
            "mode": hub.trading_mode(), "accounts_connected": len(hub.adapters),
            "brokers": broker_names()}


@app.get("/pyapi/debug/state")
async def debug_state():
    hub = Hub.instance()
    sim_stream = hub.streams.get(hub.sim_account_id) if hub.sim_account_id else None
    return {"hub_id": f"{id(hub):x}", "sim_account_id": hub.sim_account_id,
            "feed_source": hub.feed_source(), "sim_disabled": hub.sim_disabled(),
            "ticks_cached": len(hub.ticks),
            "symbol_source": dict(list(hub.symbol_source.items())[:10]),
            "symbol_refs": {k: len(v) for k, v in hub.symbol_refs.items()},
            "sockets": {k: {"symbols": sorted(v.get("symbols", set())), "candle": v.get("candle")}
                        for k, v in hub.sockets.items()},
            "sample_tick": next(iter(hub.ticks.values()), None)}


# ================================================================== auth
class LoginReq(BaseModel):
    username: str
    password: str


@app.post("/pyapi/auth/login")
async def login(req: LoginReq):
    result = auth_mod.login(req.username, req.password)
    if not result:
        raise HTTPException(401, "Invalid username or password")
    return result


@app.get("/pyapi/auth/me")
async def me(authorization: str = Header(default="")):
    return _uid(authorization)


@app.post("/pyapi/auth/logout")
async def logout(authorization: str = Header(default="")):
    _uid(authorization)   # stateless tokens — client drops it
    return {"ok": True}


# ================================================================== settings / mode
@app.get("/pyapi/settings")
async def get_settings(authorization: str = Header(default="")):
    _uid(authorization)
    hub = Hub.instance()
    return {"mode": hub.trading_mode(), "simDisabled": hub.sim_disabled(),
            "feedSource": hub.feed_source()}


@app.post("/pyapi/settings/mode")
async def set_mode(body: dict, authorization: str = Header(default="")):
    _uid(authorization)
    mode = (body or {}).get("mode")
    if mode not in ("live", "sandbox", "simulation"):
        raise HTTPException(400, "mode must be 'live' | 'sandbox' | 'simulation'")
    hub = Hub.instance()
    # single source of truth: hub.set_trading_mode (mirrors sim_disabled for
    # legacy consumers) — LIVE hard-stops the sim engine + detaches sandboxes
    hub.set_trading_mode(mode)
    await hub.enforce_mode()
    if hub.sio:
        await hub.sio.emit("mode", {"mode": mode})
    config.log("rest", f"trading mode -> {mode.upper()}")
    return {"mode": mode}


# ================================================================== accounts
# The create/update contract accepts BOTH shapes so no client can 422:
#   canonical : broker / mode(live|sandbox) / credentials / initial_capital /
#               capital_mode / capital_pct
#   UI aliases: brokerType("SIMFEED"|"DHAN"|"SHOONYA"|"ICICI_BREEZE") /
#               clientId / initialCapital / capitalMode / capitalPct /
#               capitalBase("AVAILABLE_CASH_PCT") — the quantdesk-port field
#               names (the old strict model expected only `broker`, so the
#               Add-Broker dialog died with 422 "body.broker: Field required").
_BROKER_ALIASES = {
    "sim": "sim", "simfeed": "sim", "sim_feed": "sim",
    "breeze": "breeze", "icici": "breeze", "icici_breeze": "breeze", "icicibreeze": "breeze",
    "dhan": "dhan",
    "shoonya": "shoonya", "finvasia": "shoonya", "noren": "shoonya",
}
_CAPITAL_MODES = {"PROFIT_ONLY", "INITIAL_PLUS_PNL", "INITIAL_WITH_LOSS_REDUCTION", "LIVE_BALANCE"}

# ---------------------------------------------------------------- credential key aliases
# The Add-Broker UI historically stored camelCase keys (apiKey/apiSecret/appId/
# userId/clientId…) while every broker auth flow reads snake_case (api_key/
# api_secret/…) — credentials were saved but INVISIBLE to the auth code (the
# "Save the App Key + App Secret" guard and the {api_key} login-URL placeholder).
# Normalize at EVERY write boundary; read paths additionally tolerate both
# spellings for rows created before this fix.
_CRED_KEY_ALIASES = {
    "apiKey": "api_key", "AppKey": "api_key", "appId": "api_key", "appID": "api_key",
    "apiSecret": "api_secret", "appSecret": "api_secret", "AppSecret": "api_secret",
    "secretKey": "api_secret", "secret": "api_secret",
    "userId": "user_id", "UserID": "user_id",
    "clientId": "client_id", "ClientID": "client_id",
    "pinTotp": "pin_totp", "pinTOTP": "pin_totp",
    "vendorCode": "vendor_code", "sessionToken": "session_token",
    "accessToken": "access_token", "susertoken": "susertoken",
}


def _normalize_creds(creds: dict) -> dict:
    """Map camelCase credential keys to snake_case; drop empty + masked echoes."""
    out: dict = {}
    for k, v in (creds or {}).items():
        if v is None or v == "" or str(v).startswith("••••"):
            continue                      # never persist '' or the •••• mask
        kk = _CRED_KEY_ALIASES.get(k, k)
        out[kk] = v
    return out


def _normalize_creds_row(row_credentials: str) -> str:
    """Normalize a stored credentials JSON string (keeps stored real values)."""
    try:
        cur = json.loads(row_credentials or "{}")
    except Exception:
        cur = {}
    if not isinstance(cur, dict):
        return "{}"
    out: dict = {}
    for k, v in cur.items():
        kk = _CRED_KEY_ALIASES.get(k, k)
        if kk not in out:
            out[kk] = v
    return json.dumps(out)


def migrate_credential_keys() -> int:
    """One-time (idempotent) startup migration: rewrite every stored
    credentials JSON to canonical snake_case keys.  Returns rows changed."""
    n = 0
    for r in db.core().query("SELECT id, credentials FROM accounts"):
        try:
            cur = json.loads(r["credentials"] or "{}")
        except Exception:
            continue
        if not isinstance(cur, dict) or not cur:
            continue
        new = _normalize_creds_row(r["credentials"])
        if json.loads(new) != cur:
            db.core().exec("UPDATE accounts SET credentials=? WHERE id=?", (new, r["id"]))
            n += 1
    if n:
        config.log("rest", f"credential-key migration: normalized {n} account(s)")
    return n


class AccountReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    # canonical fields
    broker: Optional[str] = None
    label: str = ""
    mode: Optional[str] = None            # live | sandbox
    credentials: dict = {}
    initial_capital: Optional[float] = None
    initial_capital_mode: Optional[str] = None
    capital_mode: Optional[str] = None    # PROFIT_ONLY | INITIAL_PLUS_PNL | INITIAL_WITH_LOSS_REDUCTION
    capital_pct: Optional[float] = None
    # UI alias fields (quantdesk port)
    brokerType: Optional[str] = None
    clientId: Optional[str] = None
    initialCapital: Optional[float] = None
    initialCapitalMode: Optional[str] = None
    capitalMode: Optional[str] = None
    capitalPct: Optional[float] = None
    capitalBase: Optional[str] = None


def _account_req_fields(req: AccountReq) -> dict:
    """Fold canonical + alias fields into one normalized dict."""
    req.credentials = _normalize_creds(req.credentials)
    broker_raw = (req.broker or req.brokerType or "").strip()
    broker = _BROKER_ALIASES.get(
        broker_raw.lower().replace("-", "_").replace(" ", "_"))
    # UI sends its CapitalMode enum as `mode` — never let that become the
    # account live/sandbox column
    capital_mode = req.capital_mode or req.capitalMode or req.initial_capital_mode \
        or req.initialCapitalMode
    if capital_mode not in _CAPITAL_MODES:
        capital_mode = req.mode if req.mode in _CAPITAL_MODES else "INITIAL_PLUS_PNL"
    initial_capital = req.initial_capital if req.initial_capital is not None else req.initialCapital
    if initial_capital is not None and initial_capital <= 0:
        initial_capital = None            # blank/0 => % of available cash
    if (req.capitalBase or "").upper() == "AVAILABLE_CASH_PCT":
        initial_capital = None            # explicit %-of-cash mode wins
    capital_pct = req.capital_pct if req.capital_pct is not None else req.capitalPct
    credentials = dict(req.credentials or {})
    if req.clientId and not credentials.get("client_id"):
        credentials["client_id"] = str(req.clientId).strip()
    acc_mode = req.mode if req.mode in ("live", "sandbox") else \
        ("sandbox" if broker == "sim" else "live")
    return {
        "broker": broker, "broker_raw": broker_raw, "label": (req.label or "").strip(),
        "mode": acc_mode, "credentials": credentials,
        "initial_capital": initial_capital,
        "capital_mode": capital_mode,
        "capital_pct": capital_pct,
    }


def _is_copy_master(aid: int) -> bool:
    ct = db.core().one("SELECT master_account_id FROM copytrade WHERE id=1")
    return bool(ct and str(ct["master_account_id"] or "") == str(aid))


_ACCOUNT_PATCH_FIELDS = {
    "label": "label", "mode": "mode", "isOrderEnabled": "is_order_enabled",
    "isActive": "is_active", "capitalBase": None, "capitalPct": "capital_pct",
    "initialCapital": "initial_capital", "mode2": None,
    "capitalMode": "capital_mode",
}


def _account_row(aid: int) -> dict:
    acc = db.core().one("SELECT * FROM accounts WHERE id=?", (aid,))
    if not acc:
        raise HTTPException(404, "account not found")
    hub = Hub.instance()
    adapter = hub.adapters.get(aid)
    connected = bool(adapter and getattr(adapter, "connected", False))
    sess = db.core().one("SELECT session_token FROM broker_sessions WHERE account_id=?", (aid,))
    cash = hub._account_cash(aid)
    initial_fixed = acc["initial_capital"]
    initial = initial_fixed if initial_fixed is not None else \
        (cash or 1_000_000.0) * ((acc["capital_pct"] or 100) / 100.0)
    usable = hub._usable_capital(acc)
    open_pos = db.core().one("SELECT COUNT(*) c FROM positions WHERE account_id=? AND qty<>0", (aid,))["c"]
    open_ord = db.core().one("SELECT COUNT(*) c FROM orders WHERE account_id=? AND status='open'", (aid,))["c"]
    try:
        creds = json.loads(acc["credentials"] or "{}")
    except Exception:
        creds = {}
    return {
        "id": str(aid), "label": acc["label"], "brokerType": acc["broker"].upper(),
        "broker": acc["broker"], "status": "connected" if connected else acc["status"],
        "statusMessage": acc["status_message"],
        "isActive": bool(adapter), "isOrderEnabled": bool(acc["is_order_enabled"]),
        "isLiveDataSource": hub.feed_source() == str(aid), "isCopyMaster": _is_copy_master(aid),
        "hasSession": bool(sess and sess["session_token"]) or acc["broker"] == "sim",
        "usableCapital": round(usable, 2), "initialCapital": round(initial, 2),
        "capitalBase": "AVAILABLE_CASH_PCT" if initial_fixed is None else "FIXED",
        "capitalPct": acc["capital_pct"] or 100,
        "availableCash": cash, "initialCapitalFixed": initial_fixed,
        "realizedPnl": acc["realized_pnl"] or 0, "chargesPaid": acc["charges_paid"] or 0,
        "deployed": 0, "mode": acc["capital_mode"] or "INITIAL_PLUS_PNL",
        "modeLabel": {"PROFIT_ONLY": "Profit only", "INITIAL_PLUS_PNL": "Initial + PnL",
                      "INITIAL_WITH_LOSS_REDUCTION": "Initial − losses",
                      "LIVE_BALANCE": "Broker balance"}.get(acc["capital_mode"] or "", "Initial + PnL"),
        "firstTradeDone": bool(acc["first_trade_done"]),
        "openPositions": open_pos, "openOrders": open_ord,
        "clientId": creds.get("client_id") or creds.get("user_id"),
        "modeLabel2": acc["mode"],
        "credentials": {k: ("••••" + str(v)[-4:] if k in ("password", "api_secret", "access_token",
                                                        "session_token", "susertoken") and v else v)
                        for k, v in creds.items()},
        "has_credentials": bool(creds),
    }


@app.get("/pyapi/accounts")
async def list_accounts(authorization: str = Header(default="")):
    _uid(authorization)
    return {"accounts": [_account_row(r["id"]) for r in
                         db.core().query("SELECT id FROM accounts ORDER BY id")]}


@app.post("/pyapi/accounts")
async def create_account(req: AccountReq, authorization: str = Header(default="")):
    _uid(authorization)
    f = _account_req_fields(req)
    if not f["broker_raw"]:
        raise HTTPException(422, "broker is required — e.g. sim / breeze / dhan / shoonya")
    if not f["broker"]:
        raise HTTPException(400, f"unknown broker '{f['broker_raw']}' — valid: "
                                 f"{', '.join(sorted(set(_BROKER_ALIASES.values())))}")
    now = time.time()
    db.core().exec(
        "INSERT INTO accounts(broker,label,mode,credentials,initial_capital,initial_capital_mode,"
        "capital_mode,capital_pct,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (f["broker"], f["label"] or f"{f['broker']} account", f["mode"],
         json.dumps(f["credentials"]), f["initial_capital"],
         "fixed" if f["initial_capital"] is not None else "percent",
         f["capital_mode"], f["capital_pct"] if f["capital_pct"] is not None else 100,
         now, now))
    row = db.core().one("SELECT id FROM accounts ORDER BY id DESC LIMIT 1")
    config.log("rest", f"account created: {f['label']} ({f['broker']}/{f['mode']}) id={row['id']}")
    return {"ok": True, "id": str(row["id"]), "account": _account_row(row["id"])}


@app.patch("/pyapi/accounts/{account_id}")
async def patch_account(account_id: int, body: dict, authorization: str = Header(default="")):
    _uid(authorization)
    acc = db.core().one("SELECT * FROM accounts WHERE id=?", (account_id,))
    if not acc:
        raise HTTPException(404, "account not found")
    # Round-25 hardening: ANY unexpected error in the flag/credential handling
    # below surfaces as a clear 400 with the real message — never a bare 500.
    try:
        return await _patch_account_inner(account_id, acc, body, authorization)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"account update failed: {str(e)[:220]}")


async def _patch_account_inner(account_id: int, acc: dict, body: dict, authorization: str = Header(default="")):
    _uid(authorization)
    sets, vals = [], []
    simple = {"label": "label", "mode": "mode",
              "isOrderEnabled": "is_order_enabled", "isActive": "is_active",
              "capitalPct": "capital_pct", "capitalMode": "capital_mode",
              "initialCapital": "initial_capital"}
    for k, col in simple.items():
        if k in body and body[k] is not None:
            v = body[k]
            if col in ("is_order_enabled", "is_active"):
                v = 1 if v else 0
            sets.append(f"{col}=?")
            vals.append(v)
    if "capitalBase" in body:
        if body["capitalBase"] == "AVAILABLE_CASH_PCT":
            # % of available cash — clear the fixed amount, keep pct
            sets.append("initial_capital=NULL")
            if "capitalPct" not in body:
                sets.append("capital_pct=?")
                vals.append(float(body.get("capitalPct") or acc["capital_pct"] or 100))
        else:
            if "initialCapital" not in body:
                raise HTTPException(400, "initialCapital required for FIXED capital base")
    # credentials + credentialsMerge — MERGE into the stored JSON.  Masked
    # echoes (••••xxxx) and empty strings keep the stored value.  (Round-24:
    # credentialsMerge was silently dropped here before — the pencil-edit
    # dialog has been sending it since Round-10, so saved credentials never
    # reached the broker auth flows.)
    _new_creds: dict = {}
    if isinstance(body.get("credentials"), dict):
        _new_creds.update(body["credentials"])
    if isinstance(body.get("credentialsMerge"), dict):
        _new_creds.update(body["credentialsMerge"])
    if _new_creds:
        try:
            cur = json.loads(acc["credentials"] or "{}")
            if not isinstance(cur, dict):
                cur = {}
        except Exception:
            cur = {}
        for k, v in _new_creds.items():
            if v in (None, "") or str(v).startswith("••••"):
                continue   # masked echo / empty — keep the stored value
            cur[k] = v
        sets.append("credentials=?")
        vals.append(_normalize_creds_row(json.dumps(cur)))
    hub = Hub.instance()
    # Data flag — point the market-data source at this account (the UI flag
    # was silently dropped before, so the row-level switch did nothing)
    if "isLiveDataSource" in body:
        try:
            if body["isLiveDataSource"]:
                await hub.set_feed_source(str(account_id))
            elif hub.feed_source() == str(account_id):
                await hub.set_feed_source("sim")
        except ValueError as e:
            raise HTTPException(400, str(e))
    # Master flag — designate this account as the copy-trade master
    if "isCopyMaster" in body:
        if body["isCopyMaster"]:
            db.core().exec(
                "INSERT INTO copytrade(id,enabled,master_account_id) VALUES(1,0,?) "
                "ON CONFLICT(id) DO UPDATE SET master_account_id=excluded.master_account_id",
                (str(account_id),))
        else:
            db.core().exec("UPDATE copytrade SET master_account_id=NULL "
                           "WHERE id=1 AND master_account_id=?", (str(account_id),))
    if sets:
        # Round-24 CRITICAL FIX: the params must end with (…, updated_at, id) —
        # the previous code appended account_id BEFORE time.time(), binding
        # updated_at=<id> and WHERE id=<timestamp> — which never matches, so
        # every PATCH write silently no-opped (credentialsMerge, capitalMode,
        # label…).  This is the real root cause of the "credentials not saved"
        # reports; the credentialsMerge key-drop was a second bug on top.
        db.core().exec(f"UPDATE accounts SET {', '.join(sets)}, updated_at=? WHERE id=?",
                       (*vals, time.time(), account_id))
    if hub.adapters.get(account_id) and (body.get("credentials") or body.get("isActive") is False):
        await hub.disconnect_account(account_id)
    if body.get("isActive") is True and not hub.adapters.get(account_id):
        row = db.core().one("SELECT * FROM accounts WHERE id=?", (account_id,))
        try:
            creds = json.loads(row["credentials"] or "{}")
            await hub.connect_account(dict(row), creds)
            await FUNDS.push_funds(account_id, reason="event")
        except Exception as e:
            raise HTTPException(400, f"connect failed: {str(e)[:200]}")
    return {"ok": True, "account": _account_row(account_id)}


@app.put("/pyapi/accounts/{account_id}")
async def update_account(account_id: int, req: AccountReq, authorization: str = Header(default="")):
    _uid(authorization)
    row = db.core().one("SELECT * FROM accounts WHERE id=?", (account_id,))
    if not row:
        raise HTTPException(404, "account not found")
    f = _account_req_fields(req)
    if f["broker_raw"] and not f["broker"]:
        raise HTTPException(400, f"unknown broker '{f['broker_raw']}'")
    creds = f["credentials"] if req.credentials else json.loads(row["credentials"] or "{}")
    # capital only changes when the client actually sent a capital field
    if req.initial_capital is None and req.initialCapital is None and not req.capitalBase:
        initial_capital, icm = row["initial_capital"], row["initial_capital_mode"]
    else:
        initial_capital = f["initial_capital"]
        icm = "fixed" if initial_capital is not None else "percent"
    db.core().exec(
        "UPDATE accounts SET label=?, mode=?, credentials=?, initial_capital=?, "
        "initial_capital_mode=?, capital_mode=?, capital_pct=?, updated_at=? WHERE id=?",
        (f["label"] or row["label"], f["mode"], json.dumps(creds),
         initial_capital, icm, f["capital_mode"],
         f["capital_pct"] if f["capital_pct"] is not None
         else (row["capital_pct"] if row["capital_pct"] is not None else 100),
         time.time(), account_id))
    hub = Hub.instance()
    if hub.adapters.get(account_id) and req.credentials:
        await hub.disconnect_account(account_id)   # force re-auth with new creds
    return {"ok": True, "account": _account_row(account_id)}


@app.delete("/pyapi/accounts/{account_id}")
async def delete_account(account_id: int, authorization: str = Header(default="")):
    _uid(authorization)
    hub = Hub.instance()
    await hub.disconnect_account(account_id)
    session_store.clear(account_id)
    db.core().exec("DELETE FROM accounts WHERE id=?", (account_id,))
    return {"ok": True, "deleted": account_id}


# ---------------------------------------------------------------- bulk accounts
# Bulk add / modify / delete from a JSON array — powers the Admin “Bulk JSON”
# dialog (the textarea is prefilled with the CURRENT accounts so the JSON can
# be edited in place and applied).
#
#   body: {"accounts": [row, ...], "deleteMissing": bool}
#   row : {"id": "5",              present → modify (absent → create)
#          "label": “…”, "broker": "breeze|dhan|shoonya|sim",
#          "mode": "live|sandbox", "credentials": {…},   ← merge into stored
#          "initialCapital": 500000 | null,              ← null → % of cash
#          "capitalPct": 100, "capitalMode": "…",
#          "isActive": true, "isOrderEnabled": true,
#          "_delete": false}                             ← true → delete row
def _apply_session_row(aid: int, broker: str, r: dict) -> None:
    """Bulk-JSON round-trip: a row's `session: {token}` (copied from the export)
    is persisted verbatim, so a pasted account is FULLY recreated — including
    its live broker session — without opening the Session dialog."""
    if not isinstance(r.get("session"), dict):
        return
    tok = str(r["session"].get("token") or "").strip()
    if not tok or tok.startswith("••••"):
        return
    session_store.save(aid, broker or "", tok, None, {"bulkImport": True})


@app.get("/pyapi/accounts/export")
async def accounts_export(authorization: str = Header(default="")):
    """FULL account dump for the Bulk-JSON editor (Round-25): raw credentials,
    live session tokens, capital config + row flags — copy/paste round-trips
    an account (or a whole book) without touching the UI forms."""
    _uid(authorization)
    out: list[dict] = []
    for row in db.core().query("SELECT * FROM accounts ORDER BY id"):
        try:
            creds = json.loads(row["credentials"] or "{}")
        except Exception:
            creds = {}
        sess = session_store.get(row["id"])
        out.append({
            "id": str(row["id"]), "label": row["label"], "broker": row["broker"],
            "mode": row["mode"], "clientId": creds.get("client_id") or creds.get("user_id") or None,
            "credentials": creds,
            "session": ({"token": sess["session_token"], "broker": sess.get("broker", row["broker"]),
                         "updatedAt": sess.get("updated_at")} if sess and sess.get("session_token") else None),
            "initialCapital": row["initial_capital"], "capitalPct": row["capital_pct"] or 100,
            "capitalMode": row["capital_mode"] or "INITIAL_PLUS_PNL",
            "isActive": bool(row["is_active"]), "isOrderEnabled": bool(row["is_order_enabled"]),
        })
    return {"accounts": out, "exportedAt": time.time(),
            "note": "rows with id=modify, without id=add, \"_delete\":true=delete; "
                    "credentials+session are RAW so a pasted copy fully recreates the account"}


@app.post("/pyapi/accounts/bulk")
async def accounts_bulk(body: dict, authorization: str = Header(default="")):
    _uid(authorization)
    rows = body.get("accounts")
    if not isinstance(rows, list):
        raise HTTPException(422, "body.accounts must be a JSON array")
    if len(rows) > 200:
        raise HTTPException(400, "max 200 accounts per bulk apply")
    delete_missing = bool(body.get("deleteMissing"))
    hub = Hub.instance()
    detail: list[dict] = []
    seen_ids: set[str] = set()

    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            detail.append({"row": i, "ok": False, "error": "row is not an object"})
            continue
        rid = str(r.get("id") or "").strip()
        if r.get("_delete"):
            if not rid or not rid.isdigit():
                detail.append({"row": i, "ok": False, "error": "_delete needs a numeric id"})
                continue
            acc = db.core().one("SELECT label FROM accounts WHERE id=?", (int(rid),))
            if not acc:
                detail.append({"row": i, "id": rid, "ok": False, "error": "account not found"})
                continue
            await hub.disconnect_account(int(rid))
            session_store.clear(int(rid))
            db.core().exec("DELETE FROM accounts WHERE id=?", (int(rid),))
            detail.append({"row": i, "id": rid, "ok": True, "action": "deleted",
                           "label": acc["label"]})
            continue
        if rid:
            seen_ids.add(rid)

    # rows for creates (batched AFTER the loop so ids line up with detail)
    creates: list[tuple[int, dict]] = []
    for i, r in enumerate(rows):
        if not isinstance(r, dict) or r.get("_delete"):
            continue
        rid = str(r.get("id") or "").strip()
        if rid:
            continue
        creates.append((i, r))

    def _after(i: int, ok: bool, **kw) -> dict:
        d = {"row": i, "ok": ok, **kw}
        detail.append(d)
        return d

    # ---- modifies
    for i, r in enumerate(rows):
        if not isinstance(r, dict) or r.get("_delete"):
            continue
        rid = str(r.get("id") or "").strip()
        if not rid or not rid.isdigit():
            continue
        aid = int(rid)
        acc = db.core().one("SELECT * FROM accounts WHERE id=?", (aid,))
        if not acc:
            _after(i, False, id=rid, error="account not found")
            continue
        patch: dict = {}
        if r.get("label"):
            patch["label"] = str(r["label"]).strip()
        if r.get("mode") in ("live", "sandbox"):
            patch["mode"] = r["mode"]
        if isinstance(r.get("credentials"), dict):
            patch["credentials"] = r["credentials"]
        if r.get("clientId"):  # Round-25: clientId round-trips too
            patch.setdefault("credentials", {})["client_id"] = str(r["clientId"]).strip()
        if "initialCapital" in r:
            ic = r.get("initialCapital")
            if ic in (None, "", 0):
                # null/0 → switch to %-of-available-cash (clears the fixed amount)
                patch["capitalBase"] = "AVAILABLE_CASH_PCT"
            else:
                patch["initialCapital"] = float(ic)
        if r.get("capitalPct") is not None:
            patch["capitalPct"] = float(r["capitalPct"])
        if r.get("capitalMode"):
            if r["capitalMode"] not in _CAPITAL_MODES:
                _after(i, False, id=rid, error=f"unknown capitalMode '{r['capitalMode']}' — "
                                               f"valid: {', '.join(sorted(_CAPITAL_MODES))}")
                continue
            patch["capitalMode"] = r["capitalMode"]
        if "isActive" in r:
            patch["isActive"] = bool(r["isActive"])
        if "isOrderEnabled" in r:
            patch["isOrderEnabled"] = bool(r["isOrderEnabled"])
        if not patch and not (isinstance(r.get("session"), dict) and r["session"].get("token")):
            _after(i, True, id=rid, action="unchanged")
            continue
        try:
            await patch_account(aid, patch, authorization=authorization)
            _apply_session_row(aid, acc["broker"], r)
            _after(i, True, id=rid, action="modified", label=patch.get("label") or acc["label"])
        except HTTPException as e:
            _after(i, False, id=rid, error=str(e.detail))
        except Exception as e:
            _after(i, False, id=rid, error=str(e)[:160])

    # ---- creates
    for i, r in creates:
        try:
            req = AccountReq(
                broker=str(r.get("broker") or r.get("brokerType") or "").strip() or None,
                label=str(r.get("label") or "").strip(),
                mode=r.get("mode") if r.get("mode") in ("live", "sandbox") else None,
                credentials=r.get("credentials") if isinstance(r.get("credentials"), dict) else {},
                initialCapital=(None if r.get("initialCapital") in (None, "", 0)
                                else float(r["initialCapital"])),
                capitalPct=(float(r["capitalPct"]) if r.get("capitalPct") is not None else None),
                capitalMode=(r["capitalMode"] if r.get("capitalMode") in _CAPITAL_MODES else None),
                clientId=str(r["clientId"]) if r.get("clientId") else None,
            )
            res = await create_account(req, authorization=authorization)
            new_id = res.get("id")
            _apply_session_row(int(new_id), str(r.get("broker") or ""), r)
            seen_ids.add(str(new_id))
            _after(i, True, id=str(new_id), action="created", label=res.get("account", {}).get("label"))
        except HTTPException as e:
            _after(i, False, error=str(e.detail))
        except Exception as e:
            _after(i, False, error=str(e)[:160])

    # ---- delete-missing (explicit opt-in)
    deleted_missing: list[str] = []
    if delete_missing:
        for row in db.core().query("SELECT id, label FROM accounts ORDER BY id"):
            sid = str(row["id"])
            if sid not in seen_ids:
                await hub.disconnect_account(row["id"])
                session_store.clear(row["id"])
                db.core().exec("DELETE FROM accounts WHERE id=?", (row["id"],))
                deleted_missing.append(f"{sid}:{row['label']}")
                detail.append({"row": None, "id": sid, "ok": True, "action": "deleted-missing",
                               "label": row["label"]})

    ok = all(d.get("ok") for d in detail)
    return {"ok": ok, "counts": {
                "created": sum(1 for d in detail if d.get("action") == "created"),
                "modified": sum(1 for d in detail if d.get("action") == "modified"),
                "deleted": sum(1 for d in detail if d.get("action") in ("deleted", "deleted-missing")),
                "errors": sum(1 for d in detail if not d.get("ok")),
            }, "detail": detail}


@app.post("/pyapi/accounts/{account_id}/connect")
async def connect_account(account_id: int, authorization: str = Header(default="")):
    _uid(authorization)
    row = db.core().one("SELECT * FROM accounts WHERE id=?", (account_id,))
    if not row:
        raise HTTPException(404, "account not found")
    hub = Hub.instance()
    try:
        creds = json.loads(row["credentials"] or "{}")
        await hub.connect_account(dict(row), creds)
        await FUNDS.push_funds(account_id, reason="event")
        return {"status": "connected", "account_id": account_id}
    except Exception as e:
        raise HTTPException(400, str(e)[:250])


@app.post("/pyapi/accounts/{account_id}/disconnect")
async def disconnect_account(account_id: int, authorization: str = Header(default="")):
    _uid(authorization)
    await Hub.instance().disconnect_account(account_id)
    return {"status": "disconnected", "account_id": account_id}


# ================================================================== orders
class OrderReq(BaseModel):
    symbol: str
    exchange: Optional[str] = None
    side: str            # BUY | SELL
    qty: Optional[int] = 0
    orderType: str = "MARKET"
    productType: str = "MIS"
    limitPrice: Optional[float] = None
    triggerPrice: Optional[float] = None
    source: str = "MANUAL"
    strategyId: Optional[str] = None
    tag: Optional[str] = None
    legAccounts: Optional[list[str]] = None
    reduceOnly: bool = False
    capitalPct: Optional[float] = None


@app.post("/pyapi/orders")
async def place_order(req: OrderReq, authorization: str = Header(default="")):
    _uid(authorization)
    hub = Hub.instance()
    body = {
        "symbol": req.symbol, "exchange": req.exchange, "side": req.side,
        "qty": req.qty or 0, "orderType": req.orderType, "productType": req.productType,
        "limitPrice": req.limitPrice, "triggerPrice": req.triggerPrice,
        "source": req.source, "strategyId": req.strategyId, "tag": req.tag,
        "legAccounts": req.legAccounts, "reduceOnly": req.reduceOnly,
        "capitalPct": req.capitalPct,
    }
    try:
        result = await hub.place_master_order(body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, str(e)[:250])
    return result


@app.get("/pyapi/orders")
async def orders(authorization: str = Header(default="")):
    _uid(authorization)
    hub = Hub.instance()
    out = []
    for o in db.core().query("SELECT * FROM orders ORDER BY id DESC LIMIT 120"):
        acc = db.core().one("SELECT label,broker FROM accounts WHERE id=?", (o["account_id"],))
        out.append({
            "id": str(o["id"]), "symbol": o["symbol"],
            "exchange": o["symbol"].split(":")[0] or "NSE",
            "side": o["side"], "qty": o["qty"], "filledQty": o["filled_qty"] or 0,
            "orderType": o["order_type"], "productType": o["product"],
            "status": (o["status"] or "").upper(), "avgPrice": o["avg_price"],
            "message": o["message"],
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(o["created_at"])),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(o["updated_at"])),
            "accountId": str(o["account_id"]),
            "accountLabel": acc["label"] if acc else "",
            "brokerType": (acc["broker"].upper() if acc else "SIM"),
        })
    return {"orders": out}


@app.post("/pyapi/orders/cancel")
async def cancel_order(body: dict, authorization: str = Header(default="")):
    _uid(authorization)
    hub = Hub.instance()
    account_id = str((body or {}).get("accountId") or "")
    order_id = str((body or {}).get("orderId") or "")
    if not order_id:
        raise HTTPException(400, "orderId required")
    try:
        return await hub.cancel_master_order(account_id, order_id)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/pyapi/orders/squareoff")
async def squareoff(body: dict, authorization: str = Header(default="")):
    _uid(authorization)
    hub = Hub.instance()
    return await hub.squareoff_all(bool((body or {}).get("killSwitch")),
                                   (body or {}).get("symbols"))


@app.post("/pyapi/orders/cancel-all")
async def cancel_all(body: dict, authorization: str = Header(default="")):
    _uid(authorization)
    return await Hub.instance().cancel_all_orders((body or {}).get("symbols"))


# ================================================================== positions
@app.get("/pyapi/positions")
async def positions(authorization: str = Header(default="")):
    _uid(authorization)
    hub = Hub.instance()
    out = []
    by_symbol: dict[str, dict] = {}
    totals = {"unrealizedPnl": 0.0, "realizedPnl": 0.0, "openPositions": 0,
              "netIfExit": 0.0}
    for p in db.core().query("SELECT * FROM positions WHERE qty<>0 ORDER BY symbol"):
        acc = db.core().one("SELECT label,broker FROM accounts WHERE id=?", (p["account_id"],))
        mrow = hub._master_row(p["symbol"])
        lot = int((mrow or {}).get("lotsize") or 1)
        net_x, ch_x = hub._exit_net_of(p)
        row = {
            "accountId": str(p["account_id"]),
            "accountLabel": acc["label"] if acc else "",
            "brokerType": (acc["broker"].upper() if acc else "SIM"),
            "symbol": p["symbol"], "exchange": p["symbol"].split(":")[0] or "NSE",
            "productType": p["product"] or "MIS",
            "netQty": p["qty"], "buyQty": p["qty"] if p["qty"] > 0 else 0,
            "sellQty": -p["qty"] if p["qty"] < 0 else 0,
            "avgPrice": p["avg_price"], "realizedPnl": 0, "ltp": p["ltp"],
            "unrealizedPnl": p["pnl"], "lotSize": lot,
            "netIfExit": net_x, "exitCharges": ch_x,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(p["updated_at"])),
            "instrumentType": (mrow or {}).get("instrument") or "EQ",
        }
        out.append(row)
        totals["unrealizedPnl"] += p["pnl"] or 0
        totals["netIfExit"] += net_x
        totals["openPositions"] += 1
        b = by_symbol.setdefault(p["symbol"], {"symbol": p["symbol"], "netQty": 0,
                                               "avgPrice": 0, "ltp": p["ltp"],
                                               "unrealizedPnl": 0, "accounts": 0})
        b["netQty"] += p["qty"]
        b["avgPrice"] = p["avg_price"]
        b["unrealizedPnl"] += p["pnl"] or 0
        b["accounts"] += 1
    totals["realizedPnl"] = db.core().one("SELECT COALESCE(SUM(realized_pnl),0) s FROM trades")["s"]
    return {"positions": out, "bySymbol": list(by_symbol.values()), "totals": totals}


# ================================================================== funds per account (tool call)
@app.get("/pyapi/funds/{account_id}")
async def funds(account_id: int, authorization: str = Header(default="")):
    _uid(authorization)
    cached = FUNDS.cached(account_id)
    if cached:
        return cached
    await FUNDS.push_funds(account_id, reason="request")
    return FUNDS.cached(account_id) or {"error": "funds unavailable"}


# ================================================================== masters
@app.get("/pyapi/masters/status")
async def masters_status(authorization: str = Header(default="")):
    _uid(authorization)
    out = {}
    for name in broker_names():
        bdb = db.broker_db(name)
        symbols = bdb.one("SELECT COUNT(*) c FROM master")["c"]
        log = bdb.one("SELECT * FROM sync_log WHERE broker=? ORDER BY ts DESC LIMIT 1", (name,))
        out[name] = {"symbols": symbols, "mappings": symbols,
                     "last_sync": log, "db": os.path.basename(config.BROKER_DBS.get(name, ""))}
    return out


@app.post("/pyapi/masters/sync")
async def masters_sync(body: dict, authorization: str = Header(default="")):
    _uid(authorization)
    from backend import masters
    name = (body or {}).get("broker")
    if name not in REGISTRY:
        raise HTTPException(400, f"unknown broker {name}")
    acc = db.core().one("SELECT * FROM accounts WHERE broker=? ORDER BY id LIMIT 1", (name,))
    if not acc:
        raise HTTPException(400, f"no {name} account configured")
    result = await masters.sync_account(dict(acc), trigger="manual")
    if "error" in result:
        raise HTTPException(400, f"master sync failed: {result['error']}")
    masters._reload_token_maps(name)
    hub = Hub.instance()
    if hub.sio:
        await hub.sio.emit("master:synced", result)
    return result


@app.get("/pyapi/masters/search")
async def masters_search(q: str = "", exchange: str = "", limit: int = 30,
                         authorization: str = Header(default="")):
    _uid(authorization)
    q = (q or "").upper().strip()
    if not q:
        return []
    out, seen = [], set()
    for name in broker_names():
        rows = db.broker_db(name).query(
            "SELECT symbol,name,exchange,instrument,expiry,strike,right,lotsize FROM master "
            "WHERE symbol LIKE ? OR name LIKE ? LIMIT ?", (f"%{q}%", f"%{q}%", limit))
        for r in rows:
            if r["symbol"] not in seen:
                seen.add(r["symbol"])
                out.append(r)
        if len(out) >= limit:
            break
    if exchange:
        out = [r for r in out if r["exchange"] == exchange.upper()]
    return out[:limit]


# ================================================================== watchlist
@app.get("/pyapi/watchlist")
async def watchlist(authorization: str = Header(default="")):
    _uid(authorization)
    return db.core().query("SELECT * FROM watchlist ORDER BY id")


@app.post("/pyapi/watchlist")
async def add_watch(body: dict, authorization: str = Header(default="")):
    _uid(authorization)
    symbol = (body or {}).get("symbol", "").upper()
    if not symbol:
        raise HTTPException(400, "symbol required")
    exch = symbol.split(":")[0]
    db.core().exec("INSERT OR IGNORE INTO watchlist(user_id,symbol,exchange,added_at) VALUES(1,?,?,?)",
                   (symbol, exch, time.time()))
    return {"ok": True}


@app.delete("/pyapi/watchlist/{symbol}")
async def del_watch(symbol: str, authorization: str = Header(default="")):
    _uid(authorization)
    db.core().exec("DELETE FROM watchlist WHERE symbol=?", (symbol.upper(),))
    return {"ok": True}


# ================================================================== workspace archive (excludes .env!)
@app.get("/pyapi/workspace/download")
async def workspace_download(authorization: str = Header(default="")):
    """Zip the project WITHOUT .env / secrets / heavy dirs."""
    root = config.PROJECT_ROOT
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_path = os.path.join(config.DOWNLOAD_DIR, f"workspace-{stamp}.zip")
    EXCLUDE_DIRS = {".git", "node_modules", ".next", "__pycache__", ".zscripts",
                    "skills", ".venv", "venv", "download", "quantdesk-ref"}
    EXCLUDE_FILES = {".env", ".env.local", "dev.log", "server.log", "backend.log"}
    n = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for fn in filenames:
                if fn in EXCLUDE_FILES or fn.endswith((".db", ".db-wal", ".db-shm", ".zip")):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root)
                try:
                    zf.write(full, rel)
                    n += 1
                except OSError:
                    continue
    config.log("rest", f"workspace archive written: {out_path} ({n} files, .env excluded)")
    return FileResponse(out_path, filename=os.path.basename(out_path),
                        media_type="application/zip")
