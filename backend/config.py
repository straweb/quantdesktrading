"""
Central configuration for the Python backend.

Env vars are read from the process environment. A .env file at the project
root is loaded by start.sh / config loader (dotenv-style, no dependency).

All ports follow the architecture agreed for this terminal:
  - 8000 : FastAPI REST   (/pyapi/*)  -> tool interaction only
  - 8001 : socket.io WS   real-time data plane (ticks / candles / funds)
  - 3000 : Next.js frontend
  - 81   : Caddy production entry (reverse proxy to 3000 + /pyapi 8000 + /pyws 8001)
"""
from __future__ import annotations

import os

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
DATA_DIR = os.path.join(BACKEND_DIR, "data")
DOWNLOAD_DIR = os.path.join(PROJECT_ROOT, "download")


def log(tag: str, msg: str, level: str = "INFO") -> None:
    """Structured timestamped log line, same format across the backend."""
    from datetime import datetime
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{level}] {tag}: {msg}", flush=True)


def _strip_inline_comment(val: str) -> str:
    """Cut a trailing '# comment' from an UNQUOTED value (comment starts at a
    '#' preceded by whitespace, so passwords like 'ab#cd' stay intact)."""
    for i, ch in enumerate(val):
        if ch == "#" and i > 0 and val[i - 1] in (" ", "\t"):
            return val[:i].rstrip()
    return val


def _load_dotenv() -> None:
    """Tiny .env loader so the backend is self-sufficient (python-dotenv free).

    Handles the forms users actually write:
      KEY=value
      KEY=value   # inline comment   <- comment stripped, value kept clean
      KEY="quoted value"            <- taken literally up to closing quote
      # full-line comment           <- skipped
    """
    path = os.path.join(PROJECT_ROOT, ".env")
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                if not key:
                    continue
                val = val.strip()
                if val[:1] in ("'", '"'):
                    # quoted: keep literally up to the matching closing quote
                    end = val.find(val[0], 1)
                    val = val[1:end] if end != -1 else val[1:].strip()
                else:
                    val = _strip_inline_comment(val).strip('"').strip("'")
                os.environ.setdefault(key, val)
    except Exception:
        pass


_load_dotenv()


def _int_env(name: str, default: int) -> int:
    """int(os.getenv(...)) that never crashes the backend on junk values."""
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        log("config", f"{name}={raw!r} is not a number — using default {default}", "WARN")
        return default


def _float_env(name: str, default: float) -> float:
    """float(os.getenv(...)) that never crashes the backend on junk values."""
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        log("config", f"{name}={raw!r} is not a number — using default {default}", "WARN")
        return default


# ------------------------------------------------------------------ ports
REST_PORT = _int_env("PYAPI_PORT", 8000)
WS_PORT = _int_env("PYWS_PORT", 8001)

# ------------------------------------------------------------------ security
APP_SECRET = os.getenv("APP_SECRET", "change-me-terminal-secret")
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

# ------------------------------------------------------------------ files
CORE_DB = os.path.join(DATA_DIR, "core.db")          # users, accounts, sessions, settings
BROKER_DBS = {                                        # per-broker DB (OpenAlgo style isolation)
    "sim": os.path.join(DATA_DIR, "sim.db"),
    "breeze": os.path.join(DATA_DIR, "breeze.db"),
    "dhan": os.path.join(DATA_DIR, "dhan.db"),
    "shoonya": os.path.join(DATA_DIR, "shoonya.db"),
}

# ------------------------------------------------------------------ mode
# Global trading mode: "live" | "sandbox". When "live", sim/sandbox data is
# never allowed to serve market data or paper fills for live accounts.
DEFAULT_TRADING_MODE = os.getenv("DEFAULT_TRADING_MODE", "simulation")

# ------------------------------------------------------------------ feed tuning
TICK_FANOUT_MIN_MS = _int_env("TICK_FANOUT_MIN_MS", 80)          # coalesce window (ms)
CANDLE_HISTORY_FALLBACK_DAYS = _int_env("CANDLE_HISTORY_FALLBACK_DAYS", 3)
FUNDS_CACHE_TTL_S = _float_env("FUNDS_CACHE_TTL_S", 3)           # funds are on-demand + event driven

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(DOWNLOAD_DIR, exist_ok=True)
