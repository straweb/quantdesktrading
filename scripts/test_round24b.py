"""Round-24 E2E verification v2 — corrected expectations, sim-safe cleanup."""
import json
import sqlite3
import urllib.request

BASE = "http://localhost:8000/pyapi"
TOKEN = open("/tmp/qd_token").read().strip()
DB = "backend/data/core.db"


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {TOKEN}"},
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    return cond


results, created = [], []

# 0 — sim account back after restart
st, r = call("GET", "/accounts")
sim = next((a for a in r["accounts"] if a["brokerType"] == "SIM"), None)
results.append(check("sim account restored on boot", sim is not None, str([a['label'] for a in r['accounts']])))

# 1 — create breeze account with CAMELCASE creds (the user's broken add-dialog shape)
st, r = call("POST", "/accounts", {
    "broker": "breeze", "label": "R24 ICICI camel", "mode": "live",
    "credentials": {"apiKey": "R24TESTKEY123456", "apiSecret": "R24secretABCD"},
    "initialCapital": 250000, "capitalMode": "INITIAL_PLUS_PNL"})
aid = r.get("id"); created.append(aid)
con = sqlite3.connect(DB)
creds = json.loads(con.execute("SELECT credentials FROM accounts WHERE id=?", (int(aid),)).fetchone()[0])
results.append(check("camelCase creds normalized on CREATE",
                     creds.get("api_key") == "R24TESTKEY123456" and "apiKey" not in creds, json.dumps(creds)))

# 2 — GET /broker-auth: login URL substituted
st, r = call("GET", f"/broker-auth?accountId={aid}")
results.append(check("ICICI login URL api_key substituted",
                     "apiuser/login?api_key=R24TESTKEY123456" in (r.get("loginUrl") or ""), r.get("loginUrl")))

# 3 — PATCH credentialsMerge (pencil-edit shape) on a creds-less account
st, r = call("POST", "/accounts", {"broker": "breeze", "label": "R24 merge", "mode": "live", "initialCapital": 100000})
aid2 = r.get("id"); created.append(aid2)
st, r = call("PATCH", f"/accounts/{aid2}", {"credentialsMerge": {"api_key": "MERGEKEY999", "api_secret": "mergesecret"}})
creds = json.loads(con.execute("SELECT credentials FROM accounts WHERE id=?", (int(aid2),)).fetchone()[0])
results.append(check("PATCH credentialsMerge persists (was silently dropped)",
                     creds.get("api_key") == "MERGEKEY999" and creds.get("api_secret") == "mergesecret", json.dumps(creds)))
st, r = call("PATCH", f"/accounts/{aid2}", {"credentialsMerge": {"api_secret": "••••cret"}})
creds = json.loads(con.execute("SELECT credentials FROM accounts WHERE id=?", (int(aid2),)).fetchone()[0])
results.append(check("masked echo keeps stored secret", creds.get("api_secret") == "mergesecret", json.dumps(creds)))
st, r = call("GET", f"/broker-auth?accountId={aid2}")
results.append(check("merged key visible in login URL", "api_key=MERGEKEY999" in (r.get("loginUrl") or ""), r.get("loginUrl")))

# 4 — complete flow: relaxed guard + real-API rejection (no 405)
st, r = call("POST", "/broker-auth", {"accountId": aid2, "action": "complete", "code": "FAKEAPISESSION123"})
msg = r.get("message", "")
results.append(check("complete proceeds past the api_secret guard",
                     "Save the App Key + App Secret" not in msg, msg[:110]))
results.append(check("fake apisession hits REAL breeze API (friendly reject)",
                     r.get("ok") is False and "rejected" in msg.lower(), msg[:110]))

# 5 — shoonya camelCase (add-dialog shape)
st, r = call("POST", "/accounts", {
    "broker": "shoonya", "label": "R24 shoonya", "mode": "live",
    "credentials": {"userId": "FA12345", "apiKey": "FA12345_U", "apiSecret": "shsecret123"}})
aid4 = r.get("id"); created.append(aid4)
st, r = call("GET", f"/broker-auth?accountId={aid4}")
results.append(check("shoonya OAuth URL client_id substituted",
                     "client_id=FA12345_U" in (r.get("loginUrl") or ""), r.get("loginUrl")))
st, r = call("POST", "/broker-auth", {"accountId": aid4, "action": "complete", "code": "freshfakecode123"})
results.append(check("shoonya paste passes the credentials guard",
                     "Save api_key" not in r.get("message", ""), r.get("message", "")[:110]))

# 6 — dhan camelCase + auto-consent (fake creds → real API 401 → graceful fallback)
st, r = call("POST", "/accounts", {
    "broker": "dhan", "label": "R24 dhan", "mode": "live",
    "credentials": {"appId": "R24appid", "appSecret": "R24appsecret", "clientId": "1101234567"}})
