"""
Sync pusher — quantdesk parity: ONE websocket subscription (sync:sub)
replaces N polling REST calls.  Loops push:
  sync:core   (1s)  accounts / positions / orders / trades / funds / session
  sync:chain  (1s)  option chain per subscribed underlying+expiry
  sync:index  (2s)  index constituents per subscribed index
  sync:admin  (2s)  feed status, sources, broker logs, audit, copy trade,
                    strategies, sync info, gtt, auto rules, recorder, replay
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Optional

from backend import config, db
from backend.market.hub import Hub
from backend.market.funds import SVC as FUNDS


def _admin_payload() -> dict:
    hub = Hub.instance()
    broker_logs = []
    for acc in db.core().query("SELECT id,label,broker FROM accounts ORDER BY id"):
        rows = db.core().query(
            "SELECT * FROM broker_logs WHERE account_id=? ORDER BY id DESC LIMIT 15", (acc["id"],))
        for r in rows:
            broker_logs.append({
                "ts": time.strftime("%H:%M:%S", time.localtime(r["ts"])),
                "level": r["level"], "message": r["message"],
                "accountId": str(acc["id"]), "accountLabel": acc["label"],
                "brokerType": acc["broker"].upper(),
            })
    broker_logs.sort(key=lambda x: x["ts"], reverse=True)
    audits = [{
        "id": str(r["id"]), "ts": time.strftime("%H:%M:%S", time.localtime(r["ts"])),
        "source": r["source"], "action": r["action"], "masterSymbol": r["master_symbol"],
        "side": r["side"], "qty": r["qty"], "status": r["status"],
        "message": r["message"],
    } for r in db.core().query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 40")]
    ct = db.core().one("SELECT * FROM copytrade WHERE id=1") or {}
    strategies = [{
        "id": str(r["id"]), "name": r["name"], "enabled": bool(r["enabled"]),
        "status": r["status"], "exchange": r["exchange"], "symbol": r["symbol"],
        "direction": r["direction"], "productType": r["product_type"],
        "orderType": r["order_type"], "qtyMode": r["qty_mode"], "fixedQty": r["fixed_qty"],
        "capitalAmount": r["capital_amount"], "entryTime": r["entry_time"],
        "entryWindowMin": r["entry_window_min"], "exitTime": r["exit_time"],
        "repeatDays": r["repeat_days"], "stopLossPct": r["stop_loss_pct"],
        "targetPct": r["target_pct"], "trailingSlPct": r["trailing_sl_pct"],
        "lastRunDate": r["last_run_date"], "entryPrice": r["entry_price"],
        "realizedPnl": r["realized_pnl"], "logs": [],
    } for r in db.core().query("SELECT * FROM strategies ORDER BY id DESC")]
    gtt = [{
        "id": str(r["id"]), "name": r["name"], "symbol": r["symbol"], "exchange": r["exchange"],
        "side": r["side"], "qty": r["qty"], "trigger": r["trigger"],
        "triggerPrice": r["trigger_price"], "orderType": r["order_type"],
        "productType": r["product_type"], "repeatDaily": bool(r["repeat_daily"]),
        "armed": bool(r["armed"]),
        "lastTriggeredAt": time.strftime("%H:%M:%S", time.localtime(r["last_triggered_at"])) if r["last_triggered_at"] else None,
        "lastStatus": r["last_status"], "lastMessage": r["last_message"],
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(r["created_at"])),
    } for r in db.core().query("SELECT * FROM gtt ORDER BY id DESC")]
    auto_rules = [{
        "id": str(r["id"]), "name": r["name"], "underlying": r["underlying"],
        "expiry": r["expiry"], "kind": r["kind"], "level": r["level"], "cross": r["cross"],
        "lo": r["lo"], "hi": r["hi"], "time": r["time"], "entryOp": r["entry_op"],
        "entryLo": r["entry_lo"], "entryHi": r["entry_hi"], "action": r["action"],
        "optType": r["opt_type"], "offset": r["offset"],
        "strikes": json.loads(r["strikes"]) if r["strikes"] else None,
        "allocPct": r["alloc_pct"], "stopLoss": r["stop_loss"], "target": r["target"],
        "enabled": bool(r["enabled"]), "repeatDaily": bool(r["repeat_daily"]),
        "lastFiredDate": r["last_fired_date"],
        "lastFiredAt": time.strftime("%H:%M:%S", time.localtime(r["last_fired_at"])) if r["last_fired_at"] else None,
        "lastStatus": r["last_status"], "lastMessage": r["last_message"],
        "fireCount": r["fire_count"],
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(r["created_at"])),
    } for r in db.core().query("SELECT * FROM autorules ORDER BY id DESC")]
    try:
        with open(__import__("os").path.join(config.DATA_DIR, "tick-recorder.json")) as f:
            rec = json.load(f)
    except Exception:
        rec = {"enabled": False, "symbols": []}
    from backend import engines
    replay = engines.REPLAY_STATE
    last_sync = None
    sym_count = 0
    for name in db.broker_dbs_keys():
        sym_count += db.broker_db(name).one("SELECT COUNT(*) c FROM master")["c"]
        log = db.broker_db(name).one("SELECT ts FROM sync_log ORDER BY ts DESC LIMIT 1")
        if log and (last_sync is None or log["ts"] > last_sync):
            last_sync = log["ts"]
    return {
        "feed": hub.feed_status(),
        "feedSource": {"source": hub.feed_source(), "simDisabled": hub.sim_disabled(), "tradingMode": hub.trading_mode(),
                       "sources": hub.feed_sources()},
        "accountsMeta": [
            {"id": str(a["id"]), "label": a["label"], "brokerType": a["broker"].upper(),
             "isActive": bool(hub.adapters.get(a["id"])),
             "hasCreds": bool(a["credentials"] and a["credentials"] != "{}"),
             "hasSession": bool(db.core().one(
                 "SELECT session_token FROM broker_sessions WHERE account_id=? AND session_token IS NOT NULL",
                 (a["id"],))),
        } for a in db.core().query("SELECT id,label,broker,credentials FROM accounts")],
        "brokerLogs": broker_logs[:40],
        "audit": audits,
        "copyTrade": {"id": "1", "enabled": bool(ct.get("enabled")),
                      "masterAccountId": ct.get("master_account_id"),
                      "capitalSharePct": ct.get("capital_share_pct", 100),
                      "slippagePct": ct.get("slippage_pct", 0.1),
                      "roundToLot": bool(ct.get("round_to_lot", 1)),
                      "skipFailedLegs": bool(ct.get("skip_failed_legs", 1)),
                      "killSwitch": bool(ct.get("kill_switch", 0))} if ct else None,
        "strategies": strategies,
        "syncInfo": {"lastSync": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(last_sync)) if last_sync else None,
                     "counts": {"symbols": sym_count, "mappings": sym_count}},
        "gtt": gtt, "autoRules": auto_rules,
        "tickRecorder": {"enabled": bool(rec.get("enabled")), "symbols": rec.get("symbols", []),
                         "session": None, "sessions": []},
        "replay": {"active": replay["active"], "file": replay["file"], "speed": replay["speed"],
                   "startedAt": replay["startedAt"], "total": replay["total"],
                   "played": replay["played"], "symbols": replay["symbols"],
                   "progressPct": (replay["played"] / replay["total"] * 100) if replay["total"] else 0},
        "ts": int(time.time() * 1000),
    }


async def _push_chains(sio) -> None:
    hub = Hub.instance()
    # union of all subscribed chains
    union: dict[tuple[str, Optional[str]], list[str]] = {}
    for sid, subs in hub._sync_subs.items():
        for c in subs.get("chains", []):
            key = (c.get("underlying", ""), c.get("expiry") or None)
            union.setdefault(key, []).append(sid)
    for (underlying, expiry), sids in union.items():
        if not underlying:
            continue
        try:
            payload = hub.chain_payload(underlying, expiry)
            for sid in sids:
                await sio.emit("sync:chain", payload, to=sid)
        except Exception as e:
            config.log("sync", f"chain {underlying}: {e}", "WARN")


async def _push_index(sio) -> None:
    hub = Hub.instance()
    union: dict[str, set[str]] = {}
    for sid, subs in hub._sync_subs.items():
        for sym in subs.get("index", []):
            union.setdefault(sym, set()).add(sid)
    for sym, sids in union.items():
        try:
            payload = hub.index_payload(sym)
            for sid in sids:
                await sio.emit("sync:index", payload, to=sid)
        except Exception as e:
            config.log("sync", f"index {sym}: {e}", "WARN")


async def run_sync_loops() -> None:
    """Background loops started from main.py once the sio server is up."""
    sio_holder = {"sio": None}

    def watch():
        sio_holder["sio"] = Hub.instance().sio
    watch()
    core_t = 0.0
    admin_t = 0.0
    while True:
        try:
            sio = Hub.instance().sio
            if sio:
                now = time.time()
                if now - core_t >= 1.0:
                    core_t = now
                    try:
                        await sio.emit("sync:core", Hub.instance().core_payload())
                    except Exception as e:
                        config.log("sync", f"core: {e}", "WARN")
                if now - admin_t >= 2.0:
                    admin_t = now
                    try:
                        await sio.emit("sync:admin", _admin_payload())
                        await _push_index(sio)
                    except Exception as e:
                        config.log("sync", f"admin: {e}", "WARN")
                await _push_chains(sio)
        except Exception as e:
            config.log("sync", f"loop: {e}", "ERROR")
        await asyncio.sleep(0.4)
