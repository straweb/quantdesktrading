#!/usr/bin/env python3
"""Round-26 verification — LIVE-ONLY discipline + Shoonya new master format +
Dhan wire fixes + broker-auth hardening.

Part A runs standalone (unit): Shoonya zip/csv master parse (live download),
Dhan binary stream layout, hub source-gate semantics.
Part B runs against the live stack (./start.sh): feed status fields,
broker-auth never-500, sim-disabled purge."""
import asyncio
import json
import os
import struct
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'  — ' + str(detail)[:200] if (not cond and detail) else ''}")


# =====================================================================
print("== Part A1: Shoonya LIVE master (zip/csv) parse ==")
import httpx
from backend.brokers.shoonya import mapping as sm

total_rows = 0
for exch in ("NSE", "NFO"):
    url = f"https://api.shoonya.com/{exch}_symbols.txt.zip"
    r = httpx.get(url, timeout=60, follow_redirects=True)
    check(f"{exch} zip master reachable ({url})", r.status_code == 200, f"HTTP {r.status_code}")
    rows = sm.parse_symbols(r.content, exch)
    total_rows += len(rows)
    check(f"{exch} parse -> many rows", len(rows) > 1000, f"got {len(rows)}")
    if exch == "NSE":
        eqs = [x for x in rows if x["instrument"] == "EQ"]
        idxs = [x for x in rows if x["instrument"] == "INDEX"]
        rel = next((x for x in eqs if x["symbol"] == "NSE:RELIANCE"), None)
        check("NSE EQ rows present", len(eqs) > 1000, f"{len(eqs)}")
        check("RELIANCE unified (no -EQ suffix)", bool(rel), str(rel)[:80])
        nifty_idx = next((x for x in idxs if x["symbol"] == "NSE:NIFTY"), None)
        check("NIFTY index alias normalized", bool(nifty_idx),
              f"idx={[x['symbol'] for x in idxs[:6]]}")
    else:
        opts = [x for x in rows if x["instrument"] == "OPT" and x["symbol"].startswith("NFO:NIFTY")]
        futs = [x for x in rows if x["instrument"] == "FUT" and x["symbol"].startswith("NFO:NIFTY")]
        nifty_exps = sorted({x["expiry"] for x in opts})
        check("NIFTY options parsed", len(opts) > 500, f"{len(opts)}")
        check("NIFTY futures parsed (tsym ...F)", len(futs) >= 1, f"{len(futs)} e.g. {futs[:1]}")
        # expiry must be CURRENT (not the stale 2023 files)
        cur = [e for e in nifty_exps if e.startswith(("27OCT26", "03NOV26", "06NOV26", "28OCT26", "30OCT26"))]
        check("NIFTY option expiries are CURRENT week (26-Oct-2026+)", bool(cur), f"{nifty_exps[:5]}")
        sample = next((x for x in opts if x["expiry"] == nifty_exps[0]), None)
        if sample:
            check("option tsym-exact unified (right letter before strike)",
                  sample["symbol"].split(":")[1].endswith(f"{sample['right'][0]}{int(sample['strike'])}"),
                  sample["symbol"])

# stale .txt must NOT be used by sync (candidate order check)
check("candidate order: zip first", sm.MASTER_URLS["NSE"][0].endswith(".zip"))

print("== Part A2: Shoonya tsym resolver (chain-synthesized Dhan-style) ==")
os.environ.setdefault("PYAPI_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend", "data"))
from backend import db as coredb  # noqa: E402
coredb.init_schema()
bdb = coredb.broker_db("shoonya")
# seed one real Noren row + one NSE equity row
bdb.exec("DELETE FROM master")
bdb.executemany(
    "INSERT OR REPLACE INTO master(token,symbol,name,exchange,instrument,expiry,strike,right,lotsize) "
    "VALUES(?,?,?,?,?,?,?,?,?)", [
        ("61717", "NFO:NIFTY27OCT26C17500", "NIFTY27OCT26C17500", "NFO", "OPT", "27OCT26", 17500.0, "CE", 65),
        ("2885", "NSE:RELIANCE", "RELIANCE", "NSE", "EQ", None, None, "", 1),
        ("61471", "NFO:NIFTY23NOV26F", "NIFTY23NOV26F", "NFO", "FUT", "23NOV26", None, "FUT", 65),
    ])
