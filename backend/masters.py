"""
Master contract sync orchestration — per ACCOUNT (not per broker type):

  • sync_account(account_row, trigger) — runs adapter.sync_master() with the
    account's OWN adapter (a connected hub adapter keeps its live session) and
    writes a history row into core.master_sync_log.
  • sync_active_accounts(trigger) — "Sync Now" for every ACTIVE/CONNECTED
    account (falls back to one account per configured broker when nothing is
    connected, so a fresh install can still build the universe).
  • Auto-sync hooks: on broker CONNECT (hub) and at DAY START (engines loop)
    — new symbols list daily, so every connected broker refreshes each morning.

History powers the Admin → Master Contracts card: broker-wise last sync,
trigger (manual/connect/day), symbols + mappings counts, duration, status.
"""
from __future__ import annotations

from typing import Optional
import asyncio
import json
import time

from backend import config, db


def _ensure_table() -> None:
    db.core().exec("""CREATE TABLE IF NOT EXISTS master_sync_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER, broker TEXT NOT NULL, label TEXT,
        trigger TEXT, source_kind TEXT, source_url TEXT,
        symbols INTEGER DEFAULT 0, mappings INTEGER DEFAULT 0,
        status TEXT, error TEXT, duration_s REAL, ts REAL NOT NULL)""")


def history(limit: int = 40) -> list[dict]:
    _ensure_table()
    rows = db.core().query(
        "SELECT * FROM master_sync_log ORDER BY id DESC LIMIT ?", (limit,))
    return [{
        "id": r["id"], "accountId": r["account_id"], "broker": r["broker"],
        "label": r["label"], "trigger": r["trigger"], "sourceKind": r["source_kind"],
        "sourceUrl": r["source_url"], "symbols": r["symbols"], "mappings": r["mappings"],
        "status": r["status"], "error": r["error"], "durationS": r["duration_s"],
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(r["ts"])),
        "tsRaw": r["ts"],
    } for r in rows]


def last_sync_per_account() -> dict[int, dict]:
    _ensure_table()
    rows = db.core().query(
        "SELECT account_id, MAX(ts) ts FROM master_sync_log WHERE status='ok' GROUP BY account_id")
    return {r["account_id"]: {"ts": r["ts"]} for r in rows}


def _record(account: dict, trigger: str, result: Optional[dict], error: Optional[str],
            duration: float) -> None:
    ok = error is None
    r = result or {}
    try:
        db.core().exec(
            "INSERT INTO master_sync_log(account_id,broker,label,trigger,source_kind,"
            "source_url,symbols,mappings,status,error,duration_s,ts) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (account.get("id"), account.get("broker"), account.get("label"),
             trigger, r.get("source_kind") or r.get("sourceKind"),
             r.get("source_url") or r.get("sourceUrl"),
             int(r.get("symbols") or 0), int(r.get("mappings") or 0),
             "ok" if ok else "failed", (error or "")[:400], round(duration, 2), time.time()))
    except Exception as e:
        config.log("masters", f"history write failed: {e}", "WARN")


async def sync_account(account: dict, trigger: str = "manual", adapter=None) -> dict:
    """Sync ONE account's broker master + record history. Uses the connected
    hub adapter when available (keeps its live session), else builds a fresh
    adapter from the account row."""
    from backend.brokers.registry import REGISTRY
    from backend.market.hub import Hub
    _ensure_table()
    broker = account["broker"]
    hub = Hub.instance()
    if adapter is None:
        adapter = hub.adapters.get(int(account["id"]))
    if adapter is None:
        spec = REGISTRY.get(broker)
        if not spec:
            return {"account": account.get("label"), "broker": broker,
                    "error": f"unknown broker {broker}"}
        try:
            creds = json.loads(account.get("credentials") or "{}")
        except Exception:
            creds = {}
        adapter = spec["adapter"](dict(account), creds)
    t0 = time.time()
    try:
        result = await adapter.sync_master()
        _record(account, trigger, result, None, time.time() - t0)
        out = {"account": account.get("label"), "accountId": account.get("id"),
               "broker": broker, "trigger": trigger, **{k: result.get(k) for k in
               ("symbols", "mappings", "source", "source_kind", "replaced")}}
        config.log("masters", f"sync ok ({trigger}) {broker}/{account.get('label')}: "
                              f"{out.get('symbols')} symbols, {out.get('mappings')} mappings")
        return out
    except Exception as e:
        _record(account, trigger, None, str(e), time.time() - t0)
        config.log("masters", f"sync FAILED ({trigger}) {broker}/{account.get('label')}: {e}", "WARN")
        return {"account": account.get("label"), "accountId": account.get("id"),
                "broker": broker, "trigger": trigger, "error": str(e)[:200]}


