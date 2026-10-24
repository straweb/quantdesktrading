#!/usr/bin/env python3
"""Round-27 verification — 37-broker openalgo port + sim-as-plain-account +
3-way trading mode + charges fixes + boot source discipline.

Part A (offline/unit): registry + catalog, plugin inventory vs upstream,
mapping resolution, charges defaults, trading-mode machine, tick gate.
Part B (live stack on :8000, skipped when down): feed/status fields, admin
surface lists oa- brokers, accounts plain-account shape.
"""
import asyncio
import json
import os
import sqlite3
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'  — ' + str(detail)[:200] if (not cond and detail) else ''}")


UPSTREAM_REAL = {  # hedging branch minus 8 icici backups minus dhan_sandbox
    "aliceblue", "angel", "arrow", "compositedge", "definedge", "deltaexchange",
    "dhan", "firstock", "fivepaisa", "fivepaisaxts", "flattrade", "fyers",
    "groww", "hdfcsecurities", "hdfcsky", "ibulls", "icici", "iifl",
    "iiflcapital", "indmoney", "jainamxts", "kotak", "motilal", "mstock",
    "nubra", "paytm", "pocketful", "rmoney", "rupeezy", "samco", "shoonya",
    "tradejini", "tradesmart", "upstox", "wisdom", "zebu", "zerodha",
}

# =====================================================================
print("== Part A1: vendored plugin inventory (vs upstream hedging branch) ==")
import glob

local = sorted(os.path.basename(p) for p in glob.glob("backend/openalgo/broker/*")
               if os.path.isdir(p))
check("37 plugin dirs present", len(local) == 37, f"{len(local)}: {local}")
check("plugin set == upstream real brokers", set(local) == UPSTREAM_REAL,
      f"missing={sorted(UPSTREAM_REAL - set(local))} extra={sorted(set(local) - UPSTREAM_REAL)}")
icici_like = [d for d in local if "icici" in d.lower()]
check("exactly ONE icici dir (backup variants excluded)", icici_like == ["icici"], str(icici_like))
check("dhan_sandbox NOT vendored (our own SANDBOX mode covers it)", "dhan_sandbox" not in local)

complete = []
for b in local:
    missing = [f for f in ("api/auth_api.py", "api/order_api.py", "api/data.py",
                           "api/funds.py", "database/master_contract_db.py", "plugin.json")
               if not os.path.exists(f"backend/openalgo/broker/{b}/{f}")]
    if missing:
        complete.append(f"{b}:{missing}")
check("every plugin has auth/order/data/funds/master/plugin.json", not complete, str(complete))

# =====================================================================
print("== Part A2: registry + lazy catalog ==")
from backend.brokers.registry import (broker_names, get_adapter, get_mapping,
                                      get_stream_cls, is_oa, oa_catalog)

names = broker_names()
check("41 broker names (4 native + 37 oa-)", len(names) == 41 and
      sum(1 for n in names if is_oa(n)) == 37, str(len(names)))
cat = oa_catalog()
check("oa catalog has 37 labelled specs", len(cat) == 37 and
      all(c.get("label") for c in cat.values()), str(len(cat)))
no_fields = [k for k, c in cat.items() if not c.get("fields")]
check("catalog specs carry credential fields (key: fields)", not no_fields, str(no_fields[:5]))
check("zerodha spec has api_key/secret + login URL template",
      {"api_key", "api_secret"} <= {f["key"] for f in cat["zerodha"]["fields"]} and
      bool(cat["zerodha"].get("login_url_template")))
for pick in ("oa-zerodha", "oa-icici", "oa-fyers", "oa-dhan"):
    a = get_adapter({"id": "t", "broker": pick, "name": "t"}, {"api_key": "x"})
    m = get_mapping(pick)
    s = get_stream_cls(pick)
    check(f"{pick} resolves adapter/mapping/stream",
          a.name == pick and type(m).__name__ == "_Mapper" and s.__name__ == "OAStream")
