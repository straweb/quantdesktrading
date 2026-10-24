// quick check: sync:admin pushes every ~2s + export route returns a zip
import { io } from 'socket.io-client'

const socket = io('http://localhost:3003', { transports: ['websocket'], reconnection: false, timeout: 5000 })
let adminCount = 0
let coreCount = 0
socket.on('connect', () => console.log('connected', socket.id))
socket.on('sync:admin', (d) => {
  adminCount++
  if (adminCount === 1 || adminCount === 2) {
    console.log('sync:admin keys:', Object.keys(d).join(','))
    console.log('  feed:', JSON.stringify({ source: d.feed?.source, fresh: d.feed?.fresh, symbols: d.feed?.symbols }))
    console.log('  feedSource:', JSON.stringify(d.feedSource?.source), 'sources:', d.feedSource?.sources?.length)
    console.log('  accountsMeta:', d.accountsMeta?.length, 'brokerLogs:', d.brokerLogs?.length, 'audit:', d.audit?.length)
    console.log('  strategies:', d.strategies?.length, 'gtt:', d.gtt?.length, 'autoRules:', d.autoRules?.length)
    console.log('  syncInfo:', JSON.stringify(d.syncInfo?.counts), 'recorder sessions:', d.tickRecorder?.sessions?.length, 'replay active:', d.replay?.active)
  }
})
socket.on('sync:core', (d) => { coreCount++; if (coreCount === 1) console.log('sync:core accounts:', d.accounts?.length, 'positions:', d.positions?.length) })
setTimeout(async () => {
  console.log(`received in 6s — sync:admin x${adminCount} (~3 expected), sync:core x${coreCount} (~6 expected)`)
  // export endpoint (login first)
  const base = 'http://localhost:3000'
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  console.log('login:', login.status, cookie ? 'cookie ok' : 'NO COOKIE')
  const exp = await fetch(`${base}/api/workspace/export`, { headers: { cookie } })
  console.log('export:', exp.status, exp.headers.get('content-type'), exp.headers.get('content-disposition'))
  if (exp.ok) {
    const buf = Buffer.from(await exp.arrayBuffer())
    console.log('zip bytes:', buf.length, '-> magic:', buf.subarray(0, 2).toString())
    const { execSync } = await import('child_process')
    const { writeFileSync } = await import('fs')
    writeFileSync('/tmp/qd-test.zip', buf)
    console.log(execSync('unzip -l /tmp/qd-test.zip | tail -4; unzip -l /tmp/qd-test.zip | head -8').toString())
  }
  process.exit(0)
}, 6000)
