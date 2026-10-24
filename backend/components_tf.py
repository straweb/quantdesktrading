"""Timeframe helpers shared by REST + sync layers."""
from __future__ import annotations

TF_MIN: dict[str, int] = {
    "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "1d": 1440,
}
