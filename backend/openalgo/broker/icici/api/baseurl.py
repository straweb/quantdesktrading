"""
ICICI Direct Breeze API base URLs.

Mirrors breeze_connect.config so the direct REST layer used by this
plugin stays byte-compatible with the official SDK.
"""

# Classic Breeze v1 REST API (checksum protected).
API_URL = "https://api.icicidirect.com/breezeapi/api/v1/"

# Historical Data V2 (apikey + X-SessionToken, query-string params).
HIST_V2_URL = "https://breezeapi.icicidirect.com/api/v2/"

# Login page for the browser redirect flow.
LOGIN_URL = "https://api.icicidirect.com/apiuser/login"

# Customer details / session exchange endpoint.
CUSTOMER_DETAILS_URL = (
    "https://api.icicidirect.com/breezeapi/api/v1/customerdetails"
)

# Security master archive used by the master contract loader and the SDK.
SECURITY_MASTER_URL = (
    "https://directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip"
)

# Socket.IO endpoints owned by the Breeze SDK.
LIVE_FEEDS_URL = "https://livefeeds.icicidirect.com"  # order notifications
LIVE_STREAM_URL = "https://livestream.icicidirect.com"  # live tick streaming
LIVE_OHLC_STREAM_URL = "https://breezeapi.icicidirect.com"  # live OHLCV
