#!/usr/bin/env python3
"""
Trading Terminal — Python backend launcher (OpenAlgo-style one-liner)

  uv run app.py                                    # deps auto-resolved via pyproject.toml
  uv run --with-requirements requirements.txt app.py
  python3 app.py                                   # deps installed via requirements.txt
  ./start.sh                                       # full stack (backend + frontend + health checks)

Runs BOTH servers in one process:
  REST :8000 (/pyapi/*)   — tool interactions only
  WS   :8001 (socket.io)  — real-time tick / candle / funds plane
"""
import os
import sys

_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from backend.main import main

if __name__ == "__main__":
    main()
