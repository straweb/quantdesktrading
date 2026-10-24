"""Quick socket.io client test: connect to :8001, subscribe, count ticks."""
import asyncio
import socketio

sio = socketio.AsyncClient()

ticks = []
candles = []
funds = []


@sio.event
async def connect():
    print("connected")
    await sio.emit("sub", {"symbols": ["NSE:NIFTY", "NSE:RELIANCE", "NFO:NIFTY29OCT2625350CE"]})
    await sio.emit("candles:get", {"symbol": "NSE:NIFTY", "tf": 1})
    await sio.emit("funds:get", {})


@sio.on("tick")
async def on_tick(data):
    if len(ticks) < 3:
        print("TICK", data.get("symbol"), data.get("ltp"), data.get("source"))
    ticks.append(data)


@sio.on("candle")
async def on_candle(data):
    candles.append(data)


@sio.on("candles:history")
async def on_hist(data):
    print("HISTORY", data.get("symbol"), "candles:", len(data.get("candles") or []))


@sio.on("funds")
async def on_funds(data):
    funds.append(data)
    if len(funds) <= 2:
        print("FUNDS", {k: data.get(k) for k in ("available", "used", "total", "error", "source")})


@sio.on("feed:down")
async def on_down(data):
    print("FEED-DOWN", data)


async def main():
    await sio.connect("http://127.0.0.1:8001", socketio_path="/")
    await asyncio.sleep(6)
    print(f"ticks received: {len(ticks)}  candle-events: {len(candles)}  funds-events: {len(funds)}")
    if ticks:
        print("last tick:", {k: ticks[-1].get(k) for k in ("symbol", "ltp", "bid", "ask", "vol")})
    await sio.disconnect()


asyncio.run(main())
