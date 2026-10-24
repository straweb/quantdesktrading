#!/bin/bash
# Round-12 final verification (server must already be running on :3000)
cd /home/z/my-project
C=/tmp/zc.txt
rm -f "$C"
curl -s -c "$C" -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null -w "login: %{http_code}\n"

echo "== feed API simDisabled =="
curl -s -b "$C" http://localhost:3000/api/feed | head -c 160; echo
curl -s -b "$C" -X POST http://localhost:3000/api/feed -H 'Content-Type: application/json' -d '{"simDisabled":true}' -o /dev/null -w "set true: %{http_code}\n"
grep -o '"simDisabled": *[a-z]*' db/feed-source.json
curl -s -b "$C" -X POST http://localhost:3000/api/feed -H 'Content-Type: application/json' -d '{"simDisabled":false}' -o /dev/null -w "set false: %{http_code}\n"

echo "== broker diagnostics (ICICI) =="
ACC=$(node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("db/custom.db", { readOnly: true }); const a = db.prepare("SELECT id FROM BrokerAccount WHERE brokerType = ? LIMIT 1").get("ICICI_BREEZE"); console.log(a ? a.id : "")')
echo "account: $ACC"
[ -n "$ACC" ] && curl -s -b "$C" -X POST http://localhost:3000/api/broker-test -H 'Content-Type: application/json' -d "{\"accountId\":\"$ACC\"}" --max-time 60 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);for(const st of j.steps)console.log(` ${st.ok?"OK ":"FAIL"} ${st.step} (${st.ms}ms) — ${st.detail.slice(0,120)}`)}catch(e){console.log("raw:",s.slice(0,300))}})'

echo "== symbols search API =="
curl -s -b "$C" "http://localhost:3000/api/symbols?q=NIFTY&limit=5" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("results:",j.symbols.length, j.symbols.slice(0,3).map(x=>x.symbol).join(", "))})'

echo "== E2E API smoke =="
bash tests/e2e/api-smoke.sh 2>&1 | grep -E "✓|✗|summary|▸" | tail -30
