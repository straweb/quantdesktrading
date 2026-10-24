/**
 * One-time repair: sandbox broker DBs tracked funds.cash as a PnL ledger
 * (starts 0, drifts by realized/charges) — the %-of-available-cash capital
 * base needs a REAL balance. Aligns cash = initialCapital + realizedPnl
 * for every account whose cash is clearly still the ledger artifact
 * (negative while the capital model says the account holds money).
 */
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'

const ROOT = '/home/z/my-project'
const master = new Database(`${ROOT}/db/custom.db`, { readonly: true })
const accounts = master.prepare(`
  SELECT ba.id, ba.label, ba.brokerType, cc.initialCapital, cc.realizedPnl
  FROM BrokerAccount ba LEFT JOIN CapitalConfig cc ON cc.accountId = ba.id
`).all()
master.close()

for (const a of accounts) {
  const dbPath = `${ROOT}/db/brokers/${String(a.brokerType).toLowerCase()}/${a.id}.db`
  if (!existsSync(dbPath)) { console.log(`skip ${a.label} (no db)`); continue }
  const db = new Database(dbPath)
  const row = db.prepare('SELECT cash FROM funds WHERE id = 1').get()
  const cash = Number(row?.cash ?? 0)
  const fair = Math.round(Number(a.initialCapital ?? 0) + Number(a.realizedPnl ?? 0))
  if (cash <= 0 && fair > 0) {
    db.prepare('UPDATE funds SET cash = ?, updated_at = ? WHERE id = 1').run(fair, new Date().toISOString())
    console.log(`repaired ${a.label}: ${cash} -> ${fair}`)
  } else {
    console.log(`ok ${a.label}: cash=${cash} fair=${fair}`)
  }
  db.close()
}
console.log('done')