aid5 = r.get("id"); created.append(aid5)
st, r = call("GET", f"/broker-auth?accountId={aid5}")
results.append(check("dhan GET /broker-auth returns (auto-consent attempted, fallback safe)",
                     st == 200 and "loginUrl" in r, str(r.get("loginUrl"))[:80]))

# 7 — LIVE_BALANCE capital mode
st, r = call("PATCH", f"/accounts/{aid}", {"capitalMode": "LIVE_BALANCE"})
results.append(check("PATCH capitalMode LIVE_BALANCE", r.get("account", {}).get("mode") == "LIVE_BALANCE",
                     str(r.get("account", {}).get("mode"))))
st, r = call("GET", "/accounts")
row = next((a for a in r["accounts"] if a["id"] == aid), {})
results.append(check("row exposes LIVE_BALANCE + 'Broker balance' label",
                     row.get("mode") == "LIVE_BALANCE" and row.get("modeLabel") == "Broker balance",
                     f"{row.get('mode')} / {row.get('modeLabel')}"))
st, r = call("POST", "/funds", {"accountId": aid})   # force a funds snapshot attempt (breeze fake → sim-safe)
row = next((a for a in call("GET", "/accounts")[1]["accounts"] if a["id"] == aid), {})
results.append(check("LIVE_BALANCE falls back to initial+realized w/o snapshot",
                     row.get("usableCapital") == 250000, f"usable={row.get('usableCapital')}"))

# 8 — bulk: prefill shape → rename one + add one; keep sim in the list
st, cur = call("GET", "/accounts")
NAME = {"SIMFEED": "sim", "ICICI_BREEZE": "breeze", "DHAN": "dhan", "SHOONYA": "shoonya", "BREEZE": "breeze"}
bulk_rows = [{"id": a["id"], "label": a["label"], "broker": NAME.get(a["brokerType"], "sim"),
              "mode": a.get("modeLabel2") or "live", "credentials": a.get("credentials") or {},
              "initialCapital": a.get("initialCapitalFixed"), "capitalPct": a.get("capitalPct", 100),
              "capitalMode": a.get("mode")} for a in cur["accounts"]]
for b in bulk_rows:
    if b["id"] == aid:
        b["label"] = "R24 ICICI RENAMED"
        b["capitalMode"] = "LIVE_BALANCE"
bulk_rows.append({"label": "R24 bulk added", "broker": "shoonya", "mode": "live",
                  "credentials": {"apiKey": "BULK123_U", "apiSecret": "bulksecret"},
                  "initialCapital": 100000, "capitalMode": "PROFIT_ONLY"})
st, r = call("POST", "/accounts/bulk", {"accounts": bulk_rows, "deleteMissing": False})
cnt = r.get("counts", {})
results.append(check("bulk apply ok (>=1 modified, 1 created)", st == 200 and r.get("ok")
                     and cnt.get("modified", 0) >= 1 and cnt.get("created") == 1, json.dumps(cnt)))
new_id = next((d.get("id") for d in r.get("detail", []) if d.get("action") == "created"), None)
created.append(new_id)
creds = json.loads(con.execute("SELECT credentials FROM accounts WHERE id=?", (int(new_id),)).fetchone()[0])
results.append(check("bulk create normalizes creds", creds.get("api_key") == "BULK123_U", json.dumps(creds)))
cur = call("GET", "/accounts")[1]["accounts"]
renamed = next((a for a in cur if a["id"] == aid), {})
results.append(check("bulk modify applied (rename + LIVE_BALANCE)",
                     renamed.get("label") == "R24 ICICI RENAMED" and renamed.get("mode") == "LIVE_BALANCE",
                     str(renamed.get("label"))))

# 9 — _delete row + deleteMissing (SAFE: list sim + nothing else afterwards)
st, r = call("POST", "/accounts/bulk", {"accounts": [{"id": new_id, "_delete": True}], "deleteMissing": False})
results.append(check("bulk _delete row", r.get("counts", {}).get("deleted") == 1, json.dumps(r.get("counts"))))
sim_id = next(a["id"] for a in call("GET", "/accounts")[1]["accounts"] if a["brokerType"] == "SIM")
st, r = call("POST", "/accounts/bulk", {"accounts": [{"id": sim_id, "label": "Simulated Feed"}],
                                        "deleteMissing": True})
cnt = r.get("counts", {})
ids_now = [a["id"] for a in call("GET", "/accounts")[1]["accounts"]]
results.append(check("deleteMissing wipes everything except listed sim",
                     cnt.get("deleted", 0) >= 4 and ids_now == [sim_id], f"cnt={cnt} ids={ids_now}"))

con.close()
failed = results.count(False)
print(f"\n=== {len(results) - failed}/{len(results)} passed ===")
