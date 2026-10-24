#!/usr/bin/env python3
"""Round-25 E2E verification — broker auth pipeline + bulk JSON + charges source.
Run against a LIVE stack (./start.sh).  Creates throwaway accounts and cleans up."""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8000/pyapi"
PASS, FAIL = [], []


def req(method, path, body=None, token=None, expect=None):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, data=data, timeout=90) as resp:
            code, payload = resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        code = e.code
        try:
            payload = json.loads(e.read().decode() or "{}")
        except Exception:
            payload = {"raw": "?"}
    if expect and code != expect:
        return code, payload, f"expected {expect} got {code}"
    return code, payload, None


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'  — ' + str(detail)[:160] if (not cond and detail) else ''}")


# ---------------------------------------------------------------- login
code, body, err = req("POST", "/auth/login", {"username": "admin", "password": "admin123"}, expect=200)
TOKEN = body.get("token", "")
check("admin login", bool(TOKEN), err or body)

# ---------------------------------------------------------------- 1. feed POST (was 401 Header bug + _feed_note 500)
code, body, err = req("POST", "/feed", {"source": "sim"}, TOKEN, expect=200)
check("POST /feed 200 (was 401 invalid-token)", code == 200 and body.get("ok"), err or body)
code, body, err = req("GET", "/feed", token=TOKEN, expect=200)
check("GET /feed 200", code == 200, err)

# ---------------------------------------------------------------- 2. export shape
code, body, err = req("GET", "/accounts/export", token=TOKEN, expect=200)
rows = body.get("accounts", [])
keys = set(rows[0].keys()) if rows else set()
need = {"id", "label", "broker", "mode", "credentials", "session", "initialCapital",
        "capitalPct", "capitalMode", "isActive", "isOrderEnabled"}
check("export has FULL row data", need <= keys, f"missing {need - keys}")
check("export session field present", "session" in keys)

# ---------------------------------------------------------------- 3. bulk round-trip: create w/ session + clientId, modify, delete
stamp = str(int(time.time()))
c_red = {"accounts": [
    {"label": f"T25-A {stamp}", "broker": "dhan", "mode": "live",
     "clientId": "1102525252", "credentials": {"api_key": "aid25", "api_secret": "asec25"},
     "session": {"token": f"tok-{stamp}-abc"}, "initialCapital": None,
     "capitalPct": 100, "capitalMode": "LIVE_BALANCE", "isActive": False, "isOrderEnabled": True},
]}
code, body, err = req("POST", "/accounts/bulk", c_red, TOKEN, expect=200)
d0 = body["detail"][0]
check("bulk create 200", body["ok"] and d0["ok"] and d0["action"] == "created", d0.get("error") or body)
new_id = d0.get("id", "")

code, body, err = req("GET", "/accounts/export", token=TOKEN, expect=200)
row = next((r for r in body["accounts"] if r["id"] == new_id), {})
check("created row carries clientId in creds", row.get("credentials", {}).get("client_id") == "1102525252", row.get("credentials"))
check("created row capitalMode LIVE_BALANCE", row.get("capitalMode") == "LIVE_BALANCE", row.get("capitalMode"))
code, body, err = req("GET", "/accounts", token=TOKEN, expect=200)
acc = next((a for a in body["accounts"] if a["id"] == new_id), {})
check("created row hasSession true (session persisted via JSON)", acc.get("hasSession") is True, acc)

mod = {"accounts": [{"id": new_id, "label": f"T25-A-mod {stamp}", "capitalMode": "PROFIT_ONLY",
                     "session": {"token": f"tok-{stamp}-abc"}}]}
code, body, err = req("POST", "/accounts/bulk", mod, TOKEN, expect=200)
check("bulk modify 200 (label+session)", body["ok"] and body["detail"][0]["ok"], body["detail"])
code, body, err = req("GET", "/accounts", token=TOKEN, expect=200)
acc = next((a for a in body["accounts"] if a["id"] == new_id), {})
check("modify applied (label)", acc.get("label") == f"T25-A-mod {stamp}", acc.get("label"))
check("modify applied (modeLabel PROFIT only)", acc.get("mode") == "PROFIT_ONLY", acc.get("mode"))

delq = {"accounts": [{"id": new_id, "_delete": True}]}
code, body, err = req("POST", "/accounts/bulk", delq, TOKEN, expect=200)
check("bulk _delete 200", body["ok"] and body["detail"][0]["action"] == "deleted", body["detail"])

