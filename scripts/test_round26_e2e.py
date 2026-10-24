#!/usr/bin/env python3
"""Round-26 LIVE-ONLY end-to-end flow against the running stack (throwaway state, restored after)."""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8000/pyapi"
PASS, FAIL = [], []


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


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'  — ' + str(detail)[:180] if (not cond and detail) else ''}")


code, body = req("POST", "/auth/login", {"username": "admin", "password": "admin123"})
TOKEN = body.get("token", "")
assert TOKEN, "login failed"

# 1. enable LIVE-ONLY (admin toggle) while sim is the source and connected
code, body = req("POST", "/feed", {"simDisabled": True}, TOKEN)
check("LIVE-ONLY toggle accepted (sim was connected + source)", code == 200, f"{code} {body}")

# 2. sim engine must be HARD-disconnected
code, accs = req("GET", "/accounts", token=TOKEN)
sim = next((a for a in accs.get("accounts", accs) if isinstance(a, dict) and a.get("broker") == "sim"), {})
check("sim adapter disconnected by the toggle", sim.get("status") == "disconnected",
      str({k: sim.get(k) for k in ("label", "status")}))

# 3. feed status: no ticks flow, honest noSource
code, fs = req("GET", "/feed/status", token=TOKEN)
check("feed_status liveOnly=True", fs.get("liveOnly") is True, str(fs.get("liveOnly")))
check("no ticks cached under LIVE-ONLY", fs.get("symbols") == 0, str(fs.get("symbols")))

# 4. picking sim as source while LIVE mode: round-27 REFUSES it at the API
#    (LIVE = real accounts only — sim is a plain account, never a LIVE source)
code, body = req("POST", "/feed", {"source": "sim"}, TOKEN)
check("sim source pick under LIVE mode refused with 400", code == 400,
      f"{code} {str(body)[:120]}")
code, fs = req("GET", "/feed/status", token=TOKEN)
check("LIVE mode => liveOnly + zero ticks", fs.get("liveOnly") is True
      and fs.get("symbols") == 0, str({k: fs.get(k) for k in ("symbols", "liveOnly", "noSource")}))

# 5. turn LIVE-ONLY off -> sim self-heals on next subscribe
code, body = req("POST", "/feed", {"simDisabled": False}, TOKEN)
check("LIVE-ONLY off accepted", code == 200, f"{code} {body}")
time.sleep(1)
code, body = req("POST", "/feed", {"source": "sim"}, TOKEN)
check("sim source re-pickable", code == 200, f"{code} {body}")
# trigger a subscribe via the watchlist poll (any client sub path); simpler: /feed/status wait then check adapter
deadline = time.time() + 15
reconn = False
while time.time() < deadline:
    code, accs = req("GET", "/accounts", token=TOKEN)
    sim = next((a for a in accs.get("accounts", accs) if isinstance(a, dict) and a.get("broker") == "sim"), {})
    if sim.get("status") == "connected":
        reconn = True
        break
    time.sleep(1.5)
check("sim engine SELF-HEALED after Live-Only off", reconn, sim.get("status"))

# 6. restore a neutral state for the sandbox (sim source, sim enabled)
req("POST", "/feed", {"simDisabled": False}, TOKEN)
req("POST", "/feed", {"source": "sim"}, TOKEN)
code, fs = req("GET", "/feed/status", token=TOKEN)
print("  final feed status:", {k: fs.get(k) for k in ("source", "symbols", "liveOnly", "epoch")})

print(f"\n===== Round-26 E2E: {len(PASS)} PASS / {len(FAIL)} FAIL =====")
if FAIL:
    print("FAILED:", FAIL)
import sys
sys.exit(1 if FAIL else 0)
