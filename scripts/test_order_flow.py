"""Test order placement via REST and event-driven funds push via WS."""
import asyncio
import json
import urllib.request

import socketio

BASE = "http://127.0.0.1:8000"


def rest(path, method="GET", body=None):
    req = urllib.request.Request(f"{BASE}{path}", method=method,
                                 data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


sio = socketio.AsyncClient()
funds_events, order_events, position_events = [], [], []


@sio.on("funds")
async def on_funds(d):
    funds_events.append(d)
    print("FUNDS", {k: d.get(k) for k in ("available", "used", "total", "error")})


@sio.on("order_update")
async def on_order(d):
    order_events.append(d)
    print("ORDER-UPDATE", {k: d.get(k) for k in ("kind", "symbol", "side", "qty", "price", "status")})


@sio.on("positions")
async def on_pos(d):
    position_events.append(d)


async def main():
    login = rest("/pyapi/auth/login", "POST", {"username": "admin", "password": "admin123"})
    token = login["token"]
    rest._h = {"Authorization": f"Bearer {token}"}  # noqa

    await sio.connect("http://127.0.0.1:8001", socketio_path="/")
    await sio.emit("funds:get", {})
    await asyncio.sleep(1.5)
    print(f"funds events after request: {len(funds_events)}")

    # place an order (tool interaction via REST)
    def r2(path, method="GET", body=None):
        req = urllib.request.Request(f"{BASE}{path}", method=method,
                                     data=json.dumps(body).encode() if body else None,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    print("ORDER:", r2("/pyapi/orders/place", "POST",
                       {"symbol": "NSE:RELIANCE", "side": "BUY", "qty": 10,
                        "order_type": "MARKET", "product": "MIS"}))
    await asyncio.sleep(2)
    print(f"funds events total: {len(funds_events)} | order events: {len(order_events)} | positions: {len(position_events)}")
    await sio.disconnect()


asyncio.run(main())
