// E2E probe for the realtime sync hub (Task r5-6)
// Connects as a browser would (via the Caddy gateway), subscribes, and
// prints the first payload of each sync channel.
const { io } = require('socket.io-client')

const socket = io('http://localhost:3003', { transports: ['websocket'], path: '/' })
const seen = {}
socket.on('connect', () => {
  console.log('connected', socket.id)
  socket.emit('sync:sub', {
    chains: [{ underlying: 'NIFTY', expiry: null }],
    index: ['NIFTY'],
  })
})
socket.on('sync:core', d => {
  if (seen.core) return
  seen.core = true
  console.log('sync:core accounts=', d.accounts?.length,
    'positions=', d.positions?.length,
    'orders=', d.orders?.length,
    'trades=', d.trades?.length,
    'funds=', d.funds?.length,
    'session=', JSON.stringify(d.session ? { wr: d.session.winRate, pts: d.session.pts, net: d.session.net, trades: d.session.trades } : null))
})
socket.on('sync:chain', d => {
  if (seen.chain) return
  seen.chain = true
  const row = d.rows?.find(r => r.strike === d.meta?.ceAtm)
  console.log('sync:chain meta=', JSON.stringify({ u: d.meta?.underlying, exp: d.meta?.expiry, step: d.meta?.step, ceAtm: d.meta?.ceAtm, peAtm: d.meta?.peAtm, spot: d.meta?.spot }),
    'rows=', d.rows?.length,
    'atmCe=', JSON.stringify(row?.ce))
})
socket.on('sync:index', d => {
  if (seen.index) return
  seen.index = true
  console.log('sync:index', d.index?.symbol, 'ltp=', d.index?.ltp, 'constituents=', d.constituents?.length, 'totalPts=', d.totalPts)
})
setTimeout(() => {
  console.log('done — missing channels:', Object.keys(seen).length < 3 ? ['core','chain','index'].filter(k => !seen[k.slice(0,4)] ?? true) : 'none')
  process.exit(0)
}, 6000)
