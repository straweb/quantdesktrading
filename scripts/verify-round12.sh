#!/bin/bash
# Round-12 verification: start the app transiently and run every check
# against the live APIs (single tool call — sandbox reaps bg processes).
cd /home/z/my-project
LOG=/tmp/verify-dev.log
: > "$LOG"

echo "== starting next dev =="
node node_modules/next/dist/bin/next dev -p 3000 > "$LOG" 2>&1 &
NEXTPID=$!
for i in $(seq 1 45); do
  code=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "app ready after ~$((i*2))s (code $code)"

C=/tmp/zterm-cookies.txt
rm -f "$C"
echo "== login =="
curl -s -c "$C" -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' | head -c 120; echo

echo "== feed API (simDisabled field) =="
curl -s -b "$C" http://localhost:3000/api/feed | head -c 220; echo

echo "== toggle simDisabled true/false =="
curl -s -b "$C" -X POST http://localhost:3000/api/feed -H 'Content-Type: application/json' -d '{"simDisabled":true}'; echo
sleep 1
cat db/feed-source.json; echo
curl -s -b "$C" -X POST http://localhost:3000/api/feed -H 'Content-Type: application/json' -d '{"simDisabled":false}'; echo

echo "== master contracts sync (incl. scrip-master enrichment) =="
curl -s -b "$C" -X POST http://localhost:3000/api/symbols/sync -H 'Content-Type: application/json' --max-time 240 | head -c 300; echo

echo "== real broker tokens in mappings =="
node -e '
const { DatabaseSync: Database } = require("node:sqlite");
const db = new DatabaseSync("db/custom.db", { readOnly: true });
const q = db.prepare(`SELECT sm.symbol s, sm.instrumentType it, sm.expiry e, sm.strike st, mp.brokerToken tok
  FROM SymbolMapping mp JOIN SymbolMaster sm ON sm.id=mp.masterId
  WHERE mp.brokerType=? AND sm.symbol=? AND sm.instrumentType=? ORDER BY sm.expiry LIMIT 2`);
for (const bt of ["DHAN","SHOONYA","ICICI_BREEZE"]) {
  for (const row of q.all(bt, "NIFTY", "CE")) console.log(bt, "NIFTY CE", row.e, row.st, "→", row.tok);
  const idx = db.prepare(`SELECT mp.brokerToken tok FROM SymbolMapping mp JOIN SymbolMaster sm ON sm.id=mp.masterId WHERE mp.brokerType=? AND sm.symbol=? AND sm.instrumentType="INDEX"`).get(bt, "NIFTY");
  console.log(bt, "NIFTY INDEX →", idx?.tok);
}
db.close();'

echo "== broker diagnostics (ICICI account) =="
ACC=$(node -e 'const { DatabaseSync: Database }=require("node:sqlite");const db=new DatabaseSync("db/custom.db",{readOnly:true});const a=db.prepare("SELECT id FROM BrokerAccount WHERE brokerType=\"ICICI_BREEZE\" LIMIT 1").get();console.log(a?a.id:"")')
if [ -n "$ACC" ]; then
  curl -s -b "$C" -X POST http://localhost:3000/api/broker-test -H 'Content-Type: application/json' -d "{\"accountId\":\"$ACC\"}" --max-time 60 | head -c 600; echo
fi

echo "== E2E API smoke =="
bash tests/e2e/api-smoke.sh 2>&1 | tail -30

echo "== server errors during run =="
grep -E "⨯|Error:" "$LOG" | grep -v "Error: " | head -5 || true

kill $NEXTPID 2>/dev/null
echo "== done =="
