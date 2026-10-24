# websocket_proxy/__init__.py — quantdesk Round-27 shim.
# Upstream pulls the FULL proxy server (server.py → services/) at package
# import; the vendored broker streaming adapters only need base_adapter,
# mapping and order_adapter, which import fine as submodules. Keep the
# package import light — no server, no services layer.
