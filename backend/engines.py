"""
Async engines — GTT triggers, auto-bot rules, time strategies, tick recorder,
replay player.  Started by main.py; every loop is defensive (errors logged,
never crash the backend).
"""
from __future__ import annotations

from typing import Optional
import asyncio
import json
import os
import time
from datetime import datetime

from backend import config, db
from backend.market.hub import Hub
from backend.market.funds import SVC as FUNDS

REPLAY_STATE = {"active": False, "file": None, "speed": 1.0, "startedAt": None,
                "total": 0, "played": 0, "symbols": []}
_replay_task: Optional[asyncio.Task] = None


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _ist_now() -> time.struct_time:
    return time.gmtime(time.time() + 19800)


def _hhmm() -> str:
    lt = _ist_now()
    return f"{lt.tm_hour:02d}:{lt.tm_min:02d}"


def _weekday() -> str:
    return str(_ist_now().tm_wday)


def _ltp(symbol: str) -> float:
    return float((Hub.instance().ticks.get(symbol.upper()) or {}).get("ltp") or 0)


# ================================================================== GTT (1s)
async def gtt_loop() -> None:
    while True:
        try:
            rules = db.core().query("SELECT * FROM gtt WHERE armed=1")
            for r in rules:
                ltp = _ltp(r["symbol"])
                if not ltp:
                    continue
                hit = (r["trigger"] == "ABOVE" and ltp >= r["trigger_price"]) or \
                      (r["trigger"] == "BELOW" and ltp <= r["trigger_price"])
                if not hit:
                    continue
                hub = Hub.instance()
                try:
                    await hub.place_master_order({
                        "symbol": r["symbol"], "exchange": r["exchange"], "side": r["side"],
                        "qty": r["qty"], "orderType": r["order_type"],
                        "productType": r["product_type"], "source": "GTT",
                        "limitPrice": r["trigger_price"] if r["order_type"] == "LIMIT" else None,
                    })
                    status, msg = "TRIGGERED", f"fired @ {ltp}"
                except Exception as e:
                    status, msg = "FAILED", str(e)[:160]
                repeat = bool(r["repeat_daily"])
                db.core().exec(
                    "UPDATE gtt SET armed=?, last_triggered_at=?, last_status=?, last_message=? WHERE id=?",
                    (1 if repeat else 0, time.time(), status, msg, r["id"]))
                config.log("gtt", f"rule #{r['id']} {r['name']} {status}: {msg}")
        except Exception as e:
            config.log("gtt", f"loop error: {e}", "ERROR")
        await asyncio.sleep(1.0)