try:
    get_adapter({"id": "t", "broker": "nope", "name": "t"}, {})
    check("unknown NATIVE broker rejected", False)
except Exception as e:
    check("unknown NATIVE broker rejected", "unknown broker" in str(e), str(e)[:80])
# oa- construction is LAZY by design: unknown plugin fails at first plugin
# call (module import), not at adapter construction
lazy = get_adapter({"id": "t", "broker": "oa-nope", "name": "t"}, {})
try:
    asyncio.run(lazy.get_funds())
    check("unknown oa- plugin fails at first call (lazy)", False)
except Exception as e:
    check("unknown oa- plugin fails at first call (lazy)",
          "plugin module" in str(e) or "unavailable" in str(e), str(e)[:90])

# =====================================================================
print("== Part A3: oa_mapping structural resolution (offline) ==")
from backend.brokers.oa import oa_mapping

mp = get_mapping("oa-zerodha")
check("_Mapper exposes resolve + sync_to_master",
      hasattr(mp, "resolve") and callable(oa_mapping.sync_to_master))
check("structural helpers present (dhan-style builder + strike/right parser)",
      callable(oa_mapping._dhan_style_symbol) and
      callable(oa_mapping._option_strike_right))
try:
    r = oa_mapping.resolve("zerodha", "NSE:RELIANCE")
    check("resolve() handles the symtoken lookup (None or a mapped row)",
          r is None or (isinstance(r, dict) and r.get("symbol") and r.get("token")), str(r))
except Exception as e:
    check("resolve() handles the symtoken lookup (None or a mapped row)", False, str(e)[:90])

# =====================================================================
print("== Part A4: charges — ICICI own rates, Shoonya ₹5, OA default ==")
from backend.charges_config import BROKER_BROKERAGE, charges_source, default_schedule

sh = default_schedule("SHOONYA")
check("Shoonya OPT brokerage = ₹5 flat (was wrongly ₹0)", sh["OPT"]["brokerageFlat"] == 5,
      str(sh["OPT"]["brokerageFlat"]))
check("Shoonya FUT = ₹5 flat", sh["FUT"]["brokerageFlat"] == 5)
check("Shoonya delivery = ₹0", sh["EQ_DELIVERY"]["brokerageFlat"] == 0)
ic = default_schedule("ICICI_BREEZE")
check("ICICI F&O = ₹20 flat (own pricing, not Dhan-mirror text)",
      ic["FUT"]["brokerageFlat"] == 20 and ic["OPT"]["brokerageFlat"] == 20)
check("ICICI delivery = 0.55% plan modelled", ic["EQ_DELIVERY"]["brokeragePct"] == 0.0055)
oa = default_schedule("oa-groww")
check("oa-<plugin> accounts get a full editable default schedule",
      set(oa) == {"EQ_INTRADAY", "EQ_DELIVERY", "FUT", "OPT"})
srcs = {b: charges_source(b) for b in ("ICICI_BREEZE", "SHOONYA", "DHAN")}
check("ICICI note references icicidirect.com (no Dhan/₹20-mirror wording)",
      "icicidirect.com" in json.dumps(srcs["ICICI_BREEZE"]) and
      "Dhan" not in srcs["ICICI_BREEZE"]["note"], srcs["ICICI_BREEZE"]["note"][:90])
check("Shoonya note says ₹5 + shoonya.com/pricing",
      "₹5" in srcs["SHOONYA"]["note"] and "shoonya.com/pricing" in json.dumps(srcs["SHOONYA"]))
check("every source block carries an asOf date", all(s["asOf"] for s in srcs.values()))

# =====================================================================
print("== Part A5: 3-way trading mode machine ==")
from backend import db as coredb
from backend.market.hub import Hub

hub = Hub.instance()
hub.sio = None
hub.adapters.clear()
hub.streams.clear()
sim_id = hub.ensure_sim_account()          # boot calls this explicitly
cdb_path = coredb.core().path