# ---------------------------------------------------------------- 4. Breeze complete — request-object shape now real
c_red = {"accounts": [{"label": f"T25-BRZ {stamp}", "broker": "breeze", "mode": "live",
                       "credentials": {"api_key": "fakey25", "api_secret": "fasec25"}}]}
code, body, err = req("POST", "/accounts/bulk", c_red, TOKEN, expect=200)
brz_id = body["detail"][0]["id"]
t0 = time.time()
code, body, err = req("POST", "/broker-auth",
                      {"accountId": brz_id, "action": "complete", "code": "fakesession123"}, TOKEN)
took = time.time() - t0
msg = body.get("message", "")
check("breeze complete hits REAL api (no Request-Object-Null)",
      "Request Object is Null" not in msg, msg)
check("breeze complete gives actionable breeze error", "Breeze" in msg and took > 0.3, f"{msg} ({took:.1f}s)")
# cleanup
req("POST", "/accounts/bulk", {"accounts": [{"id": brz_id, "_delete": True}]}, TOKEN)

# ---------------------------------------------------------------- 5. Shoonya OAuth fake code — docs-exact GenAcsTok, no 502
c_red = {"accounts": [{"label": f"T25-SHN {stamp}", "broker": "shoonya", "mode": "live",
                       "credentials": {"api_key": f"FA{stamp[-5:]}_U", "api_secret": "shsecret"}}]}
code, body, err = req("POST", "/accounts/bulk", c_red, TOKEN, expect=200)
shn_id = body["detail"][0]["id"]
code, body, err = req("POST", "/broker-auth",
                      {"accountId": shn_id, "action": "complete", "code": "fakeoauthcode123"}, TOKEN)
msg = body.get("message", "")
check("shoonya GenAcsTok no 502 noise (TP dropped)", "HTTP 502" not in msg and "TP " not in msg, msg)
check("shoonya error mentions fresh code", "FRESH" in msg.upper() or "single-use" in msg.lower(), msg)
code, body, err = req("POST", "/broker-auth",
                      {"accountId": shn_id, "action": "complete", "code": "pwd:factor2"}, TOKEN)
msg = body.get("message", "")
check("shoonya QuickAuth honest vendor-gated message", "VENDOR-GATED" in msg, msg)
# cleanup
req("POST", "/accounts/bulk", {"accounts": [{"id": shn_id, "_delete": True}]}, TOKEN)

# ---------------------------------------------------------------- 6. Dhan toggles — no 500 anywhere
c_red = {"accounts": [{"label": f"T25-DHN {stamp}", "broker": "dhan", "mode": "live",
                       "credentials": {"client_id": "1109992525", "api_key": "aid", "api_secret": "asec"}}]}
code, body, err = req("POST", "/accounts/bulk", c_red, TOKEN, expect=200)
dhn_id = body["detail"][0]["id"]
for flag in ("isOrderEnabled", "isCopyMaster"):
    code, body, err = req("PATCH", f"/accounts/{dhn_id}", {flag: True}, TOKEN)
    check(f"dhan toggle {flag} no-500", code == 200, f"HTTP {code} {body}")
code, body, err = req("PATCH", f"/accounts/{dhn_id}", {"isLiveDataSource": True}, TOKEN)
check("dhan toggle Data (unconnected) = clear 400, no 500", code == 400 and "not connected" in str(body), f"HTTP {code} {body}")
code, body, err = req("POST", "/feed", {"source": dhn_id}, TOKEN)
check("feed select unconnected dhan = clear 400", code == 400 and "not connected" in str(body).lower(), f"HTTP {code} {body}")
req("POST", "/accounts/bulk", {"accounts": [{"id": dhn_id, "_delete": True}]}, TOKEN)

# ---------------------------------------------------------------- 7. charges source block
code, body, err = req("POST", "/accounts", {"broker": "sim", "label": f"T25-SIM {stamp}"}, TOKEN, expect=200)
sim_id = body["id"]
code, body, err = req("GET", f"/charges?accountId={sim_id}", token=TOKEN, expect=200)
src = body.get("source") or {}
check("charges source block present", src.get("name") and src.get("asOf"), src)
req("DELETE", f"/accounts/{sim_id}", token=TOKEN)

# ---------------------------------------------------------------- 8. sim intact
code, body, err = req("GET", "/debug/state", token=TOKEN, expect=200)
check("sim hub intact", code == 200 and body.get("sim_account_id"), body.get("sim_account_id"))

print(f"\n===== ROUND-25 E2E: {len(PASS)} PASS / {len(FAIL)} FAIL =====")
if FAIL:
    print("FAILED:", *FAIL, sep="\n  - ")
    raise SystemExit(1)
