#!/bin/bash
# E2E test: Task 6 features — auto rules engine, deploy/swap/exit, broker API surface
set -e
BASE=http://localhost:3000
JAR=/home/z/my-project/scripts/.cookies.txt
rm -f $JAR

echo "== login =="
curl -s -c $JAR -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | head -c 120; echo

echo "== current NIFTY spot =="
SPOT=$(curl -s -b $JAR "$BASE/api/market/quote?symbol=NIFTY" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ltp"])')
echo "NIFTY=$SPOT"

LEVEL=$(python3 -c "print(round($SPOT + 1, 1))")
echo "== create INDEX rule (cross above $LEVEL -> BUY CE ATM 100%) =="
curl -s -b $JAR -X POST $BASE/api/autorules -H 'Content-Type: application/json' -d "{
  \"name\":\"e2e index cross\",
  \"underlying\":\"NIFTY\",\"kind\":\"INDEX\",\"cross\":\"ABOVE\",\"level\":$LEVEL,
  \"action\":\"BUY\",\"optType\":\"CE\",\"offset\":0,\"allocPct\":50,\"repeatDaily\":true
}" | python3 -m json.tool | head -8

echo "== create TIME rule (now+1min IST) =="
TT=$(python3 -c "
import datetime
t = datetime.datetime.utcnow() + datetime.timedelta(minutes=1, hours=5, seconds=30)
print(t.strftime('%H:%M'))")
echo "fire at $TT IST"
curl -s -b $JAR -X POST $BASE/api/autorules -H 'Content-Type: application/json' -d "{
  \"name\":\"e2e time rule\",
  \"underlying\":\"NIFTY\",\"kind\":\"TIME\",\"time\":\"$TT\",
  \"action\":\"BUY\",\"optType\":\"PE\",\"offset\":0,\"allocPct\":25,\"repeatDaily\":true
}" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("created:", r["rule"]["id"], r["rule"]["name"])'

echo "== rules list =="
curl -s -b $JAR $BASE/api/autorules | python3 -c '
import sys,json
for r in json.load(sys.stdin)["rules"]:
    print(r["kind"], r["name"], "enabled=" + str(r["enabled"]))'

echo "== wait for INDEX + TIME rules to fire (up to 100s) =="
for i in $(seq 1 20); do
  sleep 5
  FIRED=$(curl -s -b $JAR $BASE/api/autorules | python3 -c '
import sys,json
rules = json.load(sys.stdin)["rules"]
fired = [r for r in rules if r["name"].startswith("e2e") and r.get("lastStatus")]
print(len(fired))')
  echo "  t+$((i*5))s fired=$FIRED"
  if [ "$FIRED" = "2" ]; then break; fi
done

echo "== rule statuses =="
curl -s -b $JAR $BASE/api/autorules | python3 -c '
import sys,json
for r in json.load(sys.stdin)["rules"]:
    if r["name"].startswith("e2e"):
        print(r["name"], "->", r.get("lastStatus"), r.get("lastMessage",""), "fires:", r.get("fireCount"))'

echo "== delete e2e rules =="
IDS=$(curl -s -b $JAR $BASE/api/autorules | python3 -c '
import sys,json
print(" ".join(r["id"] for r in json.load(sys.stdin)["rules"] if r["name"].startswith("e2e")))')
for id in $IDS; do curl -s -b $JAR -X DELETE $BASE/api/autorules/$id | head -c 40; echo; done

echo "== broker-orderbook (sim account -> sandbox message expected) =="
ACC=$(curl -s -b $JAR $BASE/api/accounts | python3 -c 'import sys,json; print(json.load(sys.stdin)["accounts"][0]["id"])')
curl -s -b $JAR "$BASE/api/broker-orderbook?accountId=$ACC" | head -c 200; echo

echo "== deploy 1 CE strike + swap + exit-all flow =="
# ensure a strike exists (returns real symbol names)
SYM=$(curl -s -b $JAR -X POST $BASE/api/options/ensure-strike -H 'Content-Type: application/json' -d '{"underlying":"NIFTY","strike":24500}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["symbols"][0])')
echo "contract: $SYM"
# market BUY via master order (sized 25% usable)
curl -s -b $JAR -X POST $BASE/api/orders -H 'Content-Type: application/json' -d "{
  \"symbol\":\"$SYM\",\"exchange\":\"NFO\",\"side\":\"BUY\",\"qty\":0,
  \"orderType\":\"MARKET\",\"productType\":\"MIS\",\"source\":\"MANUAL\",\"capitalPct\":25
}" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("buy:", r["status"], r.get("message"), "legs:", len(r["legs"]))'

echo "== square off (exit all) =="
curl -s -b $JAR -X POST $BASE/api/orders/squareoff -H 'Content-Type: application/json' -d '{}' | head -c 200; echo

echo "== positions after exit =="
curl -s -b $JAR $BASE/api/positions | python3 -c 'import sys,json; d=json.load(sys.stdin); print("open positions:", d["totals"]["openPositions"])'

echo "DONE"
