// Verify the rewritten Breeze REST client against the REAL ICICI API
// using the stored (encrypted) credentials of the ICICI_BREEZE account.
// Run: TERMINAL_SECRET=<secret> bun scripts/verify-breeze.ts
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { Database } from 'bun:sqlite'
import { createDecipheriv, createHash } from 'node:crypto'
import { breezeRequest, breezeInstrumentParams, parseBreezeQuoteRow, firstSuccess } from '../brokers/icici_breeze/breeze'

const SECRET = process.env.TERMINAL_SECRET || 'zterm-default-secret-change-in-prod'
const KEY = createHash('sha256').update(SECRET).digest()

function decryptJson<T>(payload: string | null | undefined): T | null {
  if (!payload) return null
  try {
    const [ivB64, tagB64, dataB64] = payload.split('.')
    const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'))
    d.setAuthTag(Buffer.from(tagB64, 'base64'))
    const dec = Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()])
    return JSON.parse(dec.toString('utf8')) as T
  } catch { return null }
}

const dbPath = path.resolve(process.cwd(), 'db/custom.db')
if (!existsSync(dbPath)) { console.error('no master db'); process.exit(1) }
const db = new Database(dbPath, { readonly: true })
const acc = db.prepare("SELECT id, label, brokerType, credentialsEnc FROM BrokerAccount WHERE brokerType = 'ICICI_BREEZE' ORDER BY createdAt DESC LIMIT 1").get() as { id: string; label: string; credentialsEnc: string } | undefined
db.close()
if (!acc) { console.error('no ICICI account'); process.exit(1) }
const creds = decryptJson<Record<string, string>>(acc.credentialsEnc)
if (!creds) { console.error('decrypt failed'); process.exit(1) }
console.log(`account: ${acc.label} · keys: ${Object.keys(creds).join(', ')} · userId=${creds.userId ?? '(none)'}`)

const bc = { apiKey: creds.apiKey, apiSecret: creds.apiSecret, sessionToken: creds.sessionToken, userId: creds.userId }

// 1 — funds (the round-12 bug: /customer/margins 404 → now GET /funds)
const t0 = Date.now()
const funds = await breezeRequest(bc, 'GET', 'funds', {}, { timeoutMs: 12000, log: l => console.log('  ', l) })
console.log(`\nFUNDS  http=${funds.httpStatus} status=${funds.status} (${Date.now() - t0}ms)`)
const fs = firstSuccess(funds)
if (fs) {
  const f = (k: string) => Number(String((fs as Record<string, unknown>)[k] ?? '0').replace(/,/g, '')) || 0
  const cash = Math.max(0, f('allocated_equity') + f('unallocated_balance') + f('total_bank_balance') - f('block_by_trade_balance'))
  console.log('  Success fields:', Object.keys(fs as Record<string, unknown>).slice(0, 10).join(', '))
  console.log('  → available cash ₹', cash.toFixed(2), ' (allocated_equity', f('allocated_equity'), '· unallocated', f('unallocated_balance'), '· bank', f('total_bank_balance'), ')')
} else {
  console.log('  no Success — error:', funds.error, '· raw:', funds.raw?.slice(0, 220))
}

// 2 — quote NIFTY index (the round-12 bug: no LTP / Result envelope)
const t1 = Date.now()
const quote = await breezeRequest(bc, 'GET', 'quotes', breezeInstrumentParams({ symbol: 'NIFTY', exchange: 'NSE', instrumentType: 'INDEX' }), { timeoutMs: 10000, log: l => console.log('  ', l) })
console.log(`\nQUOTE NIFTY  http=${quote.httpStatus} status=${quote.status} (${Date.now() - t1}ms)`)
const row = firstSuccess(quote)
if (row) {
  const q = parseBreezeQuoteRow(row)
  console.log('  → LTP', q.ltp, '· bid', q.bid, '· ask', q.ask, '· prevClose', q.prevClose)
} else {
  console.log('  no Success — error:', quote.error, '· raw:', quote.raw?.slice(0, 220))
}

// 3 — a NIFTY option quote from the mapping table (validates the pipe-token path)
const db2 = new Database(dbPath, { readonly: true })
const opt = db2.prepare(`
  SELECT sm.symbol AS sym, sm.exchange AS exch, sm.instrumentType AS it, sm.expiry AS exp, sm.strike AS strike, mp.brokerToken AS tok
  FROM SymbolMapping mp JOIN SymbolMaster sm ON sm.id = mp.masterId
  WHERE mp.brokerType = 'ICICI_BREEZE' AND sm.instrumentType = 'CE' AND sm.symbol = 'NIFTY'
  ORDER BY sm.expiry ASC, ABS(sm.strike - 25500) ASC LIMIT 1`).get() as { sym: string; exch: string; it: string; exp: string; strike: number; tok: string } | undefined
db2.close()
if (opt) {
  const [stock, exp, strike, right] = opt.tok.split('|')
  const t2 = Date.now()
  const q3 = await breezeRequest(bc, 'GET', 'quotes', breezeInstrumentParams({ symbol: stock, exchange: opt.exch, instrumentType: 'CE', expiry: exp, strike, optionType: right }), { timeoutMs: 10000, log: l => console.log('  ', l) })
  const r3 = firstSuccess(q3)
  console.log(`\nQUOTE OPTION ${opt.tok}  http=${q3.httpStatus} (${Date.now() - t2}ms)`)
  if (r3) console.log('  → LTP', parseBreezeQuoteRow(r3).ltp)
  else console.log('  no Success — error:', q3.error, '· raw:', q3.raw?.slice(0, 200))
} else {
  console.log('\nno NIFTY CE mapping in db')
}
