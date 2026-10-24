"""
Broker registry + routing (OpenAlgo pattern).

  REGISTRY maps broker-name -> (BrokerAdapter class, StreamClient class, mapping module).
  The rest of the app NEVER imports broker modules directly; everything routes
  through get_adapter()/get_stream_cls()/get_mapping().

To add a broker "fyers":
  backend/brokers/fyers/{broker.py, streaming.py, mapping.py}
  + one REGISTRY line here.
"""
from __future__ import annotations

from typing import Optional
from backend.brokers.base import BaseBroker, BrokerError  # noqa: F401
from backend.brokers.sim.broker import SimAdapter
from backend.brokers.sim.streaming import SimStream
from backend.brokers.sim import mapping as sim_mapping
from backend.brokers.breeze.broker import BreezeAdapter
from backend.brokers.breeze.streaming import BreezeStream
from backend.brokers.breeze import mapping as breeze_mapping
from backend.brokers.dhan.broker import DhanAdapter
from backend.brokers.dhan.streaming import DhanStream
from backend.brokers.dhan import mapping as dhan_mapping
from backend.brokers.shoonya.broker import ShoonyaAdapter
from backend.brokers.shoonya.streaming import ShoonyaStream
from backend.brokers.shoonya import mapping as shoonya_mapping

REGISTRY: dict[str, dict] = {
    "sim":     {"adapter": SimAdapter,     "stream": SimStream,     "mapping": sim_mapping},
    "breeze":  {"adapter": BreezeAdapter,  "stream": BreezeStream,  "mapping": breeze_mapping},
    "dhan":    {"adapter": DhanAdapter,    "stream": DhanStream,    "mapping": dhan_mapping},
    "shoonya": {"adapter": ShoonyaAdapter, "stream": ShoonyaStream, "mapping": shoonya_mapping},
}


def broker_names() -> list[str]:
    return list(REGISTRY.keys())


def get_adapter(account: dict, credentials: Optional[dict] = None) -> BaseBroker:
    name = account["broker"]
    if name not in REGISTRY:
        raise BrokerError(f"unknown broker '{name}' (registered: {broker_names()})")
    creds = credentials if credentials is not None else {}
    return REGISTRY[name]["adapter"](account, creds)


def get_stream_cls(name: str):
    return REGISTRY[name]["stream"]


def get_mapping(name: str):
    return REGISTRY[name]["mapping"]