# ================================================================== auto rules (250ms)
async def autorules_loop() -> None:
    while True:
        try:
            rules = db.core().query("SELECT * FROM autorules WHERE enabled=1")
            for r in rules:
                if r["repeat_daily"] and r["last_fired_date"] == _today():
                    continue
                hub = Hub.instance()
                underlying = r["underlying"]
                ltp = _ltp(underlying)
                now_hhmm = _hhmm()
                fire = False
                detail = ""
                if r["kind"] == "INDEX" and ltp:
                    level, cross = r["level"], r["cross"]
                    if level and cross == "ABOVE" and ltp >= level:
                        fire, detail = True, f"{underlying} {ltp} >= {level}"
                    elif level and cross == "BELOW" and ltp <= level:
                        fire, detail = True, f"{underlying} {ltp} <= {level}"
                elif r["kind"] == "INDEX_RANGE" and ltp:
                    if r["lo"] is not None and r["hi"] is not None and r["lo"] <= ltp <= r["hi"]:
                        fire, detail = True, f"{underlying} {ltp} in [{r['lo']},{r['hi']}]"
                elif r["kind"] == "TIME":
                    if r["time"] and now_hhmm >= r["time"]:
                        fire, detail = True, f"time {now_hhmm} >= {r['time']}"
                elif r["kind"] == "COMPOUND":
                    op = r["entry_op"]
                    v = ltp
                    if v and op == "LTE" and r["entry_lo"] is not None and v <= r["entry_lo"]:
                        fire, detail = True, f"{underlying} {v} <= {r['entry_lo']}"
                    elif v and op == "GTE" and r["entry_hi"] is not None and v >= r["entry_hi"]:
                        fire, detail = True, f"{underlying} {v} >= {r['entry_hi']}"
                    elif v and op == "RANGE" and r["entry_lo"] is not None and r["entry_hi"] is not None \
                            and r["entry_lo"] <= v <= r["entry_hi"]:
                        fire, detail = True, f"{underlying} {v} in [{r['entry_lo']},{r['entry_hi']}]"
                if not fire:
                    continue
                try:
                    if r["action"] == "CANCEL":
                        res = await hub.cancel_all_orders()
                        status, msg = "TRIGGERED", f"cancelled {res.get('cancelled', 0)} orders"
                    elif r["strikes"]:
                        placed = 0
                        for st in r["strikes"]:
                            from backend.options_chain import ensure_strike, _opt_symbol, _expiries_of
                            ensure_strike(underlying, st["strike"], r["expiry"])
                            exps = _expiries_of(underlying)
                            exp = r["expiry"] or (exps[0] if exps else None)
                            if not exp:
                                continue
                            sym = _opt_symbol(underlying, exp, int(st["strike"]), st["type"])
                            await hub.place_master_order({
                                "symbol": sym, "side": "BUY" if r["action"] in ("BUY", "DEPLOY") else "SELL",
                                "qty": 0, "orderType": "MARKET", "productType": "MIS",
                                "source": "AUTORULE", "capitalPct": st.get("allocPct") or r["alloc_pct"],
                            })
                            placed += 1
                        status, msg = "TRIGGERED", f"deployed {placed} strikes ({detail})"
                    else:
                        from backend.options_chain import ensure_strike, _opt_symbol, _expiries_of
                        spot, _prev = None, None
                        from backend.options_chain import _spot, _step_of
                        spot, _ = _spot(underlying)
                        step = _step_of(underlying)
                        import math
                        base = math.floor(spot / step) * step if r["opt_type"] == "CE" else math.ceil(spot / step) * step
                        strike = int(base + (r["offset"] or 0) * step)
                        ensure_strike(underlying, strike, r["expiry"])
                        exps = _expiries_of(underlying)
                        exp = r["expiry"] or (exps[0] if exps else None)
                        if not exp:
                            raise ValueError(f"no expiries for {underlying}")
                        sym = _opt_symbol(underlying, exp, strike, r["opt_type"])
                        await hub.place_master_order({
                            "symbol": sym, "side": "BUY" if r["action"] in ("BUY", "DEPLOY") else "SELL",
                            "qty": 0, "orderType": "MARKET", "productType": "MIS",
                            "source": "AUTORULE", "capitalPct": r["alloc_pct"],
                        })
                        status, msg = "TRIGGERED", f"{r['opt_type']} {strike} ({detail})"
                except Exception as e:
                    status, msg = "FAILED", str(e)[:160]
                db.core().exec(
                    "UPDATE autorules SET last_fired_date=?, last_fired_at=?, last_status=?, "
                    "last_message=?, fire_count=fire_count+1 WHERE id=?",
                    (_today(), time.time(), status, msg, r["id"]))
                config.log("autorule", f"#{r['id']} {r['name']} {status}: {msg}")
                if not r["repeat_daily"]:
                    db.core().exec("UPDATE autorules SET enabled=0 WHERE id=?", (r["id"],))
        except Exception as e:
            config.log("autorule", f"loop error: {e}", "ERROR")
        await asyncio.sleep(0.25)