from backend.brokers.shoonya.broker import ShoonyaAdapter  # noqa: E402
ad = ShoonyaAdapter({"id": 0, "broker": "shoonya", "credentials": "{}"}, {})
ex, tsym, row = ad._tsym_resolve("NFO:NIFTY27OCT2617500CE")   # Dhan-style synth
check("Dhan-style synth -> Noren tsym", (ex, tsym) == ("NFO", "NIFTY27OCT26C17500"), f"{ex}:{tsym}")
ex, tsym, row = ad._tsym_resolve("NFO:NIFTY27OCT26C17500")
check("tsym-exact direct hit", (ex, tsym) == ("NFO", "NIFTY27OCT26C17500"), f"{ex}:{tsym}")
ex, tsym, row = ad._tsym_resolve("NSE:RELIANCE")
check("NSE EQ keeps -EQ suffix on the wire", (ex, tsym) == ("NSE", "RELIANCE-EQ"), f"{ex}:{tsym}")
ex, tsym, row = ad._tsym_resolve("NFO:NIFTY23NOV26FUT")
check("Dhan-style FUT -> Noren F", (ex, tsym) == ("NFO", "NIFTY23NOV26F"), f"{ex}:{tsym}")

print("== Part A3: Dhan binary stream layout (hedging-verified offsets) ==")
from backend.brokers.dhan.streaming import DhanStream  # noqa: E402
emitted = []
st = DhanStream(lambda t: emitted.append(t), type("A", (), {"session": {}})())
st.subscribed["NSE_FNO_61717"] = {"ExchangeSegment": "NSE_FNO", "SecurityId": "61717", "unified": "NFO:X"}


def frame(code, seg, sid, payload):
    # real wire header (8B): code u8 | length u16 | segment u8 | securityId u32
    return struct.pack("<BHBI", code, len(payload), seg, sid) + payload


# QUOTE (42B): ltp, ltq, ltt, atp, vol, totSell, totBuy, open, close, high, low
q = struct.pack("<fHIfIIIffff", 101.5, 3, 1698100000, 100.9, 1234, 500, 600, 100.0, 101.0, 102.0, 99.0)
st._parse(frame(4, 1, 61717, q))  # 42B
t = emitted[-1] if emitted else {}
check("QUOTE ohlc correct (was h/l=0)", (t.get("open"), t.get("high"), t.get("low"), t.get("close")) == (100.0, 102.0, 99.0, 101.0), str(t))
# FULL (154B): 26B prefix + oi 12B + ohlc 16B + 5x20B depth
full = struct.pack("<fHIfIII", 205.25, 2, 1698100001, 204.0, 4321, 700, 800)
full += struct.pack("<III", 1500, 1600, 1400)                      # oi, oiHigh, oiLow
full += struct.pack("<ffff", 200.0, 204.5, 206.0, 199.0)           # open close high low
full += struct.pack("<IIHHff", 40, 50, 3, 4, 204.5, 204.75)        # depth row0
full += b"\x00" * (20 * 4)
st._parse(frame(8, 1, 61717, full))
t = emitted[-1] if emitted else {}
check("FULL bid/ask from depth row0 (was totSell/totBuy)",
      (t.get("bid"), t.get("ask"), t.get("bid_qty"), t.get("ask_qty")) == (204.5, 204.75, 40, 50), str(t))
check("FULL ohlc correct", (t.get("open"), t.get("high"), t.get("low"), t.get("close")) == (200.0, 206.0, 199.0, 204.5), str(t))
check("FULL oi parsed", t.get("oi") == 1500, str(t.get("oi")))
# PREV_CLOSE merge
st._parse(frame(6, 1, 61717, struct.pack("<fI", 198.0, 0)))
t = emitted[-1] if emitted else {}
check("PREV_CLOSE merged", t.get("prev_close") == 198.0, str(t.get("prev_close")))

