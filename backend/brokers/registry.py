"""
Broker registry + routing (OpenAlgo pattern).

  REGISTRY maps broker-name -> (BrokerAdapter class, StreamClient class, mapping module).
  The rest of the app NEVER imports broker modules directly; everything routes
  through get_adapter()/get_stream_cls()/get_mapping().

Native adapters (Round-10..26): sim, breeze, dhan, shoonya.
Round-27: the 37 vendored openalgo plugins register as "oa-<name>" and resolve
LAZILY through OAAdapter — importing one plugin never blocks boot.

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

# Round-27 — vendored openalgo plugins (lazy, resolved on first use)
_OA_PLUGINS: list[str] = [
    "aliceblue", "angel", "arrow", "compositedge", "definedge", "deltaexchange",
    "dhan", "firstock", "fivepaisa", "fivepaisaxts", "flattrade", "fyers",
    "groww", "hdfcsecurities", "hdfcsky", "ibulls", "icici", "iifl",
    "iiflcapital", "indmoney", "jainamxts", "kotak", "motilal", "mstock",
    "nubra", "paytm", "pocketful", "rmoney", "rupeezy", "samco", "shoonya",
    "tradejini", "tradesmart", "upstox", "wisdom", "zebu", "zerodha",
]

_OA_CATALOG: dict[str, dict] = {}


def oa_catalog() -> dict[str, dict]:
    """Lazy spec lookup for oa-<plugin> (labels + credential fields)."""
    if not _OA_CATALOG:
        try:
            from backend.brokers.oa import oa_catalog as cat
            for spec in cat.catalog():
                _OA_CATALOG[spec["broker"]] = spec
        except Exception:
            pass
    return _OA_CATALOG


def is_oa(name: str) -> bool:
    return isinstance(name, str) and name.startswith("oa-")


def broker_names() -> list[str]:
    names = list(REGISTRY.keys()) + [f"oa-{p}" for p in _OA_PLUGINS]
    return names


def get_adapter(account: dict, credentials: Optional[dict] = None) -> BaseBroker:
    name = account["broker"]
    if is_oa(name):
        from backend.brokers.oa.oa_adapter import OAAdapter
        return OAAdapter(account, credentials or {}, oa_key(name))
    if name not in REGISTRY:
        raise BrokerError(f"unknown broker '{name}' (registered: {broker_names()})")
    creds = credentials if credentials is not None else {}
    return REGISTRY[name]["adapter"](account, creds)


def oa_key(name: str) -> str:
    if not is_oa(name):
        raise BrokerError(f"not an openalgo broker: {name}")
    return name[3:]


def get_stream_cls(name: str):
    if is_oa(name):
        from backend.brokers.oa.oa_stream import OAStream
        return OAStream
    return REGISTRY[name]["stream"]


def get_mapping(name: str):
    if is_oa(name):
        from backend.brokers.oa import oa_mapping
        return oa_mapping._Mapper(oa_key(name))
    return REGISTRY[name]["mapping"]
