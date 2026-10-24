"""
ICICI Direct streaming package.

The market-data adapter (IciciWebSocketAdapter) is registered with the
websocket proxy in websocket_proxy/__init__.py. Order updates are served
by the REST-polling fallback (services/order_update_service.py), since
Breeze's order stream is Socket.IO-bound and shared with the market feed
session.
"""
