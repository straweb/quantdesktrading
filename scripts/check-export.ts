// quick check: export route returns a VALID zip
const base = 'http://localhost:3000'
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
const exp = await fetch(`${base}/api/workspace/export`, { headers: { cookie } })
console.log('export:', exp.status, exp.headers.get('content-type'), exp.headers.get('content-disposition'))
if (exp.ok) {
  const buf = Buffer.from(await exp.arrayBuffer())
  console.log('zip bytes:', buf.length, '-> magic:', buf.subarray(0, 2).toString())
  const { execSync } = await import('child_process')
  const { writeFileSync } = await import('fs')
  writeFileSync('/tmp/qd-test.zip', buf)
  console.log(execSync('unzip -l /tmp/qd-test.zip | head -10 && unzip -l /tmp/qd-test.zip | tail -3 && unzip -t /tmp/qd-test.zip | tail -2').toString())
}
process.exit(0)
