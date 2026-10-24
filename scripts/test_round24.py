"""Round-24 E2E verification — broker auth fixes + bulk accounts + LIVE_BALANCE."""
import json
import urllib.request

BASE = "http://localhost:8000/pyapi"
TOKEN = open("/tmp/qd_token").read().strip()


def call(method, path, body=None, expect_error=False):
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


results = []

# ---------------------------------------------------------------- 1. create ICICI account with CAMELCASE creds (the user's broken shape)
st, r = call("POST", "/accounts", {
    "broker": "breeze", "label": "R24 ICICI camel", "mode": "live",
    "credentials": {"apiKey": "R24TESTKEY123456", "apiSecret": "R24secretABCD"},
    "initialCapital": 250000, "capitalMode": "INITIAL_PLUS_PNL"})
aid = r.get("id")
results.append(check("create breeze account with camelCase creds", st == 200 and aid, str(r)[:120]))

# raw DB row must now store SNAKE_CASE
st, r = call("GET", f"/accounts/{aid}") if False else (None, None)
import sqlite3
con = sqlite3.connect("backend/data/core.db")
con.row_factory = sqlite3.Row
row = con.execute("SELECT credentials FROM accounts WHERE id=?", (int(aid),)).fetchone()
creds = json.loads(row["credentials"])
results.append(check("credentials normalized to snake_case on CREATE",
                     creds.get("api_key") == "R24TESTKEY123456" and creds.get("api_secret") == "R24secretABCD"
                     and "apiKey" not in creds, json.dumps(creds)))

# ---------------------------------------------------------------- 2. GET /broker-auth — login URL substituted
st, r = call("GET", f"/broker-auth?accountId={aid}")
url = r.get("loginUrl") or ""
results.append(check("ICICI login URL has api_key substituted",
                     st == 200 and "apiuser/login?api_key=R24TESTKEY123456" in url and "{api_key}" not in url, url))
results.append(check("fieldsNeeded empty (creds saved)", r.get("fieldsNeeded") == [], str(r.get("fieldsNeeded"))))

# ---------------------------------------------------------------- 3. PATCH credentialsMerge (pencil-edit shape) on a fresh row
st, r = call("POST", "/accounts", {
    "broker": "breeze", "label": "R24 ICICI merge", "mode": "live",
    "initialCapital": 250000})
aid2 = r.get("id")
st, r = call("PATCH", f"/accounts/{aid2}", {"credentialsMerge": {"api_key": "MERGEKEY999", "api_secret": "mergesecret"}})
row = con.execute("SELECT credentials FROM accounts WHERE id=?", (int(aid2),)).fetchone()
creds = json.loads(row["credentials"])
results.append(check("PATCH credentialsMerge persists (was silently dropped)",
                     creds.get("api_key") == "MERGEKEY999" and creds.get("api_secret") == "mergesecret", json.dumps(creds)))

# masked echo must NOT overwrite stored value
st, r = call("PATCH", f"/accounts/{aid2}", {"credentialsMerge": {"api_secret": "••••cret"}})
row = con.execute("SELECT credentials FROM accounts WHERE id=?", (int(aid2),)).fetchone()
results.append(check("masked echo keeps stored secret",
                     json.loads(row["credentials"]).get("api_secret") == "mergesecret", row["credentials"]))

# GET /broker-auth now sees the merged key
st, r = call("GET", f"/broker-auth?accountId={aid2}")
results.append(check("merged api_key visible in login URL",
                     "apiuser/login?api_key=MERGEKEY999" in (r.get("loginUrl") or ""), r.get("loginUrl")))

# ---------------------------------------------------------------- 4. POST complete — relaxed guard: api_key only
st, r = call("POST", "/broker-auth", {"accountId": aid2, "action": "complete", "code": "FAKEAPISESSION123"})
msg = r.get("message", "")
results.append(check("complete without api_secret NOT blocked by old guard",
                     "Save the App Key + App Secret" not in msg, f"ok={r.get('ok')} msg={msg[:90]}"))
