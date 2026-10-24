"""
Backend entrypoint — runs BOTH Python servers in one asyncio loop:

  port 8000 : FastAPI REST  (/pyapi/*)   — tool interactions only
  port 8001 : socket.io WS                  — real-time data plane (Round-15)

Startup sequence:
  1. init schema + default admin + settings
  2. create/connect the default SIM account (persisted session)
  3. start sim tick stream so the terminal is alive immediately
  4. serve REST + WS concurrently
"""
from __future__ import annotations

import os
import sys

# allow `python backend/main.py` (script path): put the project root on sys.path
# (works as `python backend/main.py`, `python -m backend.main`, or `python app.py`)
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import asyncio

import uvicorn

from backend import config, db
from backend.api import sio_server
from backend.market.hub import Hub
from backend.market.funds import SVC as FUNDS


async def startup() -> None:
    db.init_schema()
    from backend import auth as auth_mod
    auth_mod.ensure_default_admin()
    # Round-24: rewrite stored credentials to canonical snake_case keys
    # (pre-fix rows may hold apiKey/apiSecret/appId — invisible to auth flows)
    try:
        from backend.api.rest import migrate_credential_keys
        migrate_credential_keys()
    except Exception as _e:
        config.log("boot", f"credential migration skipped: {_e}", "WARN")
    config.log("boot", f"backend starting — REST:{config.REST_PORT} WS:{config.WS_PORT}")

    hub = Hub.instance()
    hub.ensure_sim_account()
    # auto-connect sim so ticks flow before any user action
    row = db.core().one("SELECT * FROM accounts WHERE broker='sim'")
    import json as _json
    creds = _json.loads(row["credentials"] or "{}")
    await hub.connect_account(dict(row), creds)

    # seed sim master so search/subscribe works out of the box
    sim = db.broker_db("sim")
    if sim.one("SELECT COUNT(*) c FROM master")["c"] == 0:
        from backend.brokers.sim.broker import SimAdapter
        await SimAdapter(dict(row), {}).sync_master()
        hub._load_token_map(hub.sim_account_id)
        config.log("boot", "sim master seeded")
    # default watchlist
    if not db.core().one("SELECT id FROM watchlist LIMIT 1"):
        for sym in ("NSE:NIFTY", "NSE:BANKNIFTY", "NSE:RELIANCE", "NSE:TCS", "NSE:INFY"):
            db.core().exec("INSERT OR IGNORE INTO watchlist(user_id,symbol,exchange,added_at) "
                           "VALUES(1,?,?,?)", (sym, sym.split(":")[0], config.now() if hasattr(config, "now") else 0))

    from backend.api.rest import app as rest_app
    from backend.api.sio_server import sio_app, set_funds_pusher
    await set_funds_pusher()   # wire funds pushes to socket.io (on-demand + events)

    # background engines: sync pushers (quantdesk channels) + GTT / auto-rules /
    # strategies scheduler / tick recorder
    from backend import engines, syncpush
    asyncio.ensure_future(syncpush.run_sync_loops())
    for t in engines.start_all():
        t.add_done_callback(lambda tt: config.log(
            "engine", f"engine died: {tt.exception()}", "ERROR") if not tt.cancelled() and tt.exception() else None)
    config.log("boot", "sync pushers + engines started")

    rest_cfg = uvicorn.Config(rest_app, host="0.0.0.0", port=config.REST_PORT, log_level="warning")
    ws_cfg = uvicorn.Config(sio_server.sio_app, host="0.0.0.0", port=config.WS_PORT, log_level="warning")
    rest_srv = uvicorn.Server(rest_cfg)
    ws_srv = uvicorn.Server(ws_cfg)
    await asyncio.gather(rest_srv.serve(), ws_srv.serve())


def main() -> None:
    try:
        asyncio.run(startup())
    except KeyboardInterrupt:
        config.log("boot", "backend stopped")


if __name__ == "__main__":
    main()