# ================================================================== strategies scheduler (1s)
async def strategies_loop() -> None:
    while True:
        try:
            rows = db.core().query("SELECT * FROM strategies WHERE enabled=1")
            for s in rows:
                days = [d.strip() for d in (s["repeat_days"] or "").split(",")]
                if _weekday() not in days:
                    continue
                now_hhmm = _hhmm()
                try:
                    if s["last_run_date"] != _today() and now_hhmm >= s["entry_time"]:
                        # entry within the window?
                        if _minutes_of(now_hhmm) - _minutes_of(s["entry_time"]) <= s["entry_window_min"]:
                            await _strategy_enter(s)
                        else:
                            _slog(s["id"], "entry window missed — skipped for today")
                            db.core().exec("UPDATE strategies SET last_run_date=?, status='missed' WHERE id=?",
                                           (_today(), s["id"]))
                    elif s["status"] == "in_position" and s["entry_price"]:
                        await _strategy_manage(s, now_hhmm)
                except Exception as e:
                    _slog(s["id"], f"error: {e}", "ERROR")
        except Exception as e:
            config.log("strategy", f"loop error: {e}", "ERROR")
        await asyncio.sleep(1.0)


def _minutes_of(hhmm: str) -> int:
    try:
        h, m = hhmm.split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return 0


async def _strategy_enter(s: dict) -> None:
    hub = Hub.instance()
    quote_ltp = _ltp(s["symbol"])
    if not quote_ltp:
        _slog(s["id"], f"no feed price for {s['symbol']} yet")
        return
    qty = s["fixed_qty"]
    if s["qty_mode"] == "CAPITAL" and s["capital_amount"]:
        acc = db.core().one("SELECT * FROM accounts WHERE is_order_enabled=1 AND broker<>'sim' ORDER BY id LIMIT 1") \
            or db.core().one("SELECT * FROM accounts WHERE is_order_enabled=1 ORDER BY id LIMIT 1")
        if acc:
            budget = float(s["capital_amount"])
            mrow = hub._master_row(s["symbol"])
            lot = int((mrow or {}).get("lotsize") or 1)
            qty = max(1, int(budget / max(0.01, quote_ltp * (lot if lot > 1 else 1))))
    try:
        res = await hub.place_master_order({
            "symbol": s["symbol"], "side": s["direction"], "qty": qty,
            "orderType": s["order_type"], "productType": s["product_type"],
            "source": "STRATEGY", "strategyId": str(s["id"]),
        })
        ok = any(l["status"] == "FILLED" for l in res.get("legs", []))
        db.core().exec("UPDATE strategies SET last_run_date=?, status=?, entry_price=?, qty=? WHERE id=?",
                       (_today(), "in_position" if ok else "failed",
                        res.get("avgFillPrice") if ok else None, qty, s["id"]))
        _slog(s["id"], f"entry {s['direction']} {qty} {s['symbol']} @ {res.get('avgFillPrice')} — {res['status']}")
    except Exception as e:
        db.core().exec("UPDATE strategies SET last_run_date=?, status='failed' WHERE id=?", (_today(), s["id"]))
        _slog(s["id"], f"entry failed: {e}", "ERROR")


async def _strategy_manage(s: dict, now_hhmm: str) -> None:
    hub = Hub.instance()
    ltp = _ltp(s["symbol"])
    entry = s["entry_price"] or 0
    if not ltp or not entry:
        return
    long = s["direction"] == "BUY"
    move_pct = ((ltp - entry) / entry * 100) * (1 if long else -1)
    exit_now = now_hhmm >= s["exit_time"]
    reason = "exit time"
    if s["stop_loss_pct"] and move_pct <= -abs(s["stop_loss_pct"]):
        exit_now, reason = True, f"stop-loss {move_pct:.2f}%"
    elif s["target_pct"] and move_pct >= abs(s["target_pct"]):
        exit_now, reason = True, f"target {move_pct:.2f}%"
    if not exit_now:
        # trailing stop
        if s["trailing_sl_pct"] and move_pct > 0:
            # simple trailing: exit if the move decays 60% from its best
            db.core().exec("UPDATE strategies SET trailing_sl_pct=trailing_sl_pct WHERE id=?", (s["id"],))
        return
    try:
        res = await hub.place_master_order({
            "symbol": s["symbol"], "side": "SELL" if long else "BUY", "qty": s["fixed_qty"],
            "orderType": "MARKET", "productType": s["product_type"],
            "source": "STRATEGY", "strategyId": str(s["id"]), "reduceOnly": True,
        })
        ok = any(l["status"] == "FILLED" for l in res.get("legs", []))
        db.core().exec("UPDATE strategies SET status=?, entry_price=NULL WHERE id=?",
                       ("completed" if ok else "exit_failed", s["id"]))
        _slog(s["id"], f"exit ({reason}) — {res['status']}")
    except Exception as e:
        _slog(s["id"], f"exit failed: {e}", "ERROR")