print("== Part A4: hub source gate (LIVE-ONLY discipline) ==")
from backend.market.hub import Hub  # noqa: E402
hub = Hub.instance()
hub.sim_account_id = 19
hub.token_map[19] = {}
hub.adapters.clear()
hub.streams.clear()
hub.sio = None
# 1. sim tick with sim_disabled=1 must DROP even with a stale symbol_source pin
hub._src_aid = None
hub._src_ts = None
os.environ.setdefault("SIM_DISABLED_FORCE", "1")
import sqlite3  # noqa: E402
cdb = sqlite3.connect(coredb.core().path)
# Round-27: the gate keys off trading_mode=='live' (the legacy sim_disabled
# row is now only a mirror kept for the old toggle UI).
cdb.execute("INSERT INTO settings(key,value) VALUES('sim_disabled','1') "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value")
cdb.execute("INSERT INTO settings(key,value) VALUES('trading_mode','live') "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value")
cdb.commit()
cdb.close()
before = hub._dropped_ticks
hub._on_broker_tick({"symbol": "NSE:NIFTY", "ltp": 1.0, "source": "sim", "_aid": 19, "ts": 1})
check("sim tick DROPPED under LIVE mode (stale pin or not)", hub._dropped_ticks == before + 1,
      f"dropped={hub._dropped_ticks} before={before}")
check("no sim tick entered the cache", "NSE:NIFTY" not in hub.ticks)
# Round-27: sim is a PLAIN account — its ticks ARE legal when it IS the
# picked source and the mode is not live.
cdb = sqlite3.connect(coredb.core().path)
cdb.execute("INSERT INTO settings(key,value) VALUES('trading_mode','simulation') "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value")
cdb.commit()
cdb.close()
hub._src_ts = None
cdb2 = sqlite3.connect(coredb.core().path)
srow = cdb2.execute("SELECT id FROM accounts WHERE broker='sim' ORDER BY id LIMIT 1").fetchone()
cdb2.close()
if srow:
    cdb = sqlite3.connect(coredb.core().path)
    cdb.execute("INSERT INTO settings(key,value) VALUES('feed_source',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(srow[0]),))
    cdb.commit()
    cdb.close()
    hub._src_ts = None
    hub._on_broker_tick({"symbol": "NSE:SIMPLAIN", "ltp": 7.0, "source": "sim", "_aid": srow[0], "ts": 1})
    check("sim tick ACCEPTED as picked source in simulation mode (plain account)",
          hub.ticks.get("NSE:SIMPLAIN", {}).get("ltp") == 7.0,
          str(hub.ticks.get("NSE:SIMPLAIN")))
else:
    print("  (no sim account row — plain-account acceptance check skipped)")
# 2. explicit live source: sim ticks dropped, source-account ticks accepted,
#    other-account ticks dropped
hub._src_aid = 21
hub._src_ts = time.time()
before = hub._dropped_ticks
hub._on_broker_tick({"symbol": "NSE:NIFTY", "ltp": 2.0, "source": "sim", "_aid": 19, "ts": 1})
check("sim tick DROPPED under explicit live source", hub._dropped_ticks == before + 1)
hub._on_broker_tick({"symbol": "NSE:NIFTY", "ltp": 25000.0, "source": "breeze", "_aid": 21, "ts": 2})
check("source-account tick ACCEPTED", hub.ticks.get("NSE:NIFTY", {}).get("ltp") == 25000.0,
      str(hub.ticks.get("NSE:NIFTY")))
before = hub._dropped_ticks
hub._on_broker_tick({"symbol": "NSE:BANKNIFTY", "ltp": 9.0, "source": "dhan", "_aid": 22, "ts": 3})
check("CROSS-ACCOUNT tick DROPPED (no fallback)", hub._dropped_ticks == before + 1
      and "NSE:BANKNIFTY" not in hub.ticks)
st_row = hub.feed_status()
check("feed_status exposes dropped/waiting/noSource/epoch",
      all(k in st_row for k in ("dropped", "dropReasons", "waiting", "noSource", "epoch", "liveOnly")),
      str({k: st_row.get(k) for k in ("dropped", "waiting", "noSource", "epoch")}))
# 3. set_feed_source releases old stream subscriptions
released = []


class FakeStream:
    async def unsubscribe(self, toks):
        released.extend(toks)


hub.symbol_source["NSE:NIFTY"] = 21
hub.streams[21] = FakeStream()
hub.token_map[21] = {"tok1": "NSE:NIFTY"}
# allow sim as source again for the switch test (clear live-only)
cdb = sqlite3.connect(coredb.core().path)
cdb.execute("INSERT INTO settings(key,value) VALUES('sim_disabled','0') "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value")
cdb.execute("INSERT INTO settings(key,value) VALUES('trading_mode','simulation') "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value")
cdb.commit()
cdb.close()
hub._src_ts = None          # refresh gate cache
try:
    asyncio.run(hub.set_feed_source("sim"))
except Exception as e:
    print("  (set_feed_source sim err:", e, ")")
check("old-source subscriptions released on switch", "tok1" in released, f"released={released}")
check("symbol_source cleared on switch", not hub.symbol_source)

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
        with urllib.request.urlopen(r, data=data, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception:
        return None, {}


code, body = req("POST", "/auth/login", {"username": "admin", "password": "admin123"})
if code == 200 and body.get("token"):
    TOKEN = body["token"]
    code, fs = req("GET", "/feed/status", token=TOKEN)
    check("live /feed/status 200 + new fields", code == 200 and all(
        k in fs for k in ("dropped", "waiting", "noSource", "epoch", "liveOnly")),
        f"code={code} keys={sorted(fs)[:12]}")
    # broker-auth with a bogus account id must be 400/404 — NEVER 500
    code, body = req("POST", "/broker-auth", {"accountId": 999999, "action": "consent"}, TOKEN)
    check("broker-auth bogus account -> 404/400 (never 500)", code in (400, 404), f"code={code}")
    code, body = req("POST", "/broker-auth", {"accountId": "abc", "action": "consent"}, TOKEN)
    check("broker-auth non-numeric id -> 400 (never 500)", code == 400, f"code={code}")
else:
    print("  (stack not running — Part B skipped)")

print(f"\n===== Round-26: {len(PASS)} PASS / {len(FAIL)} FAIL =====")
if FAIL:
    print("FAILED:", FAIL)
sys.exit(1 if FAIL else 0)