def _reload_token_maps(broker: str) -> None:
    from backend.market.hub import Hub
    hub = Hub.instance()
    for aid in list(hub.adapters):
        acc = db.core().one("SELECT broker FROM accounts WHERE id=?", (aid,))
        if acc and acc["broker"] == broker:
            hub._load_token_map(aid)


async def sync_active_accounts(trigger: str = "manual") -> dict:
    """'Sync Now' — every ACTIVE/CONNECTED account, in parallel.  When no
    live account is connected, fall back to one account per configured
    broker (fresh-install bootstrap)."""
    from backend.market.hub import Hub
    _ensure_table()
    hub = Hub.instance()
    accounts: list[dict] = []
    connected_ids = {int(aid) for aid in hub.adapters}
    for aid in sorted(connected_ids):
        row = db.core().one("SELECT * FROM accounts WHERE id=?", (aid,))
        if row:
            accounts.append(dict(row))   # sim INCLUDED — its generated universe
            continue                     # must refresh after mapping changes
    if not accounts:
        seen: set[str] = set()
        for row in db.core().query("SELECT * FROM accounts ORDER BY id"):
            if row["broker"] not in seen:
                seen.add(row["broker"])
                accounts.append(dict(row))
    if not accounts:
        return {"ok": False, "message": "no broker accounts configured", "detail": []}

    async def one(acc: dict) -> dict:
        res = await sync_account(acc, trigger)
        return res

    import asyncio
    detail = await asyncio.gather(*(one(a) for a in accounts))
    for acc in accounts:
        _reload_token_maps(acc["broker"])
    if hub.sio:
        for d in detail:
            if "error" not in d:
                await hub.sio.emit("master:synced", d)
    return {
        "ok": all("error" not in d for d in detail),
        "symbolCount": sum(int(d.get("symbols") or 0) for d in detail),
        "mappedCount": sum(int(d.get("mappings") or 0) for d in detail),
        "accounts": len(detail),
        "detail": list(detail),
    }


async def auto_sync_on_connect(account: dict) -> None:
    """Fire-and-forget master sync when a broker account connects."""
    try:
        await sync_account(account, trigger="connect")
        _reload_token_maps(account["broker"])
    except Exception as e:
        config.log("masters", f"connect-sync failed {account.get('broker')}: {e}", "WARN")


def _ist_now_parts() -> tuple[str, int]:
    from backend.fnosim import _ist_now
    n = _ist_now()
    return n.strftime("%Y-%m-%d"), n.hour * 100 + n.minute


async def daystart_loop() -> None:
    """Every 5 min: after 08:00 IST, sync every broker account that has not
    been synced yet today (new symbols list every day).  Covers CONNECTED
    accounts AND accounts that merely hold a session (first login of the day
    must pull the fresh master contract even before the account is connected)."""
    from backend.market.hub import Hub
    _ensure_table()
    done_date: dict[int, str] = {}
    while True:
        try:
            today, hhmm = _ist_now_parts()
            if hhmm >= 800:
                hub = Hub.instance()
                aids = {int(a) for a in hub.adapters}
                for r in db.core().query(
                        "SELECT DISTINCT account_id FROM broker_sessions "
                        "WHERE session_token IS NOT NULL AND session_token <> ''"):
                    aids.add(int(r["account_id"]))
                for aid in sorted(aids):
                    acc = db.core().one("SELECT * FROM accounts WHERE id=?", (aid,))
                    if not acc or acc["broker"] == "sim":
                        continue
                    if done_date.get(aid) == today:
                        continue
                    last = db.core().one(
                        "SELECT MAX(ts) ts FROM master_sync_log WHERE account_id=? AND status='ok'",
                        (aid,))
                    synced_today = False
                    if last and last["ts"]:
                        from backend.fnosim import _ist_date
                        synced_today = _ist_date(int(last["ts"])) == today
                    if synced_today:
                        done_date[aid] = today
                        continue
                    await sync_account(dict(acc), trigger="day")
                    _reload_token_maps(acc["broker"])
                    done_date[aid] = today
        except Exception as e:
            config.log("masters", f"day-start loop error: {e}", "WARN")
        await asyncio.sleep(300)
