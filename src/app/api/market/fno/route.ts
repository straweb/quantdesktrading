// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { fetchQuotes } from '@brokers/feed-client'

export const dynamic = 'force-dynamic'

// GET /api/market/fno
// The full F&O universe grouped by exchange — NFO (NSE F&O), BFO (BSE F&O),
// BFNO (reserved), MCX (commodities), CDS (currency). For every underlying:
// the LATEST expiry, its option-contract count, lot size and a live spot quote
// (+ day change %) so the watchlist FNO tab renders everything at a glance.
const GROUP_LABELS: Record<string, string> = {
  NFO: 'NSE F&O',
  BFO: 'BSE F&O',
  BFNO: 'BSE F&O (BFNO)',
  MCX: 'Commodities (MCX)',
  CDS: 'Currency (CDS)',
}

interface FnoRow {
  underlying: string
  name: string
  exchange: string
  segment: string
  instrumentType: string
  lotSize: number
  latestExpiry: string | null
  contracts: number
  spot: number
  chgPct: number
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req)
  if (auth) return auth

  const deriv = await db.symbolMaster.findMany({
    where: { instrumentType: { in: ['FUT', 'CE', 'PE'] } },
    select: { symbol: true, underlying: true, exchange: true, expiry: true, lotSize: true, instrumentType: true },
  })
  if (deriv.length === 0) return NextResponse.json({ groups: [] })

  interface Agg {
    underlying: string
    exchange: string
    lotSize: number
    expiries: Set<string>
    contractsLatest: number
    latestExpiry: string | null
  }
  const map = new Map<string, Agg>()
  for (const r of deriv) {
    if (!r.underlying) continue
    const key = `${r.underlying}|${r.exchange}`
    let a = map.get(key)
    if (!a) {
      a = { underlying: r.underlying, exchange: r.exchange, lotSize: r.lotSize, expiries: new Set(), contractsLatest: 0, latestExpiry: null }
      map.set(key, a)
    }
    a.lotSize = r.lotSize
    if (r.expiry) {
      a.expiries.add(r.expiry)
      if (!a.latestExpiry || r.expiry < a.latestExpiry) a.latestExpiry = r.expiry
    }
  }
  for (const r of deriv) {
    if (!r.underlying || r.instrumentType === 'FUT') continue
    const a = map.get(`${r.underlying}|${r.exchange}`)
    if (a && r.expiry && r.expiry === a.latestExpiry) a.contractsLatest++
  }
  const bases = await db.symbolMaster.findMany({
    where: { instrumentType: { in: ['INDEX', 'EQ', 'COMM', 'CUR'] } },
    select: { symbol: true, name: true, instrumentType: true },
  })
  const baseMap = new Map(bases.map(b => [b.symbol, b]))

  const underlyings = [...new Set([...map.values()].map(a => a.underlying))]
  const quotes = await fetchQuotes(underlyings)

  const groups = new Map<string, { exchange: string; label: string; underlyings: FnoRow[] }>()
  for (const a of map.values()) {
    const base = baseMap.get(a.underlying)
    const q = quotes[a.underlying]
    const prev = q?.prevClose ?? 0
    const ltp = q?.ltp ?? 0
    const row: FnoRow = {
      underlying: a.underlying,
      name: base?.name ?? a.underlying,
      exchange: a.exchange,
      segment: base?.instrumentType === 'INDEX' ? 'IDX' : base?.instrumentType === 'COMM' ? 'COMM' : base?.instrumentType === 'CUR' ? 'CUR' : 'EQ',
      instrumentType: base?.instrumentType ?? 'EQ',
      lotSize: a.lotSize,
      latestExpiry: a.latestExpiry,
      contracts: a.contractsLatest,
      spot: ltp,
      chgPct: prev && ltp ? Math.round(((ltp - prev) / prev) * 10000) / 100 : 0,
    }
    const g = groups.get(a.exchange) ?? { exchange: a.exchange, label: GROUP_LABELS[a.exchange] ?? a.exchange, underlyings: [] }
    g.underlyings.push(row)
    groups.set(a.exchange, g)
  }
  const order = ['NFO', 'BFO', 'BFNO', 'MCX', 'CDS']
  const out = order.filter(e => groups.has(e)).map(e => {
    const g = groups.get(e)!
    g.underlyings.sort((a, b) => a.underlying.localeCompare(b.underlying))
    return g
  })
  return NextResponse.json({ groups: out })
}
