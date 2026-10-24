"""Catch-all socket.io debug client."""
import asyncio
import socketio

sio = socketio.AsyncClient()
count = 0


@sio.event
async def connect():
    print("connected", sio.sid)
    await sio.emit("sub", {"symbols": ["NSE:NIFTY"]})
    await sio.emit("ping-rtt", {"t": 1})
    await sio.emit("positions:get", {})


async def main():
    @sio.on("*")
    async def any_event(event, *args):
        global count
        count += 1
        if count <= 8:
            print("EVENT", event, str(args[0])[:120] if args else "")

    await sio.connect("http://127.0.0.1:8001", socketio_path="/")
    await asyncio.sleep(5)
    print("total events:", count)
    await sio.disconnect()


asyncio.run(main())
