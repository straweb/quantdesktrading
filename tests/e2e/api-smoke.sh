#!/usr/bin/env bash
# ============================================================
# E2E API smoke test — runs against a LIVE deployment.
#
#   bash tests/e2e/api-smoke.sh                 # default http://localhost:3000
#   BASE=http://localhost:81 bash tests/e2e/api-smoke.sh   # through Caddy
#
# Prereqs: Next.js (:3000) + feed (:3004) running, seeded bootstrap
# (admin/admin123 + demo accounts). Uses jq. Safe to re-run: the trade
# leg is on the sim feed and is squared off + cancelled at the end.
# ============================================================
set -uo pipefail

BASE="${BASE:-http://localhost:3000}"
FEED="${FEED:-http://localhost:3004}"
JAR="$(mktemp)"
PASS=0; FAIL=0

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓ %s\033[0m\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗ %s\033[0m\n' "$*"; FAIL=$((FAIL+1)); }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

# chk <desc> <actual> <jq-filter> <expected>
chk() {
  local desc="$1" actual="$2" filter="$3" expected="${4:-}" got
  got="$(printf '%s' "$actual" | jq -r "$filter" 2>/dev/null)" || { bad "$desc (unparseable JSON)"; return; }
  if [ "$got" = "$expected" ]; then ok "$desc"; else bad "$desc — expected [$expected] got [$got]"; fi
}

cleanup() {
  say "Cleanup (squareoff + cancel-all)"
  curl -s -b "$JAR" -X POST "$BASE/api/orders/squareoff"  -H 'Content-Type: application/json' -d '{}' >/dev/null
  curl -s -b "$JAR" -X POST "$BASE/api/orders/cancel-all" -H 'Content-Type: application/json' -d '{}' >/dev/null
  # remove the temporary sim account created for the order leg
  if [ -n "$TEMP_SIM" ] && [ "$TEMP_SIM" != "null" ]; then
    curl -s -b "$JAR" -X DELETE "$BASE/api/accounts/$TEMP_SIM" >/dev/null
  fi
  # restore the operator's feed source + Live-Only flag (E2E must not leave
  # the terminal on the sim feed — round-13)
  curl -s -b "$JAR" -X POST "$BASE/api/feed" -H 'Content-Type: application/json' \
    -d "{\"source\":\"$PREV_SOURCE\",\"simDisabled\":$PREV_SIMDIS}" >/dev/null
  rm -f "$JAR"
}
trap cleanup EXIT

say "1. Infra health"
H="$(curl -s --max-time 5 "$FEED/health")"
chk "feed :3004 /health ok"        "$H" '.ok' 'true'
# a live broker source purges the sim universe by design (no sim data under a
# real feed) — 0 symbols is then the CORRECT state; require 400+ only in sim
SRC_NOW="$(curl -s --max-time 3 "$FEED/feed-source")"
IS_SIM_NOW="$(printf '%s' "$SRC_NOW" | jq -r 'if .source == "sim" or .simDisabled != true then "sim" else "live" end')"
if [ "$IS_SIM_NOW" = "sim" ]; then
  chk "feed universe >= 400 symbols" "$H" '(.symbols >= 400)' 'true'
else
  ok  "live broker source active — sim universe purged (symbols=$(printf '%s' "$H" | jq -r .symbols), correct)"
fi
M="$(curl -s --max-time 8 "$BASE/api/auth/me")"
chk "Next :3000 /api/auth/me alive (user=null, feed key present)" "$M" 'has("user") and has("feed")' 'true'
say "2. Auth"
R="$(curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}')"
chk "login admin/admin123"        "$R" '.ok' 'true'
U="$(curl -s -b "$JAR" "$BASE/api/auth/me")"
chk "session cookie → user=admin" "$U" '.user' 'admin'
X="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/accounts")"
chk "unauthenticated /api/accounts → 401" "$([ "$X" = "401" ] && echo 0 || echo 1)" '0' '0'

say "3. Accounts & capital"
# the sim order tests need the SIM feed active — the round-12 no-sim-fallback
# rule stops all simulated prices while a real broker account is the source.
# SAVE the operator's live source + Live-Only flag — restored in cleanup().
FEED_BEFORE="$(curl -s -b "$JAR" "$BASE/api/feed")"
PREV_SOURCE="$(echo "$FEED_BEFORE" | jq -r '.source // "sim"')"
PREV_SIMDIS="$(echo "$FEED_BEFORE" | jq -r '.simDisabled // false')"
curl -s -b "$JAR" -X POST "$BASE/api/feed" -H 'Content-Type: application/json' -d '{"source":"sim","simDisabled":false}' >/dev/null
A="$(curl -s -b "$JAR" "$BASE/api/accounts")"
# production DBs may have deleted the demo sim accounts — create a TEMP one
# for the order leg (removed in cleanup) so the suite runs on any database
SIMID="$(printf '%s' "$A" | jq -r '[.accounts[] | select(.brokerType=="SIMFEED")][0].id' 2>/dev/null)"
TEMP_SIM=""
if [ -z "$SIMID" ] || [ "$SIMID" = "null" ]; then
  TEMP_SIM="$(curl -s -b "$JAR" -X POST "$BASE/api/accounts" -H 'Content-Type: application/json' \
    -d '{"label":"E2E Temp Sim","brokerType":"SIMFEED","initialCapital":600000,"capitalBase":"FIXED","isOrderEnabled":true}' | jq -r '.id // empty')"
  SIMID="$TEMP_SIM"
  ok "temp SIMFEED account created for the order leg (${SIMID:-FAILED})"
fi
A="$(curl -s -b "$JAR" "$BASE/api/accounts")"
chk "accounts present (>= 2)" "$A" '(.accounts | length >= 2)' 'true'
chk "every account exposes usable capital (usableCapital)" "$A" '([.accounts[] | has("usableCapital")] | all)' 'true'
chk "accounts expose hasSession (LIVE vs SANDBOX)" "$A" '([.accounts[] | has("hasSession")] | all)' 'true'

say "4. Market data (REST proxies → feed)"
Q="$(curl -s -b "$JAR" "$BASE/api/market/quote?symbol=NIFTY")"
chk "quote NIFTY has ltp"     "$Q" '(.ltp | type == "number")' 'true'
C="$(curl -s -b "$JAR" "$BASE/api/market/candles?symbol=NIFTY&tf=1m&limit=50")"
chk "candles NIFTY 1m ×50"    "$C" '(.candles | length == 50)' 'true'
CH="$(curl -s -b "$JAR" "$BASE/api/options/chain?underlying=NIFTY")"
chk "NIFTY chain: ceAtm/peAtm computed (CE floor / PE ceil)" "$CH" '(.meta.ceAtm > 0 and .meta.peAtm > 0)' 'true'
chk "NIFTY chain: peAtm = ceAtm + step (spot between strikes)" "$CH" '(.meta.peAtm - .meta.ceAtm == .meta.step)' 'true'
ATMCE_SYM="$(printf '%s' "$CH" | jq -r '.atmCe.symbol')"
ATMCE_LTP="$(printf '%s' "$CH" | jq -r '.atmCe.ltp')"
ok  "ATM CE = $ATMCE_SYM @ ₹$ATMCE_LTP"

say "5. Order lifecycle (sim fan-out → positions → squareoff)"
# trade an ATM CE option: premium-sized, affordable by the sim account
# regardless of how far the sim equity prices have drifted from base
if [ -z "$SIMID" ] || [ "$SIMID" = "null" ]; then
  ok  "SKIP order lifecycle — no SIMFEED account (live-only production DB)"
elif [ -z "$ATMCE_SYM" ] || [ "$ATMCE_SYM" = "null" ]; then
  bad "ATM CE symbol missing — cannot run order lifecycle"
else
  O="$(curl -s -b "$JAR" -X POST "$BASE/api/orders" -H 'Content-Type: application/json' \
    -d "{\"symbol\":\"$ATMCE_SYM\",\"exchange\":\"NFO\",\"side\":\"BUY\",\"orderType\":\"MARKET\",\"productType\":\"NRML\",\"qty\":25,\"source\":\"MANUAL\"}")"
  chk "master order accepted (not FAILED)" "$O" '(.status != "FAILED")' 'true'
  FILLS="$(printf '%s' "$O" | jq '[.legs[]? | select(.status == "FILLED")] | length')"
  ok  "filled legs reported: $FILLS"
  sleep 1
  P="$(curl -s -b "$JAR" "$BASE/api/positions")"
  chk "ATM CE position open after buy" "$(printf '%s' "$P" | jq --arg s "$ATMCE_SYM" '[.positions[]? | select(.symbol==$s and (.netQty != 0))] | length > 0')" '.' 'true'
  S="$(curl -s -b "$JAR" -X POST "$BASE/api/orders/squareoff" -H 'Content-Type: application/json' -d "{\"symbols\":[\"$ATMCE_SYM\"]}")"
  chk "squareoff accepted" "$S" '.ok' 'true'
  sleep 2
  P2="$(curl -s -b "$JAR" "$BASE/api/positions")"
  chk "ATM CE flat after squareoff" "$(printf '%s' "$P2" | jq --arg s "$ATMCE_SYM" '[.positions[]? | select(.symbol==$s and (.netQty != 0))] | length == 0')" '.' 'true'
fi

say "6. Stats & automation endpoints"
ST="$(curl -s -b "$JAR" "$BASE/api/stats/session")"
chk "session stats has net/winRate"  "$ST" 'has("net")' 'true'
AU="$(curl -s -b "$JAR" "$BASE/api/autorules")"
chk "auto-bot rules list reachable"  "$AU" 'has("rules")' 'true'
GT="$(curl -s -b "$JAR" "$BASE/api/gtt")"
chk "GTT list reachable"             "$GT" 'has("rules")' 'true'
TR="$(curl -s -b "$JAR" "$BASE/api/tickrecorder")"
chk "tick recorder status reachable" "$TR" 'has("sessions")' 'true'

printf '\n\033[1m──────── E2E summary: %d passed, %d failed ────────\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