# fake session → real broker API → friendly rejection (never 405)
results.append(check("fake apisession reaches breeze customerdetails (friendly error)",
                     r.get("ok") is False and "rejected" in msg.lower(), msg[:100]))

# no api_key at all → actionable guard
st, r = call("POST", "/accounts", {"broker": "breeze", "label": "R24 nokey", "mode": "live"})
aid3 = r.get("id")
st, r = call("POST", "/broker-auth", {"accountId": aid3, "action": "complete", "code": "XYZ"})
results.append(check("guard fires only when api_key truly missing",
                     r.get("ok") is False and "Save the App Key" in r.get("message", ""), r.get("message", "")[:90]))

# ---------------------------------------------------------------- 5. Shoonya camelCase (add-dialog shape) — guard must not fire
st, r = call("POST", "/accounts", {
    "broker": "shoonya", "label": "R24 shoonya camel", "mode": "live",
    "credentials": {"userId": "FA12345", "apiKey": "FA12345_U", "apiSecret": "shsecret123"}})
aid4 = r.get("id")
row = con.execute("SELECT credentials FROM accounts WHERE id=?", (int(aid4),)).fetchone()
creds = json.loads(row["credentials"])
results.append(check("shoonya camelCase creds normalized (userId→user_id, apiKey→api_key)",
                     creds.get("api_key") == "FA12345_U" and creds.get("user_id") == "FA12345"
                     and creds.get("api_secret") == "shsecret123", json.dumps(creds)))
st, r = call("GET", f"/broker-auth?accountId={aid4}")
results.append(check("shoonya OAuth URL has client_id substituted",
                     "OAuthlogin/authorize/oauth?client_id=FA12345_U" in (r.get("loginUrl") or ""), r.get("loginUrl")))
st, r = call("POST", "/broker-auth", {"accountId": aid4, "action": "complete", "code": "freshfakecode123"})
msg = r.get("message", "")
results.append(check("shoonya paste does NOT hit the save-credentials guard",
                     "Save api_key" not in msg, f"ok={r.get('ok')} msg={msg[:90]}"))

# ---------------------------------------------------------------- 6. Dhan camelCase + auto-consent URL
st, r = call("POST", "/accounts", {
    "broker": "dhan", "label": "R24 dhan camel", "mode": "live",
    "credentials": {"appId": "R24appid", "appSecret": "R24appsecret", "clientId": "1101234567"}})
aid5 = r.get("id")
row = con.execute("SELECT credentials FROM accounts WHERE id=?", (int(aid5),)).fetchone()
creds = json.loads(row["credentials"])
results.append(check("dhan camelCase creds normalized (appId→api_key, appSecret→api_secret)",
                     creds.get("api_key") == "R24appid" and creds.get("api_secret") == "R24appsecret"
                     and creds.get("client_id") == "1101234567", json.dumps(creds)))
st, r = call("GET", f"/broker-auth?accountId={aid5}")
url = r.get("loginUrl") or ""
# consent generation hits the real dhan API — accepts success OR graceful failure,
# but NEVER the static web login URL when app creds exist
results.append(check("dhan loginUrl is consentApp-login or graceful fallback (never static web URL)",
                     ("consentApp-login?consentAppId=" in url) or ("generateAccessToken" in " ".join(r.get("instructions", [])) and url == ""),
                     url[:90]))

# ---------------------------------------------------------------- 7. LIVE_BALANCE capital mode
st, r = call("PATCH", f"/accounts/{aid}", {"capitalMode": "LIVE_BALANCE"})
results.append(check("PATCH capitalMode LIVE_BALANCE accepted", st == 200 and r.get("account", {}).get("mode") == "LIVE_BALANCE",
                     str(r.get("account", {}).get("mode"))))
st, r = call("GET", "/accounts")
row5 = next((a for a in r["accounts"] if a["id"] == aid), {})
results.append(check("account row shows LIVE_BALANCE + label",
                     row5.get("mode") == "LIVE_BALANCE" and row5.get("modeLabel") == "Broker balance",
                     f"{row5.get('mode')} / {row5.get('modeLabel')}"))
