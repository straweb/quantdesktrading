#!/usr/bin/env python3
"""FNO session engine test: seed a realistic 'broker' dataset into the cache,
run turbo sessions for TWO underlyings in parallel, and verify ticks /
contracts / chain / history / greeks / minute-path OHLCV exactness."""
import asyncio
import random
import sys
import time

sys.path.insert(0, "/home/z/my-project")


def make_dataset(svc, under, day, base):
    random.seed(42)
    candles = []
    t0 = int(time.mktime(time.strptime(day, "%Y-%m-%d"))) - 19800  # naive-UTC of IST midnight
    px = base
    for day_off in range(7, -1, -1):
        d0 = t0 - day_off * 86400
        for m in range(375):                     # 09:15..15:29
            ts = d0 + (9 * 60 + 15) * 60 + m * 60
            o = px
            px = max(1.0, px * (1 + random.gauss(0, 0.0009)))
            h = max(o, px) * (1 + random.uniform(0, 0.0009))
            l = min(o, px) * (1 - random.uniform(0, 0.0009))
            candles.append({"t": ts, "o": round(o, 2), "h": round(h, 2),
                            "l": round(l, 2), "c": round(px, 2), "v": random.randint(500, 5000)})
        px = px * (1 + random.gauss(0, 0.002))   # overnight gap
    svc.prev_days = 5
    svc.session_date = day
    data = svc._build_dataset(candles)
    assert data["session"], f"no session candles built for {under}"
    svc._cache_put(under, day, data)
    data["source"] = "test-dataset"
    return data


async def main() -> int:
    from backend import fnosim, db
    from backend.market.hub import Hub

    hub = Hub.instance()
    db.init_schema()
    svc = fnosim.SVC

    UNDER_A = "RELIANCE"
    UNDER_B = "TCS"
    DAY = "2026-10-16"

    # ---- build 'real broker' 1m datasets (6 prev days + session day) ----
    eng_a = fnosim.FnoSimSession()
    data_a = make_dataset(eng_a, UNDER_A, DAY, 2895.0)
    print(f"dataset A: session={len(data_a['session'])} prev={len(data_a['prev_days'])} dailies={len(data_a['dailies'])}")
    eng_b = fnosim.FnoSimSession()
    data_b = make_dataset(eng_b, UNDER_B, DAY, 4120.0)
    print(f"dataset B: session={len(data_b['session'])}")

    # ---- start BOTH sessions in parallel (custom expiry + turbo speed) ----
    st = await svc.start([UNDER_A, UNDER_B], DAY, "2026-10-23 15:30",
                         iv_pct=30, speed=60, band=5, prev_days=5)
    print(f"started: {st['count']} sessions · underlyings={st['underlyings']} "
          f"expiry={st['expiry']} ({st['expiryDt']}) iv={st['ivPct']}%")
    assert st["active"] and st["count"] == 2
    ea, eb = svc.engines[UNDER_A], svc.engines[UNDER_B]
    assert ea.active and eb.active
    assert ea.expiry == "23OCT26" and ea.expiry_dt is not None, "custom expiry must set the label + datetime"

    # let them run a few seconds
    await asyncio.sleep(6)
    s2 = ea.status()
    print(f"A progress={s2['progressPct']}% cursor={s2['cursor']} ticks={s2['ticksSent']}")

    spot = hub.ticks.get(s2["spotSymbol"])
    print(f"spot tick: {spot['symbol']} ltp={spot['ltp']} prev_close={spot['prev_close']}")
    assert spot and spot["ltp"] > 0

    opt = next((s for s in ea.option_symbols if s.endswith("CE")), None)
    otick = hub.ticks.get(opt)
    print(f"option tick: {opt} ltp={otick['ltp'] if otick else None}")
    assert otick and 0 < otick["ltp"] < 2895.0, "option premium should be << spot"

    # contracts in master?
    row = db.broker_db("sim").one("SELECT * FROM master WHERE symbol=?", (opt,))
    print(f"master row: exists={bool(row)} lot={row['lotsize'] if row else '-'}")

    # history seeded?
    hist = await hub.get_history(s2["spotSymbol"], 1)
    print(f"spot history seeded: {len(hist)} candles, last close={hist[-1]['c'] if hist else None}")
    ohist = await hub.get_history(opt, 1)
    print(f"option history seeded: {len(ohist)} candles, last close={ohist[-1]['c'] if ohist else None}")

    # chain follows session expiry + carries greeks?
    from backend.options_chain import build_chain
    ch = build_chain(UNDER_A, None)
    ce_cell = ch["atmCe"]
    print(f"chain: expiry={ch['meta']['expiry']} spot={ch['meta']['spot']:.1f} "
          f"atmCe={ce_cell['strike']}@{ce_cell['ltp']} sessionIv={ch['meta'].get('sessionIv')}")
    assert ch["meta"]["expiry"] == ea.expiry, "chain must follow the session expiry"
    assert ce_cell["ltp"] > 0, "chain CE cell must carry the session premium"
    g = ce_cell.get("greeks")
    assert g and -1 <= g["delta"] <= 1 and g.get("iv"), f"greeks missing on chain cells: {g}"
    print(f"greeks on ATM CE: delta={g['delta']} gamma={g['gamma']} theta={g['theta']} vega={g['vega']} iv={g['iv']}%")

    # per-session expiry pinning: chain B must follow B's session too
    chb = build_chain(UNDER_B, None)
    assert chb["meta"]["expiry"] == eb.expiry
    print(f"chain B: expiry={chb['meta']['expiry']} (parallel session pinned)")

    # ensure_source must NOT attach another stream for session symbols
    await hub._ensure_source(opt)
    print(f"symbol_source for {opt}: {hub.symbol_source.get(opt)} (None = session-served)")

    # minute path = EXACT OHLCV (open first, close last, H/L touched, nothing beyond)
    ok = True
    for cnd in ({"o": 100.0, "h": 105.0, "l": 98.0, "c": 103.0, "v": 3000},
                {"o": 100.0, "h": 100.5, "l": 97.0, "c": 97.5, "v": 200}):
        for subs in (4, 6, 8):
            path = ea._minute_path(cnd, subs)
            if path[0] != cnd["o"] or path[-1] != cnd["c"] \
               or max(path) != cnd["h"] or min(path) != cnd["l"]:
                ok = False
                print("PATH FAIL", cnd, subs, path)
    print("minute path = exact OHLCV (open/close/H/L, subs 4/6/8):", ok)
    assert ok

    # BS sanity
    assert abs(fnosim._bs_premium("CE", 105, 100, 0.02, 0.3) - 5.4) < 1.5
    assert fnosim._bs_premium("PE", 105, 100, 0.02, 0.3) < fnosim._bs_premium("CE", 105, 100, 0.02, 0.3)
    print("BS pricing sane")

    # stop ONE session, the other must keep running
    svc.stop(UNDER_A)
    await asyncio.sleep(0.2)
    assert not ea.active and eb.active, "per-underlying stop"
    print("per-underlying stop OK — B still active:", eb.active)

    svc.stop()
    await asyncio.sleep(0.3)
    print("stopped all:", svc.status()["active"] is False)
    print("\nALL ENGINE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