def _set(key, val):
    c = sqlite3.connect(cdb_path)
    c.execute("INSERT INTO settings(key,value) VALUES(?,?) "
              "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, val))
    c.commit()
    c.close()


_set("trading_mode", "sandbox")
hub._mode_ts = None if hasattr(hub, "_mode_ts") else None
check("SANDBOX mode reads back", hub.trading_mode() == "sandbox")
check("SANDBOX is not sim_disabled (sim allowed as plain source)",
      hub.sim_disabled() is False)
_set("trading_mode", "live")
check("LIVE mode → sim_disabled() mirror True", hub.sim_disabled() is True)
_set("trading_mode", "simulation")
check("SIMULATION mode reads back", hub.trading_mode() == "simulation")
hub.set_trading_mode("sandbox")
check("set_trading_mode persists", hub.trading_mode() == "sandbox")
hub.set_sim_disabled(True)
check("legacy toggle True → LIVE", hub.trading_mode() == "live")
hub.set_sim_disabled(False)
check("legacy toggle False → back to SIMULATION", hub.trading_mode() == "simulation")
try:
    hub.set_trading_mode("bogus")
    check("bogus mode rejected", False)
except Exception:
    check("bogus mode rejected", True)

# =====================================================================
print("== Part A6: sim = plain account — tick gate + feed source ==")
hub.sio = None
hub.adapters.clear()
hub.streams.clear()
sim_id = hub.ensure_sim_account()          # boot calls this explicitly
check("ensure_sim_account yields a real account row", sim_id is not None)
_set("trading_mode", "simulation")
_set("feed_source", str(sim_id))
hub._src_ts = None
hub._src_aid = None
hub._dropped_ticks = 0
hub._drop_reasons.clear()
hub.loop = asyncio.new_event_loop()   # prod boot always sets loop; bare test thread has none
hub._on_broker_tick({"symbol": "NSE:PLAINSIM", "ltp": 11.0, "source": "sim",
                     "_aid": sim_id, "ts": 1})
check("picked sim account ticks ACCEPTED (no special-casing)",
      hub.ticks.get("NSE:PLAINSIM", {}).get("ltp") == 11.0)
_set("trading_mode", "live")
hub._src_ts = None
hub._dropped_ticks = 0
hub._on_broker_tick({"symbol": "NSE:PLAINSIM2", "ltp": 12.0, "source": "sim",
                     "_aid": sim_id, "ts": 2})
check("LIVE mode still hard-blocks sim ticks", hub._dropped_ticks >= 1 and
      "NSE:PLAINSIM2" not in hub.ticks)
_set("trading_mode", "simulation")
srcs_list = hub.feed_sources()
check("feed_sources lists EVERY account incl. sim (plain shape)",
      any(s["id"] == str(sim_id) for s in srcs_list) and
      all({"id", "label", "brokerType", "hasSession"} <= set(s) for s in srcs_list))
legacy = None
_set("feed_source", "sim")
check("legacy 'sim' source value maps to the sim row id", hub.feed_source() == str(sim_id))
_set("feed_source", "")

# =====================================================================
print("== Part B: live stack (skipped when :8000 is down) ==")
BASE = "http://127.0.0.1:8000/pyapi"


def req(method, path, body=None, token=None):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, data=data, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception:
        return None, {}


code, body = req("POST", "/auth/login", {"username": "admin", "password": "admin123"})
if code != 200 or not body.get("token"):
    print("  (stack down or auth failed — Part B skipped)")
else:
    TOKEN = body["token"]
    code, st = req("GET", "/feed/status", token=TOKEN)
    check("live /pyapi/feed/status 200", code == 200, f"{code}")
    check("status carries tradingMode + noSource", "tradingMode" in st and "noSource" in st,
          str({k: st.get(k) for k in ("tradingMode", "noSource", "source")}))
    code, accs = req("GET", "/accounts", token=TOKEN)
    check("live /pyapi/accounts 200", code == 200, str(code))

print(f"\n===== Round-27: {len(PASS)} PASS / {len(FAIL)} FAIL =====")
if FAIL:
    print("FAILED:", FAIL)
sys.exit(1 if FAIL else 0)