# usable capital should equal the funds snapshot available when present
fs = con.execute("SELECT data FROM funds_snapshot WHERE account_id=?", (int(aid),)).fetchone()
if fs:
    avail = json.loads(fs["data"]).get("available")
    if avail is not None:
        results.append(check("usable capital == funds available (LIVE_BALANCE)",
                             abs(row5.get("usableCapital", 0) - avail) < 1.0,
                             f"usable={row5.get('usableCapital')} avail={avail}"))
else:
    print("SKIP  usable==funds (no snapshot yet for test account)")

# ---------------------------------------------------------------- 8. BULK accounts
# current data snapshot
st, cur = call("GET", "/accounts")
bulk_rows = [{
    "id": a["id"], "label": a["label"],
    "broker": {"SIMFEED": "sim", "ICICI_BREEZE": "breeze", "DHAN": "dhan", "SHOONYA": "shoonya"}.get(a["brokerType"], "sim"),
    "mode": a.get("modeLabel2") or "live",
    "credentials": a.get("credentials") or {},
    "initialCapital": a.get("initialCapitalFixed"),
    "capitalPct": a.get("capitalPct", 100),
    "capitalMode": a.get("mode"),
} for a in cur["accounts"]]
# modify one + add one new
for b in bulk_rows:
    if b["id"] == aid:
        b["label"] = "R24 ICICI camel RENAMED"
        b["capitalMode"] = "LIVE_BALANCE"
bulk_rows.append({"label": "R24 bulk added", "broker": "shoonya", "mode": "live",
                  "credentials": {"apiKey": "BULK123_U", "apiSecret": "bulksecret"},
                  "initialCapital": 100000, "capitalMode": "PROFIT_ONLY"})
st, r = call("POST", "/accounts/bulk", {"accounts": bulk_rows, "deleteMissing": False})
counts = r.get("counts", {})
results.append(check("bulk: 1 modified + 1 created", st == 200 and counts.get("modified") == 1 and counts.get("created") == 1,
                     json.dumps(counts)))
bulk_added = next((d for d in r.get("detail", []) if d.get("action") == "created"), {})
new_id = bulk_added.get("id")
row = con.execute("SELECT credentials FROM accounts WHERE id=?", (int(new_id),)).fetchone()
results.append(check("bulk create normalized creds too",
                     json.loads(row["credentials"]).get("api_key") == "BULK123_U", row["credentials"]))
st, cur = call("GET", "/accounts")
renamed = next((a for a in cur["accounts"] if a["id"] == aid), {})
results.append(check("bulk modify applied (label + mode)", renamed.get("label") == "R24 ICICI camel RENAMED"
                     and renamed.get("mode") == "LIVE_BALANCE", str(renamed.get("label"))))

# _delete flag + deleteMissing
st, r = call("POST", "/accounts/bulk", {"accounts": [{"id": new_id, "_delete": True}], "deleteMissing": False})
results.append(check("bulk _delete row works", st == 200 and r["counts"]["deleted"] == 1, json.dumps(r["counts"])))
st, cur = call("GET", "/accounts")
keep = [a["id"] for a in cur["accounts"] if a["id"] in (str(aid2), str(aid3))]
results.append(check("survivors present before deleteMissing", len(keep) == 2, str(keep)))
st, r = call("POST", "/accounts/bulk", {"accounts": [], "deleteMissing": True})
results.append(check("deleteMissing removes everything not listed", st == 200 and r["counts"]["deleted"] >= 2,
                     json.dumps(r["counts"])))
st, cur = call("GET", "/accounts")
ids_now = [a["id"] for a in cur["accounts"]]
results.append(check("test accounts gone, sim remains", str(aid) not in ids_now and str(aid2) not in ids_now
                     and str(aid3) not in ids_now and str(aid4) not in ids_now and str(aid5) not in ids_now
                     and any(a["brokerType"] == "SIMFEED" for a in cur["accounts"]), str(ids_now)))

con.close()
print()
failed = sum(1 for _ in results if _ is False)
print(f"=== {len(results) - failed}/{len(results)} passed ===")
