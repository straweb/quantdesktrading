"""
socket.io / WebSocket data plane (port 8001) — the ONLY channel the frontend
uses for real-time data (ticks, candles, funds, orders, positions, mode).

Protocol (frontend -> backend):
  sub              {symbols: [...]}
  unsub            {symbols: [...]}
  candles:get      {symbol, tf}        -> candles:history + live candle events
  funds:get        {account_id?}       -> funds (on-demand, Round-15)
  orders:get                           -> orders snapshot
  positions:get                        -> positions snapshot
  mode:get                             -> mode

Backend -> frontend events:
  tick, candle, candles:history, funds, orders, positions, order_update,
  account_status, mode, feed:down, master:synced
"""
from __future__ import annotations

import asyncio

import socketio

from backend import config, db
from backend.market.hub import Hub
from backend.market.funds import SVC as FUNDS

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*",
                           ping_interval=20, ping_timeout=25, max_http_buffer_size=1e8)
# Dedicated port => socketio_path '/' captures everything on 8001 and passes
# the Caddy gateway unmodified (frontend: io('/?XTransformPort=8001', {path:'/'}))
sio_app = socketio.ASGIApp(sio, socketio_path="/")


@sio.event
async def connect(sid, environ, auth=None):
    hub = Hub.instance()
    hub.sio = sio
    await hub.on_connect(sid)
    # instant state so the UI never shows stale zeros after refresh (Round-14)
    if hub.sim_account_id:
        try:
            await FUNDS.push_funds(hub.sim_account_id, reason="request")
        except Exception:
            pass
    config.log("ws", f"client connected {sid} (total {len(hub.sockets)})")


@sio.event
async def disconnect(sid):
    hub = Hub.instance()
    await hub.on_disconnect(sid)
    config.log("ws", f"client disconnected {sid}")


@sio.on("sync:sub")
async def _sync_sub(sid, data=None):
    """Quantdesk sync-hub subscription: chains + index lists."""
    hub = Hub.instance()
    d = data or {}
    await hub.set_sync_subs(sid, d.get("chains") or [], d.get("index") or [])
    # instant first payload so panels never wait for the next loop tick
    try:
        await sio.emit("sync:core", hub.core_payload(), to=sid)
        from backend.syncpush import _admin_payload
        await sio.emit("sync:admin", _admin_payload(), to=sid)
    except Exception as e:
        config.log("ws", f"sync first push failed: {e}", "WARN")


@sio.on("sub")
async def _sub(sid, data=None):
    hub = Hub.instance()
    symbols = (data or {}).get("symbols") or []
    await hub.subscribe(sid, symbols)


@sio.on("unsub")
async def _unsub(sid, data=None):
    hub = Hub.instance()
    await hub.unsubscribe(sid, (data or {}).get("symbols") or [])


@sio.on("candles:get")
async def _candles(sid, data=None):
    hub = Hub.instance()
    d = data or {}
    symbol, tf = (d.get("symbol") or "").upper(), int(d.get("tf") or 1)
    if symbol:
        await hub.watch_candles(sid, symbol, tf)


@sio.on("funds:get")
async def _funds(sid, data=None):
    hub = Hub.instance()
    d = data or {}
    account_id = int(d.get("account_id") or 0)
    if not account_id:
        for aid in hub.adapters:
            account_id = aid
            break
    if account_id:
        await FUNDS.push_funds(account_id, reason="request")
    else:
        await sio.emit("funds", {"error": "no connected account"}, to=sid)


@sio.on("orders:get")
async def _orders(sid, data=None):
    hub = Hub.instance()
    await hub.push_orders()


@sio.on("positions:get")
async def _positions(sid, data=None):
    hub = Hub.instance()
    await hub.push_positions()


@sio.on("mode:get")
async def _mode(sid, data=None):
    hub = Hub.instance()
    await sio.emit("mode", {"mode": hub.trading_mode()}, to=sid)


@sio.on("ping-rtt")
async def _ping_rtt(sid, data=None):
    await sio.emit("pong-rtt", data or {}, to=sid)


async def set_funds_pusher() -> None:
    async def push(account_id: int, data: dict) -> None:
        await sio.emit("funds", {"account_id": account_id, **(data or {})})
    FUNDS.set_pusher(push)
