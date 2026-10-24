"""Bisect which backend import breaks sqlite UPDATE writes."""
import os, sys
sys.path.insert(0, os.getcwd())
import sqlite3
import sys
import time

CORE = "backend/data/core.db"


def update_test(tag):
    con = sqlite3.connect(CORE, check_same_thread=False)
    con.row_factory = sqlite3.Row
    r = con.execute("INSERT INTO accounts(broker,label,mode,credentials,created_at,updated_at) "
                    "VALUES('breeze','BISECT','live','{}',?,?)", (time.time(), time.time()))
    rid = r.lastrowid
    con.commit()
    cur = con.execute("UPDATE accounts SET credentials=? WHERE id=?",
                      ('{"api_key":"BK"}', rid))
    rc = cur.rowcount
    con.commit()
    back = con.execute("SELECT credentials FROM accounts WHERE id=?", (rid,)).fetchone()[0]
    con.execute("DELETE FROM accounts WHERE id=?", (rid,))
    con.commit()
    con.close()
    print(f"{tag}: rowcount={rc} readback={back}")
    return rc


STEPS = [
    ("bare", []),
    ("backend.config+db", ["backend.config", "backend.db"]),
    ("backend.auth", ["backend.auth"]),
    ("backend.charges_config+charges", ["backend.charges_config", "backend.charges"]),
    ("backend.session_store", ["backend.session_store"]),
    ("backend.fnosim", ["backend.fnosim"]),
    ("backend.options_chain", ["backend.options_chain"]),
    ("backend.market.funds", ["backend.market.funds"]),
    ("backend.market.hub", ["backend.market.hub"]),
    ("backend.masters", ["backend.masters"]),
    ("backend.api.rest", ["backend.api.rest"]),
]

for tag, mods in STEPS:
    for m in mods:
        try:
            __import__(m)
        except Exception as e:
            print(f"{tag}: IMPORT FAILED {m}: {e}")
            break
    try:
        if update_test(tag) != 1:
            print(f"==> BREAKER FOUND: {mods}")
            break
    except Exception as e:
        print(f"{tag}: TEST FAILED: {e}")
        break