def _slog(sid: int, msg: str, level: str = "INFO") -> None:
    db.core().exec("INSERT INTO strategy_logs(strategy_id,ts,level,message) VALUES(?,?,?,?)",
                   (sid, time.time(), level, msg[:300]))
    config.log("strategy", f"#{sid}: {msg}", level)


# ================================================================== tick recorder
async def recorder_loop() -> None:
    cfg_path = os.path.join(config.DATA_DIR, "tick-recorder.json")
    tick_dir = os.path.join(config.DATA_DIR, "ticks")
    os.makedirs(tick_dir, exist_ok=True)
    while True:
        try:
            try:
                with open(cfg_path) as f:
                    cfg = json.load(f)
            except Exception:
                cfg = {"enabled": False, "symbols": []}
            if cfg.get("enabled") and cfg.get("symbols"):
                hub = Hub.instance()
                line = json.dumps({"ts": time.time(), "ticks": {
                    s: hub.ticks.get(s) for s in cfg["symbols"] if hub.ticks.get(s)}},
                    default=str)
                with open(os.path.join(tick_dir, "session-live.jsonl"), "a") as f:
                    f.write(line + "\n")
        except Exception as e:
            config.log("recorder", f"error: {e}", "ERROR")
        await asyncio.sleep(1.0)


# ================================================================== replay
async def start_replay(file: str, speed: float = 1.0) -> dict:
    global _replay_task
    await stop_replay()
    if not os.path.isfile(file):
        raise ValueError(f"no session file {file}")

    async def player() -> None:
        hub = Hub.instance()
        REPLAY_STATE.update({"active": True, "file": file, "speed": speed,
                             "startedAt": datetime.now().isoformat(), "played": 0})
        rows: list[str] = []
        with open(file) as f:
            rows = [ln for ln in f if ln.strip()]
        REPLAY_STATE["total"] = len(rows)
        syms: set[str] = set()
        prev_ts = None
        for ln in rows:
            if not REPLAY_STATE["active"]:
                break
            try:
                rec = json.loads(ln)
                ts = float(rec.get("ts") or 0)
                if prev_ts and speed > 0:
                    await asyncio.sleep(max(0.0, (ts - prev_ts) / speed))
                prev_ts = ts
                for sym, t in (rec.get("ticks") or {}).items():
                    if not t:
                        continue
                    t = {k: (float(v) if isinstance(v, (int, float)) else v) for k, v in t.items()}
                    t["symbol"] = sym
                    t["source"] = "replay"
                    syms.add(sym)
                    hub._on_broker_tick(t)
                REPLAY_STATE["played"] += 1
                REPLAY_STATE["symbols"] = sorted(syms)
            except Exception:
                continue
        REPLAY_STATE["active"] = False
        config.log("replay", f"finished {REPLAY_STATE['played']}/{REPLAY_STATE['total']} rows")

    _replay_task = asyncio.ensure_future(player())
    return {"ok": True}


async def stop_replay() -> None:
    REPLAY_STATE["active"] = False
    global _replay_task
    if _replay_task and not _replay_task.done():
        _replay_task.cancel()
        try:
            await _replay_task
        except Exception:
            pass
    _replay_task = None


def start_all() -> list[asyncio.Task]:
    from backend.masters import daystart_loop as masters_daystart
    return [
        asyncio.ensure_future(gtt_loop()),
        asyncio.ensure_future(autorules_loop()),
        asyncio.ensure_future(strategies_loop()),
        asyncio.ensure_future(recorder_loop()),
        asyncio.ensure_future(masters_daystart()),
    ]
