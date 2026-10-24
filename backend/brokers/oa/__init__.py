"""Round-27 OpenAlgo broker support — vendored adapter layer.

`backend/openalgo/` holds the vendored straweb/hedging tree; this package
adapts it to OUR BaseBroker/StreamClient contracts:
  oa_catalog   — the 37-broker catalog (labels, credential fields, login help)
  oa_context   — per-call broker context (env vars + masters DB + token_db)
  oa_adapter   — OAAdapter(BaseBroker) for all 37 brokers
  oa_stream    — StreamClient wrapping each broker's WebSocketAdapter
  oa_mapping   — symbol mapping via the OA symtoken tables
"""
